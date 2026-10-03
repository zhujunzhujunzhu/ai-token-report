# AGENTS.md

AI token 用量统计平台。四种形态：**CLI / 本地页面 / 部门看板 / DSH 插件**。

本文件是**指针与约束**，不是文档。架构细节在 `ARCHITECTURE.md`，不要在这里复述。

---

## 运行时与工具

- **包管理器 / 运行时：`bun`** —— 不要用 `npm` / `yarn` / `pnpm`
- **测试：`bun test`** —— 不要引入 vitest / jest
- **类型检查：`bun run typecheck`**（逐包 `tsc --noEmit` / `vue-tsc`）
- **构建两个 web：`bun run build`**
- `bunfig.toml` 里 `exact = true`：新增依赖会被锁精确版本，不要改成 `^`

## 常用命令

```bash
bun install
bun test                        # 不带 MySQL：1610 pass / 13 skip / 0 fail；
                                # 带 ATR_V4_TEST_MYSQL_URL：**1626 pass / 0 skip / 0 fail**（那 13 条 MySQL 用例实跑）
bun run typecheck               # 7 个包全部 exit 0
bun run build                   # web-local + web-portal 均构建成功
bun run stats -- --period today # 终端统计（读本地库：**热态 ~0.2s**；首次冷建库含全部来源 ~13s，见 benchmark:sources）
bun run stats -- --period today --no-db   # 直扫日志（与库结果做对照）
bun run stats -- --discover               # 本机有哪些 DSH home（逐根会话数 / 最新写入）
bun run stats -- --dsh-home ~/.dsh --dsh-home "$env:APPDATA/dsh-desktop/harness"   # 固定多根
bun run stats -- --dsh-homes "$HOME/.dsh;$HOME/AppData/Roaming/dsh-desktop/harness"  # 一次给多个
bun run web                     # 本地页面（需先 bun run build:local）
bun run --filter '@ai-token-report/server' start   # 部门服务端 → 8787/api/health（本机 SQLite + 回环时自动备好 <数据目录>/server.env）
bun run dev:local               # web-local 开发服务器
bun run build:portal            # 部门看板构建产物（server 自动托管 packages/web-portal/dist）
bun run dev:portal              # web-portal 开发服务器（5198，/api 代理到 8787）

# 上报链路端到端（真 HTTP，不是 mock；改上报相关代码后全跑）
bun run packages/server/test/e2e-ingest.ts           # 服务端侧 POST /api/v1/token-usage（37 项）
bun run packages/cli/verify/verify-report-ingest.ts  # ④整条链 CLI report → 服务端 → 库（37 项；含★非 DSH 来源 Codex
                                                    # 也上报、且 source 落到 usage_event.source —— 真 HTTP + 真库）

# 人员管理与权限端到端（真 HTTP；改 admin 路由 / 数据库身份 / 角色后全跑）
bun run packages/server/test/e2e-admin.ts            # 签发即刻生效 + 401/403 + 护栏 + appKey 列表 + 分组多对多 + 供应商归一化 + 模型单价 + 数据范围（185 项；`--mysql` 同款）

# 分发面契约（100 项，含 S12.3 的静态托管断言与分组目录 / 供应商归一化 / 模型单价路由族 / 来源目录 / 看板金额门禁 / **看板数据范围** / 旧路径 404；改 app.ts / 路由 / 方法 / 状态码后必跑）
# ⚠️ 它里面有一条会**冷建本机库**（`GET /api/v1/local/stats/overview`，单条 5 秒超时）：
#   与 `bun test` 全仓或其他重活**并发**跑会超时，并让临时目录清理跟着 `EBUSY` 失败（实测 2 条 fail）。
#   要跑就单独跑（本仓实测 100 pass / 5.34s）。
bun test packages/server/test/http-contract.test.ts

# 双轨对照验证（真实日志上跑 SQL vs 直扫，断言两者逐位一致）
bun run packages/cli/verify/verify-db-parity.ts

# 双运行时驱动对照（Node 的 node:sqlite vs Bun 的 bun:sqlite，逐行比对）
bun run --filter '@ai-token-report/core' verify:drivers

# ★ 多 home 语义正确性（62 项；加 `-- --real` 是 66 项）：并集 ≡ 把日志物理合并到一个根 /
#   顺序无关 / 嵌套 / 冲突 / 规模 / 大小写变体 / 符号链接 / 「存在但读不了」vs「不存在」
#   默认用合成日志（静止、可控，能断言严格相等）；`-- --real` 用本机真实日志只读复验
#   （真实日志是**活的**：跨扫描的严格相等不成立，故按「手工并集 ⊆ 并集 + 并集单调」断言）
#   本机构造不出的条件**如实跳过**（如 Windows 上 chmod 造不出 EACCES），不假装通过；
#   发现的口径不一致按「观察项」列出，不计失败但会显现出来
bun run --filter '@ai-token-report/core' verify:multi-home
bun run --filter '@ai-token-report/core' verify:multi-home -- --real

# ★ 多 home 性能（11 项）：成本随**文件数**走而非事件数、去重不省扫描、多根无额外开销
#   合成场景只用临时目录；`-- --real` 只读本机真实日志（库一律落临时目录，不写 dataDir）
bun run --filter '@ai-token-report/core' benchmark:multi-home
bun run --filter '@ai-token-report/core' benchmark:multi-home -- --real

# ★ 多来源（纯文本：Codex / Claude Code / Trae / WorkBuddy）性能（8 项）：
#   热态成本**只随文件数**走（每文件一次 stat，一条 JSON 都不解析）、冷态与直扫都随**字节数**走、
#   只改一个文件时只重解析那一个、镜像根去重不省 IO。合成场景只用临时目录；
#   `-- --real` 只读本机真实日志（库一律落临时目录）。改采集路径 / 加来源后必跑
bun run --filter '@ai-token-report/core' benchmark:sources
bun run --filter '@ai-token-report/core' benchmark:sources -- --real

# ★ Codex 来源（rollout JSONL：Codex CLI / Desktop / VSCode 扩展共用）：
#   格式哨兵（合成 30 项 + `--real` 34 项）。`--real` 只读本机 ~/.codex
#   核心口径：`cached_input_tokens` 与 `cache_write_input_tokens` **都含在** `input_tokens` 内
#   ⇒ 必须减（与 DSH 相反）；同一次调用会写两条同值 `token_count`（逐行相加正好翻倍，
#   故按累计快照是否推进去重）；两代遥测并存时**先出现的代际说了算**；
#   幂等键主体是**文件名里的 uuid**（信封 `session_id` 实测 51 个文件与文件名不符，
#   多文件共用同一个信封 id ⇒ 拿它当键会静默丢数）。改适配器 / 升级 Codex 后必跑
bun run --filter '@ai-token-report/core' verify:codex-format
bun run --filter '@ai-token-report/core' verify:codex-format -- --real

# ★ Claude Code 来源：格式哨兵（合成 15 项 + `--real` 7 项）。`--real` 只读本机 ~/.claude
#   核心口径：同一次调用会被写成 1~4 行（message.id 相同、uuid 各不相同）——
#   不去重则总量**正好翻倍**（本机实测 63,842,793 → 126,348,873）。
#   改适配器 / 改四列映射 / 升 Claude Code 版本后必跑
bun run --filter '@ai-token-report/core' verify:claude-code
bun run --filter '@ai-token-report/core' verify:claude-code -- --real
bun test packages/core/test/claude-code-source.test.ts

# ★ Trae 来源（**两个发行版 = 两个来源**：国际版 trae / 国内版 trae-cn）：
#   格式哨兵（合成 46 项 + `--real` 9 项）。`--real` 只读本机 %APPDATA%\Trae\logs
#   核心口径：`prompt_tokens` **含** cache_read / cache_creation ⇒ 必须减
#   （与 Claude Code **相反**；不减则总量 10,870,794 → 20,928,266，1.93 倍）。
#   模型名不在用量事件里（`name` 实测恒空）⇒ model 恒 (unknown)、这一源配不上价；
#   cwd 恒 null（一个日志文件实测跨 7 个工作区）。改适配器 / 升级 Trae 后必跑
bun run --filter '@ai-token-report/core' verify:trae
bun run --filter '@ai-token-report/core' verify:trae -- --real
bun test packages/core/test/trae-source.test.ts

# ★ WorkBuddy 来源（`~/.workbuddy/projects/<cwd 压缩名>/<sessionId>.jsonl`）：
#   格式哨兵（合成 43 项 + `--real` 10 项）。`--real` 只读本机配置目录
#   核心口径：`prompt_tokens` **含**缓存命中 ⇒ 必须减（与 Codex / Trae 同）；
#   缓存字段顺序 = prompt_cache_hit_tokens > cache_read_input_tokens（后者实测恒为 0，
#   写反则输入与缓存整块对调）；用量挂在「该响应的最后一行」**行类型不固定**
#   （实测 3/4 落在 function_call，只认 message/assistant 会漏掉工具轮次）。
#   **两代格式并存**：老代际（migratedFrom agent-history）没有缓存字段、每个用户轮次
#   只落最后一次调用 ⇒ 命中率被系统性低估（`workbuddyUsageWithoutCache` 计数，本机 6/10）；
#   其 `timestamp: 0` 必须跳过（退化成 1970 = 用量静默落到时间窗之外）。
#   改适配器 / 升级 WorkBuddy 后必跑
bun run --filter '@ai-token-report/core' verify:workbuddy
bun run --filter '@ai-token-report/core' verify:workbuddy -- --real
bun test packages/core/test/workbuddy-source.test.ts

# MySQL 方言活体验证（17 项；需要可创建隔离 schema 的测试连接；只建/删自己随机测试库）
# 本机可用开发 Docker 管理连接；别的机器用 ATR_MYSQL_URL，禁止拿业务库做建删演练
bun run --filter '@ai-token-report/core' verify:mysql

# ★ Bun 的 MySQL 认证边界（12 项；需要可建临时用户的测试连接，用完自动删用户）
#   Bun 1.4.2 在**非 TLS** 下对口令 ≥20 字节的 caching_sha2_password 会 errno 1045
#   （oven-sh/bun#26195）→ openMysqlBackend() 按需自动启用 TLS（planBunMysqlAuth）。
#   这里在真库上钉住「19 字节明文能连 / 20 字节靠自动 TLS 能连 / 关掉修复必复现 1045」。
bun run --filter '@ai-token-report/server' verify:mysql:bun-auth

# ★ 双后端逐位对账（62 项；需要本机可连的 MySQL；改上报库 / 看板查询后必跑）
#   同一批数据起两个服务端（SQLite / MySQL），断言看板每个接口的响应体 JSON 全等
#   （人员目录 `/api/v1/stats/members` 不能逐位比对 —— 两侧 UUID 各自随机生成 ——
#    它比的是名册与分组关联条数）
bun run packages/server/verify/verify-mysql-portal.ts

# ★ 迁移链与回滚（18 项；SQLite + 真 MySQL）：v7 → v8 → **当前版本** 连续升级、
#   事件指纹逐位不变、两轮回滚-再迁移、v9 的加列幂等（列只有一份）。
#   ⚠️ 断言一律对着 `PORTAL_SCHEMA_VERSION`，不许写死版本号（v9 落地时这里误报过）
bun run packages/server/verify/verify-v8-migration.ts
#   各版本自己的用例在：`bun test packages/core/test/portal-v9.test.ts`（v9 加列 / 迁移 / 幂等）
#   与 `portal-v5.test.ts`（v3→v5 真实迁移、备份证明）—— 都要带 ATR_V4_TEST_MYSQL_URL 才实跑

# ★ 断言 zod 没进前端产物（S12.5；shared 根入口一旦 re-export schemas 就会变大且不报错）
bun run --filter '@ai-token-report/shared' verify:bundles

# ★ 运行时 A/B（Node 22 vs Bun）：在**目标服务器上**跑，要 root 与线上库克隆权限
#   结果与结论见 docs/性能：Node22 与 Bun 对比实测.md；夹具说明见 runtime-ab/README.md
#   ⚠️ 会在目标机建一个 atr_http_v5_* 隔离库与一个隔离 MySQL 用户，跑完务必 dispose
node packages/server/verify/perf/runtime-ab/ssh-exec.mjs --out packages/server/dist/main.mjs \
  /data/ai-token-report/packages/server/runtime-ab/main.mjs
node packages/server/verify/perf/runtime-ab/ssh-exec.mjs \
  /data/ai-token-report/packages/server/runtime-ab/fixture.sh setup
node packages/server/verify/perf/runtime-ab/ssh-exec.mjs \
  /data/ai-token-report/packages/server/runtime-ab/run.sh
node packages/server/verify/perf/runtime-ab/ssh-exec.mjs \
  /data/ai-token-report/packages/server/runtime-ab/fixture.sh dispose

# npm 发布产物（独立包 ai-token-usage，命令名 ai-token-report）：构建 + 双运行时端到端验证
bun run --filter '@ai-token-report/cli' build:npm     # 产物落在 packages/cli/dist
bun run --filter '@ai-token-report/cli' verify:npm    # ★ 发布前必跑

# 发布（根目录快捷方式，CLI 与插件各一套；详见 docs/npm发布*.md）
bun run build:npm:cli && bun run verify:npm:cli       # = 上面两条 + web-local build
bun run publish:cli:dry                               # 只断言 tarball，不发布
bun run publish:cli:next   /   bun run publish:cli     # 真发：先 next，再 latest
bun run build:npm:plugin && bun run verify:npm:plugin  # 插件同款
bun run publish:plugin:dry / :next / publish:plugin    # 插件同款
bun run publish:dry                                   # 两个包一起 dry-run
bun run publish:plugin:quick / publish:cli:quick       # 快速通道：只验目标包（构建 + verify:npm + tarball 真启动），
                                                       # 跳过全仓单测 / e2e / 对账 / MySQL / 两种 Web；跳过项会逐条打印
                                                       # 并写进 report.json（mode/skipped）。边界见 docs/发布检查与事故恢复.md

# 部门服务端部署（本地构建 → 上传 → 切换 → 重启；见 docs/服务器部署.md）
# ★ 与上面的 npm 发布是两件事：这条送产物到 117.72.173.21，那条发到 registry
bun run deploy:server            # dry-run：只本地构建 + 打包，不连服务器
bun run deploy:server:preflight  # 上传到服务器 /tmp 并校验，不切换不重启
bun run deploy:server:apply      # 真部署：备份 → 切换 → 重启 → 健检，失败自动回滚
# ⚠️ 运行时也在部署脚本内：`--runtime bun|node`（缺省 bun）会渲染并安装仓库里的
#    deploy/atr-server-start.sh（先备份、失败连它一起回滚），重启后断言进程真的 exec 在
#    那个二进制上。`--runtime bun` 还要求产物含 planBunMysqlAuth（长口令 TLS 修复），
#    否则**上传之前**就拒绝 —— 线上 atr_user 口令 32 字符，切错会 errno 1045。
#    规则在 scripts/deploy-plan.mjs，由 packages/server/test/deploy-plan.test.ts（10 项）钉住。

# DSH 插件：构建 + 五层验证（从内到外逐层接近真实，改插件后全跑）
bun run --filter '@ai-token-report/dsh-plugin' build
bun run packages/dsh-plugin/verify/verify-plugin.ts         # 真 HTTP 往返 + 面板改会话日志根的就地生效（70 项）
bun run packages/dsh-plugin/verify/verify-cordis-load.ts    # 真 cordis 装载（10 项）
bun run packages/dsh-plugin/verify/verify-resolution.ts     # Node 语义解析（9 项）
bun run packages/dsh-plugin/verify/verify-client-bundle.ts  # ★ 浏览器半产物（40 项，含金额只认字符串 / 不入账的未计价 / 会话日志根那一栏真的在产物里）
bun run packages/dsh-plugin/verify/diagnose-boot.ts web     # 排障：哪个包 import 就炸

# 部门看板（S7 + S8）：SSR 真执行组件树，断言门禁页 / 看板区块 / 统计页不出现金额 / 计价页的单价口径 / 金额三态（无字段 / 未计价 / 有金额）
bun run --filter '@ai-token-report/web-portal' verify

# ★ 费用（估算）四形态的验收（改金额相关代码后按形态各跑一条）
bun test packages/shared/test/price.test.ts               # 口径与格式化（含 modelPriceFromWire 的 NULL 语义）
bun test packages/core/test/local-cost.test.ts            # 离线折叠：换价时刻 / 多币种 / 未计价 ≠ 0 / 快照四态
bun test packages/server/test/local-api.test.ts           # 本地页三条接口的金额（SQL 与直扫逐位一致）
bun run --filter '@ai-token-report/web-local' verify      # 本地页 SSR + 明细表费用列（模板层）
bun test packages/cli                                     # --cost（默认关）+ pricing sync（44 项）
bun run --filter '@ai-token-report/cli' verify:npm        # ★ 发布产物在 Node 与 Bun 上的金额路径
bun test packages/server/test/reconcile-bill.test.ts      # 月度对账（61 项：窗口边界 / 表头 / 退出码）
# 月度账单对账（账单数字**只**出现在这个脚本的输出里，绝不进页面 / 接口 / CLI 统计输出）
bun run reconcile:bill -- --portal-db <库路径|mysql://…> --bill <账单.csv> --period 2026-01
```

