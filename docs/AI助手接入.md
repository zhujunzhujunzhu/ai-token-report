# 部门 AI 助手接入

部门后台右下角提供全局悬浮小球。展开后是可拖动的聊天窗口，不遮断页面操作；切换页面、收起窗口不会终止对话。「我的对话」从窗口左侧展开，桌面端自动加宽，窄屏在窗口内展开侧栏。支持新建、续聊、停止、删除和查询来源展示。

回答运行中仍可新建对话或从「我的对话」切换、返回，原会话在后台继续运行。列表标注运行状态与排队数量；各会话独立保留输入草稿、待发附件、消息和队列，后台会话的导航不会切走当前页面。输入框保持可编辑，Enter 或「排队发送」默认把消息排在当前回答后，按顺序逐条发送；排队消息可移除。停止、断网或请求失败会暂停该会话的队列并保留待发内容，点击「继续发送」后恢复。草稿与队列保存在本次页面内，刷新或退出登录后不会自动发送。

「立即引导」把文字追加给当前运行的 DSH agent，在下一步边界生效，保留已输出的内容；引导消息随历史保存。附件仍走排队发送。引导绑定会话与本轮 `run_id`，旧轮次结束后拒绝迟到请求；首问没有授权的管理写入或 HTML 分享须排队成为新轮次，不能通过引导扩大本轮工具权限。

输入框支持选择、拖拽附件和粘贴图片；发送前可预览图片、移除文件，也可以只发送附件。支持 PNG/JPEG/WebP/GIF、Word `.docx`、Excel `.xlsx`、PowerPoint `.pptx` 以及常见文本、CSV、JSON、日志和代码文件。旧版 `.doc/.xls/.ppt`、加密文件和宏格式需先转为支持的格式。Office 解析提取段落、表格、工作表和幻灯片文字，不执行宏、外链或文件内容里的指令，不提取 Office 内嵌图片。Excel 使用文件中保存的数值，不执行或重算公式。

每次最多6个附件、合计20 MiB；Office/文本单个最多10 MiB，图片单个最多5 MiB、单边4096像素、总像素4,194,304。每轮提取正文最多60,000字符，超出部分明确标注截断。原文件随私有会话保存，历史中可下载，删除会话时一并删除；下载复验当前权限，附件不会自动公开或生成分享链接。上传内容会发送给服务端配置的模型处理。

图片理解需配置具备视觉能力的真实模型，并显式设置 `ATR_ASSISTANT_SUPPORTS_IMAGES=1`（嵌入配置为 `supportsImages: true`）；默认关闭时页面说明原因，Office/文本仍可解析。此开关声明模型能力，不会让纯文本模型获得视觉能力。图片通过 DSH 公开附件服务以真实图像内容传入模型，后续会话可重放。损坏文件、类型不匹配、空文件、大小或压缩解包超过限制会在调用模型前拒绝整批，保留输入草稿供修正重试。

常规问题优先使用 `query_usage`，一次完成精确人员/分组解析、自然日历解析、授权查询和可选展示。Agent 按问题和实际数据选择展示参数，也可只查询后使用 `render_table`、`render_echarts` 或 `render_cards`；查询接口不绑定固定图形。同一数据集可在续聊中改成表格、柱状图、折线图、饼图或散点图，`list_datasets` 可找回已查询的数据。表格支持分页、横向滚动和 CSV 导出；ECharts 通过 dataset/encode 映射现有字段，支持横向柱图与面积折线。展示直接使用统计 API 的值，模型仅选择类型与列名，不生成数字、脚本或任意 option。比率与计数分图、分组多对多不画份额饼图，空值保留；金额仍沿用原有权限与未计价、多币种语义。超过展示上限时明确注明截断，CSV 只导出本次返回的数据。

回答支持 Markdown 标题、列表、引用、代码块与表格。渲染器禁用原始 HTML 和图片；Markdown 来源与裸网址链接只接受绝对 HTTP(S)，在独立标签打开并设置 `noopener noreferrer` 与 `no-referrer`。邮箱、裸域名、脚本协议、带凭据的 URL 与任意相对链接不会自动变成链接；站内跳转统一通过已鉴权导航工具。查询快照随对话保存，历史查看展示原查询时刻的数据。

工具开始、完成和失败通过 SSE 实时更新；同一次调用共用 ID，界面合并成一行，重试保留独立记录。回答通过 DSH 公开 `agent/assistant-stream` 的文本增量事件实时输出，不等整段答案完成；不向浏览器透传思考内容。停止或断网后，仍在运行的调用显示未完成。进度使用查询/图表等业务名称，不向页面透传 SDK 原始异常。

