# 业务逻辑提取工具（Vue）

从 VeriPro 中抽出的独立前端，聚焦两类输入：

- **操作手册提取**（已实现）：上传 PDF / TXT / Markdown，按页分段后调用 DeepSeek 依次抽取设备、业务拓扑与控制逻辑，可逐段复核、重试与导出。
- **流量解析**（占位）：保留独立路由与页面骨架，待后续接入 PCAP 解析后补全协议识别、读写关系还原与时序补全。

技术栈：Vue 3 + Vue Router + Vite + TypeScript，服务端使用 Node 内置 `http`，不依赖额外后端框架。

## 目录

```text
manual-traffic-tools/
├── server/                 # Node 服务端：DeepSeek 代理、生产静态服务
│   ├── env.ts              # 极简 .env 加载器
│   ├── manual-extract.ts   # GET 健康检查 / POST 单阶段抽取
│   └── index.ts            # 生产服务（dist + API + SPA 回退）
├── src/
│   ├── domain/manual.ts    # 抽取领域模型、归一化、合并与导出
│   ├── services/manual/    # 分段、PDF 解析、提示词、解析器、编排
│   ├── features/
│   │   ├── manual-extraction/   # 手册提取界面与结果表
│   │   └── traffic-parsing/     # 流量解析占位页样式
│   ├── views/              # /manual 与 /traffic 路由页面
│   ├── router/
│   └── App.vue             # 顶部导航与路由出口
├── scripts/copy-pdf-worker.mjs
└── tests/manual.test.ts
```

## 本地运行

需要 Node.js 22.13 及以上。

```powershell
pnpm install
Copy-Item .env.example .env
# 编辑 .env，填写 DEEPSEEK_API_KEY
pnpm dev
```

打开 http://localhost:5174/ 。开发模式下 Vite 直接挂载 `/api/manual/extract` 中间件，无需另起后端进程。

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
pnpm test        # 分段、解析、合并、导出的单元测试
pnpm typecheck   # vue-tsc --noEmit
pnpm build       # 完整构建
```

## 抽取流程

1. 浏览器解析 PDF / 文本并按页分段（每段页数、字符上限可调）。
2. 每段串行执行「设备 → 业务拓扑 → 控制逻辑」，后一阶段会带上前一阶段结果。
3. 单段失败不阻塞其余分段，可单独重试；致命错误（如未配置 Key）会立即中断。
4. 合并结果按全部字段去重并记录来源分段，可导出 JSON 或 Markdown。

提示词位于 `src/services/manual/prompts.ts`，服务端与前端共用同一份领域模型和解析器，避免两端字段口径漂移。
