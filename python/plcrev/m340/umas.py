"""UMAS（Schneider 0x5A）上载报文解析。

只覆盖"从 PLC 上载应用"这条只读路径用到的最小报文集合：

    0x33    返回应用总长度
    0x34    按索引读取一条记录
    0x35    结束标记

数据来源是 parse_pktmon_umas.py 导出的 CSV。**注意 CSV 的
umas_data_hex 列对短帧是空的**（214 个 Tx、202 个 Rx 遇到过），
因此本模块一律从 pdu_hex 重新解析，不碰 umas_data_hex。

响应头长度按子功能不同，不能统一处理：

    0x20   5a sess fe  ?  len:u16LE   data        （6 字节头）
    0x34   5a sess fe  ?  ?  len:u16LE  data       （7 字节头）
    0x33   5a sess fe  ?  ?  size:u16LE            （无内联数据）
"""

from __future__ import annotations

import csv
import struct
from dataclasses import dataclass

FUNC_UMAS = 0x5A

SF_APP_SIZE = 0x33
SF_READ_RECORD = 0x34
SF_END = 0x35
SF_READ_STREAM = 0x20

# 响应头长度（字节），data 从这里开始
HDR = {SF_READ_STREAM: 6, SF_READ_RECORD: 7}


class UmasError(Exception):
    """报文结构与预期不符时抛出，附带原始字节便于核对。"""


@dataclass(frozen=True)
class Frame:
    tid: int
    tx: bytes
    rx: bytes

    @property
    def subfunction(self) -> int:
        return self.tx[2] if len(self.tx) > 2 else -1

    @property
    def session(self) -> int:
        return self.tx[1] if len(self.tx) > 1 else -1


def load_frames(path: str) -> list[Frame]:
    """把 CSV 读成请求/响应配对。只有两侧都在的 Transaction ID 才保留。

    原始抓包请直接传给 ``reassemble()``——那边的路径不依赖请求侧，
    因为实测 pktmon 抓到的客户端方向常有空洞。
    """
    if path.lower().endswith((".pcapng", ".pcap")):
        return frames_from_pcapng(path)
    return _frames_from_csv(path)


def _frames_from_csv(csv_path: str) -> list[Frame]:
    with open(csv_path, encoding="utf-8-sig", newline="") as fh:
        rows = list(csv.DictReader(fh))

    by_tid: dict[int, dict[str, bytes]] = {}
    for row in rows:
        if row["function_code"] != str(FUNC_UMAS):
            continue
        tid = int(row["transaction_id"])
        by_tid.setdefault(tid, {})[row["direction"]] = bytes.fromhex(row["pdu_hex"])

    frames = []
    for tid in sorted(by_tid):
        sides = by_tid[tid]
        if "Tx" in sides and "Rx" in sides:
            frames.append(Frame(tid, sides["Tx"], sides["Rx"]))
    return frames


def split_mbap(stream: bytes) -> list[tuple[int, int, bytes]]:
    """把一条 TCP 流按 MBAP 切成 (TID, UnitID, PDU)。"""
    out = []
    i = 0
    n = len(stream)
    while i + 7 <= n:
        tid, _pid, length, unit = struct.unpack_from(">HHHB", stream, i)
        if length < 2 or i + 6 + length > n:
            break                      # 流被截断或不是 MBAP，停止
        out.append((tid, unit, stream[i + 7: i + 6 + length]))
        i += 6 + length
    return out


def frames_from_pcapng(path: str) -> list[Frame]:
    """直接从原始抓包里重建 UMAS 请求/响应对。"""
    from .. import pcapng

    tx: dict[int, bytes] = {}
    rx: dict[int, bytes] = {}

    for (src, sport, dst, dport), payload in pcapng.tcp_streams(path).items():
        if not payload or payload[7:8] != bytes([FUNC_UMAS]):
            continue                   # 不是 UMAS（比如普通 Modbus 数据交换）
        for tid, _unit, pdu in split_mbap(payload):
            if dport == 502:
                tx[tid] = pdu
            elif sport == 502:
                rx[tid] = pdu

    return [Frame(t, tx[t], rx[t]) for t in sorted(tx) if t in rx]


def _check_head(f: Frame, want_sf: int) -> bytes:
    p = f.rx
    if not p or p[0] != FUNC_UMAS:
        raise UmasError(f"TID {f.tid}: 响应首字节不是 0x5A: {p[:8].hex()}")
    if f.subfunction != want_sf:
        raise UmasError(f"TID {f.tid}: 期望子功能 0x{want_sf:02x}，实际 0x{f.subfunction:02x}")
    if len(p) < 3 or p[2] != 0xFE:
        raise UmasError(f"TID {f.tid}: 响应状态不是 0xFE: {p[:8].hex()}")
    return p


def parse_app_size(f: Frame) -> int:
    """0x33 响应：PLC 声明的应用总长度。

    观测到的是 u16 LE（49,080 = 0xBFB8）。样本应用小于 64 KiB，
    超过时这里需要重新确认字段宽度——所以调用方必须用实际收到的
    长度做交叉校验，不能盲信。
    """
    p = _check_head(f, SF_APP_SIZE)
    if len(p) < 7:
        raise UmasError(f"TID {f.tid}: 0x33 响应过短: {p.hex()}")
    return struct.unpack_from("<H", p, 5)[0]


