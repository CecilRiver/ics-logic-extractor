"""Web 集成用的 JSONL 运行器。

每次调用把结构化进度/结果写到 stdout（一行一个 JSON），供 Node 服务转成
前端进度条。PLC 侧只走 ``PlcReader`` 的只读上载，不发送任何写命令。

用法::

    python plc_runner.py fetch --ip 192.168.20.55 --port 502 --timeout 10 \
        --out-root <项目>/data/traffic [--stu <path>]

    python plc_runner.py variables --run-dir <项目>/data/traffic/<时间戳>_<IP>
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import socket
import sys
import tempfile
import time

from plcrev.m340 import pathbase, pou as poumod, stsource, variables
from plcrev.m340.client import PlcReader
from plcrev.m340.umas import UmasError

PROGRAM_HINT = re.compile(r"%[QIM]\d|%S\d")


def emit(payload: dict) -> None:
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def progress(stage: str, percent: float, message: str) -> None:
    emit({"type": "progress", "stage": stage, "percent": round(percent, 1), "message": message})


def fail(message: str) -> int:
    emit({"type": "error", "message": message})
    return 1


def unique_run_dir(root: str, tag: str) -> str:
    os.makedirs(root, exist_ok=True)
    safe = re.sub(r"[\\/:*?\"<>|]", "-", tag) or "plc"
    stamp = time.strftime("%Y%m%d-%H%M%S")
    base = os.path.join(root, f"{stamp}_{safe}")
    n = 1
    while os.path.exists(base):
        base = os.path.join(root, f"{stamp}_{safe}_{n}")
        n += 1
    return base


def load_blocks(stu_path: str | None) -> list[pathbase.Block]:
    if not stu_path:
        return []
    try:
        return pathbase.scan(pathbase.load_from_stu(stu_path))
    except Exception as exc:  # noqa: BLE001 - .stu 是可选输入，坏了就降级
        emit({"type": "warning", "message": f"读取 .stu 失败，变量声明将不可用：{exc}"})
        return []


def analyze_sources(sources, blocks):
    """把源码和声明配对。返回与 sources 等长的列表。

    优先用 ``pou.match``（会校验唯一性）；失败时退化为逐条取最高分声明块，
    再不行就只有代码体。
    """
    if blocks:
        try:
            matched = poumod.match(blocks, sources)
            return [{"pou": p, "block": None} for p in matched]
        except Exception as exc:  # noqa: BLE001
            emit({"type": "warning", "message": f"声明匹配失败，按最佳匹配降级：{exc}"})

    out = []
    for src in sources:
        best = None
        best_score = 0.0
        for block in blocks:
            score = poumod._score(block, src.text)  # noqa: SLF001 - 复用同一套匹配口径
            if score > best_score:
                best, best_score = block, score
        out.append({"pou": None, "block": best if best_score >= poumod.MIN_SCORE else None})
    return out


def unit_text(info, src) -> tuple[str, str, bool, bool]:
    """返回 (名称, 完整文本, 是否程序段, 声明是否已定位)。"""
    p = info.get("pou")
    block = info.get("block")
    if p is not None:
        if p.program:
            return p.name, p.text, True, False
        name = p.name or f"未命名块_0x{p.declarations.offset:06X}"
        return name, p.text, False, bool(p.declarations and p.declarations.vars)
    if block is not None:
        program = bool(PROGRAM_HINT.search(src.text))
        name = block.name or f"未命名块_0x{block.offset:06X}"
        return name, block.render(src.text, name), program, bool(block.vars)
    program = bool(PROGRAM_HINT.search(src.text))
    return f"单元 {src.stream_offset:05X}", src.text, program, False


def declarations_for(info, text: str) -> list[variables.VarDecl]:
    p = info.get("pou")
    block = info.get("block")
    decls = None
    if p is not None and not p.program and p.declarations is not None:
        decls = p.declarations.vars
    elif block is not None:
        decls = block.vars
    if decls:
        return [variables.VarDecl(v.name, v.type, v.section) for v in decls]
    return []


def cmd_fetch(args: argparse.Namespace) -> int:
    ip, port = args.ip, args.port
    progress("connect", 2, f"连接 {ip}:{port}")

    last = [0.0]

    def on_progress(got: int, total: int) -> None:
        now = time.time()
        if now - last[0] < 0.25 and got < total:
            return
        last[0] = now
        pct = 5 + (70 * got / total if total else 0)
        progress("upload", pct, f"已读取 {got:,} / {total:,} 字节")

    try:
        reader = PlcReader(ip, port, timeout=args.timeout, hostname=args.hostname)
        with reader:
            session = reader.open_session()
            progress("connect", 6, f"会话号 0x{session:02X}，读取控制程序信息")
            total = reader.read_total_size()
            if not total:
                return fail("PLC 没有返回控制程序大小，请确认目标是 M340 且 502 端口可用")
            progress("upload", 8, f"控制程序大小 {total:,} 字节")
            upload = reader.fetch(max_bytes=args.max_bytes, progress=on_progress)
    except ConnectionRefusedError:
        return fail(f"无法连接 {ip}:{port}（连接被拒绝），请确认 PLC 地址与端口")
    except socket.timeout:
        return fail(f"连接 {ip}:{port} 超时，请确认网络可达、目标机在测试网段内")
    except OSError as exc:
        return fail(f"无法连接 {ip}:{port}：{exc}")
    except UmasError as exc:
        return fail(f"控制程序提取失败：{exc}")
    except Exception as exc:  # noqa: BLE001 - 兜底，避免前端只看到断开的进程
        return fail(f"控制程序提取失败：{type(exc).__name__}: {exc}")

    image = upload.image
    digest = hashlib.sha256(image).hexdigest()
    progress("reverse", 78, f"控制程序提取完成（{len(image):,} 字节），解析程序源码")

    try:
        sources = stsource.extract(image)
    except Exception as exc:  # noqa: BLE001
        return fail(f"逆向解析失败：{exc}")
    if not sources:
        return fail("镜像里没有找到 ST 源码，请确认 PLC 里已下载用户程序")

    progress("reverse", 88, f"取到 {len(sources)} 段程序源码，解析控制程序")
    blocks = load_blocks(args.stu)
    infos = analyze_sources(sources, blocks)

    units = []
    for index, (src, info) in enumerate(zip(sources, infos), 1):
        name, text, program, declared = unit_text(info, src)
        units.append({
            "index": index,
            "name": name,
            "kind": "程序段" if program else "功能块",
            "chars": len(src.text),
            "status": "解析成功",
            "declared": declared,
            "streamOffset": f"0x{src.stream_offset:05X}",
            "text": text,
        })

    run_dir = unique_run_dir(args.out_root, ip)
    tmp_dir = tempfile.mkdtemp(prefix=".tmp-", dir=args.out_root)
    try:
        os.makedirs(os.path.join(tmp_dir, "01_上载"), exist_ok=True)
        os.makedirs(os.path.join(tmp_dir, "02_逆向"), exist_ok=True)
        with open(os.path.join(tmp_dir, "01_上载", "Station.apx"), "wb") as fh:
            fh.write(image)
        written = stsource.write_all(sources, os.path.join(tmp_dir, "02_逆向"))

        stu_name = None
        if args.stu and os.path.exists(args.stu):
            label = os.path.basename(getattr(args, "stu_name", None) or args.stu)
            label = re.sub(r"[\\/:*?\"<>|]", "_", label) or "declarations.stu"
            if len(label) > 120:
                stem, ext = os.path.splitext(label)
                label = stem[: max(1, 116 - len(ext))] + (ext or ".stu")
            stu_name = label
            os.makedirs(os.path.join(tmp_dir, "00_输入"), exist_ok=True)
            shutil.copy2(args.stu, os.path.join(tmp_dir, "00_输入", stu_name))

        manifest = {
            "plc": ip,
            "port": port,
            "time": time.strftime("%Y-%m-%d %H:%M:%S"),
            "session": f"0x{session:02X}",
            "image_bytes": len(image),
            "records": len(upload.records),
            "sha256": digest,
            "stu": stu_name,
            "files": [os.path.basename(p) for p in written],
            "units": [
                {"name": u["name"], "kind": u["kind"], "chars": u["chars"], "declared": u["declared"]}
                for u in units
            ],
        }
        with open(os.path.join(tmp_dir, "manifest.json"), "w", encoding="utf-8") as fh:
            json.dump(manifest, fh, ensure_ascii=False, indent=2)

        os.replace(tmp_dir, run_dir)
    except Exception as exc:  # noqa: BLE001 - 失败不留半成品
        shutil.rmtree(tmp_dir, ignore_errors=True)
        return fail(f"保存结果失败：{exc}")

    progress("done", 100, f"解析完成：{len(units)} 个单元")
    emit({
        "type": "result",
        "plc": ip,
        "port": port,
        "session": f"0x{session:02X}",
        "imageBytes": len(image),
        "records": len(upload.records),
        "sha256": digest,
        "declarations": bool(blocks),
        "stu": stu_name,
        "runDir": run_dir,
        "units": units,
    })
    return 0


def _read_run_units(run_dir: str):
    src_dir = os.path.join(run_dir, "02_逆向")
    paths = sorted(
        (os.path.join(src_dir, name) for name in os.listdir(src_dir) if name.endswith(".st")),
        key=lambda p: p.lower(),
    )
    sources = []
    for path in paths:
        match = re.search(r"0x([0-9A-Fa-f]+)", os.path.basename(path))
        offset = int(match.group(1), 16) if match else 0
        with open(path, encoding="utf-8") as fh:
            sources.append(stsource.Source(offset, fh.read(), 0))
    return sources


def _find_stu(run_dir: str) -> str | None:
    stu_dir = os.path.join(run_dir, "00_输入")
    if not os.path.isdir(stu_dir):
        return None
    for name in sorted(os.listdir(stu_dir)):
        if name.lower().endswith(".stu"):
            return os.path.join(stu_dir, name)
    return None


def cmd_variables(args: argparse.Namespace) -> int:
    run_dir = args.run_dir
    if not os.path.isdir(os.path.join(run_dir, "02_逆向")):
        return fail(f"运行目录里没有 02_逆向：{run_dir}")

    sources = _read_run_units(run_dir)
    if not sources:
        return fail("运行目录里没有 ST 源码，请先完成控制程序解析")

    stu_path = args.stu or _find_stu(run_dir)
    blocks = load_blocks(stu_path)
    infos = analyze_sources(sources, blocks)

    units = []
    for src, info in zip(sources, infos):
        name, _text, _program, _declared = unit_text(info, src)
        units.append(variables.Unit(name, src.text, declarations_for(info, src.text)))

    rows = variables.extract(units)

    out_dir = os.path.join(run_dir, "03_变量")
    os.makedirs(out_dir, exist_ok=True)
    saved = os.path.join(out_dir, "变量表.json")
    with open(saved, "w", encoding="utf-8") as fh:
        json.dump({
            "run_dir": run_dir,
            "stu": os.path.basename(stu_path) if stu_path else None,
            "generated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
            "variables": rows,
        }, fh, ensure_ascii=False, indent=2)

    emit({"type": "result", "runDir": run_dir, "saved": saved, "variables": rows})
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="plc_runner", description="业务逻辑提取工具的 PLC 解析运行器")
    sub = parser.add_subparsers(dest="cmd", required=True)

    fetch = sub.add_parser("fetch", help="提取 M340 控制程序并逆向 ST 源码")
    fetch.add_argument("--ip", required=True)
    fetch.add_argument("--port", type=int, default=502)
    fetch.add_argument("--timeout", type=float, default=10.0)
    fetch.add_argument("--hostname", default="PLC-READER")
    fetch.add_argument("--max-bytes", type=int, default=128 * 1024 * 1024)
    fetch.add_argument("--out-root", required=True)
    fetch.add_argument("--stu", help="IDE 保存的 .stu，用于补全变量声明")
    fetch.add_argument("--stu-name", help=".stu 的原始文件名，用于落盘与展示")
    fetch.set_defaults(func=cmd_fetch)

    var = sub.add_parser("variables", help="从已解析的 ST 源码提取关键变量与值域")
    var.add_argument("--run-dir", required=True)
    var.add_argument("--stu", help="默认复用运行目录 00_输入 里的 .stu")
    var.set_defaults(func=cmd_variables)
    return parser


def main(argv: list[str] | None = None) -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, OSError):
        pass
    args = build_parser().parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
