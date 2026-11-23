# PLC 逆向（M340 子集）

从 `plc_reverse` 项目迁入的只读 M340 实现，供 Web 服务端调用。在原有上载/逆向之外，新增了 Modbus 只读采集、PCAPNG 生成与离线解析。Python 标准库即可运行。

| 文件 | 作用 |
|---|---|
| `plc_runner.py` | JSONL 运行器：`collect`（采集流量）/ `parse`（离线解析）/ `fetch`（上载 + 逆向）/ `variables`（变量/值域） |
| `plcrev/m340/client.py` | UMAS 只读上载客户端（0x10 / 0x33 / 0x34 / 0x35） |
| `plcrev/m340/modbus.py` | Modbus/TCP 只读客户端（FC1/FC2/FC3/FC4），用于运行/IO 流量 |
| `plcrev/pcapng_writer.py` | 把采集到的请求/响应载荷重建为 PCAPNG |
| `plcrev/m340/umas.py` | 报文与完整性校验 |
| `plcrev/m340/apx.py` | 应用镜像容器 |
| `plcrev/m340/packed.py` | 镜像内 zlib 流提取 |
| `plcrev/m340/stsource.py` | 取回 ST 源码 |
| `plcrev/m340/pathbase.py` | 从 `.stu` 的 PathBase.db 取变量声明 |
| `plcrev/m340/pou.py` | 声明 + 代码体拼成完整 POU |
| `plcrev/m340/variables.py` | 关键变量与值域推断 |

手工运行：

```powershell
# 1. 采集上载 + 运行 + IO 流量（只读），保存应用镜像与 PCAPNG
python python/plc_runner.py collect --ip 192.168.20.55 --port 502 --timeout 10 `
  --out-root data/traffic --duration 10 --interval 0.5

# 2. 离线解析已采集的应用镜像（不再连接 PLC）
python python/plc_runner.py parse --run-dir data/traffic/<时间戳>_192.168.20.55

# 3. 对已有运行目录提取变量
python python/plc_runner.py variables --run-dir data/traffic/<时间戳>_192.168.20.55
```

`collect` 会用 Modbus FC1/2/3/4 只读扫描常见区段（%MW0–1023、%IW0–127、线圈 0–255、离散输入 0–255）。PCAPNG 是根据客户端请求/响应重建的合成 TCP 会话，不是被动抓包。