def parse_read_record(f: Frame) -> tuple[int, bytes]:
    """0x34 响应：返回 (记录索引, 记录正文)。"""
    p = _check_head(f, SF_READ_RECORD)
    hdr_len = HDR[SF_READ_RECORD]
    if len(p) < hdr_len:
        raise UmasError(f"TID {f.tid}: 0x34 响应短于头部: {p.hex()}")

    # 请求里的索引是 pdu[5:7] 的 LE16
    index = struct.unpack_from("<H", f.tx, 5)[0]
    declared = struct.unpack_from("<H", p, 5)[0]
    body = p[hdr_len:]

    if declared != len(body):
        raise UmasError(
            f"TID {f.tid} 索引 {index}: 声明长度 {declared} 与实际 {len(body)} 不符 "
            f"（头 {p[:hdr_len].hex()}）"
        )
    return index, body


def parse_stream_chunk(f: Frame) -> tuple[int, int, bytes]:
    """0x20 响应：返回 (流 id, 偏移, 数据块)。用于 0x36 这类分块流读取。"""
    p = _check_head(f, SF_READ_STREAM)
    hdr_len = HDR[SF_READ_STREAM]
    if len(p) < hdr_len:
        raise UmasError(f"TID {f.tid}: 0x20 响应短于头部: {p.hex()}")

    stream_id = f.tx[4]
    offset = struct.unpack_from("<I", f.tx, 6)[0]
    declared = struct.unpack_from("<H", p, 4)[0]
    data = p[hdr_len:]

    if declared != len(data):
        raise UmasError(
            f"TID {f.tid} 流 0x{stream_id:02x} 偏移 {offset}: 声明 {declared} 实际 {len(data)}"
        )
    return stream_id, offset, data


@dataclass
class Upload:
    """一次 0x33 → 0x34×N → 0x35 上载的完整结果。"""

    declared_size: int
    records: list[tuple[int, bytes]]
    end_index: int | None

    @property
    def image(self) -> bytes:
        """按索引序拼接的应用镜像。"""
        return b"".join(body for _, body in sorted(self.records))

    def verify(self) -> None:
        """声明长度必须等于实收长度，否则说明上载不完整。"""
        actual = len(self.image)
        if self.declared_size != actual:
            raise UmasError(
                f"上载不完整：PLC 声明 {self.declared_size} 字节，实收 {actual} 字节"
            )


def messages_from_pcapng(path: str) -> list[tuple[int, int, bytes]]:
    """从原始抓包里取 PLC→PC 方向的全部 UMAS 消息，按 TID 排序。

    实测 pktmon 抓的请求方向有空洞（一次上载里 154 处断档），所以上载只依赖
    响应方向：它对 PLC 来说是完整、连续的。
    """
    from .. import pcapng

    out: list[tuple[int, int, bytes]] = []
    for (_src, sport, _dst, _dport), payload in pcapng.tcp_streams(path).items():
        if sport != 502 or not payload:
            continue
        out.extend(split_mbap(payload))
    return sorted(out)


def upload_from_messages(msgs: list[tuple[int, int, bytes]]) -> Upload:
    """从 UMAS 响应消息直接重组应用镜像，不需要请求侧。

    记录报文（两种抓包实测一致）::

        5a <sess> fe  00  00  len:u16LE   data
                      │   └─ 0x00 = 记录
                      └─ 0x01 = 总长，后跟 u32LE

    用"声明长度 == 实际长度"做自洽校验，可以自动滤掉会话里同形状的状态报文。
    """
    records: list[tuple[int, bytes]] = []
    declared: list[int] = []

    for _tid, _unit, pdu in msgs:
        if len(pdu) < 8 or pdu[0] != FUNC_UMAS or pdu[2] != 0xFE:
            continue
        if pdu[4] == 0x01:
            declared.append(struct.unpack_from("<I", pdu, 5)[0])
        elif pdu[4] == 0x00:
            length = struct.unpack_from("<H", pdu, 5)[0]
            if len(pdu) != 7 + length:
                continue                      # 长度对不上，不是记录
            records.append((len(records) + 1, pdu[7:7 + length]))

    if not declared:
        raise UmasError("抓包里没有总长应答（0x33），无法确认应用长度")
    if not records:
        raise UmasError("抓包里没有任何记录")

    actual = sum(len(body) for _, body in records)
    if actual not in declared:
        # 会话里可能有多个"总长"应答（不同对象），只有与应用镜像对得上的那个才算数
        raise UmasError(
            f"记录合计 {actual} 字节，与任何总长应答都不符："
            f"{sorted(set(declared))}"
        )

    upload = Upload(actual, records, records[-1][0])
    upload.verify()
    return upload


def reassemble(path: str) -> Upload:
    """从抓包重组完整应用镜像。支持 .csv 和 .pcapng。"""
    if path.lower().endswith((".pcapng", ".pcap")):
        return upload_from_messages(messages_from_pcapng(path))

    frames = load_frames(path)

    declared = None
    records: list[tuple[int, bytes]] = []
    end_index = None

    for f in frames:
        sf = f.subfunction
        if sf == SF_APP_SIZE:
            declared = parse_app_size(f)
        elif sf == SF_READ_RECORD:
            records.append(parse_read_record(f))
        elif sf == SF_END:
            # 请求 5a 19 35 00 01 34 00：索引在 [5:7]，回显最后一条记录号
            if len(f.tx) >= 7:
                end_index = struct.unpack_from("<H", f.tx, 5)[0]

    if declared is None:
        raise UmasError("抓包里没有 0x33 应答，无法确认应用长度")
    if not records:
        raise UmasError("抓包里没有任何 0x34 记录")

    indexes = [i for i, _ in records]
    if len(set(indexes)) != len(indexes):
        raise UmasError(f"记录索引重复: {sorted(indexes)}")

    upload = Upload(declared, records, end_index)
    upload.verify()
    return upload
