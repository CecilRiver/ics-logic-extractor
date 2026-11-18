"""把两半拼成完整 POU。

    Station.apx     →  FB 的代码体（ST 原文，见 stsource）
    PathBase.db     →  FB 的接口声明（见 pathbase）

两边都没有名字直接关联，所以靠**变量名匹配**配对：某段代码体里出现的
该块变量越多，就越可能是同一块。匹配结果会校验唯一性，不唯一就报错，
不猜。
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from . import pathbase, stsource
from .apx import Apx

MIN_SCORE = 0.5          # 至少一半的声明变量要在代码体里出现
MIN_MARGIN = 0.15        # 最佳与次佳的分差，低于此判为不确定

# 出现绝对地址（%M/%MW/%S/%Q/%I）的代码体是程序段，不是功能块。
# 程序段的变量声明不在 PathBase.db 里，硬配对只会配上别人的声明。
PROGRAM_HINT = re.compile(r"%[QIM]\d|%S\d")


class MatchError(Exception):
    pass


@dataclass
class Pou:
    name: str
    declarations: pathbase.Block
    body: str
    score: float
    name_inferred: bool = False
    program: bool = False

    @property
    def text(self) -> str:
        if self.program:
            return (
                f"(* ===== 程序段 0x{self.declarations.offset if self.declarations else 0:06X} =====\n"
                f"   名称与变量声明尚未定位，以下是从 Station.apx 取回的完整代码体。 *)\n\n"
                f"{self.body.strip()}\n"
            )
        return self.declarations.render(self.body, self.name)


def _score(block: pathbase.Block, body: str) -> float:
    if not block.vars:
        return 0.0
    words = set(re.findall(r"[A-Za-z_][A-Za-z0-9_]*", body))
    hits = sum(1 for v in block.vars if v.name in words)
    return hits / len(block.vars)


def match(blocks: list[pathbase.Block], bodies: list[stsource.Source]) -> list[Pou]:
    """把每个代码体分配给最匹配的声明块。"""
    out: list[Pou] = []
    for src in bodies:
        if PROGRAM_HINT.search(src.text):
            out.append(Pou(f"程序段_0x{src.stream_offset:05X}", None, src.text, 0.0, program=True))
            continue

        scores = sorted(((_score(b, src.text), b) for b in blocks), key=lambda x: -x[0])
        if not scores:
            raise MatchError("没有任何声明块")
        best_score, best = scores[0]
        runner_up = scores[1][0] if len(scores) > 1 else 0.0

        if best_score < MIN_SCORE:
            raise MatchError(
                f"流 0x{src.stream_offset:05X} 的代码体与所有声明的匹配度都低于 {MIN_SCORE:.0%}"
                f"（最高 {best_score:.0%}，候选 {best.name}）"
            )
        if best_score - runner_up < MIN_MARGIN:
            second = scores[1][1].name or f"块@0x{scores[1][1].offset:06X}"
            raise MatchError(
                f"流 0x{src.stream_offset:05X} 匹配不确定："
                f"{best.name or '未命名块'} {best_score:.0%} 与 {second} {runner_up:.0%} 太接近"
            )
        out.append(Pou(best.name or "", best, src.text, best_score))

    _infer_names(out)
    return out


def _infer_names(pous: list[Pou]) -> None:
    """有的工程里 DFB 名字不落在 PathBase.db，只能从调用方推断。

    ``FB_FuelController`` 的内部变量声明了 ``OutputFilter : FB_Hfop``，
    于是"被引用但还没分配"的类型就只剩 FB_Hfop——正好补上那个无名块。
    只有在"剩余类型数 == 未命名块数 == 1"时才敢这么补，否则留空。
    """
    blocks = [p for p in pous if p.declarations is not None]
    assigned = {p.name for p in blocks if p.name}
    referenced = {
        v.type
        for p in blocks
        for v in p.declarations.vars
        if v.type.startswith("FB_")
    }
    missing = referenced - assigned
    unnamed = [p for p in blocks if not p.name]

    if len(missing) == 1 and len(unnamed) == 1:
        unnamed[0].name = missing.pop()
        unnamed[0].name_inferred = True
    else:
        for p in unnamed:
            p.name = f"未命名块_0x{p.declarations.offset:06X}"


def rebuild(stu_path: str) -> list[Pou]:
    """从一个 .stu 里重建所有能配上的 POU。"""
    apx = Apx.from_file(stu_path)
    db = pathbase.load_from_stu(stu_path)
    return match(pathbase.scan(db), stsource.extract(apx.image))


def write_all(pous: list[Pou], outdir: str) -> list[str]:
    import os

    os.makedirs(outdir, exist_ok=True)
    paths = []
    for p in pous:
        path = os.path.join(outdir, f"{p.name}.st")
        with open(path, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(p.text)
        paths.append(path)
    return paths
