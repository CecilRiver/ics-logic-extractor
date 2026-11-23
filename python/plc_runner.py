"""Web 集成用的 JSONL 运行器。

每次调用把结构化进度/结果写到 stdout（一行一个 JSON），供 Node 服务转成
前端进度条。PLC 侧只走只读命令：UMAS 上载与 Modbus FC1/2/3/4 读取。

用法::

    python plc_runner.py collect --ip 192.168.20.55 --port 502 --timeout 10 \
        --out-root <项目>/data/traffic

    python plc_runner.py parse --run-dir <项目>/data/traffic/<时间戳>_<IP>

    python plc_runner.py variables --run-dir <项目>/data/traffic/<时间戳>_<IP>
"""

from __future__ import annotations

import argparse
import hashlib
import ipaddress
import json
import os
import re
import shutil
import socket
import struct
import sys
import tempfile
import time

from plcrev.m340 import pathbase, pou as poumod, stsource, variables
from plcrev.m340.client import MAX_RECORDS, PlcReader
from plcrev.m340.modbus import ModbusReader
from plcrev.m340.umas import UmasError, Upload
from plcrev.pcapng_writer import TcpPayload, TcpSession, write_pcapng

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


def replace_dir(source: str, target: str) -> None:
    """Windows 上杀毒/文件监听可能短暂占用目录，重命名失败时重试。"""
    last: OSError | None = None
    for _ in range(20):
        try:
            os.replace(source, target)
            return
        except OSError as exc:
            last = exc
            time.sleep(0.1)
    if last is not None:
        raise last


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


MODBUS_RANGES = [
    ("runtime", 3, "FC3", "读保持寄存器", "%MW", 0, 1024, 125),
    ("runtime", 4, "FC4", "读输入寄存器", "%IW", 0, 128, 125),
    ("io", 1, "FC1", "读线圈", "%M/%Q", 0, 256, 256),
    ("io", 2, "FC2", "读离散输入", "%I", 0, 256, 256),
]


class RecordingReader(PlcReader):
    """记录每次 UMAS 请求/响应的原始 PDU 与时间戳。"""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.frames: list[tuple[float, float, bytes, bytes]] = []

    def _send(self, payload: bytes) -> bytes:
        started = time.time()
        try:
            response = super()._send(payload)
        except Exception:
            self.frames.append((started, time.time(), payload, b""))
            raise
        self.frames.append((started, time.time(), payload, response))
        return response


def wrap_mbap(pdu: bytes, tid: int, unit: int = 0) -> bytes:
    return struct.pack(">HHHB", tid & 0xFFFF, 0, len(pdu) + 1, unit) + pdu


def iso_time(timestamp: float) -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(timestamp)) + \
        f".{int((timestamp % 1) * 1000):03d}"


def make_frame(index: int, timestamp: float, direction: str, category: str, protocol: str,
               function: str, summary: str, payload: bytes, **extra) -> dict:
    frame = {
        "index": index,
        "time": iso_time(timestamp),
        "direction": direction,
        "category": category,
        "protocol": protocol,
        "function": function,
        "summary": summary,
        "bytes": len(payload),
        "hex": payload.hex(),
    }
    frame.update(extra)
    return frame


def build_upload_frames(reader_frames, client_ip: str, client_port: int, ip: str, port: int):
    display: list[dict] = []
    packets: list[TcpPayload] = []
    for tid, (t0, t1, request, response) in enumerate(reader_frames, 1):
        request_tcp = wrap_mbap(request, tid)
        response_tcp = wrap_mbap(response, tid) if response else b""
        packets.append(TcpPayload(t0, "c2s", request_tcp))
        if response_tcp:
            packets.append(TcpPayload(t1, "s2c", response_tcp))

        function = request[2] if len(request) > 2 else -1
        record_index = struct.unpack_from("<H", request, 5)[0] \
            if function == 0x34 and len(request) >= 7 else None
        if function == 0x10:
            request_summary = "建立 UMAS 会话"
            response_summary = f"会话号 0x{response[3]:02X}" if len(response) > 3 else "无响应"
        elif function == 0x33:
            request_summary = "读取应用总长度"
            total = struct.unpack_from("<I", response, 5)[0] if len(response) >= 9 else 0
            response_summary = f"总长 {total:,} 字节"
        elif function == 0x34:
            request_summary = f"读取记录 {record_index}"
            length = struct.unpack_from("<H", response, 5)[0] if len(response) >= 7 else 0
            response_summary = f"记录 {record_index}，{length:,} 字节"
        elif function == 0x35:
            request_summary = "结束会话"
            response_summary = "结束确认"
        else:
            request_summary = f"UMAS 0x{function:02X}"
            response_summary = "响应"

        display.append(make_frame(
            len(display) + 1, t0, "request", "upload", "UMAS", f"0x{function:02X}",
            request_summary, request_tcp, recordIndex=record_index,
        ))
        if response_tcp:
            display.append(make_frame(
                len(display) + 1, t1, "response", "upload", "UMAS", f"0x{function:02X}",
                response_summary, response_tcp, recordIndex=record_index,
            ))
    session = TcpSession(client_ip, client_port, ip, port, packets)
    return display, session