底层直接装载锁定版本的 DSH 公开包：`dsh-agent`、`dsh-agent-loop`、`dsh-session`、`dsh-system-prompt`、`dsh-tools`、`dsh-llm` 与 DeepSeek / pi-ai 适配器。没有另写模型调用循环。每次对话运行创建独立 Cordis 上下文，工具包括结构化统计查询、数据集与展示、站内导航、有限管理读写、公开联网和私有文件生成。修改工具仅在本轮用户明确提出新增、编辑、启停或删除时挂载；HTML 分享工具仅在本轮主动要求分享时挂载。

## 启用

助手默认关闭。在服务端进程的环境里配置后重启：

```dotenv
ATR_ASSISTANT_ENABLED=1
ATR_ASSISTANT_PROTOCOL=openai-completions
ATR_ASSISTANT_BASE_URL=https://your-provider.example/v1
ATR_ASSISTANT_API_KEY=<appKey>
ATR_ASSISTANT_API_KEY_ENV=ATR_ASSISTANT_API_KEY
ATR_ASSISTANT_MODEL=<服务端真实模型 ID>
```

根目录 `.env` 已留带中文注释的空配置，默认关闭。填写 baseUrl、appKey、model 后设置 ENABLED=1 并重启。协议可选 `openai-completions`（Chat Completions）、`openai-responses`、`deepseek-messages`。OpenAI 协议的 baseUrl 包含版本路径（如 `/v1`），完整端点后缀会自动去除。旧配置未指定协议时仍默认 DeepSeek Messages 与 `DEEPSEEK_API_KEY`。凭证只在服务端使用；`.env` 不入 Git。

`ATR_ASSISTANT_MAX_TOKENS` 控制每次模型请求的输出额度（正整数，最多 131072；未配置时仍为 4096）。思考模型可能把思考内容也计入此额度，额度过低会在正文出现前截断。Qwen3.8 的 `openai-completions` 接入可显式设置 `ATR_ASSISTANT_REASONING_EFFORT=off|low|medium|high|xhigh`；其他模型或协议暂不接受此项。线上 Qwen3.8 使用 `MAX_TOKENS=16384` 与 `REASONING_EFFORT=low`，通过公开 DSH 适配器发送思考力度并保留历史 `reasoning_content`，不同时发送 `thinking_budget`。参数含义见[百炼官方接口文档](https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-chat-completions/)。

模型以 `max-tokens` 结束时，页面明确提示输出达到上限并保留本轮问题、附件与已有正文，等待用户继续；不自动重跑已可能执行管理操作的轮次。服务端日志只记录终止分类，不记录模型思考、正文或原始上游错误中的凭证。


本机通过 `bun run server` 启动时，把变量提供给启动进程；线上由既有 `portal.env` 提供。不自动改写线上配置，也不自动部署。构建仍使用 `bun run build` 和 `bun run --filter '@ai-token-report/server' build:node`。

程序嵌入宿主可以通过 `ServerOptions.assistant` 提供 `model`、`baseUrl`、`protocol`、`apiKeyEnv`、`retentionDays`，或提供可信的 `assistantEngine` 驱动。HTTP 请求不能指定驱动、模型地址、空间归属或持久化根目录。

## 权限与独立空间

- 复用现有登录、Cookie/Bearer 与 `stats:read` 权限，没有第二套用户表。
- 目录为 `<dataDir>/assistant/<member_id 的 SHA-256>/<会话 UUID>/`。不使用姓名、浏览器路径或客户端声明的用户 ID。
- 每个身份只可列出、读取、续聊、删除自己的会话，管理员也不能打开别人的会话。
- 会话保存创建时的人员、角色、权限与分组范围。范围变化后拒绝读取和续聊旧会话，不能把已保存的历史文本或文件当作当前授权数据；运行中发现范围变化会中止后续工具。旧版没有会话范围的记录，仅在全部已保存数据集都带有一致的权威 `scope` 时迁移，不根据姓名、当前身份或部分数据集猜测授权。
- 统计工具直接调用现有 `StatsRoute.handle()`。每次工具调用重新鉴权，数据范围与金额权限沿用看板实现：内置管理员可查部门，其他身份仅本人，点名其他人被拒绝。
- 导航工具 `portal_navigate` 只接受 `shared/src/assistant.ts` 的站内页面白名单，并限制在当前身份有权访问的页面。服务端发送 SSE 导航事件，浏览器通过 Vue Router 执行；工具返回的是“导航请求已发出”。事件可以携带人员、分组、时间、供应商、模型、来源等结构化筛选，统计页沿用现有筛选入口查询，绝对时间窗口保留原毫秒边界；管理页携带 `search` 后会同步搜索框与列表。禁止外部页面、任意脚本或任意点击。
- 原始 cwd 不传给模型。基础统计工具默认匿名化人员；常规查询只保留当前授权结果中的人员/分组名称，不发送完整人员目录。姓名完全匹配，同名或未找到直接返回澄清结果，不选择第一位或改查默认范围。
- 聚合与按日趋势最多查询366天，明细与小时查询仍限31天，每次明细最多50行。会话保存最多400行供表格/图表使用，常规工具给模型最多12行预览，附真实日期、格式化指标及趋势首尾/峰值；超过上限明确说明。基础统计不保存数据集时仍限制64 KB。工具不重算 token 或金额口径。