✅ 四种形态全部落地。`/api/v1/stats/*` 查询接口（S7）与部门看板页面（S8）
均已实现：上报写 `portal.sqlite`（S3），看板**只读**它，两者是同一条链路的
两端。改看板相关代码后要跑 `packages/server/test/stats-api.test.ts`
（接口与鉴权）、`packages/core/test/portal.test.ts`（查询与人员排行）。

## 目录

| 路径 | 职责 |
|---|---|
| `packages/shared` | **契约单一真源**：上报 DTO、查询响应、口径公式 |
| `packages/core` | **内核**：decode / scanner / aggregate / range / state / format / types / home / identity-store |
| `packages/core/src/db` | ★ **本地 SQLite 增量库**（独立入口 `@ai-token-report/core/db`）：schema / ingest / query / stats / **portal（上报库只读查询）** / **cost（离线金额折叠 + `pricing.json` 快照）** |
| `packages/cli` | **命令入口**：`cli.ts` / `deliver.ts` / `report.ts` / **`cost-view.ts`（`--cost` 三态渲染，零金额算术）** / **`pricing-sync.ts`（`pricing sync`）** |
| `packages/server` | 上报接收 + 本地直查 + 部门统计（含**分组目录与 `by=group` 分组维度**）+ **数据库身份、账号、会话、人员与分组（多对多）管理** + 静态托管 |
| `packages/web-local` | 本地页面（`/api/local/*`） |
| `packages/web-portal` | 部门看板：人员排行 / 趋势 / 分布 / 明细 / 诊断 + **金额（估算）**（概览卡片 / 排行与分布的费用列 / 明细逐条金额 / 趋势费用指标；趋势金额在**多币种或一条价都没配上时禁用并说明原因，不画线**） + **人员管理页（按权限）** + **appKey 管理页（列表按人呈现归属）** + **分组管理页（`/groups`，需 `groups:manage`）** + **供应商归一化页（`/providers`，需 `providers:read`）** + **模型单价页（`/pricing`，需 `pricing:manage`，按供应商分组、逐模型配四类单价与生效区间）**。后台账号登录。看板数据来自 `/api/v1/stats/*`（含分组候选项 `/api/v1/stats/groups` 与人员候选项 `/api/v1/stats/members`）；管理页数据来自 `/api/v1/admin/members*`、`/api/v1/admin/appkeys`、`/api/v1/admin/groups*`、`/api/v1/admin/provider-aliases*` 与 `/api/v1/admin/pricing*`；看板金额的**解释材料**走 `/api/v1/stats/pricing`（`cost:read`，只读单价快照、不含任何用量） |
| `packages/dsh-plugin` | DSH 插件：实时上报 + `token_usage` 工具 + `ctx.tokenReport` 服务 + **界面用量面板（宿主半 + 浏览器半）**。金额（估算）由宿主算好**格式化成字符串**再透传（浏览器半一个 workspace 包都不 import，只排版）；**面板刻意没有金额曲线**（多币种不相加那条规则的唯一实现在部门看板）。见其 `README.md` |

> 迁移期旧目录（`dsh-token-stats/`、`p0-verify/`）**已删除**。
> `dsh-session-inspector/` 也已移除（它是与本项目无关的独立插件）。
> `frontend/` 只剩 `node_modules`/`dist` 残留空壳，**不在 workspace 内、勿改**。

## 改代码前先读

| 要改什么 | 先读 |
|---|---|
| 任何指标 / 口径 | `packages/shared/src/metrics.ts` + `.agents/skills/token-metrics-contract/SKILL.md` |
| 字段 / 接口契约 | `packages/shared/src/protocol.ts` |
| 会话日志解析 | `.agents/skills/dsh-session-log-parsing/SKILL.md` |
| 身份署名 / 归属 | `.agents/skills/identity-attribution/SKILL.md` + `ARCHITECTURE.md` §4.5 |
| **权限 / 人员管理 / token 发放** | `packages/server/src/identity/` + `docs/数据库重设计.md` + `ARCHITECTURE.md` §4.5.5~§4.5.8；`member-admin.ts` 仅历史兼容测试 |
| **工程约定**（命令 / 测试位置 / 命名 / 中文注释 / 依赖） | `.agents/skills/repo-conventions/SKILL.md` + `docs/本仓工程约定.md` |
| 目录分工 / 数据通路 | `ARCHITECTURE.md` |
| **多客户端来源适配器**（新增一个客户端 / 各来源的日志与四列映射） | `packages/core/src/sources/types.ts` 文件头（三步）+ `docs/Codex会话采集方案.md` + `docs/ClaudeCode会话采集方案.md` + `docs/Trae会话采集方案.md` + `docs/WorkBuddy会话采集方案.md` |
| 插件方案（历史） | `docs/插件方案.md` |
| **DSH 插件**（配置 / 安装 / 排障 / 为什么不能碰私有字段） | `packages/dsh-plugin/README.md` |
| **DSH Desktop 桌面端安装**（命令行步骤 / peer 版本窗口 / 验收 / 回滚） | `docs/桌面端安装交付清单.md` + `packages/dsh-plugin/README.md` |
| **server 层分层 / 要不要引入第三方库** | `docs/server架构重构方案.md` + `.agents/skills/repo-conventions/SKILL.md` |
| **部门上报库接 MySQL（方言坑 / 部署 / 备份）** | `docs/mysql上报库.md` |
| **Portal v9 部署 / v4→v5→v6→v7→v8→v9 显式迁移 / 身份导入** | `docs/数据库部署与迁移.md` + `docs/数据库重设计.md` + `docs/汇总表设计规格.md`（v8） |
| **供应商归一化（查询期口径 / 按查看者解析）** | `packages/core/src/db/provider-alias.ts` + `docs/数据库重设计.md` §4.3.1 |
| **分组（多对多）/ 归属展开** | `docs/数据库重设计.md` + `ARCHITECTURE.md` §4.5；归属权威是关联表 `member_group_assignments`，`usage_event.group_name` 只是文本快照 |

---

## 三条铁律

1. **口径只在 `packages/shared/src/metrics.ts` 定义。**
   要算缓存命中率等指标必须调用它。两端口径不一致的 bug 极难排查。
2. **`cacheRead` 不是 input 的一部分。**
   `input` 是「未命中缓存」那部分；实测 `cacheRead` 占总用量 **94.3%**。
   漏掉它等于漏掉 94% 的用量。
   恒等式：`total = input + output + cacheRead + cacheWrite`，**`reasoning` 不在其中**（它是 output 的子集）。
3. **落库必须存 4 个独立列。** 展示时再相加。
   采集端一旦合并，后续任何拆分都无法还原。

## 非显而易见的约束

