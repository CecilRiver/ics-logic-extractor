# PLC 逆向（M340 子集）

从 `plc_reverse` 项目迁入的只读 M340 实现，供 Web 服务端调用。只保留主动上载与 ST 源码解析所需模块，Python 标准库即可运行。

| 文件 | 作用 |
|---|---|
| `plc_runner.py` | JSONL 运行器：`fetch`（上载 + 逆向）与 `variables`（变量/值域提取） |
| `plcrev/m340/client.py` | UMAS 只读上载客户端（0x10 / 0x33 / 0x34 / 0x35） |
| `plcrev/m340/umas.py` | 报文与完整性校验 |
| `plcrev/m340/apx.py` | 应用镜像容器 |
| `plcrev/m340/packed.py` | 镜像内 zlib 流提取 |
| `plcrev/m340/stsource.py` | 取回 ST 源码 |
| `plcrev/m340/pathbase.py` | 从 `.stu` 的 PathBase.db 取变量声明 |
| `plcrev/m340/pou.py` | 声明 + 代码体拼成完整 POU |
| `plcrev/m340/variables.py` | 关键变量与值域推断（新增） |

手工运行：

```powershell
# 上载并逆向（只读）
python python/plc_runner.py fetch --ip 192.168.20.55 --port 502 --timeout 10 `
  --out-root data/traffic --stu <工程.stu> --stu-name 工程.stu

# 对已有运行目录提取变量
python python/plc_runner.py variables --run-dir data/traffic/<时间戳>_192.168.20.55
```
