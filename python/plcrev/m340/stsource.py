"""从 Station.apx 里取回 ST 源码。

这是本项目最重要的发现：编译后的应用镜像里，**DFB 的 ST 原文仍然存在**，
以 Control Expert 的 ``STExchangeFile`` 格式嵌在 zlib 流里：

    <?xml version="1.0" standalone="yes"?>
    <STExchangeFile>
      <STSource>(* 注释 *)\\nRateLimiter(...)  ...  </STSource>
      <D1 c14="e"><D0 k="8" O0="0"/><D0 k="4010" O0="38" .../></D1>
    </STExchangeFile>

``STSource`` 是纯文本（XML 转义过），``D0`` 节点是编辑器用来把文本映射回
图形/表格的索引，对只想要逻辑的人没有用。

注意：这里拿到的是**代码体**，不含 VAR_INPUT / VAR_OUTPUT 声明——
声明在另一处，尚未定位。
"""

from __future__ import annotations

import html
import re
from dataclasses import dataclass

from . import packed

SRC_RE = re.compile(rb"<STSource>(.*?)</STSource>", re.S)
NODE_RE = re.compile(rb"<D0\b")


@dataclass
class Source:
    stream_offset: int
    text: str
    nodes: int
    fmt: str = "xml"     # "xml" = <STSource>...</STSource>；"tagged" = 标签树后直接跟文本

    @property
    def first_line(self) -> str:
        for line in self.text.splitlines():
            line = line.strip()
            if line and not line.startswith("(*"):
                return line[:60]
        return "(空)"

    @property
    def looks_like_st(self) -> bool:
        return ":=" in self.text or "IF" in self.text or "(" in self.text


def _read_text_run(data: bytes, pos: int, limit: int = 65536) -> str:
    """从 pos 开始读连续的可打印文本（允许 UTF-8 多字节与 CR/LF/TAB）。

    遇到真正的控制字节就停——标签树里的长度前缀（0x01/0x02…）正好充当终止符。
    """
    end = pos
    stop = min(len(data), pos + limit)
    while end < stop:
        b = data[end]
        if b in (0x09, 0x0A, 0x0D) or 0x20 <= b < 0x7F:
            end += 1
            continue
        if b >= 0x80:
            # 只接受合法的 UTF-8 多字节序列
            for size in (2, 3, 4):
                chunk = data[end:end + size]
                if len(chunk) == size:
                    try:
                        chunk.decode("utf-8")
                        end += size
                        break
                    except UnicodeDecodeError:
                        continue
            else:
                break
            continue
        break
    return data[pos:end].decode("utf-8", "replace")


def _tagged_text(data: bytes) -> str | None:
    """第二种序列化：标签树 + XML 声明 + 裸文本。

    这种格式里没有 ``<STSource>`` 尖括号，文本紧跟在 XML 声明之后。
    """
    i = data.find(b"<?xml")
    if i < 0:
        return None
    j = data.find(b"?>", i)
    if j < 0:
        return None

    # 声明和正文之间夹 1~4 字节的长度前缀，跳过它们逐个试探
    for skip in range(0, 5):
        text = _read_text_run(data, j + 2 + skip)
        if len(text) >= 16:
            return html.unescape(text).replace("\r\n", "\n")
    return None


def extract(image: bytes) -> list[Source]:
    """扫描镜像内所有 zlib 流，取出其中的 ST 源码（两种序列化都支持）。"""
    out: list[Source] = []
    for st in packed.find_streams(image):
        if b"STExchangeFile" not in st.data:
            continue

        xml_hits = list(SRC_RE.finditer(st.data))
        if xml_hits:
            nodes = len(NODE_RE.findall(st.data))
            for m in xml_hits:
                raw = m.group(1).decode("utf-8", "replace")
                text = html.unescape(raw).replace("\r\n", "\n")
                out.append(Source(st.offset, text, nodes, "xml"))
            continue

        text = _tagged_text(st.data)
        if text:
            out.append(Source(st.offset, text, 0, "tagged"))
    return out


def write_all(sources: list[Source], outdir: str) -> list[str]:
    import os

    os.makedirs(outdir, exist_ok=True)
    paths = []
    for i, src in enumerate(sources, 1):
        path = os.path.join(outdir, f"st_{i:02d}_0x{src.stream_offset:05X}.st")
        with open(path, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(src.text)
        paths.append(path)
    return paths