- **`packages/shared` 不得依赖任何运行时** —— 前端、CLI、插件都要 import 它。
- **命名约定**：DB 列 / HTTP 线上字段用 `snake_case`（`cache_read_tokens`），
  TS 内存类型用 `camelCase`（`cacheReadTokens`）。转换只发生在边界。
- **上报只需 at-least-once**：幂等键 `event_id = ${sessionId}:${seq}`，
  服务端普通 INSERT，仅把事件主键冲突记为重复。外键/CHECK/截断等错误必须回滚并返回非 2xx；插件与 CLI 可同时上报而无需协调。
- **未署名 = 不采集也不上报**。不要加 `unknown` 兜底上报 —— 那是未授权采集。
- **插件 `emit()` 在同步热路径**，只能入队。任何 `await fetch` 都会拖慢 agent loop。
- **🚨 插件的公开方法不得访问 `this.#私有字段`**。cordis 的 `ctx.get(name)`
  返回**服务代理**，而 JS 私有字段穿不过 Proxy —— coordinator 正是通过代理调用
  `emit()`，所以方法体里碰 `#x` 会让**每一次会话事件**都抛
  `TypeError: Cannot access invalid private field`，而单测（拿到真实例）全绿。
  热路径走 `createSink()` 的闭包实现，诊断入口用构造时挂上的自有属性。
  **改插件后必须跑 `packages/dsh-plugin/verify/verify-cordis-load.ts`** ——
  它是唯一能发现这类问题的检查。
- **🚨 插件的 `inject` 必须写在 `default` 导出上，不能写在类上**。
  cordis 读的是**插件条目对象**的 `inject`；类根本不会被实例化
  （`apply()` 是被直接调用的）。写在类上的结果是：插件照常 import、
  `apply()` 也照常跑，但「先等依赖就绪」的语义**静默失效**。
- **🚨 构建插件时不要 external `@ai-token-report/*`**。本仓 workspace 包的
  `main` 指向 `src/index.ts`（Bun 直接吃，**Node 不能**），而 DSH 宿主跑在 Node 上。
  external 出去会让 DSH 加载即失败。同理，动态 import 的说明符要**构建期不可静态分析**
  （用变量拼），否则 bundler 会把 `bun:sqlite` 提到产物的顶层 import。
  这两条都由 `verify/verify-resolution.ts`（Node 语义解析）兜住。
- **🚨 插件与官方 OTel telemetry 后端互斥**：cordis 同一时刻只允许注册一个
  `sessionTelemetry` 服务。装插件必须在 profile 里
  `- id: session-telemetry-otel` + `disabled: true`，
  否则 DSH 启动直接失败（报 service already registered）。
- **🚨 插件的 `peerDependencies` 是「兼容窗口」，不是「同版本」**（当前
  `@deepseek-ai/dsh-{session,session-telemetry,agent}` = `>=0.1.7-rc.2 <0.3.0-0`）。
  宿主启动时由 `dsh-app-boot` 的 `evaluatePluginCompatibility` 逐个 `@deepseek-ai/dsh*`
  peer 做 `semver.satisfies(runtime, range, { includePrerelease: true })`，
  **任一不满足就跳过整个 bundle**（`@deepseek-ai/cordis` 不参与这个判定）——
  表现是「面板不见了 + 一条也不上报」，启动日志只有一行
  `skipping profile bundle …`，**不是报错**。所以钉死精确版本会在每次 DSH 升版时
  把全队变成静默不采集。
  - 范围有**两份真源**（`packages/dsh-plugin/package.json` 与
    `scripts/build-npm.ts` 的发布清单），由 `verify:npm:plugin` 的两条断言钉住：
    两份必须一致；且用**宿主自己那个函数**逐个代际打分 —— 已实测的代际必须被接受、
    未验证的代际（`0.1.6-alpha.2` / `0.3.0-rc.1`）必须被拒，上下界都要钉。
  - 放开范围前必须自己复验这两条实测结论（0.1.7-rc.2 → 0.2.0-rc.2 已复核）：
    ① `@deepseek-ai/dsh-session-telemetry` 的导出/`SessionTelemetryCoordinator`
    签名**只是纯增量**（多一个可选 `sourceEvent`）；② `dsh-session-format*` 全树
    实现文件**逐字节相同**（即落盘日志格式没变，`core` 的 scanner 口径不受影响）。
    复验办法：把新版宿主 `npm install` 到临时目录，用 `ATR_DSH_MODULES` 指向它跑
    `verify:npm:plugin` 与 `verify-profile-boot.ts`。
- **🚨 浏览器半只能 `require` DSH 预置的 9 个模块**（react / react-dom /
  cordis / client-store / ui-slots / ui-primitives / ui-dockkit 这几个）。
  前端只预置这一张表，越界会在**物化阶段**抛错，表现为「插件没起来」。
  最阴的一种是 JSX 走**开发版**转换（`react/jsx-dev-runtime`）—— 所以
  `tsconfig.json` 里必须有 `"jsx": "react-jsx"`（bun build 读的是它）。
  这两条由 `build-client.ts` 在**构建期**断言，`verify-client-bundle.ts` 再验一次。
- **🚨 `dsh.client` 声明缺了 `exports["./client"]`（或产物文件不存在）会让
  DSH 启动直接失败**（`ClientPackageCompositionError`），不是「面板不出现」。
  改完插件要重新 `build`，否则下一次启动就起不来。
- **🚨 界面路由必须挂在 `/api` 下**（`ctx.connection.fetch.register`）。
  DSH 的 web 服务器**不做任何鉴权**；`/api` 前缀由 `dsh-client-connection`
  加了 Host/Origin 栅栏 + 浏览器会话 cookie 校验。裸挂在别的路径上
  等于「监听地址一旦改成 `0.0.0.0` 就向整个内网公开本机用量」。
- **🚨 浏览器半不得重算任何口径**。载荷里的 `metrics` 由宿主用
  `shared/metrics.ts` 算好后透传；页面只做格式化与排版。
  在组件里写一遍除法 = 第二个口径实现，且它不会报错。
- **🚨 插件的 `StatsContext` 三个路径必须是「活取值」，不能改回启动时的快照**。
  面板的「会话日志根」（齿轮「配置」里的文本域，落 `plugin-connection.json` 的
  `dshHomes`，覆盖部署配置；留空 = 清掉覆盖）保存后走 `runtime.refresh()`，
  统计侧靠 getter 现读 `runtime.config()`，UI 的 30 秒 TTL 缓存另有「取数范围指纹」
  （`ui-bridge.ts` 的 `scope`）兜住 —— 三处缺一，表现都是「改完没生效」而**不报错**。
  另：面板刻意**没有** `dataDir`（那会连身份 / 库 / outbox 一起换掉，等于填完变成另一个人），
  它只能在部署配置 / 环境变量里给；面板里也不许出现「算一遍再丢」的金额相关逻辑。
- **插件的 `connection` 是可选依赖，绝不能写进 `inject`**。`inject` 的语义是
  「等它就绪」，而 headless profile 永远不提供它 —— 写进去等于**上报功能在
  headless 下直接不激活**。用 `ctx.get()` 试一次 + `ctx.inject()` 等它出现。
- **`includeContent` 必须保持 `false`** —— 只采 token 数值与模型名，不采对话内容。
- **服务端默认只监听 `127.0.0.1`**。改 `0.0.0.0` 前必须确认凭证已配置。
- **身份以服务端为准**：校验返回的 `name` 只可能来自数据库人员表，
  绝不回显客户端提交的内容。改动此处等于打开冒用身份的口子。
- **🚨 两个署名填写面都只填「服务端地址 + appKey」，且写同一份连接配置**：
  插件面板（`dsh-plugin/src/settings.ts`）与本地页「配置」弹框
  （`web-local` + `server/src/identity-route.ts`）是同一形态 ——
  姓名 / 分组由服务端按 appKey 解析，**界面上不许再出现这两栏输入框**
  （填了也不作数 = 做不到的承诺）。连接配置是
  `<dataDir>/plugin-connection.json`（`core/src/connection-store.ts`：
  路径 / 原子写 / **合并写** 的唯一实现；本地页只动 `baseUrl` + `appKey`，
  插件的间隔 / 位置 / 日志根一个字节都不碰）。地址优先级：
  **页面 / 面板里存过的那份 > 部署参数 `--portal`**；
  `GET /api/local/identity` 回报生效地址用于回填，但**绝不回传 token**。
  地址归一化（`normalizeBaseUrl` / `endpointOf` / `baseUrlOf`）只在
  `shared/src/portal-url.ts` 一份，插件那侧只 re-export。
- **🚨 权限来自数据库角色关系；Bearer 权限还须与 Token scopes 取交集**。
  新上报 Token 默认仅 `identity:read` / `usage:write`，不是后台登录凭证。
  **appKey（插件 / CLI 上报用）走独立端点 `POST /api/v1/admin/members/appkey`，
  范围由服务端固定为 `APP_KEY_SCOPES` = `usage:write` + `stats:read`
  （就是「上报」与「获取统计信息」两条），请求体里给不出更宽的范围**；
  因为不含 `identity:read`，`verifyIdentity` 同时接受 `usage:write`，
  使插件只填 appKey 就能拿到自己的服务端署名（仍然不回显客户端提交的姓名）。
  平台「appKey 管理」页（web-portal `/appkeys`，需 `tokens:manage`）的主体是
  **全部凭证的列表**：每行一把 key，归属由服务端按 `member_id` 关联人员表得出
  （改名后仍指向同一个人），可按人员搜索、可轮换 / 吊销、可设置与修改**有效期**
  （`POST /api/v1/admin/members/tokens/expiry`，`null` = 长期有效；过期只是时间比较，
  所以过期 key 能续期而不必轮换），可**删除**（`POST /api/v1/admin/members/tokens/delete`，
  物理删除：只放行从未上报、也没被审计引用的凭证 —— `usage_event.report_token_id` 与
  `admin_audit_log.actor_token_id` 都是 RESTRICT 外键，被引用时回 `409 token_referenced`
  并提示改用吊销，页面**原样**呈现那条原因；失败不会降级成吊销），**交付信息**（上报 / 统计的完整地址 + 使用人 +
  凭证提示）点开弹框查看。明文仅存于签发 / 轮换响应，库内只有摘要，关掉就找不回来 ——
  所以页面**不把明文放进 DOM**（最多显示 `atr-ab12…ef34` 这种中间省略号遮罩），
  完整值只在剪贴板里，且凭证提示（`token_prefix`）也统一按中间省略号渲染
  （省略号是展示层的事：库里存裸摘要前缀，见 `web-portal/src/utils/credential.ts`）。
  **人员管理页不再承担凭证功能**（无「上报凭证」入口、无「有效凭证」列）：
  人是谁、有哪些角色在那里，key 发给了谁在这里。
  旧客户端兼容字段 `role: admin | member` 缺省 `member`。
  **绝不要用姓名白名单判断管理员** —— 姓名是可以随便改的显示值。
  消费方（页面 / 插件）拿到缺字段的校验响应时**必须按 `member` 处理**：
  默认成管理员意味着「服务端少返回一个字段」直接变成「人人可发 token」。
- **🚨 数据库管理接口的失败使用真实 HTTP 状态**：`401`（身份无效）、
  `403`（权限不足）、`503`（未初始化或数据库不可用）；版本冲突和最后管理员护栏为 `409`，输入错误为 `400`。
  `200 + ok:false` 的旧业务约定只留在历史独立处理器测试，不可照搬到新路由。
- **🚨 生产身份的唯一真值是与用量共用的 portal 数据库**（`server/src/identity/`）。
  人员、分组、角色、账号、Token 摘要、会话、挑战、限流和审计均入库；管理变更和成功审计在同一事务提交。
  写事务锁住 `portal_identity_state` 后重新鉴权，跨进程签发/撤权立即生效，不能用内存长期缓存替代数据库事实。
