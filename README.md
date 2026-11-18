# 业务逻辑提取工具（Vue）

从 VeriPro 中抽出的独立前端，聚焦两类输入：

- **操作规范解析**（已实现）：上传 PDF / TXT / Markdown，按页分段后调用 DeepSeek 依次抽取设备、业务拓扑与控制逻辑，支持单独执行操作规范属性提取，可逐段复核、重试与导出。
- **控制程序解析**（已实现）：配置 PLC 网络参数后自动完成施耐德 M340（BMX P34 2020，TCP 502 / UMAS）控制程序提取（只读），逆向取出 ST 源码，并按源码常量与数据类型推断关键变量的值域。

技术栈：Vue 3 + Vue Router + Vite + TypeScript，服务端使用 Node 内置 `http`，不依赖额外后端框架。PLC 逆向部分为随项目维护的 Python 包（仅标准库），由 Node 以子进程调用。

## 目录

```text
manual-traffic-tools/
├── server/                 # Node 服务端：DeepSeek 代理、PLC 解析任务、静态服务
│   ├── env.ts              # 极简 .env 加载器
│   ├── manual-extract.ts   # GET 健康检查 / POST 单阶段抽取
│   ├── traffic.ts          # 控制程序解析任务（创建 / 轮询 / 变量提取）
│   └── index.ts            # 生产服务（dist + API + SPA 回退）
├── python/                 # 随项目维护的 PLC 逆向（仅标准库）
│   ├── plc_runner.py       # JSONL 运行器：fetch / variables
│   └── plcrev/m340/        # UMAS 上载、镜像容器、ST 源码、声明、POU、变量推断
├── src/
│   ├── domain/manual.ts    # 抽取领域模型、归一化、合并与导出
│   ├── domain/traffic.ts   # 控制程序解析结果与变量表类型
│   ├── services/manual/    # 分段、PDF 解析、提示词、解析器、编排
│   ├── services/traffic/   # 任务创建 / 轮询 / 变量提取客户端
│   ├── features/
│   │   ├── manual-extraction/   # 操作规范解析界面与结果表
│   │   └── traffic-parsing/     # 控制程序解析界面
│   ├── views/              # /manual 与 /traffic 路由页面
│   ├── router/
│   └── App.vue             # 顶部导航与路由出口
├── scripts/copy-pdf-worker.mjs
├── data/traffic/           # 运行产物（自动生成，不提交）
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

打开 http://localhost:5174/ 。开发模式下 Vite 直接挂载 `/api/manual/extract` 与 `/api/traffic/*` 中间件，无需另起后端进程。

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
工程大小   91,676 字节
记录数     94 条
SHA-256    bf275c692ec3657d434ff7a483f476a5d5382cb030e586255ccab7951fb0017b
程序单元   5 个（4 个功能块 + 1 个程序段）
```

## 抽取流程

1. 浏览器解析 PDF / 文本并按页分段（每段页数、字符上限可调）。
2. 每段串行执行「设备 → 业务拓扑 → 控制逻辑」，后一阶段会带上前一阶段结果。
3. 单段失败不阻塞其余分段，可单独重试；致命错误（如未配置 Key）会立即中断。
4. 合并结果按全部字段去重并记录来源分段，可导出 JSON 或 Markdown。

提示词位于 `src/services/manual/prompts.ts`，服务端与前端共用同一份领域模型和解析器，避免两端字段口径漂移。

## 控制程序解析流程

1. 页面填写 PLC 地址 / 端口 / 超时。
2. 服务端启动 `python/plc_runner.py fetch`，用只读 UMAS 命令（`0x10` / `0x33` / `0x34` / `0x35`）自动完成控制程序提取，约 1 秒完成。
3. 从镜像的 zlib 流中取出 ST 源码，并重建程序单元。
4. 页面展示每个单元的名称 / 类型 / 字符数 / 解析状态，点行展开 ST 原文；同时显示 SHA-256 供核对。
5. 点击「关键变量属性提取」，按「源码比较 / 赋值常量 → 声明初值 → 数据类型固有范围 → 未定」的顺序推断值域，并标注依据。

落盘结构（每次运行一个目录，旧结果不覆盖）：

```text
data/traffic/<时间戳>_<IP>/
├── 01_上载/Station.apx     # 应用镜像
├── 02_逆向/st_01_0x064FA.st ...  # ST 源码
├── 03_变量/变量表.json     # 点击变量提取后生成
└── manifest.json           # 时间 / 会话号 / SHA-256 / 文件清单
```

约束与注意：

- **只读**：只发送上述四类只读命令，不包含任何写入或控制命令。
- **失败不落半成品**：先写临时目录，成功后原子改名；连接失败或逆向失败不会留下结果目录。
- 目标机需与测试机在同一网段；虚拟网卡会造成“假连通”，先用 `ping` 确认。主机名超过 15 字节会被截断，可能拿不到会话号。

接口：

| 方法 | 路径 | 用途 |
|---|---|---|
| `POST` | `/api/traffic/jobs` | 创建解析任务（`ip` / `port` / `timeout`） |
| `GET` | `/api/traffic/jobs/:id` | 查询进度与结果 |
| `POST` | `/api/traffic/jobs/:id/variables` | 从已解析源码提取关键变量与值域 |
