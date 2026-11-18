"""Station.apx —— M340 编译后应用镜像。

已知结构（由抓包逐字节验证）：

    记录 1    "APX\\0" + 头部
    记录 2    "SD\\0\\0" + 描述符
    记录 3..  [tag:u8][payload]

抓包证明：把 52 条 0x34 记录按索引拼起来，与 Control Expert 保存出来的
``BinAppli/Station.apx`` SHA-256 完全相同（样本 49,080 字节）。

**关键限制**：记录边界只存在于传输层（每次 0x34 请求对应一条记录），
.apx 文件本身没有自描述的长度字段。因此 from_file() 只能给出整块镜像，
不能还原记录划分；需要记录级信息时走 from_capture()。
"""

from __future__ import annotations

import hashlib
import struct
import zipfile
from dataclasses import dataclass

MAGIC = b"APX\x00"
DESCRIPTOR_MAGIC = b"SD\x00\x00"

# .STU 是 ZIP 容器，应用镜像在下面这个路径
STU_ENTRY = "BinAppli/Station.apx"


@dataclass
class Apx:
    image: bytes
    records: list[tuple[int, bytes]] | None = None

    @property
    def size(self) -> int:
        return len(self.image)

    @property
    def sha256(self) -> str:
        return hashlib.sha256(self.image).hexdigest()

    @classmethod
    def from_capture(cls, csv_path: str) -> "Apx":
        """从抓包重组，带记录划分。"""
        from .umas import reassemble

        upload = reassemble(csv_path)
        return cls(upload.image, upload.records)

    @classmethod
    def from_file(cls, path: str) -> "Apx":
        """直接读 .apx 或包含它的 .stu/.STU。"""
        with open(path, "rb") as fh:
            head = fh.read(4)

        if head == b"PK\x03\x04":
            with zipfile.ZipFile(path) as zf:
                if STU_ENTRY not in zf.namelist():
                    raise ValueError(f"{path} 里没有 {STU_ENTRY}")
                data = zf.read(STU_ENTRY)
        else:
            with open(path, "rb") as fh:
                data = fh.read()
        return cls(data)

    def check_magic(self) -> bool:
        return self.image.startswith(MAGIC)

    def record_tags(self) -> dict[int, int]:
        """统计 [tag:u8] 的取值分布。tag 语义尚未确定，先只看分布。"""
        if self.records is None:
            raise ValueError("没有记录划分（请用 from_capture）")
        counts: dict[int, int] = {}
        for _, body in self.records:
            if body:
                counts[body[0]] = counts.get(body[0], 0) + 1
        return dict(sorted(counts.items()))

    def header_words(self) -> list[tuple[int, int]]:
        """把前 64 字节按 LE32 列出来，便于人工比对结构。"""
        raw = self.image[:64]
        return [(i, struct.unpack_from("<I", raw, i)[0]) for i in range(0, len(raw) - 3, 4)]