- **稳定归属使用 `member_id` UUID**；显示姓名允许重复、用户名仍唯一。
  改名或轮换 Token 不改写旧事件快照。历史引用使用 RESTRICT；最后一个仍有管理入口的管理员不可停用、降级或失去最后有效凭证。
- **`credentials.json` 只作为显式离线导入源**：先完成 v7 结构迁移（v4 是冻结基线，v3 库先迁 v4、再迁 v5、再迁 v6、最后 v7），再运行 `packages/server/scripts/import-credentials.ts`。
  `credentials.ts` / `member-admin.ts` 和 `LegacyPortalAuth` 仅保留历史兼容测试；生产启动拒绝 `credentialsPath`，不双写文件。
- **首次管理员初始化只允许空身份库执行一次**：`ATR_ADMIN_USERNAME` / `ATR_ADMIN_PASSWORD` 成对配置，
  `ATR_ADMIN_TOKEN` 可作为初始化输入；密码仅哈希、Token 仅摘要入库。已有初始化标记后重启不会从环境变量复活停用身份。
  后台验证码需要所有实例共享至少 32 字符的 `ATR_CAPTCHA_HMAC_KEY`，密钥不入数据库；**唯一例外是本机自用**：`bun run server` 在本机 SQLite + 回环监听时会把缺失的密钥与随机管理员初始化值写进 `<数据目录>/server.env`（`src/local/dev-env.ts`），配了 `--mysql` / `ATR_MYSQL_URL` 或 `--host` 非回环地址**一律不生成**（各实例各生成一把＝「验证码永远错」，且不报错）。
- **看板的人员筛选是精确匹配、可多选**：新页面使用 `identity_view=member` 及稳定 ID；旧 `user` 视图有同名歧义时明确拒绝，不能静默合并。
  provider / model 才是子串匹配。页面上的**人员候选不带任何筛选参数**（自锁定）：
  从已筛选结果里取候选，选中一个人之后下拉会塌缩成一个选项，使用者再也加不回别人。
  **候选的主来源是人员名册 `GET /api/v1/stats/members`（`stats:read`；`members` +
  `member_group_assignments`），不是用量行** —— 只从用量取候选时，「当前窗口内没有
  用量的人」不会出现，而**选中一个分组之后整个下拉会空掉**（看起来像数据丢了）。
  分组与人员因此是**联动**的：未选分组 = 全部人员；选中分组 = 只列该分组成员，
  同时把分组外的人选从筛选里去掉（服务端按 AND 叠加，留着必然查出 0）。
  收窄只在名册可用时做；名册取不到（旧服务端 / 请求失败）时按原样保留。
  名册接口失败**不拖垮看板**（回落成用量候选），但 401 仍要让会话过期。
  只有「未署名 / 待确认历史」目录里表达不出来，仍由用量行补上。
  实现只此一处：`web-portal/src/types/portal.ts` 的 `memberFilterOptions()`。
  ⚠️ 人员下拉**只对能看到全员的人出现**（`session.scopedToSelf` 为假）；
  只看自己的身份**既没有这个下拉，也没有任何替代提示** —— 页面不替服务端解释数据范围，
  更不在筛选栏里宣布使用者的身份（真正的收窄在 `applyDataScope()`，与页面画了什么无关）。
- **看板的厂商筛选是「多选 + 可搜索 + 可新建」，每个值仍是子串匹配**：
  候选 = `GET /api/v1/stats/providers`（`stats:read`；库里出现过的名字，**按查看者
  归一化后的展示名**，与筛选匹配共用同一份映射）**∪ 使用者在本机浏览器里自建的名字**
  （`allow-create`，落 `localStorage`；合并规则只在
  `web-portal/src/types/portal.ts` 的 `providerFilterOptions()`，同名以目录为准）。
  🚨 **自建项绝不写库**：供应商名是用量行上的事实，库里那份可编辑配置是归一化规则
  （`provider_alias`）—— 往库里插一个没有用量、没有价格的「供应商」只会得到一个
  永远查不出数据的幽灵选项，而且没有任何地方能删掉它。
  线上是**一值一个同名参数**（`?provider=a&provider=b`，服务端也接受逗号分隔）；
  候选目录**不带任何筛选**，否则选中一项后下拉会塌缩成一项（自锁定）。
  目录失败**不拖垮看板**（回落成「自建的 + 现敲现用」），但 401 仍要让会话过期。
- **🚨 金额一律在查询期现算，绝不存 `cost` 列**（v7 起有了单价来源：`model_price` 表 +
  `packages/shared/src/price.ts`，故旧的「不展示金额」决策**已作废**）：
  - **部门看板现在会显示金额**：`/api/v1/stats/*` 在 `cost:read` 下会下发 `cost` 字段；
    没有这个权限时**整个字段不下发**（不是 0），页面按「字段在不在」决定出不出现。
    而 `packages/web-portal/verify/verify-render.ts` 里那条「统计页不包含金额或旧 mock」断言
    **必须保留** —— 它渲染的统计页数据里**不带 `cost`**，验的正是「没有 `cost:read` 时一位金额都不显示」；
    `/pricing` 页刻意不进那个拼接串。
  - **单价粒度是 `(provider, model)` 精确匹配**，且匹配的是**上报原值**
    （不是归一化后的展示名 —— 供应商归一化只是查询期口径）；同一供应商下不同模型各配各的价。
  - 金额是**整数微元 / 千 token**（1 微 = 1e-6 货币单位）：
    `cost = input×p_in + output×p_out + cacheRead×p_cr + cacheWrite×p_cw`，
    **四类必须分开乘**（`cacheRead` 占总量 94% 以上，合成一个价等于让绝大部分用量算错）。
  - **概览金额必须先按 `(provider, model)` 分组算完再求和**，
    **绝不能用「总量 × 均价」** —— 世上没有「平均单价」。
  - **多币种各自累加，绝不换算、绝不相加**（页面上用 ` + ` 连接不同币种）。
  - **趋势金额在多币种时禁用，而不是画线**（一条价都没配上时同样禁用）：
    指标照常出现，但点不动并说明「本次区间内有 N 种币种，金额绝不跨币种相加，请看分布表的费用列」。
    把跨币种求和画出来（或画一条全 0 的线）看起来像「花得很少 / 没花钱」——
    那是把一个口径错误伪装成结论。曲线上的值仍是**服务端下发的整数微元原值**，
    只换刻度与悬浮提示的格式化（`formatCostMicro`），画图层不做任何单位换算。
  - 🚨 **`unpricedRate` 必须显式给出，绝不把未计价当 0** ——
    这是最危险的误读：未定价看起来像「省了钱」。
  - **生效区间不得重叠**：应用层 `findPriceConflicts` 兜住并回 `409`；数据库的 UNIQUE 索引
    只拦「`effective_from_ms` 完全相同」那一类，**拦不住 `[1,100]` vs `[50,200]`**。
    区间两端都是**含**的。
  - `cost:read`（能看金额）与 `pricing:manage`（能看 / 改计价）是**两件事**，不互相附带；
    **单价目录读也要求 `pricing:manage`**（它是配置，不是「看一眼的数字」）。
    而看数据时的**只读单价快照**另走 `GET /api/v1/stats/pricing`（`cost:read`）——
    它与 `/api/v1/admin/pricing` 是**两条接口两道门**：前者只读 `model_price`、
    回答「这个金额是按哪个价算的」，**不含任何用量**；后者才是配置面。
  - 口径与格式化只在 `packages/shared/price.ts`；页面 / CLI / 插件**不得重算**。
    单价与总额的格式化是**两个函数**（`formatUnitPriceMicro` 与 `formatCostMicro`）——
    50 微 / 千 token 用总额那个会显示成 `0.0001`（差 500 倍）。
    **单价一律按「货币单位 / 百万 token」呈现与录入**（与各家价目表同单位，
    官方页就是「元 / 百万 tokens」），库里仍存整数微元 / 千 token，两者差 1000
    （换算只在 `web-portal/src/utils/unitPrice.ts` 一处，`× 1000` / `÷ 1000` 是整数倍）；
    内置种子价是**人民币官方高峰价**（Flash 缓存命中 ¥0.04 / 未命中 ¥2 / 输出 ¥8，
    Pro ¥0.30 / ¥9 / ¥27，均为「元 / 百万 token」）。
  - **自建计价 ≠ 财务账单**（折扣 / 预付 / 赠送额度不在单价里）；账单金额只允许出现在
    月度对账脚本里，**绝不进页面 / 接口 / CLI 输出**。
  - **离线端（本地页 / CLI / 插件）的价来自数据目录下的 `pricing.json` 快照**
    （`ai-token-report pricing sync --portal <根地址> --token <带 cost:read 的凭证>`
    从 `GET /api/v1/stats/pricing` 拉，写盘前用**读取方同一个解析器**回读校验）；
    没有该文件或解析失败就退回**内置种子价**并把原因写进 `note`。
    所以 `pricingSource` 只有 `'snapshot' | 'builtin'`（离线端不可能有 `'db'`），
    且**必须与金额同时展示** —— 离线端与看板读的不是同一份价，
    **同一个时间窗会给出不同的金额**。实测：内置种子价只覆盖 `deepseek-official`，
    真实数据是 `dashscope` 时命中率为 0，`unpricedRate` 必然是 100%。
  - **折叠公共件是 `packages/core/src/db/cost.ts`**（离线端唯一实现）：
    `loadLocalPricing` / `priceResolver` / `costTotalsOf` / `costByGroupOf` /
    `recordCostOf` / `unpricedTargetsOf`。它**逐条事件按事件时刻取价**
    （换价那一刻两侧各用各的价），分组键复用 `aggregate.ts` 的 `groupKey()`。
    ⚠️ 代价是每次统计都要 `records()`（本机实测 2.37 万条 +56ms）——
    **刻意接受**：省掉它的那条路正是「分组总量 × 一个价」。
  - **CLI 的 `--cost` 默认关**，关着时**连计价函数都不调用**（不是算了再丢）；
    `pricing sync` 必须在「有没有会话目录」的检查**之前**分派 ——
    一台还没装 DSH 的机器正是最需要先同步单价的机器。
  - **插件面板的金额由宿主格式化成字符串后放进载荷**：浏览器半只能 `require`
    DSH 预置的 9 个模块，**进不去 `@ai-token-report/shared`**。
    于是行金额只有「非空字符串」与「缺字段（= 未计价）」两种形态，
    顶部 `cost` 整块**缺字段 = 老宿主**（整块不出现）、`text: null` = 一条价都没配上
    （写「未计价」）。**面板与 `token_usage` 的表格金额共用 `formatRowCost()`**
    （返回 `null` = 未计价，以 `*` 结尾 = 只有部分 token 配上了价）。
    面板**刻意没有金额曲线** —— 多币种不相加那条规则的唯一实现在
    `web-portal/src/utils/cost.ts` 的 `costSeriesOf`，照抄一遍就是第二个实现。
  - **月度对账脚本 `packages/server/scripts/reconcile-bill.ts`**（`bun run reconcile:bill`）
    是全仓**唯一**允许出现账单金额的地方，且**只读**（不写库、不写文件）。
    它不自己算钱：估算侧取 `costTotals()` / `costByGroup('provider-model')`，
    唯一的减法是同币种内的「估算 − 账单」（`sameCurrencyDiff()`）。
    账单 CSV 表头前 3 列 `period,currency,amount` 逐字相符，后 3 列必须是
    `provider,model,note` 的**前缀**；坏行一律报错并回**退出码 2**（绝不跳过：
    跳一行会让「少比了一行」看起来像「完全一致」）。退出码 `1` **只**表示有差额。
    ⚠️ `openPortalStats()` 对**不存在的 SQLite 路径会静默新建空库**，
    把「路径写错」伪装成「这个月没有用量」—— 脚本用 `assertPortalTargetExists()`
    兜住，**core 未改**（服务端启动本来就要初始化空库）。
  - 细节见 `docs/费用统计方案.md`。
