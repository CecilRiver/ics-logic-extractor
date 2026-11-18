"""M340 主动上载客户端（只读）。

报文序列从三份抓包里反推出来，三份完全一致：

    1. 建会话   5a 00 10  <4字节>  <len>  <主机名>
                 ← 5a 00 fe <会话号>            PLC 在应答第 4 字节回一个会话号

    2. 问总长   5a <sess> 33 00 01 fb 03
                 ← 5a <sess> fe 00 01 <u32 总长>

    3. 逐条读   5a <sess> 34 00 01 <序号 u16LE>
                 ← 5a <sess> fe 00 00 <u16 长度> <数据>      （第 4 字节 00 = 记录）

    4. 结束     5a <sess> 35 00 01 <最后序号 u16LE>

本模块**只发送这三类只读请求**，没有任何写入、停止、初始化命令。
默认是 dry-run，只打印将发送的字节；加 --execute 才会真正连设备。

实测数据：把 52 条记录拼起来与 IDE 保存的 Station.apx 逐字节相同。
"""

from __future__ import annotations

import socket
import struct
from dataclasses import dataclass

from .umas import FUNC_UMAS, Upload, UmasError

DEFAULT_PORT = 502
DEFAULT_HOSTNAME = "PLC-READER"
MAX_RECORDS = 4096          # 保护上限，正常工程远小于此
STATUS_OK = 0xFE            # PLC 应答第三字节


@dataclass
class Plan:
    """dry-run 时展示的计划，便于先行核对。"""

    host: str
    port: int
    hostname: str

    def steps(self) -> list[str]:
        return [
            f"连接 {self.host}:{self.port}",
            f"发会话请求（主机名 {self.hostname}）→ 取得会话号",
            "发 0x33 问工程总长",
            "发 0x34 逐条读取，直到收满总长",
            "断开（不发任何写命令）",
        ]


class PlcReader:
    def __init__(self, host: str, port: int = DEFAULT_PORT, timeout: float = 10.0,
                 hostname: str = DEFAULT_HOSTNAME):
        self.host = host
        self.port = port
        self.timeout = timeout
        self.hostname = hostname[:15]
        self.sock: socket.socket | None = None
        self.session = 0
        self._tid = 0
        self.sent: list[bytes] = []          # dry-run 用：记录本应发出的 PDU

    # ---------- 底层收发 ----------

    def _next_tid(self) -> int:
        self._tid = (self._tid + 1) & 0xFFFF
        return self._tid

    def _send(self, payload: bytes) -> bytes:
        self.sent.append(payload)
        if self.sock is None:                # dry-run：不真的发
            return b""
        tid = self._next_tid()
        frame = struct.pack(">HHHB", tid, 0, len(payload) + 1, 0) + payload
        self.sock.sendall(frame)

        head = self._recv_exact(7)
        _tid, _pid, length, _unit = struct.unpack(">HHHB", head)
        body = self._recv_exact(length - 1)
        if not body or body[0] != FUNC_UMAS:
            raise UmasError(f"应答不是 UMAS：{body[:8].hex()}")
        if len(body) > 2 and body[2] != STATUS_OK:
            raise UmasError(f"设备返回错误状态 0x{body[2]:02X}")
        return body

    def _recv_exact(self, n: int) -> bytes:
        buf = b""
        while len(buf) < n:
            chunk = self.sock.recv(n - len(buf))
            if not chunk:
                raise UmasError("连接被对端关闭")
            buf += chunk
        return buf

    # ---------- 协议步骤 ----------

    def open_session(self) -> int:
        """0x10：带上主机名，PLC 回一个会话号。无需任何凭证。"""
        payload = (bytes([FUNC_UMAS, 0x00, 0x10, 0x48, 0x17, 0x00, 0x00,
                          len(self.hostname)])
                   + self.hostname.encode("ascii", "replace"))
        resp = self._send(payload)
        if not resp and self.sock is None:
            self.session = 0x01             # dry-run 占位
            return self.session
        self.session = resp[3]
        return self.session

    def read_total_size(self) -> int:
        payload = bytes([FUNC_UMAS, self.session, 0x33, 0x00, 0x01, 0xFB, 0x03])
        resp = self._send(payload)
        if not resp:
            return 0
        return struct.unpack_from("<I", resp, 5)[0]

    def read_record(self, index: int) -> bytes:
        payload = (bytes([FUNC_UMAS, self.session, 0x34, 0x00, 0x01])
                   + struct.pack("<H", index))
        resp = self._send(payload)
        if not resp:
            return b""
        length = struct.unpack_from("<H", resp, 5)[0]
        data = resp[7:7 + length]
        if len(data) != length:
            raise UmasError(f"第 {index} 条记录长度不符：声明 {length}，实收 {len(data)}")
        return data

    def end_session(self, last_index: int) -> None:
        payload = (bytes([FUNC_UMAS, self.session, 0x35, 0x00, 0x01])
                   + struct.pack("<H", last_index))
        self._send(payload)

    # ---------- 主流程 ----------

    def fetch(self, max_bytes: int = 128 * 1024 * 1024, progress=None) -> Upload:
        """完整走一遍上载，返回带自校验的 Upload。

        ``progress(已读字节, 总字节)`` 会在每条记录之后被调用，用于显示进度。
        """
        self.open_session()
        total = self.read_total_size()
        if not total:
            raise UmasError("没读到工程总长")
        if total > max_bytes:
            raise UmasError(f"工程 {total} 字节，超过上限 {max_bytes}")

        records: list[tuple[int, bytes]] = []
        got = 0
        index = 1
        while got < total and index <= MAX_RECORDS:
            data = self.read_record(index)
            if not data:
                break
            records.append((index, data))
            got += len(data)
            index += 1
            if progress is not None:
                progress(got, total)

        self.end_session(index - 1)

        upload = Upload(total, records, index - 1)
        upload.verify()                      # 总长对不上会抛异常
        return upload

    # ---------- 连接管理 ----------

    def __enter__(self) -> "PlcReader":
        self.sock = socket.create_connection((self.host, self.port), self.timeout)
        self.sock.settimeout(self.timeout)
        return self

    def __exit__(self, *exc) -> None:
        if self.sock is not None:
            try:
                self.sock.close()
            finally:
                self.sock = None


def dry_run(host: str, port: int = DEFAULT_PORT,
            hostname: str = DEFAULT_HOSTNAME) -> list[bytes]:
    """不连设备，只把将要发送的 PDU 打出来。"""
    reader = PlcReader(host, port, hostname=hostname)
    reader.open_session()
    reader.read_total_size()
    for i in (1, 2, 3):
        reader.read_record(i)
    reader.end_session(3)
    return reader.sent
