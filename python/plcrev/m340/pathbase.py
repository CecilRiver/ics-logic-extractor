"""从 IDE 的 PathBase.db 里取回 DFB 的接口声明。

PathBase.db 是 SQL Anywhere 数据库（不在 PLC 上，只存在于 .stu 里），
但 DFB 的变量声明在页内以明文存放，可以直接按结构扫出来，不需要装驱动。

一条声明记录（已核对）：

    <kind:u16LE> <name>\\0 <type>\\0

``kind`` 紧贴在名字前面：

    1 = VAR_INPUT
    3 = VAR_OUTPUT
    5 = VAR（内部变量）

一个 DFB 块的起点是 ``00 00 00 00`` + ``FB_<名字>\\0``。
块内变量按出现顺序即为声明顺序。
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

KIND_NAMES = {1: "VAR_INPUT", 3: "VAR_OUTPUT", 5: "VAR"}

BLOCK_RE = re.compile(rb"\x00\x00\x00\x00(FB_[A-Za-z0-9_]{2,40})\x00")
VAR_RE = re.compile(rb"([A-Za-z_][A-Za-z0-9_]{0,39})\x00([A-Za-z_][A-Za-z0-9_]{0,39})\x00")
ID_RE = re.compile(rb"ID\d{3,6}\x00")


@dataclass
class Var:
    section: str
    name: str
    type: str


@dataclass
class Block:
    name: str | None          # 有些工程的 DFB 名字不落在本库里，会是 None
    offset: int
    vars: list[Var] = field(default_factory=list)

    def section(self, which: str) -> list[Var]:
        return [v for v in self.vars if v.section == which]

    def render(self, body: str = "", name: str | None = None) -> str:
        """拼成 ST 源码：声明 + 代码体。"""
        label = name or self.name or "UNNAMED"
        lines = [f"FUNCTION_BLOCK {label}"]
        for which in ("VAR_INPUT", "VAR_OUTPUT", "VAR"):
            items = self.section(which)
            if not items:
                continue
            lines.append(which)
            lines.extend(f"    {v.name} : {v.type};" for v in items)
            lines.append("END_VAR")
        if body:
            lines.append("")
            lines.append(body.strip())
        lines.append("END_FUNCTION_BLOCK")
        return "\n".join(lines) + "\n"


def _blocks_from(data: bytes) -> list[tuple[str, int, int]]:
    starts = [(m.group(1).decode("ascii"), m.start(), 0) for m in BLOCK_RE.finditer(data)]
    out = []
    for i, (name, start, _) in enumerate(starts):
        end = starts[i + 1][1] if i + 1 < len(starts) else len(data)
        out.append((name, start, end))
    return out


def _var_span(db: bytes, start: int, end: int) -> tuple[int, int]:
    """缩窄到"本块"的变量区。

    每个块头后面跟一个 ``ID####`` 标记，下一个 ``ID####`` 就是下一块的开头。
    没有 ID 标记时退回原来的区间。
    """
    ids = [m.start() for m in ID_RE.finditer(db, start, end)]
    if not ids:
        return start, end
    return ids[0], (ids[1] if len(ids) > 1 else end)


def scan(db: bytes) -> list[Block]:
    """扫描整库，返回所有声明块。

    块的锚点是 ``ID####`` 标记，不是 ``FB_名字``——实测有些工程（2026-11-17 的
    三台版）里 DFB 名字并不落在本库中，但声明照常存在。名字只在"前一块的 ID
    与本次 ID 之间恰好出现一个 ``FB_名字``"时才采用，否则记为 None。
    """
    headers = [(m.group(1).decode("ascii"), m.start()) for m in BLOCK_RE.finditer(db)]
    ids = [m.start() for m in ID_RE.finditer(db)]

    blocks: list[Block] = []
    for i, pos in enumerate(ids):
        end = ids[i + 1] if i + 1 < len(ids) else len(db)
        prev_id = ids[i - 1] if i > 0 else -1

        candidates = [h for h in headers if prev_id < h[1] < pos]
        name = max(candidates, key=lambda h: h[1])[0] if candidates else None

        block = Block(name, pos)
        seen = set()
        for m in VAR_RE.finditer(db, pos, end):
            name_pos = m.start()
            if name_pos < 2:
                continue
            kind = int.from_bytes(db[name_pos - 2:name_pos], "little")
            if kind not in KIND_NAMES:
                continue
            var = m.group(1).decode("ascii")
            typ = m.group(2).decode("ascii")
            if (var, typ) in seen:
                continue
            seen.add((var, typ))
            block.vars.append(Var(KIND_NAMES[kind], var, typ))

        if block.vars:
            blocks.append(block)
    return blocks


def load_from_stu(stu_path: str, entry: str = "PathBase.db") -> bytes:
    import zipfile

    with zipfile.ZipFile(stu_path) as zf:
        return zf.read(entry)


def find(blocks: list[Block], name: str) -> Block | None:
    for b in blocks:
        if b.name == name:
            return b
    return None