- **本地身份文件解析失败降级为未署名并告警**；生产数据库损坏、不可用或版本不符则明确失败，不能退回空文件身份或另一个数据库。
- **`Bun.serve` 必须显式设 `idleTimeout`**：默认 10 秒太短 —— 首次冷建库
  要约 15 秒，客户端会看到 `ECONNRESET` 而**服务端一条日志都没有**。
  已在 `server/src/runtime/listen.ts` 设为 120 秒，改动此处前先读那段注释。
- **🚨 本地库只定义存储，不定义口径**。`packages/core/src/db/query.ts` 里
  **只做 `SUM(原始列)`**，绝不写 `cache_read/(cache_read+input)` 这类公式，
  也绝不返回 `SUM(input+output+...)` 当 total。派生指标一律交给
  `core/types.ts` 的 `derive()` / `shared/metrics.ts`。SQL 里一旦出现公式，
  就存在第二个口径实现 —— 它不会报错，只会让某个数字悄悄不对。
- **🚨 金额取数同样只做 `SUM(原始列)`**（口径仍在 `packages/shared/price.ts`）：
  `LEFT JOIN (SELECT price_id, provider AS mp_provider, model AS mp_model, … FROM model_price) mp`
  按 `(分组键, price_id, currency)` 分组 —— 四类分价相乘全部在 JS 侧交给
  `costMicroOf()` / `summarizeCosts()`。未定价那一撮天然落进 `price_id IS NULL` 的行，
  所以**不需要 `SUM(CASE WHEN …)`**：条件聚合等于把「这一行有没有价」也变成 SQL 里的判定，
  而那是口径。
- **🚨 单价表与用量表有同名列（`provider` / `model`），JOIN 前必须先把单价表的列起别名**：
  直接 JOIN 会让维度表达式里的**裸列名变成歧义列**
  （实测 SQLite `ambiguous column name: provider`，MySQL errno 1052），
  于是「按供应商 / 按模型看金额」整条路径直接不可用。**两个后端都会报，它不是方言差异**，
  别归进「只有活体 MySQL 才会暴露」那两份清单里。
- **单价行的 snake_case → 契约映射只有一份**（`server/src/identity/model-price-row.ts`
  的 `modelPriceFromRow()` / `priceShapeFromRow()`）：管理面与看板的只读快照共用。
  各写一份的结果是「同一行价在管理页与看板解释里显示得不一样」，而它不会报错。
- **🚨 没有 `cost:read` 时 core 连算都不算金额**（不是算完再丢掉）：由
  `openPortalStats(target, filter, loadAliases, withCost)` 的第 4 个参数决定要不要查。
  无权限时 `costTotals()` 返回 `null`、`costByGroup()` 返回空表，趋势点与明细行
  **根本没有 `cost` 字段**。「先算再丢」在响应上看起来完全一样，
  但它让一个不该有金额的进程真的读了单价表 —— 权限不该只体现在序列化那一步。
- **🚨 时间分桶（`day`/`hour`）必须在 JS 侧做**，不要用 SQL 的
  `strftime(..., 'localtime')`。实测 SQLite 按**操作系统时区**、JS 按
  **进程 TZ 解析**，在 `bun test` 下两者相差 8 小时（JS 被强制成 UTC），
  表现为趋势图的点整体错位且**只在测试环境暴露**。统一用
  `aggregate.ts` 的 `toDayKey()` / `toHourKey()`。
- **🚨 `core/db` 拿驱动只能经 `driver.ts`**：Bun → `bun:sqlite`，Node → `node:sqlite`，
  两个后端的能力差异（`query()` / `transaction()` / `finalize()`）由它抹平。
  **绝不要在 `core/db` 里重新 `import ... from 'bun:sqlite'`** ——
  `bun build --target=node` 会把它原样留在产物顶层，Node 用户 import 即崩，
  而**所有在 Bun 下跑的测试依然全绿**。`verify:npm` 与
  `core/verify/run-driver-parity.ts` 分别从产物与行为两侧兜住。
- **🚨 SQLite 绑定值里的 `undefined` 必须在 `driver.ts` 归一成 `null`**：
  `node:sqlite` 对 `undefined` 直接抛
  `Provided value cannot be bound to SQLite parameter`，
  而 `UsageRecord.cwd` / `turn` / `step` 都是可选字段（`insertRecords()` 会原样绑定）。
  别在调用点各自判空 —— 归一化只该有一处。
- **🚨 两个 SQLite 驱动不能合并成一个**：实测 **Bun + `node:sqlite`** 在 `close()`
  之后**不释放句柄**（`-wal` 残留 MB 级、`rmSync` 抛 `EBUSY`），
  而它没有 `finalize()` 可补救 → `--reset-db` 会永远失败。
  所以 Bun 必须走 `bun:sqlite`。对应地，`finalize()` 在 Bun 上**必须真的调用**
  （未 finalize 的 `prepare()` 语句会让 `db.close()` 不释放句柄，
  之后删库抛 `EBUSY`，而错误信息完全不提 prepared statement），
  在 Node 后端则是空操作（GC 负责）。
- **🚨 服务端不得依赖 `Bun.serve` / `Bun.file()`**：npm 发布出去的那份 CLI
  要跑在 **Node** 上。请求处理器本身就是 Web 标准的 `Request`/`Response`，
  最外层由 `server/src/runtime/listen.ts` 的 `tryListen` 按运行期二选一
  （`Bun.serve`，或 `node:http` 桥接见 `server/src/serve-node.ts`）；
  静态文件一律走 `node:fs/promises`。
  ⚠️ **不要为 Node 另写一套路由** —— 那会产生第二个「什么路径返回什么」的实现，
  两边必然漂移且不会报错。
- **🚨 server 的路由与中间件只在 `server/src/app.ts` 一份**（S12 起用 Hono，4.13.9 精确锁版）。
  改任何路径 / 方法 / 状态码，先跑 `packages/server/test/http-contract.test.ts`
  （100 项契约断言，重构前 `bun test` 完全不覆盖分发面）。
  四条实测踩出来的坑，改这里之前必读 `app.ts` 的注释：
  1. **Hono 不做 405**，方法不匹配默认回**纯文本 404**且无 `Allow` ——
     405 靠 `hono/method-not-allowed` 读 `app.routes` 反查；
  2. **兜底必须 `app.use('*')`，绝不能 `app.get('*')`** ——
     后者作为 GET 路由登记后，`method-not-allowed` 会认为任何路径都允许 GET，
     于是「只收 POST」的端点永远拿不到 405，而未注册路径反而回 `405 + Allow: GET`；
  3. `method-not-allowed` 会把 **HEAD 并进 GET**，而本仓契约是
     `Allow` **恰好列出真实处理器**（`e2e-ingest.ts` 逐字断言），故要滤掉 HEAD；
  4. **`/api/*` 未命中一律 JSON 404**：静态兜底若把它接过去会回 200 + HTML，
     前端会渲染成「数据通道没装上」（`dsh-plugin/test/client/usage-store.test.ts:137`）。
- **鉴权的状态码映射只有一处**：`server/src/http/auth.ts` 的 `authorize()`
  （401/503 + 管理员 403，顺序是「先认人、再认角色」）。
  角色缺省 `member` 只在 `verify-route.ts` 的 `viewerFrom()` 里写一次 ——
  改动这两处等于动「谁能进管理页」。
- **请求体上限与 JSON 读取只有一处**：`server/src/http/body.ts`
  （`strict` = 空 body 也算非法，用于上报/署名；`lenient` = 空 body 合法，
  用于人员管理）。32 MiB 是**刻意给足**的：被挡下的批次会在客户端无限重试。
- **🚨 `zod` 只准从 `@ai-token-report/shared/schemas` 子路径进**（S12.5）：
  `packages/shared/src/index.ts` **绝不 re-export** schemas —— 根入口要同时跑在浏览器、
  Bun 与插件进程里，一旦 re-export，zod 会进 `web-local` / `web-portal` / 插件浏览器半的产物
  （**只会变大，不会报错**）。新增跨包 import 记得在各包 `tsconfig.json` 的 `paths` 里补一条。
  准入断言：`bun run --filter '@ai-token-report/shared' verify:bundles`。
  另：**查询参数解析仍手写**（`stats-route` / `local-api`），不要顺手 schema 化 ——
  那几处的文案与「非法值不许静默当成没给」的语义被逐字断言钉着。
- **部门上报库可选 MySQL；本机库 `usage.sqlite` 恒为 SQLite**：
  本地路径的函数只收**同步 SQLite `Database`**，MySQL 侧只有异步 `PortalStore` ——
  「员工机器上跑 CLI 要有 MySQL」这件事**在类型上就不可能**。Bun 上用内建 `Bun.sql`，
  Node 上用可选依赖 `mysql2`（动态 import + 可变说明符，**两边都不进 npm 发布产物**；
  没装时明确报错并给出 `cd packages/server && bun add mysql2`）。
  Node 那条路的活体验证：`bun run --filter '@ai-token-report/server' verify:mysql:node`
  （真 Node，49 项 + 编排 6 项）。详见 `docs/mysql上报库.md`。
- **🚨 `ATR_V4_TEST_MYSQL_URL` 是「管理连接」，不是「目标库」**：本机开发容器里它指向
  `information_schema`（别的机器给一个可建库的账号即可）。任何 MySQL 用例 / 验证脚本都必须
  **自己创建随机隔离 schema 并 DROP**（照 `core/test/portal-v5.test.ts`、
  `core/test/portal-batch-ingest.test.ts`、`server/verify/mysql-isolation.ts` 的写法）。
  直接把它当上报库目标用过一次，症状是 `上报库状态 unsupported，版本 0`，
  而且**差一点就往一个共用 schema 里建 portal 表**。这条只有活体 MySQL 才暴露：
  SQLite 分支没有 schema 这一层（2026-10-03 实测，`portal-v9.test.ts` 就踩在这里）。
- **🚨 版本号断言一律写 `PORTAL_SCHEMA_VERSION`，绝不写死数字**；脚本里「降级到 vN」
  必须删掉**所有 `version > N` 的账本行**（只删 `N+1` 那一行时，判定逻辑里的 `current`
  仍为真 ⇒ 库被判成 `unsupported` 而不是 `legacy`，整条回滚路径失效）。
  一条会**因为加了新版本而误报**的断言比没有断言更糟。2026-10-03 v9 落地时两处都实测到。
- **🚨 MySQL 有三处「静默语义变化」的方言坑**（都在 `core/src/db/dialect.ts` 收口，
  改 SQL 前必读）：
  1. `a || b` 在 MySQL 是**逻辑或**，`provider || '/' || model` 会返回 `0`/`1` ——
     分组键悄悄变成两行垃圾数据。必须走 `dialect.concat()`。
  2. `SUM(BIGINT)` 经驱动返回**字符串** `"60"`（`COUNT(*)` 是数字）——
     未归一会让看板数字变 `NaN`/字符串拼接。归一只能在口径边界 `portal.ts` 的 `num()`。
  3. `key` 是 MySQL **保留字**（`AS key` 语法错误）→ 分组别名统一 `grp_key`，
     TS 侧映射回 `key`（对外契约不变）。
  另有两条会报错的（好抓）：标量最大值 `MAX(a,b)`→`GREATEST(a,b)`；
  `INSERT OR IGNORE`→`INSERT IGNORE`、`ON CONFLICT…excluded`→`AS new ON DUPLICATE KEY UPDATE…new`。
- **🚨 `toPositional()` 的参数表键名带 `$`**：`query.ts` 的 `buildWhere()` 产出的是
  `params['$since']`，翻译成 `?` 时必须用**带前缀的原始键**查表 ——
  写成剥掉 `$` 的名字会让**每一句真实 SQL 都抛「参数缺失」**（这个 bug 被活体脚本抓到过）。
- **MySQL 侧 `close()` 是空操作**（连接来自进程内共享池，每请求关池 = 每请求重新
  握手）。上层照常 `finally { await store.close() }`，两种后端形状一致。
