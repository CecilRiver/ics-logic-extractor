# 业务逻辑提取工具（Vue）

从 VeriPro 中抽出的独立前端，聚焦两类输入：

- **操作规范解析**（已实现）：上传 PDF / TXT / Markdown，按页分段后调用 DeepSeek 依次抽取设备、业务拓扑与控制逻辑，支持单独执行操作规范属性提取，可逐段复核、重试与导出。
- **控制程序解析**（已实现）：先从现场 PLC 采集上载、运行与 IO 流量并保存 PCAPNG，再离线解析控制程序，逆向 ST 源码并推断关键变量值域。

技术栈：Vue 3 + Vue Router + Vite + TypeScript，服务端使用 Node 内置 `http`，不依赖额外后端框架。PLC 逆向部分为随项目维护的 Python 包（仅标准库），由 Node 以子进程调用。

## 目录

```text
manual-traffic-tools/
├── server/                 # Node 服务端：DeepSeek 代理、历史、PLC 解析任务、静态服务
│   ├── env.ts              # 极简 .env 加载器
│   ├── manual-extract.ts   # GET 健康检查 / POST 单阶段抽取
│   ├── manual-runs.ts      # 操作规范运行历史（保存 / 列表 / 读取 / 更新）
│   ├── traffic.ts          # 控制程序解析任务（创建 / 轮询 / 变量提取）
│   └── index.ts            # 生产服务（dist + API + SPA 回退）
├── python/                 # 随项目维护的 PLC 逆向（仅标准库）
│   ├── plc_runner.py       # JSONL 运行器：collect / parse / fetch / variables
│   ├── plcrev/             # UMAS 上载、Modbus 采集、PCAPNG 写入、ST 源码、变量推断
│   └── reference/m251/     # 两台 M251 的主程序源码
├── src/
│   ├── domain/manual.ts    # 抽取领域模型、归一化、合并、导出与历史类型
│   ├── domain/traffic.ts   # 控制程序解析结果、运行历史与质量评分类型
│   ├── services/manual/    # 分段、PDF 解析、提示词、解析器、编排、历史
│   ├── services/traffic/   # 任务创建 / 轮询 / 历史 / 变量提取 / 导出
│   ├── features/
│   │   ├── manual-extraction/   # 操作规范解析界面与结果表
│   │   └── traffic-parsing/     # 控制程序解析界面
│   ├── views/              # /manual 与 /traffic 路由页面
│   ├── router/
│   └── App.vue             # 顶部导航与路由出口
├── scripts/copy-pdf-worker.mjs
├── data/
│   ├── manual/             # 操作规范运行历史（自动生成，不提交）
│   └── traffic/            # 控制程序运行产物（自动生成，不提交）
└── tests/                  # 操作规范 + 控制程序解析测试
```

## 本地运行

需要 Node.js 22.13 及以上。控制程序解析还需要 Python 3.10 及以上（开发环境为 3.12），只用标准库，无需 `pip install`。服务端默认调用 PATH 里的 `python`，可用 `PYTHON_BIN` 指定解释器。

```powershell
pnpm install
Copy-Item .env.example .env
# 编辑 .env，填写 DEEPSEEK_API_KEY
pnpm dev
```

打开 http://localhost:5174/ 。开发模式下 Vite 直接挂载 `/api/manual/extract`、`/api/manual/runs` 与 `/api/traffic/*` 中间件，无需另起后端进程。

- PDF 在浏览器本地解析（pdfjs），正文不会上传到第三方存储；只有分段文本发送给模型。
- API Key 仅存在于服务端环境变量，不会进入浏览器包。
- 若默认端口 5174 被占用，修改 `vite.config.ts` 中的 `server.port`。

## 构建与部署

```powershell
pnpm build       # 复制 pdf worker、类型检查、构建 dist/
pnpm start       # 启动生产服务：dist 静态资源 + /api/manual/extract
```

生产服务默认监听 `http://localhost:4174/`，可用 `HOST` / `PORT` 环境变量覆盖。`pnpm start` 通过 `tsx` 直接运行 TypeScript 服务端代码，无需额外编译步骤。

