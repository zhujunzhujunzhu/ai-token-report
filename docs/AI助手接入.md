# 部门 AI 助手接入

部门后台右下角提供全局悬浮小球。展开后是可拖动的聊天窗口，不遮断页面操作；切换页面、收起窗口不会终止对话。「我的对话」从窗口左侧展开，桌面端自动加宽，窄屏在窗口内展开侧栏。支持新建、续聊、停止、删除和查询来源展示。

统计工具返回结构化展示快照：总览指标卡片、趋势折线图、分布柱状图、调用明细与其他查询表格。图表可选择指标、切换表格，表格支持分页、横向滚动和 CSV 导出。展示直接使用统计 API 的值，不让模型生成数字、脚本或 Chart.js 配置；金额仍沿用原有权限与未计价、多币种语义。超过展示上限时明确注明截断，CSV 只导出本次返回的数据。

回答支持 Markdown 标题、列表、引用、代码块与表格。渲染器禁用原始 HTML、图片、链接和自动链接；站内跳转统一通过已鉴权导航工具。查询快照随对话保存，历史查看展示原查询时刻的数据。

底层直接装载锁定版本的 DSH 公开包：`dsh-agent`、`dsh-agent-loop`、`dsh-session`、`dsh-system-prompt`、`dsh-tools`、`dsh-llm` 与 DeepSeek 适配器。没有另写模型调用循环。每次对话运行创建独立 Cordis 上下文，只有八个统计查询工具与一个站内导航工具。

## 启用

助手默认关闭。在服务端进程的环境里配置后重启：

```dotenv
ATR_ASSISTANT_ENABLED=1
ATR_ASSISTANT_MODEL=deepseek-v4-flash
DEEPSEEK_API_KEY=<模型服务凭证>
```

可选 `ATR_ASSISTANT_BASE_URL` 指向支持 DeepSeek Messages 协议的服务根地址。默认使用 DSH 官方 DeepSeek 适配器的地址；它不是 Chat Completions 接口。凭证由 DSH 的环境引用机制解析，浏览器不接触模型 key。

本机通过 `bun run server` 启动时，把变量提供给启动进程；线上由既有 `portal.env` 提供。不自动改写线上配置，也不自动部署。构建仍使用 `bun run build` 和 `bun run --filter '@ai-token-report/server' build:node`。

程序嵌入宿主可以通过 `ServerOptions.assistant` 提供 `model`、`baseUrl`、`retentionDays`，或提供可信的 `assistantEngine` 驱动。HTTP 请求不能指定驱动、模型地址、空间归属或持久化根目录。

## 权限与独立空间

- 复用现有登录、Cookie/Bearer 与 `stats:read` 权限，没有第二套用户表。
- 目录为 `<dataDir>/assistant/<member_id 的 SHA-256>/<会话 UUID>/`。不使用姓名、浏览器路径或客户端声明的用户 ID。
- 每个身份只可列出、读取、续聊、删除自己的会话，管理员也不能打开别人的会话。
- 统计工具直接调用现有 `StatsRoute.handle()`。每次工具调用重新鉴权，数据范围与金额权限沿用看板实现：内置管理员可查部门，其他身份仅本人，点名其他人被拒绝。
- 导航工具 `portal_navigate` 只接受 `shared/src/assistant.ts` 的站内页面白名单，并限制在当前身份有权访问的页面。服务端发送 SSE 导航事件，浏览器通过 Vue Router 执行；工具返回的是“导航请求已发出”。不允许外部网址、任意脚本或任意点击。
- 模型收到的 API 结果去除原始 cwd 与人员姓名，并限制每次明细 50 行、时间窗 31 天、结果 64 KB。工具不重算 token 或金额指标。

## 保存与生命周期

为了支持重启续聊，保存页面对话记录和 DSH 的公开 `Session.snapshotEvents()` 快照。续聊时把快照交给 DSH 的 `agents.create({ seed })` 校验与重放。采用原子文件替换，不依赖 DSH JSONL 后端的 Windows 原生锁。

页面明确告知记录保留期、模型服务会收到查询数据，以及删除会同时移除页面记录和 DSH 快照。默认保留 30 天，启用助手后启动时和每小时清理过期会话；运行中的用户空间不参与清理。部署者须同时备份 `dataDir/assistant`，只备份 MySQL 不包含对话记录。

每用户同时一轮，全局最多四轮；每轮最多两分钟、12 步，每会话最多 50 轮，每用户最多 100 个会话。断开 SSE、停止按钮、服务关闭都会取消运行并释放锁。收起悬浮窗仅隐藏 UI，继续运行。

当前面向单个服务端进程与本机持久目录；多实例需要后续增加共享会话存储和分布式单写者锁。助手自身的模型用量暂未接入平台上报链路。

## 验证

```powershell
bun test packages/server/test/assistant.test.ts
bun test packages/server/test/assistant-presentation.test.ts
bun test packages/server/test/serve-node-stream.test.ts
bun test packages/web-portal/test/assistant-stream.test.ts
bun test packages/web-portal/test/assistant-markdown.test.ts
bun test packages/web-portal/test/assistant-csv.test.ts
bun run packages/server/verify/verify-assistant-runtime.ts
bun run typecheck
bun run build
```

运行时哨兵使用回环模型夹具，在 Bun 和打包后的 Node 上实跑 DSH 工具调用、站内导航和事件快照续聊，不消耗真实模型额度。单文件构建使用 `scripts/dsh-bundle.ts` 内联 DSH 包自身的版本信息，避免其 `createRequire(import.meta.url)("../package.json")` 在打包后读错位置。