- **🚨 人员与分组是「多对多」（v5）**：一个人可同时属于多个分组，归属的**权威**是关联表
  `member_group_assignments`（`member_id` + `group_id` + `created_at_ms`）。`members.department_id`
  与 `usage_event.department_id` 已**删除**；`usage_event.group_name` 只是上报当时客户端自己填的
  **文本快照**，不参与归属。`group_ids` 是**全量替换**语义，没有增量语义。
  **按分组筛选与分组排行都是 OR / 展开**：一条事件计入它的人员所属的**每个**分组，
  所以「各分组之和 > 总量」是**定义**，不是重复计数的 bug；未分组人员不进任何分组行，
  差额就是他们 —— 页面必须能说清这一点。看板的分组候选项走 `GET /api/v1/stats/groups`
  （`stats:read`），**不要**让页面去读管理接口 `/api/v1/admin/groups`（那是 `groups:read`）；
  人员候选项同理走 `GET /api/v1/stats/members`（`stats:read`），不是 `/api/v1/admin/members`。
- **上报库的 schema 变更绝不能自愈**：portal 当前是 **v9**（**v4 是冻结基线**：v3 库先经
  `portal-schema-v4.ts` 迁到 v4，再依次走 v4→v5、v5→v6、v6→v7、v7→v8、v8→v9；v5 的 `usage_event` 去掉了一列并把 `dept`
  改名 `group_name`；**v6 只增表** `provider_alias` 与两个权限码；**v7 同样只增表** `model_price`
  与两个权限码（`cost:read` = `...114`、`pricing:manage` = `...115`）；
  **v8 只增表** `usage_rollup_*` 三张看板汇总表（`portal-schema-v8.ts`）；
  **v9 是唯一一次给既有表加列**：`usage_event.source`（`portal-schema-v9.ts`）），
  本地 `usage.sqlite` 为 **v4**（同样只多了 `source`，靠 `rebuildSchema()` 重建而不是迁移）。
  - **当前版本的受控 DDL 恒在 `portal-schema-v5.ts`**（v5 结构 + `_V6_ADDITIONS` + `_V7_ADDITIONS`），
    **不要新建 `portal-schema-v7.ts`** —— 分成两个文件会让「哪些表属于当前版本」变成两处各自维护，
    而它们必然漂移。v8 / v9 各自独立成文件（前者是性能设施，后者动既有表）。
  - 🚨 **v9 的那一列不能写进 v5 常量**：`portalSchemaChecksumV6/V7` 按 v5 文本的**当前全文**
    求摘要，改了它会让已经迁到 v6 / v7 的库从「可迁移起点」退化成 `unsupported`（服务端拒绝启动）。
    所以受控定义里的 `usage_event` 由 `portalV9UsageEventStatement()` **拼接**得到，
    插入点（最后一个列定义之后、第一条表级约束之前）**由 SQLite 的 `ALTER … ADD COLUMN`
    改写规则钉住** —— `verifyTable()` 在 SQLite 分支按表定义**全文**比对（只抹空白与引号），
    位置不一致就是「迁移做完了却判失败」。
  - **v6 / v7 / v8 的校验和都已冻结**（`portalSchemaChecksumV6/V7/V8`），用来把「已经是那一版」的库
    识别成**可迁移起点**；不冻结它，那些库的账本摘要永远对不上，从「起点」退化成 `unsupported`
    （而它们只差一次追加迁移）。
  - ⚠️ `type SchemaVersion = 4 | 5` **刻意没有扩到 6/7/8/9**：`tableStatement(kind, table, version)`
    把 ≠5 一律映射到 v4 的 DDL，加上 6 会让它**静默返回 v4 DDL**。
  - ⚠️ v9 的迁移步骤（`upgradeV8ToV9`）**位置是刻意的**：它在 v5 的事实表重建**之前**跑
    （MySQL 的 `alignMysqlEventColumns()` 要求「实际列数 == 受控定义列数」，所以列必须先加），
    于是它必须**幂等**（`!v5Ready` 的库由 v5 重建直接产出带 `source` 的表）且
    **只在事实表已是 v5 形态时逐列核对**（v5 之前的表形状与受控定义本来就不同）。
  空 portal 库可初始化；旧库/半完成迁移拒绝普通业务写入，只能通过 `packages/server/scripts/migrate-db.ts`
  显式 inspect/migrate/resume。SQLite 先一致性备份（v5 在 SQLite 分支**必须重建事实表**才能去掉列，
  所以按备份流程执行），MySQL 需离线确认和备份证明；迁移前后逐位校验事件指纹，**不改写任何事件原值**。
- **🚨 MySQL 的 v5/v6/v7 结构迁移有六条「只有活体 MySQL 才会暴露」的坑**（SQLite 一条都不会报，
  所以「SQLite 上测过了」在这里**不构成证据** —— 它们全是靠本机 Docker MySQL 才抓出来的）：
  1. **`DROP COLUMN` / `RENAME COLUMN` 会被引用该列的 CHECK 约束挡住**
     （errno 3959 `Check constraint 'x' uses column 'y', hence column cannot be dropped or renamed`）。
     SQLite 会连带改写 CHECK 表达式，MySQL 不会。改列前先按 `information_schema.check_constraints`
     摘下来、改完再装回去；列被彻底删掉的就**不**再装回。表达式必须读 `CHECK_CLAUSE` ——
     内联 CHECK 的约束名是 MySQL 自己生成的（`member_groups_chk_1` 这种），硬编码必然写错。
  2. **`RENAME COLUMN` 只改名字、不改类型**。实测 v3 的 `dept` 是 `TEXT`、v5 的 `group_name` 是
     `VARCHAR(255)`，改名之后列定义与受控 DDL 对不上，`verifyCurrent` 会在**最后一步**拒绝标记完成 ——
     表现为「迁移明明做完了却不算成功」。所以 MySQL 侧同样要按受控定义逐列 `MODIFY COLUMN` 对齐，
     且必须剥掉行尾的内联 CHECK，否则会多出一份重复约束。
  3. **`CHECK_CLAUSE` 里的字符串定界符是反斜线转义的**（`\'…\'`），拼回
     `ADD CONSTRAINT … CHECK (…)` 之前必须还原成 `'…'`，否则 errno 1064 语法错误。
  4. **受控 DDL 的「唯一约束」解析必须锚定在关键字之后**。写成
     `(?:PRIMARY KEY|UNIQUE) \(([^)]+)\)` 会**跨过中间的令牌**去匹配，于是列级写法
     `alias_id … NOT NULL PRIMARY KEY CHECK (alias_id REGEXP '…')` 被捕获成
     `alias_id REGEXP '^[0-9a-f]{8}-…'` —— 一个不存在的列组合。同时
     `CREATE UNIQUE INDEX … ON t (a, b)` 是**独立语句**，不在 `CREATE TABLE` 文本里，
     必须扫 `portalSchemaStatements(kind)` 才拿得到。两条都只在 MySQL 分支生效
     （SQLite 分支只比对 `sqlite_master.sql` 全文），所以又是「SQLite 全绿、MySQL 报
     `表 provider_alias 的唯一约束与主键不一致`」。另外 MySQL 主键索引名恒为 `PRIMARY`，
     受控 DDL 里写的是列名 —— 只比**列组合**，比索引名会让每张带主键的表都判失败。
  5. **两端的唯一索引都不拦含 `NULL` 的行**（实测 `(NULL, 'dashscope')` 在 SQLite 与
     MySQL 上都能插进两行）。所以 `provider_alias` 的「同一原始名只有一条**全局**规则」
     **不由数据库保证**，只有 `repository.ts` 的 `findProviderAlias()` 显式查重兜住 ——
     不要写「数据库会拒」的断言（那是假承诺），也不要用生成列 `COALESCE(member_id,'')`
     去补（受控 DDL 逐列核对，多一列会在迁移最后一步判成结构不符）。
  6. **`CREATE UNIQUE INDEX` 语句此前没有任何迁移路径会执行它** —— `ensureIndex` 的正则与两处
     `startsWith('CREATE INDEX')` 过滤都跳过了 `CREATE UNIQUE INDEX`，于是迁移出来的库缺少
     `idx_provider_alias_member`（v7 会缺 `idx_model_price_span`）。SQLite 的 `verifyCurrent`
     只比对 `sqlite_master.sql` 全文、**从不比对索引**，所以本地全绿；MySQL 的
     `verifyUniqueConstraints` 会在**最后一步**报「表 provider_alias 的唯一约束与主键不一致」
     → 表现为「迁移明明做完了却不算成功」。修法是 `isCreateIndex()` +
     `ensureControlledIndexes()`（扫 `portalV6Statements` / `portalV7Statements` 兜住全部受控索引）。
     **新增受控索引时必须确认它在某条迁移路径里真的被执行过**，别只写进 DDL 就算完。
     🚨 而且**建索引必须排在 `verifyTable` 之前**（`upgradeV5ToV6` / `upgradeV6ToV7` 里就是
     `ensureControlledIndexes()` 在前、`verifyTable()` 在后）：MySQL 分支的 `verifyTable`
     会把独立 `CREATE UNIQUE INDEX` 也算进「期望的唯一约束」，**先校验后建索引 ⇒ 真实 MySQL 上
     v5→v6 的第一步就报同一条错，整个迁移一步都走不动**（2026-09-30 线上 v5 库实测卡在这里）。
     反向验证：`packages/core/test/portal-v5.test.ts` 的「v4→v5 真实迁移」用例能复现，
     所以改这两处后**必须带 `ATR_V4_TEST_MYSQL_URL` 实跑**——只跑 `bun test` 会整段跳过。
- **🚨 resume 只看版本号判断「v4 基线是否就绪」会让 MySQL 库永久卡死**：v5 结构已经就位、
  但 v5 账本行被标成 `started`/`failed` 的库（迁移中途崩过之后就是这副样子）版本号已经是 5，
  只按版本判断会得出「基线还没做」→ 重跑 v3→v4 → 而那时 `dept` 早已改名 `group_name`，
  `historyFingerprint('dept')` 抛 `Unknown column 'dept'`，此后**每一次 resume 都失败**。
  判定依据要认「v5 账本行是否存在」，不是「版本号是否等于 4」。
- **空库（`historyCount === 0`）不要求 MySQL 备份证明**：备份的意义是不丢唯一副本里的历史，
  对一份没有保护对象的库索要备份证明，只会把「空库初始化」这条最常见的路径卡死 ——
  它恰恰是除 `--confirm-offline` 之外**不需要任何人工准备**的那条路。
- **本地库必须保留降级路径**：`openStats()` 在库不可用（磁盘满 / 权限 /
  `SQLITE_CORRUPT` / `SQLITE_BUSY`）时自动回退直扫日志并带 `degradedReason`。
  库是**日志的派生物**，不是真值 —— 为它让页面白屏是不划算的。
- **本地库坏了就重建，不要写迁移逻辑**：`DB_SCHEMA_VERSION` 不符 → `rebuildSchema()`。
  数据全部可从日志重扫，迁移代码比「重建」更容易出错且更难测试。
  ⚠️ 于是**升级期会出现库在版本之间来回抖**：一个**还在跑的旧版客户端**（它的
  `DB_SCHEMA_VERSION` 还是旧的）每次取数都会把库重建回旧版本，而新代码下一次运行又建回来。
  实测症状：`no such column: source` 突然出现（2026-10-03 本机 `verify-db-parity` 在**第 2 个窗口**
  炸在这里，而把它指到一个**隔离的新库**上立刻 160/160 全过）、或对账脚本跑到一半失败。
  **处置：重启那个客户端进程（DSH）**，别改代码 —— 库是日志的派生物，重建不丢数据。
  详见 `docs/Codex会话采集方案.md` 的「两条必须记住的运维/验证事实」第 2 条。
