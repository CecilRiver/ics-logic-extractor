"""Modbus/TCP 只读客户端（用于运行流量与 IO 流量采集）。

只实现 FC1/FC2/FC3/FC4 四类读取，不包含任何写入功能。每次读取返回
请求/响应原始字节和时间戳，供流量展示与 PCAPNG 生成使用。
"""

from __future__ import annotations

import socket
import struct
import time


class ModbusError(Exception):
    pass


class ModbusReader:
    def __init__(self, host: str, port: int = 502, timeout: float = 5.0, unit: int = 1):
        self.host = host
        self.port = port
        self.timeout = timeout
        self.unit = unit
        self.sock: socket.socket | None = None
        self.tid = 0
        self.client_addr: tuple[str, int] | None = None

    def __enter__(self) -> "ModbusReader":
        self.sock = socket.create_connection((self.host, self.port), self.timeout)
        self.sock.settimeout(self.timeout)
        addr = self.sock.getsockname()
        self.client_addr = (addr[0], addr[1])
        return self

    def __exit__(self, *exc) -> None:
        if self.sock is not None:
            try:
                self.sock.close()
            finally:
                self.sock = None

    def _next_tid(self) -> int:
        self.tid = (self.tid + 1) & 0xFFFF
        if self.tid == 0:
            self.tid = 1
        return self.tid

    def _recv_exact(self, size: int) -> bytes:
        if self.sock is None:
            raise ModbusError("未连接")
        buf = b""
        while len(buf) < size:
            chunk = self.sock.recv(size - len(buf))
            if not chunk:
                raise ModbusError("连接被对端关闭")
            buf += chunk
        return buf

    def read(self, function: int, start: int, quantity: int) -> tuple[float, float, bytes, bytes]:
        """返回 (请求时间, 响应时间, 请求字节, 响应字节)，均含 MBAP。"""
        if self.sock is None:
            raise ModbusError("未连接")
        tid = self._next_tid()
        pdu = struct.pack(">BHH", function, start, quantity)
        request = struct.pack(">HHHB", tid, 0, len(pdu) + 1, self.unit) + pdu

        started = time.time()
        self.sock.sendall(request)
        head = self._recv_exact(7)
        r_tid, _pid, length, _unit = struct.unpack(">HHHB", head)
        body = self._recv_exact(length - 1)
        finished = time.time()
        if r_tid != tid:
            raise ModbusError(f"事务号不符：期望 {tid}，收到 {r_tid}")
        return started, finished, request, head + body

    @staticmethod
    def parse(function: int, response: bytes) -> dict:
        """解析响应体，返回 words / bits / exception。"""
        pdu = response[7:]
        if len(pdu) < 2:
            return {"error": "响应过短"}
        code = pdu[0]
        if code == (function | 0x80):
            return {"exception": pdu[1]}
        if code != function:
            return {"error": f"功能码不符：{code:#04x}"}

        byte_count = pdu[1]
        data = pdu[2:2 + byte_count]
        if len(data) < byte_count:
            return {"error": "数据长度不足"}

        if function in (3, 4):
            words = [struct.unpack_from(">H", data, i)[0] for i in range(0, len(data) - 1, 2)]
            return {"words": words}
        if function in (1, 2):
            bits: list[int] = []
            for byte in data:
                for offset in range(8):
                    bits.append((byte >> offset) & 1)
            return {"bits": bits}
        return {"error": f"不支持的功能码 {function}"}