def collect_modbus(
    ip: str,
    port: int,
    timeout: float,
    duration: float,
    interval: float,
    warnings: list[str],
    progress_cb,
):
    display: list[dict] = []
    packets: list[TcpPayload] = []
    points_map: dict[tuple[str, str], dict] = {}
    times: list[float] = []
    client_ip, client_port = "", 0
    cycles = 0
    started = time.time()

    try:
        with ModbusReader(ip, port, timeout) as reader:
            if reader.client_addr:
                client_ip, client_port = reader.client_addr
            while time.time() - started < duration:
                for category, function, function_name, label, area, start, end, chunk in MODBUS_RANGES:
                    offset = start
                    while offset < end and time.time() - started < duration:
                        quantity = min(chunk, end - offset)
                        try:
                            t0, t1, request, response = reader.read(function, offset, quantity)
                        except Exception as exc:  # noqa: BLE001 - 某段失败不应中断其它段
                            warnings.append(f"{label} {area}{offset} 采集失败：{exc}")
                            break
                        packets.append(TcpPayload(t0, "c2s", request))
                        packets.append(TcpPayload(t1, "s2c", response))
                        times.extend([t0, t1])
                        display.append(make_frame(
                            0, t0, "request", category, "Modbus/TCP", function_name,
                            f"{label} {area}{offset}–{offset + quantity - 1}（{quantity}）",
                            request, address=f"{area}{offset}", count=quantity,
                        ))

                        parsed = ModbusReader.parse(function, response)
                        values = parsed.get("words")
                        if values is None:
                            values = parsed.get("bits")
                        if values is not None:
                            values = values[:quantity]
                            for i, value in enumerate(values):
                                address = f"{area}{offset + i}"
                                points_map[(category, address)] = {
                                    "category": category,
                                    "area": area,
                                    "address": address,
                                    "value": value,
                                }
                            response_summary = f"{len(values)} 个值"
                        elif "exception" in parsed:
                            response_summary = f"异常码 {parsed['exception']}"
                        else:
                            response_summary = parsed.get("error", "无数据")

                        display.append(make_frame(
                            0, t1, "response", category, "Modbus/TCP", function_name,
                            response_summary, response, address=f"{area}{offset}",
                            count=quantity, values=values,
                        ))
                        offset += quantity
                cycles += 1
                elapsed = time.time() - started
                progress_cb(elapsed, duration, len(display), cycles)
                remaining = duration - elapsed
                if remaining <= 0:
                    break
                time.sleep(min(interval, remaining))
    except Exception as exc:  # noqa: BLE001 - 主动采集失败只降级，不影响上载
        warnings.append(f"运行/IO 流量采集失败：{exc}")

    for index, frame in enumerate(display, 1):
        frame["index"] = index
    session = TcpSession(client_ip, client_port, ip, port, packets) if packets else None
    return display, session, list(points_map.values()), times, cycles