- **🚨 「选了哪些来源」有两个落点，缺一个就是错数字**（多客户端之后最容易踩的一处）：
  - **根**（`sourceRoots`）决定**本次 ingest 谁**；**查询期来源清单**（`openStats` 的
    `sources`）决定**本次只算谁**。只给根，库里别的来源的行就会混进来 ——
    而本地库 `usage.sqlite` 是 CLI / 本地页 / 插件 / report **共用的一个文件**。
  - `sources` 的**缺省语义是「库里的全部来源」**，所以每一条「只想看某几个来源」
    的调用都必须显式给。实测（2026-10-03）：CLI 的纯 DSH 分支（`--source dsh`，
    也就是 `--help` 里承诺的「回到旧口径」）与 `--source all` 的总量**逐位相同**
    （326,041,147），`--by source` 里还挂着 workbuddy；插件的
    `extraSources: []`（= 面板只统计 DSH）同样会把库里 Codex 的行算进面板。
    两处都已修，回归用例：`packages/cli/test/source-filter.test.ts`、
    `packages/dsh-plugin/test/stats-worker.test.ts` / `extra-sources.test.ts`。
  - **`DSH_TOKEN_REPORT_<来源>=0` 只在「没显式给 sources」时生效**（`resolveSourceRoots`
    的「显式即接管」语义 —— 测试正是靠它才能在 preload 全关的情况下显式指定来源）。
    而 CLI **永远**显式给清单 ⇒ 那个开关曾经整个失效（实测：设与不设读的根**逐字相同**，
    2.8 GB 的 Codex 日志照扫，只是慢、不报错）。CLI 的缺省清单因此由它自己按同一判据算出来。
  - 同理 **spawn 子进程的测试必须自己钉住来源**（preload 改的 env 不被 `Bun.spawn`
    继承）：漏了会让「装过 Codex 的机器」上 8 条 CLI 用例全部 5 秒超时（本机实测），
    而失败信息与断言毫无关系。公共件：`packages/cli/test/child-env.ts` 的 `pinnedChildEnv()`。
- **★ 「来源」是端到端的一个维度（v9 起，部门看板也能按它筛与分组）**：
  - 链路上的落点，缺一处就是静默错数：`shared/protocol.ts`（`WireTokenRecord.source?`
    + `GroupBy` 的 `'source'` + `StatsSourcesResponse`）→ `shared/schemas.ts` 的
    `sourceOrNull`（**只校验形状 `[a-z0-9-]{1,32}`，不按注册表白名单** —— 客户端比服务端新
    时严格枚举会让整批上报被拒，而 CLI 会把 pending 一直重发）→ `core/db/ingest.ts`
    的 `ATTRIBUTED_COLUMNS`（缺省 `?? 'dsh'`，**不是 NULL**：列是 NOT NULL，而 v9 之前
    只有 DSH 上报过，所以 `dsh` 是事实）→ `core/db/query.ts` 的 `filter.sources`
    （**精确匹配** `source = ?`，与 provider 的子串匹配刻意相反）→ `stats-route.ts`
    的 `GROUP_BYS` + `parseWindow()`（只校验形状）→ web-portal 的来源下拉与「来源」页签。
  - **查询期要不要绕开汇总表，由 `portal.ts` 的 `isTimeWindowOnly()` 判**：`usage_rollup_*`
    的键里没有来源列，`?source=` / `by=source` 必须**显式**退原始表 —— 漏判的后果是
    带着 `source = ?` 去查汇总表（`no such column`）而**靠 `try/catch` 静默回退**：
    数字看起来仍然对，但那条路从此永远依赖异常（「汇总表坏了」与「这个筛选不支持汇总表」
    变成同一个现象）。回归：`packages/core/test/rollup.test.ts` 的
    「★ v9 来源维度与汇总表」+ `packages/server/test/stats-api.test.ts` 的「★ 来源维度（v9）」。
  - **上报链路必须带上非 DSH 来源**（否则看板上的来源永远是 `dsh`）：`report` 的
    `plainRoots` 走 `scanner.ts` 的 `scanPlainSources()`（与本地库 `ingestPlainSources()`
    **同一份** L1 字节数水位线实现），水位写进同一份 `state.json` 的 `files[path]`（`frameCount: 0`）。
    实测：`report --dry-run` 在本机采到 69,027 条 / 12.4s（DSH 118 个文件 + 五个非 DSH 根 1,528 个文件）。
- **🚨 「会话日志根」与「token-report 数据目录」是两个概念，别合并**
  （`core/src/home.ts`）：`dshHomes`（**一组** home，默认**自动发现**本机全部 DSH）
  决定**日志从哪读**，`dataDir`（默认 **`~/.ai-token-report`**，**刻意与 home 无关**，可用
  `DSH_TOKEN_REPORT_DATA_DIR` 或配置项 `dataDir` 覆盖）决定身份 / 本地库 / outbox / 补报水位放哪。
  - **多个 home 是一组，库仍然只有一份**：`sessionsRoots` 是并集，而 `dataDir` / `usage.sqlite`
    不随根分叉 —— 分成两个库就没法表达「并集」。镜像会话靠 `event_id`（`sessionId:seq`）
    主键去重（直扫路径由 `scanner.ts` 的 `seenEvents` 保证同一语义），所以
    **「并集 < 各根相加」是正确结果**，不是漏扫（本机实测：两个 home 共 254 个会话，不是 478）。
  - **来源必须可见（四条形态都有）**：`--discover` 逐个打印候选（会话数 / 最新写入 / 是否被采用），
    `--format json` 给 `dshHomes` / `sessionsRoots` / `missingRoots`；**本地页面**
    `/api/local/stats/{overview,diagnostics}` 都带 `sources`（`LocalStatsSources` =
    `sessionsRoots` + `missingRoots` + `dataDir`，见 `shared/src/protocol.ts`），
    由 `UsageStatsView` 渲染成一行「数据来源」；
    ⚠️ 那一行**刻意不渲染缺失根**（「以下会话日志根不存在，已跳过」曾出现过，已去掉）——
    来源缺省是全部已注册来源，没装 Trae CN / Codex 这类「本来就没有」的根每次都会命中，
    页面上只剩噪音（要关掉得改环境变量，使用者什么也做不了）。
    「配了但读不到」仍然查得出：CLI 每次统计都在 stderr 逐项打印，接口也照旧下发 `missingRoots`；
    插件诊断打印全部根；`inspectSessionRoots()` 回答「这次统计到底读了哪几处」。
    配了但不存在的根**逐项报出**，绝不静默 —— 否则「加了 home 数字没变」分不清是
    镜像去重还是那个根根本没读到（两种情况的数字看起来一模一样）。
    ⚠️ **已知缺口（未修）**：「存在但读不了」（EACCES，或根路径被一个同名**文件**占住 → ENOTDIR）
    能在 `inspectSessionRoots` 里报出来（`exists=true` + `error`），但**取数路径**
    （`ingest` / `stats`）只按 `existsSync` 分流 —— 它既不算 `missingRoots`，也没有别的诊断字段，
    会被**当成空 home**。于是「这个 home 是空的」与「这个 home 读不到」在 `stats` 输出里
    仍然不可区分，而 `SessionsRootInspection` 的注释明确承诺这是两件事。
    `verify-multi-home.ts` 的 S15 把这条作为**观察项**列出（不计失败）。修复方向是让
    `ingest` / `stats` 也做一次 `readdir` 探测，或干脆复用 `inspectSessionRoots` 的判定。
    注意 `dshHomes` / `--dsh-home` / `DSH_TOKEN_REPORT_DSH_HOMES` 收的是 **home 目录**
    （路径层自己拼 `<home>/sessions`）；写错成 sessions 目录会得到「全部缺失」而不是静默 0。
  - **路径去重只在 home 层，而且只归一小写**（`normalizeHomes` 的 `dedupeKey`，Windows 上
    `toLowerCase`）；`listSessionFiles` 的列表去重是**按 `filePath` 字符串**、**不做 `realpath`**。
    所以同一份日志经由「大小写变体」「符号链接 / junction」「嵌套父子目录」都会**被列两次、
    解析两次**，最终只靠 `event_id` 主键兜住（本机实测：junction 的两个根列出 2 个文件而事件
    仍是 3 条；大小写变体列出 2 个文件而事件仍是 2 条）。这是**刻意的取舍** ——
    realpath 解析要给每个根加一次全量 `stat`，而正确性已由 `event_id` 保证；
    代价就是 benchmark 里那条「成本随**文件数**走」。
  - **日志根的结构是固定三层** `sessions/<project>/<sessionId>/<file>`：`listSessionFilesInRoot`
    只做两层 `readdir` 就找 `session*.jsonl.zstd`，`sessionFilesFromPaths` 也逐字校验
    「三段式」（`candidate.length !== 3`）。自己搭测试 / 演练目录时多一级会让它
    **静默扫到 0 个文件** —— 不报错、不告警、总量为 0，看起来像「这个 home 是空的」。
    `core/verify/verify-multi-home.ts` 的 `materialize()` 注释里记了这条踩坑记录。
  - **多根的成本只与「文件总数」有关**（`core/verify/benchmark-multi-home.ts` 实测）：
    去重发生在**解析之后**，所以镜像文件照样要被打开、解压、`JSON.parse` ——
    两个 root 全是镜像时数字一条不涨，扫描成本**照样翻倍**（本机真实日志：文件数 ×1.97，
    并集事件只 ×1.05，冷扫 ×1.83）。同样的 800 个文件放进 1 个根与 4 个根耗时相同，
    所以**多根本身没有额外开销**。热态路径只按文件数做一次 `stat`（约 0.5ms/文件），
    与事件数无关。
  - **自动发现是结构驱动的，不是硬编码清单**：候选 = `$DSH_HOME` + `~/.dsh` + `~/.dsh*`
    + 各平台应用数据目录（Windows 的 `%APPDATA%` / `%LOCALAPPDATA%`）下名字以 `dsh` 开头的
    目录及其 `<dir>/harness`；只有**真的有 `sessions` 子目录**才算一个根。名字不像 DSH 客户端
    但结构像的目录只进 `suspicious`（只提示，**绝不自动采用**）。接入新的第三方客户端不需要改代码。
    关掉发现：`DSH_TOKEN_REPORT_DISCOVER=0`；显式指定：`DSH_TOKEN_REPORT_DSH_HOMES`
    （`path.delimiter` 分隔）或 CLI 的 `--dsh-home`（**可重复**）/ `--dsh-homes`。
  - DSH Desktop 与命令行版 DSH **天然共用**同一份身份与凭证（都落到 `~/.ai-token-report`），
    **不需要任何配置**；想「共用一份身份但各统计自己的会话」也只能改 `dataDir`，绝不要改 home
    （那会把日志来源一起换掉，而且**不会以「完全没数据」的形式暴露** —— 实时上报不受影响，
    只有面板与历史补报少掉那台机器自己的会话）。插件侧一律经 `dsh-plugin/src/paths.ts` 取路径，
    不要在各处重新 `join(dshHome, 'token-report')`；`~` 的展开与绝对化只在
    `core/src/home.ts` 一处做（`join()` 不展开 `~`，会建出字面的 `~` 目录）。
- **🚨 隔离测试 / 验证脚本必须同时钉住「数据目录」与「会话日志根」**：数据目录不跟随
  `DSH_HOME`，而会话日志根**默认自动发现**。只设 `DSH_HOME` 既不隔离身份/库、也不隔离扫描范围：
  脚本会连带扫使用者真实的 home —— 断言随机器漂移，插件的历史补报线程还会把**真实用量
  以验收身份上报出去**，而脚本输出一切正常。
  - 同进程 `bun test` 由 preload（`scripts/test-preload.ts`）兜住：它设
    `DSH_TOKEN_REPORT_DATA_DIR` 与 `DSH_TOKEN_REPORT_DISCOVER=0`。
    ⚠️ 这里必须是**发现开关**而不是 `DSH_TOKEN_REPORT_DSH_HOMES` ——
    `dsh-plugin/test/paths.test.ts` 会删掉 `DSH_HOME` 与插件 `ENV`（但不清发现开关），
    用 `DSH_HOMES` 会把它的「缺省跟 `$DSH_HOME`」断言打成失败。`core/test/home.test.ts`
    自己管 `DISCOVER`，别去动它。
  - preload **管不到子进程**（实测 Bun 1.4.2：preload 改的 `process.env` 不被 `Bun.spawn` 继承），
    所以**任何 spawn CLI / DSH / 服务端的测试与脚本必须自己传
    `--data-dir` / `DSH_TOKEN_REPORT_DATA_DIR` **以及**
    `DSH_TOKEN_REPORT_DSH_HOMES`（或 `DSH_TOKEN_REPORT_DISCOVER=0`）**。
    spawn **真实 DSH 宿主**（`dsh --profile …`）时只能走环境变量 —— `dsh` 本体不认这些 CLI 参数；
    而且那几个脚本会「删掉所有 `DSH_TOKEN_REPORT_*`」，救场变量必须在删完之后再钉上。
    helper：`core/verify/lib/runtime.ts` 的 `scratchDataDir(home)` / `scratchDshHomes(...homes)`。