## 管理动作、联网与文件

`portal_manage_query` 查询当前身份有权查看的人员、分组、角色、供应商模型规则、项目规则与模型单价。`portal_manage_save` 在本轮用户明确要求直接新增、修改、保存或写入时挂载，通过生产管理路由直接保存，复用 shared schema、事务审计、版本与最后管理员护栏，不直接写 SQL。支持人员姓名/分组归属、分组名称、归一化规则和模型单价；更新前精确查询目标 ID，不允许替换规则业务键而偷偷新建。“是的直接帮我新建两条”等肯定续聊可以启用写入，纯“是的”、查询、否定与填写弹框请求不能授权直接保存。供应商归一化的每个原值分别保存一条映射，`provider` 是原值，`alias` 是统一名称。既有 `portal_manage_mutate` 保留兼容，并承接删除和启停。角色权限、登录账号和完整凭证操作仍打开对应管理页；原始用量没有任意编辑或删除入口。

`portal_open_form` 请求浏览器打开人员、分组、供应商模型规则、项目规则或模型单价的现有新建/编辑弹框，允许部分预填；用户可以修改补齐后点击页面原有保存按钮。工具本身不写入数据库，返回 `executed:false` 与等待填写保存状态。更新表单必须提供查询得到的精确 `target_id`，服务端读取真实对象并保留不可变业务键；秘密、账号、角色与权限不能预填。每次调用重新校验当前权限，页面保存时仍由管理接口鉴权。SSE 的 `open_form` 只交给当前实时对话；预填值仅保存在浏览器内存，不放到网址或本地持久存储，查看历史不会重开弹框。已打开的编辑草稿不会被新请求覆盖；被路由权限守卫拦截时清理待打开请求。

删除规则/单价与停用人员/分组/规则先生成独立确认卡，不立即写入。卡片显示具体对象和后果，用户必须点击“确认删除”或“确认停用”；聊天中的同意不会执行。服务端动作绑定人员、登录会话、对话、目标快照，默认 10 分钟有效，单次消费；确认时重新鉴权并在事务内核对目标快照。取消、过期、对象变化、权限变化、重复确认均不会执行原计划。人员与分组无物理删除；停用人员会关闭登录并吊销现有凭证，重新启用不会自动恢复它们。已挂载管理页在编辑或确认成功后重新取数。

`web_search` 搜索公开互联网，`web_read` 读取公开 HTTP(S) 网页。请求限制时间、字节数与跳转，检查 DNS 与每次重定向，禁止内网、回环、链路本地、凭据和非标准端口。网页文字是不可信资料，不能扩大本轮操作范围；联网工具不携带后台 Cookie、模型密钥或平台统计。回答可以点击来源核对，网络失败会明确显示失败。

`create_file` 生成当前私有会话中的 docx、xlsx、html、md、csv、txt，浏览器文件卡可以直接下载。统计表格使用已授权数据集的原值，附查询窗口、生成时间和截断说明；下载重新核对身份与数据权限，不接受任意磁盘路径。Word 与 Excel 使用实际 OOXML 容器，CSV 防公式注入，HTML 是安全静态内容，不执行模型脚本。文件与对话一并保存，删除对话后文件不再可访问。

生成 HTML 默认私有。用户明确要求分享，或在文件卡点击“创建分享链接”后，才创建公开链接；持有链接者无需登录即可查看文件内容，包括其中的数据。有效期为 1～720 小时，页面提供 1 小时、24 小时、7 天、30 天，默认 24 小时；显示实际到期时间并提供复制与撤销。分享为文件快照，高熵令牌不包含人员或文件路径；到期、撤销、对话删除或主人权限变化后停止访问。公开 HTML 配置隔离 CSP、禁止索引和缓存。对话正在运行时，页面暂时禁用确认与分享修改，避免与同一用户的运行锁冲突，下载仍可使用。

