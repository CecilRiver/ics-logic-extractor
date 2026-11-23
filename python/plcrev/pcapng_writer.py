"""把采集到的请求/响应载荷写成 PCAPNG。

采集端只能看到自己发出的请求和收到的响应，没有被动抓包。本模块把
这些 TCP 载荷包装成一段合理的 Ethernet/IPv4/TCP 会话（含握手、ACK、
FIN），生成的 PCAPNG 可直接用 Wireshark 打开并 Follow TCP Stream。

MAC 地址为本地管理地址（02:...），仅用于文件展示，不代表真实网卡。
仅支持 IPv4。
"""

from __future__ import annotations

import struct
from dataclasses import dataclass

CLIENT_MAC = bytes.fromhex("020000000001")
SERVER_MAC = bytes.fromhex("020000000002")
ETH_IPV4 = 0x0800
PROTO_TCP = 6

SYN = 0x02
ACK = 0x10
PSH = 0x08
FIN = 0x01


@dataclass
class TcpPayload:
    timestamp: float
    direction: str          # "c2s" / "s2c"
    payload: bytes


@dataclass
class TcpSession:
    client_ip: str
    client_port: int
    server_ip: str
    server_port: int
    packets: list[TcpPayload]


def _ipv4(value: str) -> bytes:
    parts = value.split(".")
    if len(parts) != 4:
        raise ValueError(f"仅支持 IPv4：{value}")
    return bytes(int(part) for part in parts)


def _checksum(data: bytes) -> int:
    if len(data) % 2:
        data += b"\x00"
    total = sum(struct.unpack(f">{len(data) // 2}H", data))
    while total >> 16:
        total = (total & 0xFFFF) + (total >> 16)
    return (~total) & 0xFFFF


def _frame(
    session: TcpSession,
    direction: str,
    seq: int,
    ack: int,
    flags: int,
    payload: bytes,
    ident: int,
) -> bytes:
    client4 = _ipv4(session.client_ip)
    server4 = _ipv4(session.server_ip)
    if direction == "c2s":
        src_ip, dst_ip = client4, server4
        src_port, dst_port = session.client_port, session.server_port
        dst_mac, src_mac = SERVER_MAC, CLIENT_MAC
    else:
        src_ip, dst_ip = server4, client4
        src_port, dst_port = session.server_port, session.client_port
        dst_mac, src_mac = CLIENT_MAC, SERVER_MAC

    tcp_len = 20 + len(payload)
    tcp = struct.pack(
        ">HHIIBBHHH",
        src_port, dst_port, seq & 0xFFFFFFFF, ack & 0xFFFFFFFF,
        5 << 4, flags, 65535, 0, 0,
    ) + payload
    pseudo = src_ip + dst_ip + struct.pack(">BBH", 0, PROTO_TCP, tcp_len)
    tcp_checksum = _checksum(pseudo + tcp)
    tcp = tcp[:16] + struct.pack(">H", tcp_checksum) + tcp[18:]

    ip = struct.pack(
        ">BBHHHBBH4s4s",
        0x45, 0, 20 + tcp_len, ident & 0xFFFF, 0x4000, 64, PROTO_TCP, 0,
        src_ip, dst_ip,
    )
    ip = ip[:10] + struct.pack(">H", _checksum(ip)) + ip[12:]
    return dst_mac + src_mac + struct.pack(">H", ETH_IPV4) + ip + tcp


def _session_packets(session: TcpSession) -> list[tuple[float, bytes]]:
    packets = sorted(session.packets, key=lambda item: item.timestamp)
    if not packets:
        return []

    first = packets[0].timestamp
    start = max(0.001, first - 0.003)
    isn_c = 1000 + (session.client_port & 0x0FFF)
    isn_s = 5000 + (session.server_port & 0x0FFF)
    cseq = isn_c + 1
    sseq = isn_s + 1
    ident = 1
    out: list[tuple[float, bytes]] = []

    def add(ts: float, direction: str, seq: int, ack: int, flags: int, payload: bytes = b"") -> None:
        nonlocal ident
        out.append((ts, _frame(session, direction, seq, ack, flags, payload, ident)))
        ident += 1

    add(start, "c2s", isn_c, 0, SYN)
    add(start + 0.001, "s2c", isn_s, isn_c + 1, SYN | ACK)
    add(start + 0.002, "c2s", isn_c + 1, isn_s + 1, ACK)

    for item in packets:
        if item.direction == "c2s":
            add(item.timestamp, "c2s", cseq, sseq, PSH | ACK, item.payload)
            cseq += len(item.payload)
            add(item.timestamp + 0.0002, "s2c", sseq, cseq, ACK)
        else:
            add(item.timestamp, "s2c", sseq, cseq, PSH | ACK, item.payload)
            sseq += len(item.payload)
            add(item.timestamp + 0.0002, "c2s", cseq, sseq, ACK)

    end = packets[-1].timestamp + 0.002
    add(end, "c2s", cseq, sseq, FIN | ACK)
    cseq += 1
    add(end + 0.001, "s2c", sseq, cseq, FIN | ACK)
    sseq += 1
    add(end + 0.002, "c2s", cseq, sseq, ACK)
    return out


def _block(block_type: int, body: bytes) -> bytes:
    if len(body) % 4:
        body += b"\x00" * (4 - len(body) % 4)
    total = 12 + len(body)
    return struct.pack("<II", block_type, total) + body + struct.pack("<I", total)


def write_pcapng(path: str, sessions: list[TcpSession]) -> int:
    packets: list[tuple[float, bytes]] = []
    for session in sessions:
        packets.extend(_session_packets(session))
    packets.sort(key=lambda item: item[0])

    shb = _block(0x0A0D0D0A, struct.pack("<IHHq", 0x1A2B3C4D, 1, 0, -1))
    idb = _block(0x00000001, struct.pack("<HHI", 1, 0, 65535))

    with open(path, "wb") as fh:
        fh.write(shb)
        fh.write(idb)
        for timestamp, frame in packets:
            micros = int(timestamp * 1_000_000)
            high = (micros >> 32) & 0xFFFFFFFF
            low = micros & 0xFFFFFFFF
            body = struct.pack("<IIIII", 0, high, low, len(frame), len(frame)) + frame
            fh.write(_block(0x00000006, body))
    return len(packets)
