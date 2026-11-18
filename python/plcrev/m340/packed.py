"""镜像内的 zlib 流提取。

Station.apx 里约有 10% 的字节是高熵区。实测这些高熵区**不是**压缩后的代码，
而是完整、自终止的 zlib 流，解出来主要是 XML（工程定义、设置）和一小组
带私有魔数的二进制描述符。

因此："压缩段里藏着代码"这个假设是错的。代码就在明文 ARM 段里。
"""

from __future__ import annotations

import zlib
from dataclasses import dataclass

ZHDR = (0x01, 0x5E, 0x9C, 0xDA)   # 78 01 / 78 5E / 78 9C / 78 DA
MIN_OUT = 64                      # 太短的多半是误命中


@dataclass
class Stream:
    offset: int          # 在镜像中的起始位置
    compressed: int      # 消耗的压缩字节数
    data: bytes          # 解压结果

    @property
    def kind(self) -> str:
        if self.data.startswith(b"<?xml"):
            return "xml"
        if self.data[:4] == b"\xe5\xe3\xd2\x9e":
            return "descriptor"
        return "binary"

    def summary(self) -> str:
        sig = self.data[:20]
        try:
            text = sig.decode("ascii")
        except UnicodeDecodeError:
            text = sig.hex()
        text = "".join(c if 32 <= ord(c) < 127 else "." for c in text)
        return (f"0x{self.offset:05X}  in={self.compressed:6d}  "
                f"out={len(self.data):6d}  {self.kind:<10}  {text}")


def find_streams(image: bytes) -> list[Stream]:
    """扫描并解出所有完整的 zlib 流，按位置排序。

    只接受 ``zlib.decompressobj`` 报出 EOF 的流——不完整的流在损坏样本上
    会产出垃圾，宁可漏掉也不要误报。
    """
    found: list[Stream] = []
    i = 0
    n = len(image)
    while i < n - 2:
        if image[i] == 0x78 and image[i + 1] in ZHDR:
            try:
                dec = zlib.decompressobj()
                out = dec.decompress(image[i:])
            except zlib.error:
                i += 1
                continue
            if dec.eof and len(out) >= MIN_OUT:
                consumed = (n - i) - len(dec.unused_data)
                found.append(Stream(i, consumed, out))
                i += consumed
                continue
        i += 1
    return found


def write_all(streams: list[Stream], outdir: str) -> list[str]:
    """把每个流写成独立文件，返回写出的路径列表。"""
    import os

    os.makedirs(outdir, exist_ok=True)
    paths = []
    for st in streams:
        ext = {"xml": "xml", "descriptor": "desc.bin"}.get(st.kind, "bin")
        name = f"0x{st.offset:05X}.{ext}"
        path = os.path.join(outdir, name)
        with open(path, "wb") as fh:
            fh.write(st.data)
        paths.append(path)
    return paths