def cmd_collect(args: argparse.Namespace) -> int:
    ip, port = args.ip, args.port
    try:
        if ipaddress.ip_address(ip).version != 4:
            return fail("PCAPNG 采集目前仅支持 IPv4 地址")
    except ValueError:
        return fail(f"IP 地址不合法：{ip}")

    warnings: list[str] = []
    progress("connect", 2, f"连接 {ip}:{port}")
    last = [0.0]

    def on_progress(got: int, total: int) -> None:
        now = time.time()
        if now - last[0] < 0.25 and got < total:
            return
        last[0] = now
        percent = 5 + (55 * got / total if total else 0)
        progress("upload", percent, f"已读取 {got:,} / {total:,} 字节")

    reader = RecordingReader(ip, port, timeout=args.timeout, hostname=args.hostname)
    try:
        with reader:
            session = reader.open_session()
            total = reader.read_total_size()
            if not total:
                return fail("PLC 没有返回控制程序大小，请确认目标是 M340 且 502 端口可用")
            progress("upload", 8, f"控制程序大小 {total:,} 字节")
            records: list[tuple[int, bytes]] = []
            got = 0
            index = 1
            while got < total and index <= MAX_RECORDS:
                data = reader.read_record(index)
                if not data:
                    break
                records.append((index, data))
                got += len(data)
                index += 1
                on_progress(got, total)
            reader.end_session(index - 1)
            upload = Upload(total, records, index - 1)
            upload.verify()
            local = reader.sock.getsockname() if reader.sock is not None else ("", 0)
    except ConnectionRefusedError:
        return fail(f"无法连接 {ip}:{port}（连接被拒绝），请确认 PLC 地址与端口")
    except socket.timeout:
        return fail(f"连接 {ip}:{port} 超时，请确认网络可达、目标机在测试网段内")
    except OSError as exc:
        return fail(f"无法连接 {ip}:{port}：{exc}")
    except UmasError as exc:
        return fail(f"控制程序提取失败：{exc}")
    except Exception as exc:  # noqa: BLE001
        return fail(f"控制程序提取失败：{type(exc).__name__}: {exc}")

    image = upload.image
    digest = hashlib.sha256(image).hexdigest()
    progress("upload", 60, f"上载完成：{len(records)} 条记录 / {len(image):,} 字节")

    upload_frames, upload_session = build_upload_frames(reader.frames, local[0], local[1], ip, port)
    duration = max(1.0, float(args.duration))
    interval = max(0.05, float(args.interval))
    progress("live", 64, f"采集运行 / IO 流量（{duration:g} 秒）")

    def live_progress(elapsed: float, total: float, frames: int, cycles: int) -> None:
        percent = 64 + (27 * min(1.0, elapsed / total)) if total else 90
        progress("live", percent, f"已采集 {elapsed:.1f} / {total:.0f} 秒 · {frames} 帧 · {cycles} 轮")

    modbus_frames, modbus_session, points, modbus_times, cycles = collect_modbus(
        ip, port, args.timeout, duration, interval, warnings, live_progress,
    )
    progress("pack", 93, "生成 PCAPNG 流量文件")

    frames = modbus_frames
    for index, frame in enumerate(frames, 1):
        frame["index"] = index

    upload_times = [stamp for pair in reader.frames for stamp in pair[:2]]
    all_times = upload_times + modbus_times
    duration_ms = int((max(all_times) - min(all_times)) * 1000) if all_times else 0

    def stats_for(items: list[dict]) -> dict:
        return {"frames": len(items), "bytes": sum(frame["bytes"] for frame in items)}

    stats = {
        "frames": len(frames),
        "bytes": sum(frame["bytes"] for frame in frames),
        "upload": stats_for(upload_frames),
        "runtime": stats_for([frame for frame in frames if frame["category"] == "runtime"]),
        "io": stats_for([frame for frame in frames if frame["category"] == "io"]),
        "samples": cycles,
        "duration_ms": duration_ms,
        "client_ip": local[0],
        "ranges": [
            {"category": category, "area": area, "start": start, "end": end}
            for category, _fc, _name, _label, area, start, end, _chunk in MODBUS_RANGES
        ],
    }

    run_dir = unique_run_dir(args.out_root, ip)
    tmp_dir = tempfile.mkdtemp(prefix=".tmp-", dir=args.out_root)
    try:
        os.makedirs(os.path.join(tmp_dir, "01_上载"), exist_ok=True)
        os.makedirs(os.path.join(tmp_dir, "流量"), exist_ok=True)
        with open(os.path.join(tmp_dir, "01_上载", "Station.apx"), "wb") as fh:
            fh.write(image)
        traffic_file = os.path.join(tmp_dir, "流量", "采集流量.pcapng")
        sessions = [session_ for session_ in (upload_session, modbus_session) if session_ is not None]
        packet_count = write_pcapng(traffic_file, sessions)
        with open(os.path.join(tmp_dir, "流量", "frames.json"), "w", encoding="utf-8") as fh:
            json.dump({"frames": frames, "points": points, "stats": stats}, fh, ensure_ascii=False)

        manifest = {
            "plc": ip,
            "port": port,
            "time": time.strftime("%Y-%m-%d %H:%M:%S"),
            "session": f"0x{session:02X}",
            "image_bytes": len(image),
            "records": len(records),
            "sha256": digest,
            "parsed": False,
            "traffic": {
                "file": "流量/采集流量.pcapng",
                "packets": packet_count,
                **stats,
            },
            "files": ["Station.apx", "采集流量.pcapng", "frames.json"],
        }
        with open(os.path.join(tmp_dir, "manifest.json"), "w", encoding="utf-8") as fh:
            json.dump(manifest, fh, ensure_ascii=False, indent=2)

        replace_dir(tmp_dir, run_dir)
    except Exception as exc:  # noqa: BLE001 - 失败不留半成品
        shutil.rmtree(tmp_dir, ignore_errors=True)
        return fail(f"保存流量失败：{exc}")

    for warning in warnings:
        emit({"type": "warning", "message": warning})

    progress("done", 100, f"流量采集完成：{len(frames)} 帧（运行 / IO）")
    emit({
        "type": "result",
        "runDir": run_dir,
        "name": os.path.basename(run_dir),
        "parsed": False,
        "plc": ip,
        "port": port,
        "session": f"0x{session:02X}",
        "imageBytes": len(image),
        "records": len(records),
        "sha256": digest,
        "declarations": False,
        "stu": None,
        "units": [],
        "traffic": {
            "file": os.path.join(run_dir, "流量", "采集流量.pcapng"),
            "frames": frames,
            "points": points,
            "stats": stats,
        },
        "warnings": warnings,
    })
    return 0