- **🚨 来源范围有三个不同的缺省，别混**（2026-10-03 起）：
  | 形态 | 缺省统计哪些来源 |
  |---|---|
  | CLI（`stats` / `report` 的参数解析） | **全部已注册来源**（`--source dsh` 回到旧口径；`--no-<来源>` / `DSH_TOKEN_REPORT_<来源>=0` 逐个去掉） |
  | 本地页面 `/api/local/*` | **全部已注册来源**（`resolveSourceRoots()` 不带 `sources`） |
  | DSH 插件面板 / `token_usage` | **只有 DSH**；要并入别的来源得在插件 config 或面板齿轮里写 `extraSources: [trae, …]`（白名单默认空，见 `dsh-plugin/src/extra-sources.ts`） |
  | `report`（上报部门库） | **只有 DSH** —— 它走 `scanIncremental`，`--source` 对它无效（未接通多客户端上报） |
  - spawn 子进程的测试/脚本**必须**按注册表钉住全部 `disableEnv`（`cli/test/child-env.ts` 与
    `cli/verify/verify-npm-package.ts` 的 `pinnedEnv()` 都这么做了）——
    漏一个来源的症状是「用例慢到超时」或「数字里多出别的来源」，而不是报错。
  - Trae 的日志**会被 Trae 自己删掉**（2026-10-03 实测：一次启动之后旧会话目录全没了），
    所以「按需扫描」对它是**有损**的；面板/本地页每次取数都会 ingest，别让它们的白名单空着。
- **🚨 上报库（`portal.sqlite`）是唯一副本，绝不自动重建**：它由
  `openPortalDb()` 打开，schema 版本不符时**抛错**（不是 `rebuildSchema`）。
  客户端投递成功后已清掉自己的 pending / outbox，删掉 = 全员历史用量永久消失。
  本地 v3 走 `openDatabaseForIngest()`（可重建），服务端独立 v7 走
  `openPortalStore()`（不可重建），**两个入口和版本不能混用**。
  上报库还必须与本地库 `usage.sqlite` 分开：混用后无法事后拆开。
- **🚨 `server/src/serve-node.ts` 必须动态 `import('node:http')`**：
  它在被求值的那一刻就构造 `http.globalAgent` 并解析 `HTTP_PROXY`，
  环境变量里只要有一个非法值（实测：末尾带 CRLF 的 `HTTP_PROXY`）就抛
  `ERR_PROXY_INVALID_CONFIG` —— 静态 import 会让**跑在 Bun 上的服务端也起不来**，
  且崩在 import 阶段、没有任何启动日志。Node 适配器的依赖不该在 Bun 上被求值。
- **🚨 上报接口的鉴权失败必须是非 2xx**（`401` / 未配置凭证时 `503`），
  **不能学 `/api/v1/identity/verify` 的 `200 + ok:false`**：客户端把 2xx 当作
  「已投递」并清掉 pending，回 200 等于把那批用量静默丢掉。
- **上报的归属只信服务端**：`client.userName` 一律忽略，写入可信 `member_id`、Token ID 和接收时间；
  事件本身不再存分组 ID（归属由 `member_group_assignments` 关联展开），同时保留
  `user_id` / `user_name` / `group_name` 的原姓名/快照语义 —— 服务端仍继续接受旧客户端上报体里的
  `client.dept`，按 `client.group ?? client.dept` 写入 `usage_event.group_name`，`verify` 响应也同时
  返回 `group` 与 `dept`（同值，`dept` 仅为兼容旧插件）。鉴权重验与插入在同一事务内。
  同一条记录被两个上报方上报时，归属以**先到的**为准（主键冲突整行不写）。
- **🚨 看板接口（`/api/v1/stats/*`）的鉴权失败也必须是非 2xx**（`401` /
  未配置凭证时 `503`）。理由与上报不同但同样硬：它的响应体里装的是**数据**，
  回 `200 + ok:false` 会让前端把「token 不对」渲染成「这段时间没人用」——
  一个 0 值空看板比一个明确的 401 危险得多。
- **🚨 看板只读上报库，`stats-route.ts` 不写一个字节**。它由
  `openPortalStats()`（内部走 `openPortalDb()`）打开，schema 版本不符时
  **抛错而不是重建**；这里**没有降级直扫这条退路** —— 上报库没有可重扫的真值。
- **🚨 看板的数据范围只认内置 `admin` 角色**（`stats-route.ts` 的 `applyDataScope()`）：
  只有它能看**全部门**，其余任何角色（含自定义角色）一律被**服务端**收窄成
  「只看自己」——即非管理员即使手拼 `?member_id=<别人>` 也拿不到别人的数字。
  判据刻意是**角色码**而不是权限码：`members:read` 是人员目录、`stats:read` 是能不能进看板、
  `cost:read` 是金额，它们回答的都是「能做什么操作」；拿它们当数据范围会把
  「能管名册」与「能看全员用量」绑成一件事，而那种绑定在页面上看不出来。
  三条硬规矩：① 显式点名别人 / 要未署名 / 要旧姓名子集一律 `403`，**绝不静默替换成「我」**
  （那会给出一个看起来正常的错答案）；② 数据库身份按稳定 `member_id` 收窄；
  ③ 兼容凭证表身份没有稳定 ID 时也 `403`，**绝不按姓名兜底**（同名会把两个人并成一个）。
  页面侧只有 `session.scopedToSelf` → 隐藏人员下拉并写明「只看本人」，
  **那不是权限**：手拼查询串一样会被服务端挡住。
- **未归属对外使用 `UNATTRIBUTED_USER`（`'unknown'`）**。portal 新视图（v4 起）区分稳定人员、
  legacy 待确认和真正未归属；旧历史标记为 `received_at_ms IS NULL`，legacy selector 只查这一子集。
  旧 `user` 视图保留原姓名键语义，有歧义时报错；禁止将待确认历史当成匿名或自动映射同名人员。
- **按人筛选是精确匹配，provider/model 才是子串匹配**。人名做子串会把
  「张三」和「张三丰」并成一个人 —— 那是数据错误，不是便利。
- **🚨 供应商归一化是「查询期的展示口径」，绝不是数据改写**（`provider_alias`，v6）：
  `usage_event.provider` 永远是上报原值，规则只决定「分组与筛选时按哪个名字算」
  （`core/src/db/provider-alias.ts` 的 `providerCaseSql()` 产出**没有 ELSE** 的 `CASE`，
  命中不到就回落原值）。因此改规则即时生效、可逆，**历史数据不需要也没有回填步骤**。
  四条实测踩出来的：
  1. **没配规则的供应商保持原始名** —— 归一化是「折叠少数几个」，不是统一改名；
  2. **原始名大小写敏感精确匹配**，写错就静默不命中；映射之后**原始名再也搜不到**它
     （筛选作用在归一化后的表达式上，这是刻意的），所以明细必须同时给出原值；
  3. **归一化按查看者解析**（只用 `auth.viewer.memberId`，**绝不从查询参数取「以谁的身份归一化」**）：
     否则任何有 `stats:read` 的人都能套用别人的口径，而页面上看不出差别。人员规则逐条覆盖全局；
  4. `provider-model` 维度必须**先归一化 provider 段再拼接**（`dialect.concat`），
     对拼好的字符串做 `CASE` 永远匹配不到 —— 这是一个不会报错、只是不生效的坑。
- **`user` 维度只存在于查询层**（`core/db/query.ts` 的 `QueryDimension`），
  **不要并进 `aggregate.ts` 的 `GroupDimension`**：后者是内存聚合（直扫日志）
  的维度集合，而日志里根本没有归属，塞进去只会多一个恒为 `unknown` 的选项。
- **看板前端不得重算任何口径**（同浏览器半那条）。页面上的算术只有两处，
  且都只是排版、不参与数字展示：排行条的宽度比例，以及图表里「值 → 像素」
  的换算（由 Chart.js 完成）。
- **趋势图用 Chart.js 4**（`web-portal/src/components/trendChartConfig.ts`），
  与 DSH 插件界面同一个库。两条容易踩的：canvas **不认 `var(--c-chart-*)`**，
  颜色必须先经 `readTrendChartTheme()` 解析；悬浮提示靠
  `interaction: { mode: 'index', intersect: false }`，少了它就退化成
  「必须精确压中柱子」—— 改完跑 `bun run --filter '@ai-token-report/web-portal' verify:charts`。
- **看板的时间窗默认传具名周期（`period`）**，由服务端用 `core/range.ts`
  解析。前端自己算「本月从哪天开始」= 把时区口径复制到第二个地方。
  **唯一的例外是「自定义区间」**：它传显式的 `from` / `to`（epoch 毫秒），
  因为那本来就是使用者选定的两个绝对时刻（`datetime-local` 给的就是本地墙上时间），
  不是任何口径；两者**不能同时发**（`period=custom` 会被服务端当成未知周期而 400）。
- **上报库没有 `total_tokens` 列**（铁律 2），所以诊断里的
  `identityViolations` **结构性恒为 0** —— 文案不能说成「扫了 N 条都没问题」，
  那是把一个恒真值伪装成检查结果。

## 测试

```bash
bun test                                    # 全仓
bun test packages/shared                    # 单包
bun run --filter '@ai-token-report/server' test
```

- 测试文件与被测代码同包，放 `<pkg>/test/*.test.ts`
- `packages/server/test/e2e-identity.ts` / `e2e-ingest.ts` / **`e2e-admin.ts`** 是**端到端脚本**
  （`bun run` 执行，非 `bun test`）；`e2e-admin.ts` 覆盖人员管理全链路
  （签发即刻可上报、401/403 分开、最后一个管理员护栏、坏文件拒绝写入）
- `packages/*/verify/` 下的脚本用于人工验证渲染与图表
- **改口径公式必须同时改 `packages/shared/test/metrics.test.ts`** —— 那里的断言
  固化了 94.3% / 19.3 倍等实测结论，是防止口径漂移的最后一道防线

## 提交前

发布必须通过根目录 `publish:plugin:dry` / `publish:plugin:next` / `publish:plugin`
（CLI 同款），统一入口 `scripts/release.ts`。禁止用直接发布 dist 绕过验证。
**迭代期**可以用 `publish:plugin:quick` / `publish:cli:quick`（= `--quick`）：
它只保留 `typecheck` + 目标包构建 + `verify:npm` + tarball 真启动，
跳过全仓单测 / e2e / 对账 / MySQL / 两种 Web，跳过的步骤逐条打印并落进 `report.json`；
改动涉及内核 / 口径 / 上报链路 / 数据库 / 插件装载，或对外首发时，仍必须走完整通道。
插件 bundle 是 `token-report` 的唯一 insert 来源，用户 profile 只能按 id 覆盖；
改发布或安装链路必须通过真实 tarball 的 `verify-profile-boot.ts`（两条通道都会跑它）。
完整范围、两条通道的边界与 0.3.0 事故恢复见 `docs/发布检查与事故恢复.md`。

```bash
bun test && bun run typecheck
```

两者都必须过（`bun test` 全绿 + 7 个包全部 exit 0）。
typecheck 是契约漂移的主要拦截点 ——
前后端字段对不上时它会直接编译失败，而不是等运行时看到空图表。