需求边界、管理 API 映射与正反向验收清单见 [AI助手能力扩展方案与用例](AI助手能力扩展方案与用例.md)。

询问“目前对外开放的 HTML 页面有哪些”或“已分享报告的链接和有效期”时，助手调用只读 `list_shared_html`，跨当前账号所有历史对话查询仍有效的 HTML 分享，返回真实标题、链接与北京时间到期时间。已到期、已撤销、原对话或 HTML 文件已删除、当前权限已变化的分享不计入。每页默认 50 条、最多 100 条，通过 `next_offset` 继续查询；回答注明当前账号范围和分页状态。管理员也只能查询自己的助手文件。查询不会新建分享、续期或撤销，也不会用站内后台路由代替公开报告。

## 保存与生命周期

为了支持重启续聊，保存页面对话记录和 DSH 的公开 `Session.snapshotEvents()` 快照。续聊时把快照交给 DSH 的 `agents.create({ seed })` 校验与重放。采用原子文件替换，不依赖 DSH JSONL 后端的 Windows 原生锁。

对话默认永久保存，只有用户手动删除时才同时移除页面记录和 DSH 快照。`retentionDays` 缺省或为 `null` 时不启用过期清理；程序嵌入宿主仍可显式设置 1～365 天的有限保留期，此时启动时和每小时清理过期会话，运行中的用户空间不参与清理。部署者须同时备份 `dataDir/assistant`，只备份 MySQL 不包含对话记录。

浮动助手窗口支持标题栏拖动、右下角拖拽调整大小，以及标题栏的放大／还原按钮；收起、调整大小和页面跳转不会销毁当前对话。

输入框默认显示四行，随内容最多自动扩展到八行，也可拖动输入框右下角调整高度。Enter 直接发送，Alt+Enter 在光标处换行；中文输入法选字回车不会发送，按住回车不会重复提交。

每会话同时一轮，同一用户可并行运行不同会话，全局最多四轮；每轮最多两分钟、12 步，每会话最多 50 轮，每用户最多 100 个会话。断开 SSE、停止按钮、服务关闭都会取消运行并释放锁。收起悬浮窗、切换对话仅改变 UI，继续运行。任一会话正在运行期间，确认管理动作、修改文件分享与删除历史仍暂时禁用，避免和用户私有文件的写入冲突。

当前面向单个服务端进程与本机持久目录；多实例需要后续增加共享会话存储和分布式单写者锁。助手自身的模型用量暂未接入平台上报链路。

## 验证

填写 `.env` 后，运行 `bun run --filter '@ai-token-report/server' verify:assistant:live`。这是付费模型的真实调用：使用隔离 SQLite 合成用量，通过真实 HTTP/SSE 请求助手，验证查询→表格→复用柱图→复用饼图→导航与私有历史；数字逐项对照 SQL，失败返回非零。不读取线上业务库，也不输出密钥。`--check` 仅检查配置是否齐全，无模型调用；尚未填写会明确输出 `LIVE_TEST_PENDING`，不视为真实模型验收通过。

加 `--natural` 使用普通中文提问，不在问题中提供工具名或字段名；额外验证折线趋势与总览指标卡。2026-10-09 已用本机填写的实际模型配置完成标准验收与自然语言验收，两次均为 `LIVE_TEST_OK`，展示值与 SQLite 查询逐项一致。

常规用例回归运行 `bun run --filter '@ai-token-report/server' verify:assistant:eval`，覆盖年度点名、自然月份、模型筛选、排行、续聊、两期比较、图表复用、权限、同名、空数据、缓存、未计价与导航等24项。用例、性能基线和实测结果见 [AI助手用例与验收](AI助手用例与验收.md)。报告写入忽略目录 `.artifacts/assistant-eval`，不含凭证。

数据集存于各自会话 `dsh/datasets.json`，最多 20 个。渲染和目录工具重新鉴权；成员、角色、权限或分组变更后需新建会话重新查询，旧会话不会继续重放历史快照。SSE 后台任务不继承请求数据库作用域，各次工具调用独立开关连接。

## 线上配置与部署验收