## 校验

```powershell
pnpm test        # 分段、解析、合并、导出 + 变量推断 / 失败不留文件
pnpm typecheck   # vue-tsc --noEmit
pnpm build       # 完整构建
```

`tests/traffic.test.ts` 会启动 Python 运行器；本机没有 `python` 时自动跳过该组测试。控制程序解析的回归基线（现场设备 192.168.20.55）：

```text
工程大小   93,139 字节
记录数     95 条
SHA-256    25745ea3d5e1469c19196a7dd5e68ebba6821f2617904054aa2f8c562f152dfa
程序单元   7 个（5 个 M340 + 2 个 M251）
```

## 抽取流程

1. 浏览器解析 PDF / 文本并按页分段（每段页数、字符上限可调）。
2. 每段串行执行「设备 → 业务拓扑 → 控制逻辑」，后一阶段会带上前一阶段结果。
3. 单段失败不阻塞其余分段，可单独重试；致命错误（如未配置 Key）会立即中断。
4. 合并结果按全部字段去重并记录来源分段，可导出 JSON 或 Markdown。

提示词位于 `src/services/manual/prompts.ts`，服务端与前端共用同一份领域模型和解析器，避免两端字段口径漂移。

## 操作规范运行历史

每次操作规范解析完成后自动保存到 `data/manual/<时间戳>_<来源>/`：

```text
data/manual/<时间戳>_<来源>/
├── meta.json    # 来源、时间、模型、分段数与各类行数
└── state.json   # 分页文本 + 各分段抽取结果
```

- 运行历史收在左侧抽屉中，点击左边缘「运行历史」按钮展开；点击记录后自动收起并定位到抽取结果。属性提取会更新当前记录；更换文件或调整分段口径后重新解析会新建记录，旧记录保留。
- 上传、分段抽取、抽取结果卡片可分别收起；页面右侧快捷导航可一键跳转到上传、抽取、结果或历史。
- 刷新页面只加载历史列表，不自动载入结果。

接口：

| 方法 | 路径 | 用途 |
|---|---|---|
| `POST` | `/api/manual/runs` | 保存一次解析 |
| `GET` | `/api/manual/runs` | 列出历史 |
| `GET` | `/api/manual/runs/:name` | 读取历史结果 |
| `PUT` | `/api/manual/runs/:name` | 更新（属性提取后） |

## 控制程序解析流程

1. 页面可填写多个 PLC 地址，点击「收集流量」后采集运行 / IO 流量并保存 PCAPNG。
2. 服务端启动 `python/plc_runner.py collect`：
   - 用只读 UMAS 命令（`0x10` / `0x33` / `0x34` / `0x35`）上载应用镜像；
   - 用标准 Modbus/TCP 只读命令（FC1 / FC2 / FC3 / FC4）扫描常见区段：`%MW0–1023`、`%IW0–127`、线圈 `0–255`、离散输入 `0–255`，默认每台 **10 秒**、每 0.5 秒一轮循环采样，多台地址按数量累计采集时长；
   - 把全部请求/响应帧写入 `流量/采集流量.pcapng`（重建 TCP 会话，含握手与 ACK；另含程序上载会话），并保存页面展示用的内部索引 `流量/frames.json`（只含运行/IO 帧）。
3. 页面展示流量统计、运行 / IO 分类帧表、帧十六进制、采集点位最新值，可下载 PCAPNG。
4. 点击「开始解析」，服务端执行 `python/plc_runner.py parse --run-dir ...`，离线读取 `01_上载/Station.apx`，逆向取出 ST 源码并写入 `02_逆向`，**不再连接 PLC**；同时解析两台 M251 的主程序源码；随后自动执行关键变量与值域提取。
5. 页面展示每个单元的名称 / PLC / 类型 / 字符数 / 解析状态，点行展开 ST 原文；同时显示 SHA-256 供核对。结果按 PLC 地址分别标注，便于核对每台设备的程序与变量。
6. 关键变量表自动生成，按「源码比较 / 赋值常量 → 声明初值 → 数据类型固有范围 → 未定」的顺序推断值域，并标注依据。
7. 没有变量声明时，类型与类别按代码用法推断（表格字段不显示「推断」后缀，页面注明推断来源）：布尔表达式 → BOOL，小数常量 → REAL，纯整数常量 → INT，成员访问 → 实例；只读 / 只写 / 读写分别对应输入 / 输出 / 内部。输出在本块内被再次读取时会判为内部，结果仅供参考。

