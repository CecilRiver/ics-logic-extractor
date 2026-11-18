"""关键变量与值域推断。

输入是 ST 源码（可能带声明）和可选的 PathBase 声明，输出一张变量表。
值域按以下优先级推断，并在 ``basis`` 里如实标注来源：

    1. 源码里的比较 / 赋值常量
    2. 声明里的初值
    3. 数据类型固有范围
    4. 都推算不出 → 未定

没有声明时不会整表消失：退化为从源码里收集被赋值或被比较的标识符，
类型记 ``未知``、依据记 ``源码标识符（无声明）``。
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

SECTION_CATEGORY = {
    "VAR_INPUT": "输入",
    "VAR_OUTPUT": "输出",
    "VAR_IN_OUT": "输入输出",
    "VAR_TEMP": "临时",
    "VAR_GLOBAL": "全局",
    "VAR_EXTERNAL": "外部",
    "VAR": "内部",
    "": "未声明",
}

TYPE_RANGES = {
    "BOOL": "0 / 1",
    "SINT": "-128 ~ 127",
    "INT": "-32768 ~ 32767",
    "DINT": "-2147483648 ~ 2147483647",
    "USINT": "0 ~ 255",
    "UINT": "0 ~ 65535",
    "UDINT": "0 ~ 4294967295",
    "WORD": "0 ~ 65535",
    "DWORD": "0 ~ 4294967295",
    "BYTE": "0 ~ 255",
    "REAL": "±3.402823E38",
    "LREAL": "±1.797693E308",
    "TIME": "0 ~ 24d20h31m23s647ms",
    "DATE": "日期型（无固定上下限）",
    "TOD": "00:00:00 ~ 23:59:59.999",
}

KEYWORDS = {
    "IF", "THEN", "ELSIF", "ELSE", "END_IF", "FOR", "TO", "BY", "DO",
    "END_FOR", "WHILE", "END_WHILE", "REPEAT", "UNTIL", "END_REPEAT",
    "CASE", "END_CASE", "RETURN", "EXIT", "NOT", "AND", "OR", "XOR",
    "MOD", "TRUE", "FALSE", "ABS", "MIN", "MAX", "LIMIT", "SEL", "MUX",
    "SHL", "SHR", "ROL", "ROR", "SQRT", "LN", "LOG", "EXP", "SIN", "COS",
    "TAN", "ASIN", "ACOS", "ATAN", "ADD", "SUB", "MUL", "DIV", "GT", "GE",
    "EQ", "LT", "LE", "NE", "FUNCTION_BLOCK", "PROGRAM", "END_FUNCTION_BLOCK",
    "END_PROGRAM", "VAR", "END_VAR", "TYPE", "END_TYPE", "STRUCT",
    "END_STRUCT", "FUNCTION", "END_FUNCTION",
}

NUM = r"[-+]?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][-+]?\d+)?"

DECL_BLOCK = re.compile(
    r"\b(VAR_INPUT|VAR_OUTPUT|VAR_IN_OUT|VAR_TEMP|VAR_GLOBAL|VAR_EXTERNAL|VAR)\b"
    r"(.*?)\bEND_VAR\b",
    re.S | re.I,
)
DECL_LINE = re.compile(
    r"^\s*([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s*:\s*([^;:=]+?)"
    r"(?:\s*:=\s*([^;]+?))?\s*;",
    re.M,
)


@dataclass
class VarDecl:
    name: str
    type: str
    section: str = ""
    init: str = ""


@dataclass
class Unit:
    """一��可分析的 ST 单元。``declarations`` 为空时从 ``text`` 自行解析。"""

    name: str
    text: str
    declarations: list[VarDecl] = field(default_factory=list)


def _clean(text: str) -> str:
    """去掉注释与字符串内容，保留换行，便于按行取常量。"""
    out: list[str] = []
    i = 0
    depth = 0
    in_string = False
    n = len(text)
    while i < n:
        ch = text[i]
        if depth:
            if text.startswith("(*", i) or text.startswith("/*", i):
                depth += 1
                out.append("  ")
                i += 2
            elif text.startswith("*)", i) or text.startswith("*/", i):
                depth -= 1
                out.append("  ")
                i += 2
            else:
                out.append("\n" if ch == "\n" else " ")
                i += 1
            continue
        if in_string:
            if ch == "'":
                in_string = False
                out.append("'")
            else:
                out.append("\n" if ch == "\n" else " ")
            i += 1
            continue
        if text.startswith("(*", i) or text.startswith("/*", i):
            depth = 1
            out.append("  ")
            i += 2
        elif text.startswith("//", i):
            j = text.find("\n", i)
            if j < 0:
                out.append(" " * (n - i))
                i = n
            else:
                out.append(" " * (j - i))
                i = j
        elif ch == "'":
            in_string = True
            out.append("'")
            i += 1
        else:
            out.append(ch)
            i += 1
    return "".join(out)


def parse_declarations(text: str) -> list[VarDecl] | None:
    """解析 ST 文本里的 VAR 段；没有声明时返回 None。"""
    clean = _clean(text)
    found: list[VarDecl] = []
    seen: set[tuple[str, str, str]] = set()
    for block in DECL_BLOCK.finditer(clean):
        section = block.group(1).upper()
        for line in DECL_LINE.finditer(block.group(2)):
            names = [part.strip() for part in line.group(1).split(",")]
            typ = line.group(2).strip()
            init = (line.group(3) or "").strip()
            for name in names:
                key = (name, typ, section)
                if key in seen:
                    continue
                seen.add(key)
                found.append(VarDecl(name, typ, section, init))
    return found or None


def normalize_type(type_name: str) -> str:
    base = re.sub(r"\(.*?\)", "", type_name).strip().upper()
    if base.startswith("ARRAY"):
        return "ARRAY"
    return base.split()[0] if base else ""


def type_range(type_name: str) -> str:
    return TYPE_RANGES.get(normalize_type(type_name), "")


def _search(pattern: str, text: str) -> list[str]:
    return [m.group(1) for m in re.finditer(pattern, text, re.I | re.M)]


def _constants(name: str, text: str, is_bool: bool) -> tuple[list[str], list[str], list[str]]:
    """返回 (比较常量, 赋值常量, 同行相关常量)。

    BOOL 变量不取数字常量：``Alarm := Deviation > 43.0`` 里的 43.0
    属于被比较的量，不是 Alarm 自己的值域。
    """
    if is_bool:
        return [], [], []
    var = re.escape(name)
    clean = _clean(text)

    cmp_after = _search(
        rf"(?<![\w.]){var}\b\s*(?:<=|>=|<>|<|>|=)\s*({NUM})", clean
    )
    cmp_before = _search(
        rf"({NUM})\s*(?:<=|>=|<>|<|>|=)\s*{var}\b", clean
    )
    compares = cmp_after + cmp_before

    assigns = _search(
        rf"(?<![\w.]){var}\b\s*:=\s*({NUM})\s*(?=;|$)", clean
    )

    related: list[str] = []
    occurrences = re.compile(rf"(?<![\w.]){var}\b", re.I)
    number = re.compile(rf"(?<![\w.]){NUM}(?![\w.])")
    for line in clean.splitlines():
        if not occurrences.search(line):
            continue
        for hit in number.finditer(line):
            value = hit.group(0)
            if value not in related:
                related.append(value)

    return _unique(compares), _unique(assigns), _unique(related)


def _unique(values: list[str]) -> list[str]:
    out: list[str] = []
    for value in values:
        if value not in out:
            out.append(value)
    return out


def _line_with(text: str, name: str, needles: list[str] | None = None) -> str:
    """给依据列找一条有代表性的原文行；优先包含推断所用的常量。

    先跳过 ``Name : TYPE;`` 这样的声明行，避免依据写成声明本身。
    """
    pattern = re.compile(rf"(?<![\w.]){re.escape(name)}\b", re.I)
    declaration = re.compile(rf"^\s*{re.escape(name)}\s*:\s*(?!=)", re.I)
    fallback = ""
    for line in _clean(text).splitlines():
        stripped = line.strip()
        if not stripped or declaration.match(stripped) or not pattern.search(stripped):
            continue
        compact = " ".join(stripped.split())
        if needles and any(needle in compact for needle in needles):
            return compact[:80]
        if not fallback:
            fallback = compact
    return fallback[:80]


def _row(name: str, type_name: str, section: str, init: str, text: str) -> dict:
    base = normalize_type(type_name)
    is_bool = base == "BOOL"
    compares, assigns, related = _constants(name, text, is_bool)

    if compares:
        sample = _line_with(text, name, compares)
        value_range = "比较常量 " + "、".join(compares)
        basis = f"源码比较常量：{sample}" if sample else "源码比较常量"
    elif assigns:
        sample = _line_with(text, name, assigns)
        value_range = "赋值常量 " + "、".join(assigns)
        basis = f"源码赋值常量：{sample}" if sample else "源码赋值常量"
    elif init:
        value_range = f"初值 {init}"
        basis = f"声明初值：{name} : {type_name} := {init}"
    elif related:
        sample = _line_with(text, name, related)
        value_range = "相关常量 " + "、".join(related)
        basis = f"源码相关常量：{sample}" if sample else "源码相关常量"
    elif type_range(type_name):
        value_range = type_range(type_name)
        basis = f"数据类型固有范围（{base}）"
    else:
        value_range = "未定"
        basis = "无法从源码推断"

    return {
        "name": name,
        "type": type_name or "未知",
        "category": SECTION_CATEGORY.get(section, "内部"),
        "range": value_range,
        "basis": basis,
    }


def _looks_like_call_arg(clean: str, start: int) -> bool:
    """``RateLimit := 10.0`` 在调用参数列表里，不是本块的赋值语句。"""
    i = start - 1
    while i >= 0 and clean[i].isspace():
        i -= 1
    return i >= 0 and clean[i] in "(,"


def _fallback_declarations(text: str) -> list[VarDecl]:
    clean = _clean(text)
    names: list[str] = []
    for match in re.finditer(r"(?<![\w.])([A-Za-z_]\w*)\s*:=", clean):
        name = match.group(1)
        if name.upper() in KEYWORDS or name.startswith(("FB_", "PRG_")):
            continue
        if _looks_like_call_arg(clean, match.start()):
            continue
        if name not in names:
            names.append(name)
    return [VarDecl(name, "", "") for name in names]


def extract(units: list[Unit]) -> list[dict]:
    """把多个 ST 单元展开成一张扁平的变量表。"""
    rows: list[dict] = []
    for unit in units:
        declarations = unit.declarations or parse_declarations(unit.text)
        if not declarations:
            declarations = _fallback_declarations(unit.text)
            section = ""
        else:
            section = None  # 用每个声明自己的 section
        seen: set[tuple[str, str, str]] = set()
        for decl in declarations:
            key = (decl.name, decl.type, decl.section)
            if key in seen:
                continue
            seen.add(key)
            row = _row(decl.name, decl.type, decl.section if section is None else section, decl.init, unit.text)
            row["unit"] = unit.name
            rows.append(row)
    return rows