经部署授权后，使用 `bun --env-file=.env scripts/deploy-assistant-config.mjs --apply` 同步本地已验证的协议、baseUrl、model 和对应密钥。仅更新 `/root/.atr/portal.env` 中的助手配置，原文件先备份为 `portal.env.assistant-backup-<时间戳>`；候选文件通过 Bash 语法检查后原子替换，权限为0600。凭证通过 SSH stdin 传输，不进入命令行、代码或报告。`--check` 核对远端配置是否与本地一致，仅输出布尔结果。

随后使用仓库的 `deploy:server:preflight`、`deploy:server:apply` 构建、上传、备份切换和重启。助手配置备份独立于产物备份，回滚时需要同时考虑两份；助手历史应备份服务端实际 `dataDir/assistant`。不要将本机历史 SQLite 的临时兼容产物当正式部署产物。

部署后运行 `bun packages/server/verify/verify-assistant-online.mjs`。脚本通过服务器已保存的管理员配置完成公网验证码与 Cookie 登录，使用实际线上统计数据，验证年度精确人员、模型表格、数据集复用柱图与饼图、站内导航事件、趋势和私有历史。展示数值与相同条件下的统计 API 逐项核对，记录首个文字、首个展示和总耗时。不会写入测试用量、修改人员或价格；测试对话最后删除并登出。报告仅含检查项与耗时，落在 `.artifacts/assistant-online/latest.json`。这项验收覆盖公网 HTTP/SSE 链路，浏览器拖拽和图表视觉交互需另行检查。

```powershell
bun test packages/server/test/assistant.test.ts
bun test packages/server/test/assistant-presentation.test.ts
bun test packages/server/test/assistant-actions.test.ts packages/server/test/assistant-artifacts.test.ts packages/server/test/assistant-network.test.ts packages/server/test/assistant-navigation.test.ts
bun test packages/server/test/assistant-shared-html.test.ts packages/server/test/assistant-intents.test.ts
bun test packages/server/test/assistant-forms.test.ts
bun run packages/server/verify/verify-assistant-capabilities.ts --mysql
bun run packages/server/verify/verify-assistant-capabilities-live.ts
bun --env-file=.env run packages/server/verify/verify-assistant-shared-html-live.ts
bun --env-file=.env run packages/server/verify/verify-assistant-management-live.ts
bun run packages/server/verify/verify-assistant-capabilities-online.mjs
bun test packages/server/test/serve-node-stream.test.ts
bun test packages/web-portal/test/assistant-stream.test.ts
bun test packages/web-portal/test/assistant-conversations.test.ts
bun test packages/web-portal/test/assistant-markdown.test.ts
bun test packages/web-portal/test/assistant-csv.test.ts
bun test packages/web-portal/test/assistant-capabilities.test.ts packages/web-portal/test/assistant-navigation.test.ts
bun test packages/web-portal/test/assistant-forms.test.ts
bun run packages/server/verify/verify-assistant-runtime.ts
bun run packages/server/verify/verify-assistant-runtime.ts openai-completions
bun run packages/server/verify/verify-assistant-runtime.ts openai-responses
bun run packages/server/verify/verify-assistant-runtime.ts openai-completions --live-http
bun run typecheck
bun run build
```

运行时哨兵使用回环模型夹具，在 Bun 和打包后的 Node 上实跑三个协议的 DSH 工具调用、表格/柱图/饼图复用、站内导航和事件快照续聊，不消耗真实模型额度。`--live-http` 还会实跑完整 HTTP/SSE 与 SQL 链路并验证连接释放，输出 `LOOPBACK_TEST_OK`；只有填写实际模型配置后运行 live 验收命令才是 `LIVE_TEST_OK`。单文件构建使用 `scripts/dsh-bundle.ts` 内联 DSH 包自身的版本信息，避免其 `createRequire(import.meta.url)("../package.json")` 在打包后读错位置。

能力扩展验收分别覆盖回环模型与真实数据库、真实模型自然中文、公网上线链路。`verify-assistant-capabilities.ts --mysql` 只使用可创建随机隔离 schema 的开发连接；`verify-assistant-capabilities-live.ts` 使用隔离 SQLite，验证查询、文件、分享、编辑、待确认删除、联网与导航。公网脚本只查询登录者本人最近七天的概览、生成自己的 Word/Excel/HTML 文件，验证下载、24 小时分享、匿名访问、撤销 410、公开网页引用和导航事件，最后清理自己的会话与附件，不修改生产管理数据。报告仅保存固定检查项和耗时；实际发布结果及未完成的验收项见 [2026-10-10 能力扩展部署验收](AI助手能力扩展部署验收-20261010.md)。