def cmd_parse(args: argparse.Namespace) -> int:
    run_dir = args.run_dir
    manifest_path = os.path.join(run_dir, "manifest.json")
    try:
        with open(manifest_path, encoding="utf-8") as fh:
            manifest = json.load(fh)
    except Exception as exc:  # noqa: BLE001
        return fail(f"读取运行记录失败：{exc}")

    image_path = os.path.join(run_dir, "01_上载", "Station.apx")
    try:
        with open(image_path, "rb") as fh:
            image = fh.read()
    except Exception as exc:  # noqa: BLE001
        return fail(f"运行目录里没有应用镜像，请先采集流量：{exc}")

    progress("parse", 30, "离线解析应用镜像")
    try:
        sources = stsource.extract(image)
    except Exception as exc:  # noqa: BLE001
        return fail(f"逆向解析失败：{exc}")
    if not sources:
        return fail("镜像里没有找到 ST 源码，请确认 PLC 里已下载用户程序")

    out_dir = os.path.join(run_dir, "02_逆向")
    os.makedirs(out_dir, exist_ok=True)
    for name in os.listdir(out_dir):
        if name.endswith(".st"):
            os.remove(os.path.join(out_dir, name))
    written = stsource.write_all(sources, out_dir)

    units = []
    for index, source in enumerate(sources, 1):
        program = bool(PROGRAM_HINT.search(source.text))
        units.append({
            "index": index,
            "name": f"单元 {source.stream_offset:05X}",
            "kind": "程序段" if program else "功能块",
            "chars": len(source.text),
            "status": "解析成功",
            "declared": False,
            "streamOffset": f"0x{source.stream_offset:05X}",
            "text": source.text,
        })

    manifest["parsed"] = True
    manifest["parse_time"] = time.strftime("%Y-%m-%d %H:%M:%S")
    manifest["units"] = [
        {"name": unit["name"], "kind": unit["kind"], "chars": unit["chars"], "declared": False}
        for unit in units
    ]
    files = list(manifest.get("files") or [])
    for path in written:
        name = os.path.basename(path)
        if name not in files:
            files.append(name)
    manifest["files"] = files
    manifest_path_tmp = manifest_path + ".tmp"
    try:
        with open(manifest_path_tmp, "w", encoding="utf-8") as fh:
            json.dump(manifest, fh, ensure_ascii=False, indent=2)
        os.replace(manifest_path_tmp, manifest_path)
    except Exception as exc:  # noqa: BLE001
        return fail(f"更新运行记录失败：{exc}")

    progress("done", 100, f"解析完成：{len(units)} 个单元")
    emit({
        "type": "result",
        "runDir": run_dir,
        "name": os.path.basename(run_dir),
        "parsed": True,
        "plc": manifest.get("plc", ""),
        "port": manifest.get("port", 502),
        "session": manifest.get("session", ""),
        "imageBytes": manifest.get("image_bytes", len(image)),
        "records": manifest.get("records", 0),
        "sha256": manifest.get("sha256", ""),
        "units": units,
    })
    return 0


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
            "parsed": True,
            "files": [os.path.basename(p) for p in written],
            "units": [
                {"name": u["name"], "kind": u["kind"], "chars": u["chars"], "declared": u["declared"]}
                for u in units
            ],
        }
        with open(os.path.join(tmp_dir, "manifest.json"), "w", encoding="utf-8") as fh:
            json.dump(manifest, fh, ensure_ascii=False, indent=2)

        replace_dir(tmp_dir, run_dir)
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

    collect = sub.add_parser("collect", help="采集上载、运行与 IO 流量并保存 PCAPNG")
    collect.add_argument("--ip", required=True)
    collect.add_argument("--port", type=int, default=502)
    collect.add_argument("--timeout", type=float, default=10.0)
    collect.add_argument("--hostname", default="PLC-READER")
    collect.add_argument("--out-root", required=True)
    collect.add_argument("--duration", type=float, default=10.0, help="运行/IO 采集时长（秒）")
    collect.add_argument("--interval", type=float, default=0.5, help="两轮采样之间的间隔（秒）")
    collect.set_defaults(func=cmd_collect)

    parse = sub.add_parser("parse", help="离线解析已采集的应用镜像")
    parse.add_argument("--run-dir", required=True)
    parse.set_defaults(func=cmd_parse)

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