> 控制程序解析会同时覆盖 M340 与两台 M251 的主程序；功能块内部实现不在展示范围内。

> 运行 / IO 流量是按常见区段主动只读扫描得到的，地址映射为推测；PCAPNG 由采集端请求/响应重建，不是被动抓包，但可直接用 Wireshark 打开并 Follow TCP Stream。

## 运行历史、导出与质量评分

- 运行历史收在左侧抽屉中，点击左边缘「运行历史」按钮展开；点击记录后自动收起并定位到对应结果。仅采集未解析的记录会标注「仅采集」，可稍后离线解析。
- 运行 / IO 流量与控制程序卡片可分别收起；页面右侧快捷导航可一键跳转到参数、流量、程序或历史。
- 导出：变量表 CSV / Markdown、多 Sheet Excel（运行信息 / 程序单元 / 关键变量 / 程序源码）、分析报告 Markdown、验收证据 HTML（含 SHA-256、单元、变量与源码，可直接打印为 PDF）、结果 JSON；流量文件可单独下载 PCAPNG。
- 质量评分：值域缺失 -35、仅相关常量 -10、类型未知 -20、类别未知 -10、依据缺失 -15，推断项各 -5，按 0–100 折算高 / 中 / 低。
- 变量表支持按关键字、类型、类别、质量等级和「是否有值域」筛选；程序单元表支持关键字搜索。

落盘结构（每次运行一个目录，旧结果不覆盖）：

```text
data/traffic/<时间戳>_<IP>/
├── 01_上载/Station.apx        # 应用镜像（离线解析输入）
├── 流量/采集流量.pcapng       # 上载 + 运行 + IO 流量
├── 流量/frames.json           # 页面展示用的内部索引
├── 02_逆向/st_01_...st        # 离线解析后生成
├── 02_逆向/m251_01_PRG_AB.st  # 两台 M251 主程序
├── 02_逆向/m251_02_PRG_D.st
├── 03_变量/变量表.json        # 点击变量提取后生成
└── manifest.json              # parsed 标记 / 会话号 / SHA-256 / 流量统计
```

约束与注意：

- **只读**：UMAS 只发送 `0x10/0x33/0x34/0x35`，Modbus 只发送 FC1/FC2/FC3/FC4，不包含任何写入或控制命令。
- **失败不落半成品**：先写临时目录，成功后原子改名；连接失败或保存失败不会留下结果目录。运行/IO 采集失败只降级为警告，不影响上载。
- 目标机需与测试机在同一网段；虚拟网卡会造成“假连通”，先用 `ping` 确认。主机名超过 15 字节会被截断，可能拿不到会话号。

接口：

| 方法 | 路径 | 用途 |
|---|---|---|
| `POST` | `/api/traffic/collect` | 创建采集任务（`ip` / `port` / `timeout` / `duration` / `plcs`） |
| `GET` | `/api/traffic/jobs/:id` | 查询采集进度与结果 |
| `POST` | `/api/traffic/runs/:name/parse` | 离线解析已采集的应用镜像 |
| `POST` | `/api/traffic/jobs/:id/variables` | 从已解析源码提取关键变量与值域 |
| `GET` | `/api/traffic/runs` | 列出历史运行 |
| `GET` | `/api/traffic/runs/:name` | 读取历史运行的流量、单元与变量 |
| `POST` | `/api/traffic/runs/:name/variables` | 对历史运行重新提取变量 |
| `GET` | `/api/traffic/runs/:name/traffic` | 下载采集流量 PCAPNG |
