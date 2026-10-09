# AI Token Report —— 平台整体梳理

> 本文是**目录与职责的顶层约定**：平台由哪几块组成、各自边界在哪、数据怎么流。
> 口径细节见 `docs/口径实测结论.md`，插件方案见 `docs/插件方案.md`，本文不重复。
>
> **已确认决策**：Bun 作为包管理器与运行时 / `--web` 起服务并自动开浏览器 /
> 本地页与服务端页是**两个独立 web 应用** / **插件与 CLI 互补上报** /
> 本地页**用本地 SQLite 增量库**（由日志派生，库不可用时降级直扫日志）。

---

## 0. 一句话架构

**四种形态，三个数据源，一条主线。**

```
① ai-token --web        → 本地页面：只看这台机器（本地增量库，零依赖）
② 服务端 portal          → 部门页面：看全部门很多人（读数据库）
③ DSH 插件               → 无人值守实时上报（装在 DSH 内）
④ ai-token report       → 定时补齐历史 + 离线机器兜底
```

**核心结构决策**：本地与服务端**彻底解耦** —— 本地用自己的库
（`~/.ai-token-report/usage.sqlite`），**只装本机数据、从不出网**。
这让「本地」名副其实：断网也能用，且服务端挂掉不影响任何人看自己的数据。

> ⚠️ **「会话日志根」与「token-report 数据目录」是两个东西**（`core/src/home.ts`）：
> `dshHome`（默认 `$DSH_HOME`，再缺省 `~/.dsh`）决定**日志从哪读**，
> `dataDir`（默认 **`~/.ai-token-report`**，**刻意与 `dshHome` 无关**）决定**身份 / 本地库 / outbox / 补报水位放哪**；
> 可用配置项 `dataDir` 或环境变量 `DSH_TOKEN_REPORT_DATA_DIR` 覆盖。本文里出现的 `~/.ai-token-report/...` 都是 `dataDir` 的默认值。
> 因为缺省不跟随 `DSH_HOME`，DSH Desktop 与命令行版 DSH **天然共用同一份身份与凭证**（都落到 `~/.ai-token-report`），
> 不需要任何配置；想「只这套 DSH 用它」时才显式写 `dataDir`（例：`dataDir: ~/.dsh/token-report`）
> —— 改 `dshHome` 会把日志来源一起换掉（详见 `packages/dsh-plugin/README.md` §1.1）。

> ⚠️ **本地端数据源在 S10 阶段从「直扫日志」改为「本地 SQLite 增量库」。**
> 原因是实测发现瓶颈**不是 IO 而是 CPU**：196 文件 / 80.8 MB 的全量扫描中，
> zstd 解压占 76.9%、JSON 解析占 19.5%，**磁盘读只占 3.7%** ——
> 每次查询都把同一段历史重新解压解析一遍。落库后 today 查询从 ~15,700 ms
> 降到 **0.26 ms**。详见 §3.1。

---

## 1. 现状盘点（重构前）

> ⚠️ **本节记录的是迁移前的历史状态，已过期。**
> 下表中的旧目录**均已删除**，内容分别迁入 `packages/core` 与 `packages/cli`。
> 保留此表仅为说明「为什么要重构」。

| 目录 | 实际内容 | 处置 |
|---|---|---|
| `dsh-token-stats/` | 完整 CLI：zstd 解码、扫描、聚合、增量上报、HTTP 投递 | ✅ 已拆成 `core` + `cli`，原目录已删 |
| `frontend/` | Vue 3 统计页 UI（卡片 / 图表 / 明细表 / 筛选） | ✅ 已改造为 `web-local` 并接真数据，原目录已删 |
| `dsh-session-inspector/` | 会话探针插件，可在工具调用处打断点 | ✅ 与本项目主线无关，已移除 |
| 服务端 | —— | ✅ 上报接收（S3）、本地直查（S4）、部门查询（S7）均已落地 |
| DSH 插件 | —— | ✅ 身份解析、上报后端、工具/服务、**界面用量面板**均已落地（S9，见 `packages/dsh-plugin/README.md`） |

### 1.1 三个必须修的裂缝

**裂缝 A：前端是假数据。** ✅ **已修复（S5）**
`frontend/src/mock/usage.ts` 曾硬编码 `¥4.56 / 461 次请求 / 80,642,909 tokens`，
与真实日志无关。UI 再完整，接不上真值就没有意义。
现已删除整个 `mock/` 目录，本地页改为从 `/api/local/stats/*` 取真实数据；
金额相关字段（`cost` / `CNY`）与组件一并移除 —— 当时是「不展示金额」决策下的正确做法；
该决策**已于 v7 反转**（单价来源就位），见 §7 待决项 2 与 `docs/费用统计方案.md`。

**裂缝 B：前后端字段口径已经漂移。**

| 前端旧类型 | 真实产出 | 冲突 |
|---|---|---|
| `apiKey` | `provider` + `model` | ❌ 概念不同 |
| `cost`（CNY 金额） | 只有 token 数 | ❌ 前端要钱，无单价来源 |
| `requests` | `calls` | ⚠️ 同义不同名 |
| （无） | `cacheReadTokens` | ❌ **漏掉 94.3% 的用量** |

> ⚠️ `cache_read` 实测占总量 **94.3%**。前端模型里根本没有这个字段，
> 意味着即使直接接上真值，页面也会漏掉 94% 的用量。

**裂缝 C：无身份归属。**
CLI 上报带着 `userId: 'unknown'` 兜底，但部门看板需要「谁用了多少」。
DSH 原生**故意匿名**（`crypto.randomUUID()`，官方明示「不要用它识别用户」），
所以身份必须由插件配置/环境变量显式提供（方案 A）。

---

## 2. 目标目录结构（Bun 管理）

```
ai-token-report/
├─ package.json                # workspace 根：Bun workspaces
├─ bunfig.toml                 # Bun 配置
├─ ARCHITECTURE.md             # ★ 本文
├─ docs/                       # 中文文档：插件方案 / 口径实测结论 / npm 发布 / 本仓工程约定
│
├─ packages/
│  ├─ shared/                  # ★ 契约单一真源（两端 + 插件都 import）
│  │   ├─ src/protocol.ts      #   上报 DTO + 查询响应类型
│  │   ├─ src/metrics.ts       #   口径公式（缓存命中率 / 恒等式校验）
│  │   └─ src/price.ts         #   单价口径与格式化（见 §7 待决项 2）
│  │
│  ├─ core/                    # ★ 统计内核（从 dsh-token-stats 迁入）
│  │   ├─ src/decode.ts        #   zstd 分帧解码
│  │   ├─ src/scanner.ts       #   会话日志扫描
│  │   ├─ src/aggregate.ts     #   分组聚合 / 时间序列
│  │   ├─ src/range.ts         #   时间范围解析（today / week / 最近7天）
│  │   ├─ src/state.ts         #   增量水位线（report 上报用）
│  │   └─ src/db/              #   ★ 本地 SQLite 增量库（独立入口 /db）
│  │       ├─ schema.ts        #     建表：4 独立列 + event_id 主键 + 索引
│  │       ├─ ingest.ts        #     增量入库（复用 scanIncremental 水印）
│  │       ├─ query.ts         #     查询（只出原始列，不写任何公式）
│  │       └─ stats.ts         #     门面：SQL/直扫两条路径 + 降级
│  │
│  ├─ cli/                     # ★ 用户唯一命令入口
│  │   ├─ src/cli.ts           #   参数解析 + 子命令分派
│  │   └─ src/cmd/
│  │       ├─ stats.ts         #   默认：终端统计
│  │       ├─ report.ts        #   ④ 增量上报到服务端
│  │       └─ web.ts           #   ① --web：起本地服务 + 开浏览器
│  │
│  ├─ web-local/               # ★ ① 本地页面（由 frontend/ 改造）
│  │   ├─ src/api/local.ts     #   调本地服务的 /api/local/*
│  │   ├─ src/views/           #   现有统计页（复用）
│  │   └─ vite.config.ts
│  │
│  ├─ web-portal/              # ★ ② 部门看板页面（S8，已落地）
│  │   ├─ src/api/portal.ts    #   调服务端的 /api/v1/stats/*（带 Bearer token）
│  │   ├─ src/composables/     #   usePortalSession（门禁）/ usePortalDashboard（取数编排）
│  │   ├─ src/views/
│  │   │   └─ DashboardView.vue#     总览 + 趋势 + 人员排行 + 分组排行 + 分布 + 明细 + 诊断
│  │   ├─ src/components/      #   RankingTable / TrendChart / RecordsTable / DiagnosticsPanel …
│  │   └─ vite.config.ts       #   5198；开发期把 /api 代理到 8787（DSH_PORTAL_API 可改）
│  │
│  ├─ server/                  # ★ ② 服务端（一个 server 两副面孔，见 index.ts 顶部表）
│  │   ├─ src/index.ts         #   createServer() + 路由分派（Bun.serve / node:http 二选一）
│  │   ├─ src/ingest-route.ts  #   POST /api/v1/token-usage  ← 插件 & CLI（S3，已落地）
│  │   ├─ src/stats-route.ts   #   GET  /api/v1/stats/*      ← 部门页（S7，已落地）
│  │   ├─ src/local-api.ts     #   /api/local/*  ← 本地页专用（本地增量库）
│  │   ├─ src/identity/        #   数据库身份、账号、权限、会话和审计
│  │   ├─ src/credentials.ts   #   旧凭证格式及历史兼容测试；生产不读写
│  │   ├─ src/verify-route.ts  #   POST /api/v1/identity/verify + 上报归属/看板身份解析
│  │   ├─ src/identity-route.ts#   /api/local/identity  ← 引导页读写
│  │   └─ src/serve-node.ts    #   node:http 适配器（★ 必须动态 import node:http）
│  │
│  └─ dsh-plugin/              # ★ ③ DSH 插件（docs/插件方案.md §3）
│      ├─ src/index.ts         #   apply() 装配 + TokenReportCapture（薄适配器）
│      ├─ src/capture.ts       #   ★ 订阅宿主 session/event → 账本记录（**不注册 sessionTelemetry**）
│      ├─ src/reporter.ts      #   非阻塞队列（热路径只能入队！）
│      ├─ src/outbox.ts        #   磁盘 outbox（崩溃不丢）
│      ├─ src/identity.ts      #   方案 A 三级回退
│      ├─ src/ui-bridge.ts     #   ★ 宿主侧 UI 数据通道 GET /api/tokenReport.stats
│      ├─ src/client/          #   ★ 浏览器半（用量条 + 标题栏徽章），构建成 lib/client.js
│      └─ build-client.ts      #   浏览器半构建：__ModuleLoader__ 信封 + 平台模块纯度校验
│
├─ tools/
│  └─ install-task.ps1         # ④ 计划任务注册（每 10 分钟 report）—— 待 S10
```

> `dsh-session-inspector/` 曾是独立 DSH 插件，与本项目无耦合，**现已移除**。
>
> **尚未落地**：`tools/`（计划任务注册，S10）。
> （`packages/core/src/db/` 已在 S10 落地，见 §3.1；
> `packages/server/src/stats-route.ts` 与 `packages/web-portal/` 已在 S7/S8 落地，
> 见 §5.3 与 §6。）
>
> 已落地但计划里未单列的：`packages/server/src/local-api.ts` —— `/api/local/*`
> 的直查实现（进程内 mtime 缓存 + 参数解析），S4 的实际产物。
> 迁移期旧目录 `dsh-token-stats/`、`frontend/`、`p0-verify/` 已全部删除。

---

## 3. 四条数据通路

同样的数据，四条路，用途完全不同。

```
              ~/.dsh/sessions/**/session.v3.jsonl.zstd
                    │  唯一真值源（计费级 data.usage）
                    │
   ┌────────────────┼─────────────────┬──────────────────┐
   │                │                 │                  │
 ① 本地页      ② 插件实时        ④ CLI 定时          ③ 本地终盘
 直扫          上报              补漏                统计
   │                │                 │                  │
   ▼                ▼                 ▼                  ▼
本地服务        POST               POST             终端表格
/api/local/*   /api/v1/           /api/v1/
   │           token-usage        token-usage
   ▼                │                 │
浏览器              └────────┬────────┘
（只看本机）                 ▼
                    ┌─────────────────┐
                    │     SQLite      │ ← event_id 幂等
                    │  token_event    │   ②④ 写同一张表
                    └────────┬────────┘
                             │
                             ▼
                    GET /api/v1/stats/*
                             │
                             ▼
                    部门看板页面（管理员看全员，普通成员只看自己）
```

| 通路 | 触发 | 数据源 | 覆盖 | 延迟 |
|---|---|---|---|---|
| ① 本地页 | `ai-token --web` | **本地增量库**（日志派生） | 仅本机 | **~50 ms** |
| ② 插件 | DSH 运行时自动 | 实时事件 | 装了插件的机器 | 实时 |
| ③ 终盘 | `ai-token` | **本地增量库**（日志派生） | 仅本机 | **~50 ms** |
| ④ 定时上报 | 计划任务 | 本地日志 → HTTP | 装了 CLI 的机器 | 10 分钟 |

### 3.1 为什么本地端改用 SQLite 增量库

#### 先看实测：瓶颈在 CPU，不在 IO

对 196 个会话文件 / 80.81 MB（解压后 262.8 MB / 96,282 行 JSON）
做全量扫描的分阶段实测：

| 阶段 | 耗时 | 占比 |
|---|---|---|
| 列目录（readdir + stat ×196） | 49 ms | 0.3% |
| stat 全部文件 | 7 ms | 0.04% |
| **读文件 IO** | **577 ms** | **3.7%** |
| **zstd 解压** | **12,102 ms** | **76.9%** |
| **JSON 解析** | **3,061 ms** | **19.5%** |
| 合计 | **15.7 s** | 100% |

> ⚠️ 旧文档写的「156 文件 / 61 MB 约 1~2 秒」已过期。真实冷扫描是 **15.7 秒**。

**关键结论**：磁盘 IO 只占 3.7%。花 96% 的时间解压 262 MB 文本、parse 9.6 万行
JSON，只为捞出 16,021 条计费记录 —— 而且**每次查询都重来一遍**。
这不是「读文件慢」，是纯粹的重复 CPU 劳动，只能靠「解析一次、复用多次」解决。

#### 落库后的实测数字

| 查询 | 直扫日志 | 本地库 | 加速 |
|---|---|---|---|
| today 总计 | ~15,700 ms | **0.26 ms** | ~60,000× |
| today 按 provider 分组 | ~15,700 ms | **9.12 ms** | ~1,700× |
| today 按天趋势 | ~15,700 ms | **1.03 ms** | ~15,000× |
| 全量按 provider/model 分组 | ~15,700 ms | **20.36 ms** | ~770× |
| 热态 ingest（L1 全跳过） | — | **~10 ms** | — |

一次性建库成本：全量入库 **231 ms**，库文件 **4.46 MB**
（原始压缩日志 80.8 MB，缩小 18 倍）。

#### 设计要点

| 要点 | 做法 | 原因 |
|---|---|---|
| **四个独立列** | `input_tokens` / `output_tokens` / `cache_read_tokens` / `cache_write_tokens` | 铁律 1：落库合并后无法还原 |
| **幂等键** | `event_id` 作 PRIMARY KEY + `INSERT OR IGNORE` | 复用上报协议的同名键，重扫/截断/并发全部安全 |
| **水位线入库** | `file_watermark` + `session_state` 两张表 | 与数据**同事务**推进，消灭「水印超前 → 丢数据」的窗口 |
| **SQL 不写公式** | 只做 `SUM(原始列)`，派生指标交给 `shared/metrics.ts` | 铁律 1：不允许出现第二个口径实现 |
| **时间分桶在 JS 侧** | `day`/`hour` 不用 SQL 的 `strftime` | ⚠️ SQLite 的 `'localtime'` 与 JS 时区在 `bun test` 下差 8 小时（见下） |
| **降级直扫** | `openStats()` 任何失败都回退 `scanAll` | 库是派生物不是真值，报错会让页面白屏 |

> ⚠️ **时区陷阱（实测踩到）**：`strftime('%Y-%m-%dT%H', ts/1000, 'unixepoch', 'localtime')`
> 与 `toHourKey()` 看起来等价，实际不是 —— SQLite 按**操作系统时区**，
> JS 按**进程 TZ 解析结果**。实测同一台机器上 `bun run` 两者都是 +08:00，
> 而 `bun test` 下 JS 被强制成 UTC 而 SQLite 仍是 +08:00，**相差 8 小时**。
> 表现为趋势图的点整体错位，且**只在测试环境暴露**。
> 因此时间分桶一律在 JS 侧用 `toDayKey()` / `toHourKey()` 完成。

#### 保留的收益

| 收益 | 是否保留 | 说明 |
|---|---|---|
| **零依赖** | ✅ | 库是本地的，服务端挂了、断网了照常可用 |
| **天然最新** | ✅ | 每次请求前先跑增量 ingest（热态 ~10 ms），把「库旧于日志」压到一次请求内 |
| **口径同源** | ✅ | SQL 只出原始列，派生指标仍走同一套 `derive()` / `metrics.ts` |
| **零存储** | ❌ **放弃** | 这是唯一的代价。换来的是 60,000× 的查询加速与整套缓存补丁的删除 |

> 库是**日志的派生物**：真值永远在磁盘日志里。因此它「坏了就重建」
> （`DB_SCHEMA_VERSION` 不符、文件损坏、`--reset-db`），不会丢任何数据。

#### 被删除的复杂度

数据源换掉后，为「15 秒的慢」而生的整套机制全部失去意义并被删除：

- `StatsCache` 的 mtime 签名失效逻辑
- 并发请求的 in-flight 合并（以及它那个 `await null` → `ECONNRESET` 的坑）
- `Bun.serve` 的 `idleTimeout` 从「正确性必需」降级为「冷建库兜底」

**接口延迟从 15 秒降到 50 毫秒后，为慢而生的补丁消失，同时消除了它们的 bug 面。**

### 3.2 插件与 CLI 的分工（已确认）

| | DSH 插件 ② | CLI report ④ |
|---|---|---|
| 触发 | DSH 运行时自动 | 计划任务每 10 分钟 |
| 时机 | **实时**（会话进行中） | 事后补齐 |
| 优点 | 数据新、无需额外任务 | 覆盖插件装不上的机器 |
| 缺点 | 需重启 DSH 生效 | 最长滞后 10 分钟 |
| 幂等 | `event_id` = `sessionId:seq` | 同左 |

**两者写同一张表，靠 `event_id` 去重，天然互补** ——
即使插件和 CLI 同时上报同一条记录，服务端也只会入库一次。
这是幂等键设计的最大收益：**上报方可以有多个，不必互相协调。**

---

## 4. 前后端口径统一（本次重构的核心目的）

### 4.1 字段映射表

| 前端旧字段 | 新字段（shared 真源） | 说明 |
|---|---|---|
| `apiKey` | `provider` + `model` | **语义变更**：改按厂商/模型分组 |
| `cost` | token 数（金额另由 `cost` 字段按权限下发） | **当时移除金额**：无单价来源；v7 起单价来源已就位（见 §7 待决 2） |
| `requests` | `calls` | 统一命名 |
| `inputTokens` | `inputTokens` | ⚠️ 语义收窄 = **未命中缓存**的输入 |
| `outputTokens` | `outputTokens` | 不变 |
| —— | `cacheReadTokens` | **★ 新增，占用量 94.3%** |
| —— | `cacheWriteTokens` | 新增（该 provider 恒为 0） |
| —— | `cacheHitRate` | **★ 新增，成本优化核心指标** |

### 4.2 三个绝不能搞错的口径

来自 `docs/口径实测结论.md` §2 的实测结论，已固化在 `shared/src/metrics.ts`：

```ts
// 1. input 是「未命中缓存」的部分，不是总输入
//    误把 cacheRead 加回去 → 虚增 20.3 倍
total = input + output + cacheRead + cacheWrite   // 9845 条样本全验证
//    注意 reasoning 不在恒等式内（它是 output 的子集）

// 2. 缓存命中率（实测 94.3%）
cacheHitRate = cacheRead / (cacheRead + input)

// 3. 只报 input + output → 漏掉 94.3% 的真实用量
```

**落库必须存 4 个独立列**，展示时再相加。一旦采集端合并，后续任何拆分都无法还原。

### 4.3 幂等键

```
event_id = `${sessionId}:${seq}`
```

- 服务端以 `event_id` 为主键，普通 INSERT 只捕获该主键冲突；其他约束错误回滚并返回非 2xx
- 所有上报方只需保证 **at-least-once**，重试与 outbox 重放天然安全
- 与 DSH 官方建议的 `(session.id, format_version, seq)` 去重口径一致

---

## 4.5 身份署名（已实现）

这是整个平台**唯一无法靠技术绕过**的问题：DSH 原生**故意匿名**
（`~/.dsh/.anonymous-user-id` 是 `crypto.randomUUID()`，官方明示「不要用它识别用户」）。
所以「谁用了多少」必须由用户显式提供。

### 4.5.1 方案：用户主动署名

| | 旧设想（安装时由 IT 写入） | **现行方案（用户主动填写）** |
|---|---|---|
| 谁填 | IT / 安装脚本 | **员工本人** |
| 何时 | 装机时 | **首次打开页面 / 首次启动插件** |
| 入口 | 配置文件 | **本地页「配置」弹框 / 插件的「连接配置」面板** |
| 合规 | 需另行书面告知 | **员工知情且主动**，更干净 |

**填写内容：只有两项** —— `服务端地址` + `appKey`（管理员发放）。
姓名与分组**不由用户填**：它们由服务端按 appKey 解析（见 4.5.2）。
两个入口（本地页弹框、插件面板）是同一形态、写同一份连接配置，在哪填一次都生效。

### 4.5.2 关键设计：appKey 是身份凭证，不是普通鉴权

```
用户填「服务端地址 + appKey」
        │
        ▼
POST <地址>/api/v1/identity/verify ──► 部门服务端凭证表
        │                                      │
        │  ◄── { ok, name: "张三", group } ───┘
        │      （响应同时带兼容别名 dept，同值）
        ▼
以【服务端返回的姓名】落盘 ← ★ 不采信客户端声明的任何身份字段
```

**为什么必须这样**：如果服务端直接采信客户端声明的姓名，
任何人改一下本地配置就能以他人名义上报，部门看板的数据立刻失去意义。

由此得到的性质：
- 客户端「我填了张三」不算数，**服务端以 appKey 解析出的身份为准**
- 即使本地身份文件被篡改，**也无法冒用他人身份**上报
- 界面里因此**没有**姓名 / 分组输入框（填了也不作数 = 做不到的承诺）

> 实证：端到端测试里故意在请求体里塞「张三三（用户打错）」，落盘结果是「张三」。

### 4.5.3 未署名 = 不采集也不上报

★ **已确认的行为约定**，实现落在三处：

| 位置 | 行为 |
|---|---|
| 本地页面 | 仍可查看本机总量（那是用户自己的数据），但不写归属、不发任何请求 |
| CLI `report` | 无署名时**跳过上报**，不静默记成 `unknown` |
| DSH 插件 | **不注册上报后端**，只提示一次「去哪里填」 |

> 为什么不按 `unknown` 兜底上报？因为那是**未授权的数据采集**。
> 宁可数据缺失（可在看板上看到「有 N 人未署名」），也不要偷偷采集。

### 4.5.4 身份文件与连接配置

```
<dataDir>/identity.json            # 缺省 ~/.ai-token-report/identity.json
<dataDir>/plugin-connection.json   # 服务端地址 + appKey（+ 插件的本机偏好）
```

**本地页与插件共用这两份** —— 员工在哪里填一次就够了。
两套 DSH（Desktop 与命令行版）**缺省就共用同一份**（都落到 `~/.ai-token-report`），不需要任何配置；
想各用一套时才显式写 `dataDir` 或 `DSH_TOKEN_REPORT_DATA_DIR`。

```json
// identity.json —— 「我是谁」（服务端认定的）
{ "name": "张三", "token": "...", "group": "研发一部",
  "createdAt": 1789984019944, "updatedAt": 1789984019944 }

// plugin-connection.json —— 「连哪台、拿什么凭证」（+ 面板偏好）
{ "baseUrl": "http://portal:8787", "appKey": "...",
  "flushIntervalMillis": 10000, "position": "dock", "dshHomes": ["~/.dsh"] }
```

> 旧身份文件里 `group` 这个字段叫 `dept`：读取按 `group ?? dept`，**写出只写 `group`** ——
> 兼容只发生在读取边界，不能让两种写法在新文件里并存。

实现要点（`packages/core/src/identity-store.ts`、`connection-store.ts`）：

| 约束 | 原因 |
|---|---|
| **原子写入**（临时文件 + rename） | 写一半被杀死会留下截断 JSON，用户会看到「我明明填过了」 |
| **权限 0600** | 文件含 token / appKey（凭证） |
| **解析失败不抛错**，降级为「未署名」 | 抛错会让页面白屏，而用户此时最需要看到配置入口 |
| **地址与凭证成对才认** | 半份连接会让「连哪台」与「我是谁」分叉，而两边都不报错 |
| **连接配置合并写**（本地页只动 `baseUrl` / `appKey`） | 整份覆盖 = 在本地页保存一次就把插件的偏好清空，且不报错 |
| **坏文件拒绝覆盖** | 内容可能还有救，销毁证据比报错糟得多 |

地址的优先级：**页面/面板里存过的那份 > 部署参数 `--portal`（或插件 `endpoint`）**。

### 4.5.5 数据库初始化与旧凭证导入

生产服务端的身份与权限事实和用量事件存于同一个 portal 数据库，支持 MySQL 和 SQLite。
人员 UUID、分组、角色权限、账号、Token 摘要、会话、挑战、限流及审计均持久化。
`credentials.json` 不再是运行时来源；指定 `credentialsPath` 会拒绝启动，禁止文件与数据库双写。

空库初始化为独立 portal v5（**v4 是冻结基线**），本地 `usage.sqlite` 仍为 v3。首次管理员可以由
`ATR_ADMIN_USERNAME` / `ATR_ADMIN_PASSWORD` 成对初始化，`ATR_ADMIN_TOKEN` 可作为初始化输入，
`ATR_ADMIN_NAME` 为显示名。密码只保存 KDF 哈希，Token 只保存摘要。
初始化标记存在后，不会因重启重新导入环境变量或复活已停用人员。

旧库必须先停止旧服务、备份并运行 `packages/server/scripts/migrate-db.ts` 的
inspect/migrate/resume，再通过 `packages/server/scripts/import-credentials.ts` 显式离线导入旧文件。
迁移路线是 **v3 → v4（冻结基线）→ v5**：v4 库直接走 v4→v5 步骤；v5 把 `usage_event` 的分组 ID 列
删掉（归属改由关联表承载）并把 `dept` 改名为 `group_name`，所以 SQLite 分支会**重建事实表**（必须先按
备份流程执行，迁移前后逐位核对事件指纹），MySQL 分支是 RENAME / DROP COLUMN。命令与备份参数见
[数据库部署与迁移](docs/数据库部署与迁移.md)。
导入检查原始重复 Token、用户名冲突、角色和哈希格式；源文件不改写，报告不输出秘密。
旧姓名历史保持 pending，只有人工确认映射才回填人员 ID。

数据库不可用、版本不符或迁移未完成均明确失败，不降级为空身份文件。
旧 `CredentialStore`、`member-admin.ts` 和 `LegacyPortalAuth` 只保留历史独立处理器测试。
表结构和操作边界见 [数据库重设计](docs/数据库重设计.md) 与 [接口与验收](docs/数据库重设计-接口与验收.md)。

### 4.5.6 人员管理与 appKey 发放（管理页）

人员管理按稳定的 `member_id` 操作；显示名可以重复，用户名仍唯一。
账号和上报 Token 独立关联人员，Token 列表不返回明文，只在签发或轮换成功时返回一次。
后台权限由数据库角色关系决定；Bearer 还须与该 Token scopes 取交集。

| 方法 | 路径 | 用途 |
|---|---|---|
| GET / POST | `/api/v1/admin/members` | 列表 / 创建人员 |
| POST | `/api/v1/admin/members/update`、`roles`、`status` | 人员资料、角色与状态 |
| POST | `/api/v1/admin/members/login`、`login/status` | 设置独立登录账号、启停账号 |
| GET / POST | `/api/v1/admin/members/tokens` | 凭证摘要列表 / 签发 |
| POST | `/api/v1/admin/members/tokens/rotate`、`revoke`、`scopes` | 轮换、吊销与范围变更 |
| POST | `/api/v1/admin/members/tokens/expiry` | ★ 改有效期（`null` = 长期有效，其余须是未来时刻） |
| POST | `/api/v1/admin/members/tokens/delete` | ★ 物理删除凭证（仅限从未上报、也未被审计引用的；其余 409 并提示改用吊销） |
| POST | `/api/v1/admin/members/appkey` | ★ 签发 appKey（范围固定为上报 + 获取统计） |
| GET | `/api/v1/admin/appkeys` | ★ appKey 列表：每行一把凭证 + 它发给了谁（`tokens:manage`） |
| GET | `/api/v1/admin/roles`、`storage`、`audit`、`legacy-attributions` | 角色目录＋权限目录、数据库状态、审计与历史映射 |
| POST | `/api/v1/admin/roles`、`roles/update`、`roles/status` | ★ 角色定义：新建 / 改名改权限 / 启停（均需 `roles:assign`；内置角色只读） |
| GET | `/api/v1/groups` | 分组目录：`{ groups: PortalGroup[] }`（`groups:read`） |
| POST | `/api/v1/admin/groups`、`groups/update`、`groups/status` | ★ 新建 / 改名 / 启用停用分组（`groups:manage`；动作名 `group.create` / `group.update` / `group.status`，审计 `target_type: 'group'`） |

**几个页面的分工**（`packages/web-portal`）：人员管理页（`/members`，`members:read`）只管
「这个人是谁」——资料、角色、登录账号与**所属分组（多选）**；分组管理页（`/groups`，`groups:manage`）
维护分组目录本身；appKey 管理页（`/appkeys`，**`tokens:manage`**）只管「这把 key 发给了谁」——
列表主体是全部凭证，归属由服务端按 `report_tokens.member_id`
关联人员表得出（改名后仍指向同一个人），可按人员搜索、轮换 / 吊销、**删除从未上报过的**，
并设置与修改**有效期**（`null` = 长期有效，过期只是时间比较，所以过期 key 可以续期而不必轮换）。
「删除」与「吊销」分工明确：吊销保留整行（谁被吊销过一屏可见，历史用量仍指向它），
删除只放行**从未被引用**的凭证 —— `usage_event.report_token_id` 与
`admin_audit_log.actor_token_id` 都是 RESTRICT 外键，被引用时服务端回 409 并在原因里
直说「请改用吊销」，页面原样呈现，不做「失败就降级成吊销」。
交付信息（上报 / 统计的完整地址 + 使用人 + 凭证提示）点开弹框查看，明文**不进 DOM**：
页面最多显示中间省略号的遮罩 `atr-ab12…ef34`，完整明文只在剪贴板里 ——
它只随签发 / 轮换响应出现一次，库内只有摘要，且凭证提示（`token_prefix`）也统一按
中间省略号渲染（`web-portal/src/utils/credential.ts`，展示层加省略号，库里存裸摘要前缀）。
两页权限互不附带：能读人员名单的人未必该看到谁手里有哪些凭证。
**人员的分组归属是「多对多」**（`PortalMember.groups: PortalMemberGroupRef[]`）：
`POST /api/v1/admin/members` 收 `group_ids?: string[]`，`members/update` 的 `group_ids` 是
**全量替换**语义（不给增量接口）。归属的权威是关联表 `member_group_assignments`，见 §4.5.9。

**角色的组成与分配**（角色管理页 `/roles`：`roles:read` 读、`roles:assign` 写）：一个角色就是一组权限的
命名集合，而人员权限是他所持**全部角色权限的并集**（`member_roles` 是多对多，一个人可同时持多个角色）。
页面可以新建自定义角色（`code` 是稳定标识，建后不可改）、改名、整组替换权限、停用 / 启用；
**内置角色（`admin` / `member`）只读**，停用某个角色前服务端会确认没有在职成员仍持有它 ——
否则会出现「零角色人员」（能登录、什么都不能做，而页面看不出原因）。
角色定义管理复用 `roles:assign` 而不新增 `roles:manage`：权限目录来自 schema seed，而
`portalSchemaChecksum` 是对整份 SQL（含 seed）求哈希，新增一行权限会让现有部署的校验和不匹配、
`current` 判定失败而拒绝启动，必须配套显式迁移。授予的权限还必须是操作者本次有效权限的子集
（`subset()`），否则一枚只有 `roles:assign` 的窄凭证就能给自己造一个高权限角色。

实现位于 `packages/server/src/identity/`。写事务先锁住 `portal_identity_state`，重新验证操作者，
再执行 CAS 版本检查、业务修改和成功审计；提交后其他进程立即读到新状态。
最后一个仍有可恢复管理入口的管理员不能停用、降级或失去最后有效凭证。
历史外键采用 RESTRICT；改名、Token 轮换均不改写旧事件快照。

新 Token 默认仅有 `identity:read` / `usage:write`。普通后台账号可读取部门统计；管理权限由角色目录授予，
不能用姓名白名单，也不能把上报 Token 默认当作后台登录密码。
无效身份、权限不足、未初始化/数据库不可用分别返回 401、403、503；版本或管理护栏冲突返回 409。

### 4.5.7 提示文案的三条原则

未署名时的提示写了什么，直接决定这个功能会不会被接受：

1. **说明去哪里填**，而不是抱怨「你没填」—— 后者让用户卡住
2. **明确承诺不采集** —— 含糊其辞会让人怀疑在偷采，反而更容易被拒绝
3. **区分「token 填错了」与「管理员还没发凭证」** ——
   后者用户做什么都没用，混为一谈会让人反复重试

---

### 4.5.8 部门后台的账号登录

部门后台现在以 **用户名 + 密码 + 图形验证码** 登录；CLI / 插件仍使用上报 Token。
账号通过 `login_accounts.member_id` 关联人员，用户名唯一，既有 Token 不自动成为密码。
新增账号和密码重置由人员管理页完成，密码版本与撤权状态在数据库事务内更新。

- `server/src/auth/password.ts`：`@noble/hashes` scrypt，随机盐，密码不明文落盘。
- `auth/captcha.ts`：生成 PNG 位图；数据库保存绑定挑战 ID 的答案 HMAC 和浏览器 binding 摘要，2 分钟有效、CAS 一次消费。
- `identity/portal-auth.ts`：数据库会话与限流。会话 8 小时过期，秘密只保存摘要；每次从数据库重读账号、人员和角色权限。
- `app.ts`：`/api/v1/auth/{captcha,login,session,logout}`；后台可使用 HttpOnly Cookie，
  原 Bearer API 契约保留。POST Cookie 操作校验同源及自定义请求头。
- `POST /api/v1/admin/members/login`：管理员设置 username / password，响应不含密码或哈希。

首次初始化见 §4.5.5；所有实例共享至少 32 字符的 `ATR_CAPTCHA_HMAC_KEY`，密钥留在部署环境、不入数据库。
HTTPS 反向代理需配置 `ATR_PORTAL_ORIGIN`。密码版本变化、账号/人员停用使旧会话失效；
单独轮换或吊销上报 Token 不使后台会话退出。数据库会话与验证码可跨服务重启、跨进程使用，
请求仍执行同源校验和当前权限重验。迁移和验证结果见 [Portal v4 验证记录](docs/database-v4/验证记录.md)。

### 4.5.9 分组（多对多）与归属展开

「分组」是人员归属维度的实体（表 `member_groups`，主键 `group_id`；权限码 `groups:read` / `groups:manage`）。
**人员与分组是多对多**：`members` 上不再有分组列，归属由关联表
`member_group_assignments(member_id, group_id, created_at_ms)` 承载 —— 用关联表而不是
`members` 上的 JSON 数组，是因为「按分组筛用量」必须能走索引。

- **归属的权威是关联表**。`usage_event.group_name` 只是上报当时客户端自己填的**文本快照**，
  不参与归属；服务端仍继续接受旧客户端的 `client.dept`，按 `client.group ?? client.dept` 落这一列。
- `members.department_id` 与 `usage_event.department_id` 已**删除**（v5）：一条事件属于哪个分组，
  由它的 `member_id` 关联出该人员**当前**所属的每个分组。
- **按分组筛选与分组排行都是 OR / 展开**：一条事件计入它的人员所属的**每个**分组，所以
  **「各分组之和 > 总量」是定义，不是重复计数的 bug**；未分组人员不进任何分组行，差额就是他们 ——
  页面必须能说清这一点。
- 权限码的改名随 v5 迁移**原地**发生（只改 `permissions.code`，权限 ID 与角色关联不变，**不做兼容别名**）；
  前端管理页路由由 `/departments` 改为 `/groups`。

## 5. 接口契约

### 5.1 本地服务（`--web` 起，仅供本地页）

| 接口 | 说明 |
|---|---|
| `GET /api/local/identity` | **署名状态**（★ 响应不含 token；含生效的 `baseUrl`） |
| `POST /api/local/identity` | **提交配置**（`{ baseUrl, token }`，会向该地址校验 appKey） |
| `DELETE /api/local/identity` | 清除署名 / 换人 |
| `GET /api/local/stats/overview?period=today` | 卡片指标（**实时扫描**） |
| `GET /api/local/stats/series?bucket=day` | 趋势 |
| `GET /api/local/stats/breakdown?by=provider` | 分组排行 |
| `GET /api/local/stats/diagnostics` | 解析诊断（恒等式校验失败数等，从库中读回） |
| `POST /api/local/refresh` | 触发下一次增量 ingest（回执） |

> 响应结构在 `packages/shared/src/protocol.ts` 的**「本地直查」一节**定义，
> 与部门看板的 `/api/v1/stats/*` 契约**刻意分开**：部门口径有 `userId` /
> `unattributedRate` 这些本机根本不存在的概念，硬套会把它们填成 0，
> 页面上那个「未归属占比 0%」纯属虚构。分列定义后这类假数据无从产生。

⚠️ **只监听 `127.0.0.1`，不做鉴权** —— 它只读本机数据，不暴露任何敏感数据。
`--web` **不提供改 host 的参数**（改 `0.0.0.0` 等于把你的用量与工作目录
开放给整个内网）；要开放给全组请用部门服务端。
参数直接复用 CLI 的 `--period` / `--since` 解析（`core/range.ts`），
保证「页面上看到的数」与「命令行看到的数」完全一致。

**数据新鲜度**：每个请求先跑一次增量 ingest（热态 L1 全跳过，约 10 ms）
再查库，因此不存在「库还是旧的」这种状态。实测热态请求约 **50 ms**
（直扫日志时代约 15 秒）。首次冷建库需全量解析历史，约 15 秒。

> **解析诊断的持久化**：`eventTypes` / `totalTokenMismatches` 这类计数
> 只能在**解析日志时**观察到，而热态请求根本不解压任何文件（本轮全为 0）。
> 因此 ingest 会把它们写进 `ingest_run` 表，诊断接口从库里读回 ——
> 否则页面上这组「采集是否健康」的关键信号会永久空白。

### 5.1.1 身份校验（部门服务端）

```http
POST /api/v1/identity/verify
Authorization: Bearer <token>
{ "token": "<token>" }
→ { "ok": true, "name": "张三", "group": "研发一部", "dept": "研发一部", "registered": true }
```

- 同时接受 header 与 body 里的 token（header 优先），兼容不同 HTTP 客户端
- **纯查询，不写库不落日志** —— 让「验证一下 token」这个无害动作不产生审计噪音
- ★ 返回的 `name` **只可能来自凭证表**，绝不回显客户端提交的内容
- `group` 与 `dept` **同值**同时返回：`dept` 已废弃，仅为兼容已部署的旧插件 / 旧 CLI；
  新代码一律读 `group`

> 校验失败返回 **200 + `ok:false`**，而不是 401。
> 用 401 会让前端把「token 填错了」和「网络坏了」混为一谈。

### 5.2 服务端上报（② 插件 & ④ CLI 共用）

2026-09-27：HTTP 入口增加有界异步 FIFO，等待时不解析正文，事务提交后才返回 200；
数据库写入使用有界多行 INSERT，普通版本闸门不再扫描历史事件。
容量配置、故障语义、看板 5 秒刷新与隔离压测结果见 [上报性能与队列方案](docs/上报性能与队列方案.md)。

```http
POST /api/v1/token-usage
Authorization: Bearer <DSH_REPORT_TOKEN>
Content-Type: application/json

{
  "schemaVersion": 1,
  "client": { "name": "ai-token-report", "userId": "zhangsan",
              "userName": "张三", "group": "研发一部" },
  "generatedAt": "2026-09-21T10:00:00Z",
  "records": [ { "event_id": "...", "session_id": "...", "seq": 16,
                 "ts": 1789984019944, "provider": "dashscope",
                 "model": "deepseek-v4.1-flash",
                 "input_tokens": 7772, "output_tokens": 186,
                 "cache_read_tokens": 1024, "total_tokens": 8982,
                 "cwd": "...", "turn": 1, "step": 1 } ]
}
```

响应（CLI 已按此解析，见 `deliver.ts:147`）：

```json
{ "accepted": 48, "duplicates": 2, "rejected": 0 }
```

> ⚠️ **契约已由 CLI 侧固化**，服务端必须遵守：字段用**下划线**、
> 身份在 `client` 对象内而非记录内、响应必须如实返回三个计数
> （缺失时 CLI 会回退成「全部接受」—— 不报错，但统计会失真）。
> 归属字段是 `client.group`；服务端**继续接受**旧客户端的 `client.dept`，
> 按 `client.group ?? client.dept` 取值写入 `usage_event.group_name` ——
> 旧插件 / 旧 CLI 不改也能继续上报（这是刻意的，不要删）。

实现落在 `packages/server/src/ingest-route.ts`。四条容易搞错、且已在
`test/ingest.test.ts` 里锁死的语义：

| 语义 | 做法 | 不这么做会怎样 |
|---|---|---|
| **鉴权失败回 401/503，不是 `200 + ok:false`** | ★ 与 §5.1.1 的 `/identity/verify` **刻意相反** | 客户端把 2xx 当成「已投递」并清掉 `pending`，那批用量**静默消失** |
| **归属取 token 查凭证表** | ★ `client.userName` 一律忽略，只用于排查 | 改一下本地配置就能以他人名义上报 |
| **`event_id` 主键幂等** | 普通 INSERT，仅事件主键冲突记为重复；其他数据库约束错误整批回滚 | 将外键/CHECK 错误当成重复会错误确认投递 |
| **单行拒收不牵连整批** | 坏行计入 `rejected`，好行照常入库 | 一条脏数据让整批 10 分钟的增量被反复重投 |

> portal v5 里 `usage_event` 持有 `member_id`、`report_token_id` 和 `received_at_ms`，
> 原 `user_id` / `user_name` / `group_name` 姓名快照、事件键和四项 token 保持原意；
> **事件本身不再存分组 ID**（v4 的 `department_id` 列已删除，`dept` 改名为 `group_name`），
> 一条事件属于哪些分组由 `member_id` 经 `member_group_assignments` 关联展开（见 §4.5.9）。
> v4 是**冻结基线**：v3 库先迁到 v4 再走 v4→v5。
> 本地派生库仍为 v3；两个入口和版本独立，不能共用库文件。

#### 🚨 上报库（`portal.sqlite`）绝不自动重建

本地库是**日志的派生物**，所以它「版本不符就重建」（§3.1）；
**上报库不是** —— 客户端投递成功后就清掉了自己的 `pending` / outbox，
**服务端是唯一副本**。因此 `openPortalDb()` 在 schema 版本不符时**抛错**，
而不是沿用 `openDatabaseForIngest()` 的「丢了重建」。一旦搞反，
一次 schema 升级就会把全员历史用量静默清空，且无从恢复。

库路径默认 `<dataDir>/portal.sqlite`（即 `~/.ai-token-report/portal.sqlite`），与本地库
`usage.sqlite` **必须分开**：混用会让全员数据与本机数据互相污染，
而库里没有「数据来源」列，事后拆不开。

#### 上报库可选 MySQL（本机库**不行**）

部门服务端可以把上报库放到 MySQL：`--mysql <url>` 或环境变量 `ATR_MYSQL_URL`
（见 `packages/core/src/db/portal-db.ts`）。**本机库 `usage.sqlite` 恒为 SQLite** ——
员工机器上跑 CLI 不需要任何数据库服务，这条边界由**类型**保证：
本地路径的函数只收同步 SQLite `Database`，MySQL 侧只有异步 `PortalStore`。

设计要点（细节与实测坑见 `docs/mysql上报库.md`）：

- **一份 SQL，两种后端**：`query.ts` 的构建器产出 `$name` 参数，MySQL 侧由
  `toPositional()` 翻成 `?`；四处语法差异（含 `||` 在 MySQL 是**逻辑或**这种
  「不报错只出错」的坑）全部收在 `dialect.ts`。
- **异步只在 portal 一侧**：MySQL 驱动只有异步 API，所以上报库门面统一异步；
  本机库路径保持同步（`bun run stats` 的终端表格就是产品本身）。
- **MySQL 的 `close()` 是空操作**：连接来自进程内共享池，每请求关池会重新握手。
- **两个运行时都能用，但驱动不同**：Bun 走内建 `Bun.sql`；Node 走**可选依赖 `mysql2`**
  （只声明在 `packages/server`）。🚨 两者都**不进 npm 发布产物** —— Node 那条是
  动态 import 且说明符构建期不可静态分析，否则 core 被内联时会把它带进 `cli.js`；
  没装 `mysql2` 时明确报错并给出安装命令。
  ⚠️ 部署含义：Node 上跑服务端时，入口要落在**能解析到 `mysql2`** 的位置
  （本仓是隔离式依赖布局，根 `node_modules` 里没有它）。
- 验收：`bun run packages/server/verify/verify-mysql-portal.ts`（53 项）断言
  两种后端在**同一批数据**下每个接口的响应体**逐位一致**；
  Node 那条通路另有一份真 Node 的活体脚本
  （`bun run --filter '@ai-token-report/server' verify:mysql:node`，55 项）。

### 5.3 服务端查询（部门页用）

| 接口 | 用途 |
|---|---|
| `GET /api/v1/stats/overview?period&from&to&provider&model&user` | 部门总览卡片 |
| `GET /api/v1/stats/series?bucket=day\|hour[&stack=user\|model][&stack_top=8\|20\|all]` | 部门趋势。★ 带 `stack` 时多算一趟「每个桶 × 每个分层」的交叉值（含逐层金额），页面据此画**堆叠柱 / 多条折线**；缺 `stack` 字段 = 这次没要过分层（老客户端行为不变）。`stack_top` 只在展开时有用（缺省仍前 8 名 + 「其余 N 个」，`all` = 全部，上限 200） |
| `GET /api/v1/stats/breakdown?by=user\|group\|model\|provider\|provider-model\|project\|day\|hour` | **★ 人员排行 / 分组排行**（`by=group` 是新增的分组维度） |
| `GET /api/v1/stats/records?limit&offset` | 明细（分页，最新在前；每行带 `group_ids` 与 `group_name_snapshot`） |
| `GET /api/v1/stats/groups` | ★ 分组候选项 `{ groups: StatsGroupOption[] }`（`stats:read`；筛选栏与分组排行的选项都取自它） |
| `GET /api/v1/stats/members` | ★ 人员候选项 `{ members: StatsMemberOption[] }`（`stats:read`；名册 + 每人**当前**分组 ID，筛选栏的人员下拉取自它） |
| `GET /api/v1/stats/providers` | ★ 供应商候选项 `{ providers: string[]; aliases?: string[] }`（`stats:read`）。`providers` = 库里出现过的名字，**已按查看者的归一化规则映射成展示名**；`aliases` = **归一化规则里配的名字**（配置面，**可能还没有任何用量** —— 只从用量取候选时那个名字不会出现在下拉里）。两份都去重升序。刻意**不带时间窗与筛选**，也不含任何用量数字 —— 它是一份目录，因此不跟数据范围收窄 |
| `GET /api/v1/stats/projects` | ★ **项目目录候选项** `{ projects: string[] }`（v11，`stats:read`）。回的是**原始 `cwd`**（项目归一化配置页要配的就是「哪个目录算哪个项目」，给它归一化后的名字等于让它无据可配），去重升序、**不含任何用量数字**、**不带时间窗**（候选必须是完整集合）。🚨 与供应商候选的关键差别：它**跟着数据范围收窄** —— `cwd` 会带出使用者路径（`C:\Users\alice\…`），一份全量路径清单等于给「非管理员只看本人」开一个侧门。⚠️ 实现上是**开裸连接跑一条 `distinctCwdsQuery()`**（同 `/stats/providers`），**不走 `openPortalStats()`** —— 那条路会撞上 `assertLegacyIdentityView()` 的 409，而那一关是给「按人排行」用的 |
| `GET /api/v1/stats/diagnostics` | 覆盖率 / 未归属 / 数据边界 / 最近落库 |

**页面上的筛选**（`web-portal`）：

| 筛选 | 传什么 | 为什么 |
|---|---|---|
| **时间窗** | 具名周期 `period`（`today` / `上周` / `最近 90 天` …） | 由服务端 `core/range.ts` 解析，**前端不做日期换算** |
| **自定义区间** | `from` / `to`（epoch 毫秒） | 那本来就是使用者选定的两个绝对时刻，不是口径；结束时刻按「含该分钟」处理 |
| **人员** | `member_id` / `legacy_user` / `unattributed`（**多选**） | 归属筛选是**精确匹配**；候选来自 `GET /api/v1/stats/members` **名册 ∪ 用量派生键**（未署名 / 待确认历史） |
| **分组** | `group_id`（**逗号分隔多选**，精确匹配） | 候选项来自 `GET /api/v1/stats/groups`，**不是** `/api/v1/admin/groups` |
| **厂商** | `provider`（**多选**：一值一个同名参数，服务端也接受逗号分隔） | 每个值仍是**子串**匹配（与 CLI 同义）。候选三档 = `GET /api/v1/stats/providers` 的 **`providers`（数据里出现过的，已归一化）∪ `aliases`（归一化规则里配的名字，可能还没有用量）∪ 使用者在本机浏览器里自建的名字**（`allow-create`）；自建项**不写库** —— 供应商名是用量行上的事实，库里那份可编辑配置是归一化规则（`provider_alias`）。合并规则只在 `providerFilterOptions()` 一处（同名以数据 > 规则 > 自建为准）。下拉**可搜索**，输入未命中时回车即新建 |
| **模型** | `model` | **子串**匹配（与 CLI 同义），与人名规则刻意不同 |

**趋势图上的三个开关**（总览与分析共用同一份 store 状态）：

| 开关 | 取值 | 传什么 |
|---|---|---|
| **指标** | Token 用量 / 调用次数 / 费用（估算） | **不重新取数** —— 三种值本来就在同一份 `series` 载荷里（金额在 `points[].cost`、逐层金额在 `stack.items[].cost`） |
| **分层维度** | 合计 / 按用户 / 按模型 | `stack=user\|model`；选「合计」时**不传**该参数（载荷里连 `stack` 字段都没有） |
| **保留层数**（仅展开时出现） | 前 8 名 / 前 20 名 / 全部 | `stack_top=8\|20\|all`；**必须重新取数** —— 截断发生在服务端，前 8 名那趟响应里根本没有第 9 名以后的数据，页面上拆不开「其余」。选择记在**本机** `localStorage`（`utils/trendDepth.ts`），默认「全部」 |

**分布表的搜索与分页**（`BreakdownTable.vue`；分析页「用量分布」与总览页「分组排行」
共用同一个组件，行为不需要调用方各自打开）：

| 交互 | 作用范围 | 为什么 |
|---|---|---|
| **搜索框** | 第一列真的画出来的东西：原始键 / 展示名 / **分组标签**；大小写不敏感，**数值列不参与** | `by=source` 的展示名是翻译过的（`trae-cn` → `Trae CN`），只认一半就会出现「明明有这个来源却搜不到」；而按数值搜会让「1」命中一大片，那不是搜索 |
| **页码条** | **客户端**分页，每页 10 行（`utils/breakdownView.ts` 的 `BREAKDOWN_PAGE_SIZE`） | `/api/v1/stats/breakdown` 一次返回窗口内的**全部**分组行（几十到几百），协议里既没有 `limit` 也没有 `total` —— 与 appKey 列表同一笔账。⚠️ 与调用明细**刻意不同**：那里一次查询可能是几十万条事件，必须服务端分页 |
| **工具条可见性** | 行数 > 10 行**或**有关键词时才出现 | 与「只有一页时不画分页条」同一条纪律（它那时解释不了任何事情）；⚠️ 有关键词时**必须**留着，否则使用者没有地方清掉它 |

> 🚨 **先匹配、后分页**：反过来写（先切当前页再 `filter`）会让搜索框静默变成
> 「只搜当前页」—— 表现是「明明有这一行，翻到第 2 页才出现」，而页面上没有任何迹象。
> 纯逻辑在 `utils/breakdownView.ts`，由 `packages/web-portal/test/breakdown-view.test.ts` 钉住。

> ★ **柱状图堆叠、折线图不堆叠**：堆叠柱的总高就是趋势总量（各层之和 ≡ 总量，
> 逐桶逐点成立）；折线堆叠之后只有最上面那条的高度可读，下面几条的值要靠相邻两条
> 相减才能得到 —— 那是一个不会报错的读图陷阱。两种图形都靠
> `interaction: { mode: 'index', intersect: false }` 让同一横坐标上的**每一层**
> 一起进提示框，这就是「鼠标移上去看到每个用户 / 每个模型的用量」的全部实现。
>
> ★ **按人分层的键与人员排行同源**（成员视图下是稳定 `member_id`，旧视图是 `user_id`）：
> `PortalStatsSession.stackSeries()` 刻意复制 `memberGroups()` 的键与标签判定 ——
> 两者分叉的话，图上「张三」那一层与排行里的「张三」不是同一个键，而两边看起来都正常。
>
> ★ **分层默认只画前 8 层，尾部合并成「其余 N 人 / N 个模型」**（`SERIES_STACK_MERGED_KEY`
> 这一哨兵键 + `merged: true`）。不是丢弃：合并项让「各层之和 ≡ 总量」在任何层数下
> 都成立，而几十个人各占一条柱子之后每一层都细到看不见。
> ★ 但**这个默认值由页面覆盖**：层数是看的人自己的取舍 —— 只想核对「每个人各用了多少」
> 时，「其余 7 人」恰恰是他唯一看不到的东西。所以页面上有一个「前 8 / 前 20 / 全部」
> 开关（默认全部），对应 `stack_top`；`all` 在服务端仍有一条 200 层的**载荷护栏**
> （每一层都要下发 `len(points)` 个数字），被它折掉的层照旧进「其余」并在标题里说明。
> `mergedCount > 0` 时标题那句说明由 store 的 `stackDepthNote` **只拼一次**
> （总览与分析是同一张图）。
>
> ★ **金额在多币种时逐层整块缺席**（`items[].cost` 不存在），页面据此退回 token 并说明
> 原因。逐层挑一个币种画出来 = 在堆叠柱上偷偷做一次换算 —— 那是这一期最想避免的误读。
> 修正后的规则：`cost` 只在**全部层合起来**恰好一个币种时才下发。

> ⚠️ 人员下拉的候选**必须不带任何筛选参数**（名册接口本身不收参数）：
> 若从已筛选的结果里取候选，选中一个人之后下拉会塌缩成一个选项（自锁定），
> 使用者再也加不回别人，而页面看起来像「其余人都没数据」。
>
> ★ 候选也不能只从**用量**里取（`breakdown?by=user`）：那样「当前窗口内没有
> 用量的人」会从下拉里消失，而**选中一个分组之后整个下拉会空掉** ——
> 看起来像数据丢了。所以名册以 `GET /api/v1/stats/members` 为准（它由
> `members` + `member_group_assignments` 两张权威表得出），页面再用每人当前的
> `group_ids` 做**联动收窄**：未选分组 = 全部人员；选中分组 = 只列该分组成员。
> 收窄是页面的展示过滤（不参与任何数值），`memberFilterOptions()` 是它唯一的实现。
> 只有「未署名 / 待确认历史」这两类归属状态目录里表达不出来，仍由用量行补上。

> ★ 厂商下拉的候选同样**不带任何筛选参数**（`GET /api/v1/stats/providers` 本身不收），
> 否则选中一个供应商之后下拉会塌缩成一项。响应里有**两份**候选：
> `providers` 给的是**归一化后**的展示名（数据里出现过的原值经映射）——
> 与筛选匹配用的是同一份映射（`loadProviderAliases` 按**查看者**解析），
> 所以「页面上看到什么名字就能筛什么名字」；`aliases` 给的是**归一化规则里配的名字**
> （`provider_alias`）—— 只从用量取候选时，一条规则配好了、对应原值却还没有用量时，
> 那个规范化名字在下拉里**根本不会出现**，而它正是使用者在 `/providers` 页配出来、
> 想在看板上筛的那个名字（选中它可能是如实的 0 行，与来源候选里「本机还没跑过
> Codex」同一件事 —— 所以它在下拉里**单独成组**，把这句写在组标题上）。
> ⚠️ 使用者还能在框里**手输一个新名字**（`allow-create`）：它只被记进
> **本机浏览器**（`web-portal/src/utils/providerCatalog.ts` 的 `atr.portal.customProviders.v1`），
> **绝不写库** —— 供应商名是用量行上的事实，往库里插一个没有用量、没有价格的
> 「供应商」只会得到一个永远查不出数据的幽灵选项，而且没有地方能删掉它。
> 库里那份可编辑配置是归一化规则（`provider_alias`），那是管理面的事。
> 合并规则只有一处：`web-portal/src/types/portal.ts` 的 `providerFilterOptions()`
> （**同名以靠前一档为准：数据 > 规则 > 自建**；`aliases` 缺字段 = 老服务端，按空数组处理）。

**分组维度是「展开」语义，不是重复计数**：人员与分组是多对多（§4.5.9），
所以 `by=group` 与 `group_id` 筛选都把一条事件计入它的人员所属的**每个**分组 ——
**各分组之和可能大于总量**，这是定义；未分组人员不进任何分组行，差额就是他们。
明细里的 `group_ids` 是该人员**当前**的归属，`group_name_snapshot` 才是上报当时的文本快照，
两者不该互相冒充。

**响应结构在 `packages/shared/src/protocol.ts` 定义，前后端共用** —— 防漂移的关键。

实现落在 `packages/server/src/stats-route.ts`（数据层在 `core/db/portal.ts`）。
五条容易搞错的语义：

| 语义 | 做法 | 不这么做会怎样 |
|---|---|---|
| **鉴权失败回 401/503，不是 `200 + ok:false`** | ★ 与 §5.1.1 的 `/identity/verify` **刻意相反**，理由同 §5.2 | 响应体里装的是**数据**，回 2xx 会让前端把「token 不对」渲染成「这段时间没人用」—— 一个 0 值空看板 |
| **只读上报库，一个字节都不写** | `openPortalStats()` → `openPortalDb()` | 写坏唯一副本；schema 版本不符时还会触发「重建」 |
| **没有降级路径** | 库打不开 → `500` + 具体原因 | 上报库没有可重扫的真值，拿空数据冒充「今天没人用」比报错危险 |
| **未归属统一成 `unknown`** | 稳定人员、历史待确认和真正未归属三者分开（v4 起建立的新视图）；旧姓名视图保持原键含义 | 待确认历史不能冒充匿名或自动归给同名人员 |
| **分组是 OR / 展开** | 归属取 `member_group_assignments`，一条事件计入人员所属的每个分组；`usage_event.group_name` 只是快照，**不参与归属** | 把快照当归属 = 按错别字统计；断言「各分组之和 == 总量」= 把定义当 bug |
| **时间窗由服务端解析** | 页面只传 `period`，服务端调 `core/range.ts` | 前端自己算「本月从哪天开始」= 时区口径的第二份实现 |
| **数据范围只认内置 `admin` 角色** | `applyDataScope()`：非管理员一律收窄成 `member_id = 自己`；点名别人 / 未署名 / 旧姓名子集一律 `403`，兼容身份没有稳定 ID 时也 `403` | 手拼 `?member_id=<别人>` 就能把看板换成全公司；按姓名兜底还会把同名的两个人并成一个人 |

> 🚨 **数据范围是服务端的边界，不是页面的**：页面在「只看自己」时隐藏人员下拉
> （`web-portal` 的 `session.scopedToSelf` → `FilterBar.vue`），那只是不再画一个假控件；
> 那里也**刻意不写任何「你只看得到自己」的提示** —— 身份不该由筛选栏宣布，
> 真正的收窄在服务端，与页面画了什么无关。拿页面当权限就是「前端过滤 = 权限」那一类错误。
> 判据刻意是**角色码**而非权限码：`members:read`（人员目录）、`stats:read`（能不能进看板）、
> `cost:read`（金额）回答的都是「能做什么操作」，拿它们当数据范围会把
> 「能管名册」与「能看全员用量」绑成一件事，而那种绑定在页面上看不出来。
>
> ⚠️ **权限来自数据库角色关系**（见 §4.5.6）：后台账号可按角色读取部门看板，
> Bearer 还要求 Token scope 包含 `stats:read`；新默认上报 Token 没有看板或管理权限。
> 管理动作逐项检查对应权限。鉴权失败分 401 / **403** / 503 三者，
> 绝不能用姓名硬编码白名单判断管理员。
>
> ⚠️ 诊断里的 `identityViolations` **恒为 0 且是结构性的**：上报库不存
> `total_tokens` 列（铁律 2），总量一律由四项相加得出，所以恒等式不可能不成立。
> 页面文案必须说清这一点，否则它就是个「看起来很健康」的假信号。

数据链路：

```
CLI / 插件 ──POST /api/v1/token-usage──► portal.sqlite ──只读──► /api/v1/stats/* ──► 看板页
                （归属取 Bearer token 查凭证表）        （openPortalStats）
```

---

## 6. 页面职责划分（两个独立应用）

| | `web-local` 本地页 | `web-portal` 部门页 |
|---|---|---|
| 使用者 | 我自己 | 管理者 / 全组 |
| 数据范围 | 本机 | 管理员 = 全员；**其他任何身份 = 只看自己**（服务端 `applyDataScope()` 强制，页面据此隐藏人员下拉） |
| 数据源 | `/api/local/*`（本地增量库） | `/api/v1/stats/*`（只读上报库；分组 / 人员 / 供应商候选项走 `/api/v1/stats/groups`、`/api/v1/stats/members` 与 `/api/v1/stats/providers`） |
| 鉴权 | 无（仅 127.0.0.1） | 用户名、密码、验证码登录；HttpOnly Cookie 会话，退出后清除页面数据 |
| 部署 | CLI 内置，随命令启动 | 独立部署（`bun run server` 托管 `packages/web-portal/dist`） |
| 核心视图 | **首次署名引导** / 我的用量 / 我的项目分布 | **人员排行** / 部门趋势 / 模型分布 / 单人下钻 / 用量明细 / 采集诊断 |
| 管理视图 | ❌ 无（本机数据只有我自己） | ★ **人员管理 / 分组管理 / 角色管理 / appKey 管理**（按服务端权限显示）：人员资料与分组归属、分组目录、角色、发放 / 重置 / 吊销 token |
| 筛选 | 时间窗 / 厂商 / 模型 | 时间窗（**含自定义区间**）/ **人员（多选，仅管理员）** / **分组（多选）** / **厂商（多选 + 可搜索 + 可新建，自建项只存本机浏览器）** / 模型 |
| 金额（估算） | ✅ **展示**（概览卡片 / 明细列 / 费用口径那一行），但**前提是配置过上报**（已署名）：没配置 → 三个接口的 `cost` 整块不下发（不是 0；判据见下方） | ✅ **展示**（需 `cost:read`；无权限时字段**整个不下发**） |
| 特色指标 | 我的缓存命中率、我的项目消耗 | **未署名占比**、**是谁没署名**、**给谁发了 token** |

两者共享 `shared` 的类型与视觉规范（`styles/base.css` 的设计令牌同源），
但**构建产物、路由、部署方式完全独立** —— 样式文件刻意各存一份，
不为几个 CSS 变量把两个应用绑成同一个构建单元。

> **金额（估算）自 v7 起可用**（旧决策「不展示金额」已反转）：单价粒度是 `(provider, model)`、
> 匹配**上报原值**（供应商归一化只改展示名，不参与计价），金额按**事件发生时刻**现算、
> **绝不存 `cost` 列**，公式只在 `shared/src/price.ts`。看板需要 `cost:read`：
> 没有这个权限时整个 `cost` 字段**不下发**（不是 0），页面按「字段在不在」决定出不出现。
> 看金额时的**只读单价快照**走 `GET /api/v1/stats/pricing`（`cost:read`），
> 与配置面 `/api/v1/admin/pricing*`（`pricing:manage`）是**两条接口两道门**。
> 多币种各自累加、绝不换算相加；趋势金额在多币种时不画线（画出来像「没花钱」）。
> **离线端（本地页 / CLI / 插件）的价来自数据目录下的 `pricing.json` 快照**
> （`ai-token-report pricing sync` 从只读快照接口拉取），没有该文件时退回**内置种子价**
> 并在响应里如实标注来源 —— 离线端与看板读的不是同一份价，**同一个时间窗会给出不同的金额**，
> 所以「按哪份单价算的」必须与金额同时出现。金额折叠的公共件在 `core/src/db/cost.ts`。
> ★ **本地页多一道配置门禁**：`/api/local/stats/*` 只在**本机已署名**
> （`<dataDir>/identity.json` 存在，与 `/api/local/identity` 的 `signed` 同一份事实）
> 时才下发 `cost` —— 没配置上报的机器上，能用的价只有**内置种子价**（只覆盖
> `deepseek-official` 那几个模型），那个数会以一个「看起来正常」的金额出现在第一屏。
> 未配置时三个接口**都不带 `cost`**，且服务端**连 `pricing.json` 都不读、
> 连记录都不物化**；页面/CSV 靠既有的「字段在不在」判定把卡片、费用列、口径行
> 与 CSV 两列一起收掉。它**不是权限**（`/api/local/*` 无鉴权、只监听回环），
> 与部门看板的 `cost:read` 是两件事。
> 详见 `docs/费用统计方案.md`。

> **看板的账号门禁**：`web-portal` 未登录时只渲染登录页，不发统计请求。
> `/api/v1/auth/{captcha,login,session,logout}` 对接数据库认证；客户端署名仍走独立 Token 校验。
> 会话失效时退回登录页并清空旧数据；数据库不可用明确展示错误，不能当成空统计。
> 页面上还留着上一轮的数据，使用者会以为「这是最新的，只是有个警告」。
>
> **管理入口和操作能力来自服务端当前权限**（见 §4.5.6）。前端隐藏入口是排版，不是权限：
> 权限不足直接请求管理 API 会拿到 **403**。
> 权限判断只写在前端 = 没有权限。

---

## 7. 待决项

1. ☐ **`--web` 起服务后端口被占用怎么办？** ✅ 已实现：自动 +1 重试（最多 10 次），
   并在启动信息里明确提示「端口 X 被占用，已改用 Y」。
   配套决策：`--web` **不允许改 host**（恒为 `127.0.0.1`），避免一次参数误用
   就把全员数据暴露在内网。
2. ✅ **部门页要不要金额？** 原结论是「**不要**」：只展示 token 数（可审计的真值），理由是**当时没有单价来源**。
   该结论**已于 v7 反转** —— `model_price` 表 + `shared/src/price.ts` 提供了单价来源，
   服务端在 `cost:read` 下按**事件发生时刻**现算并下发金额（无权限时字段整个不下发），
   只读单价快照走 `GET /api/v1/stats/pricing`。方案、口径与分期见 `docs/费用统计方案.md`。
3. ☐ **身份落地方式？** ✅ 已确认：**用户主动署名 + token 作为身份凭证**（§4.5）。
4. ☐ **「数字集团 token」口径**：只算 `dashscope`，还是员工全部流量？
   （`docs/口径实测结论.md` §4.1，差 2.36 亿 vs 10 亿+）—— **仍需拍板**
5. ☐ **部门页开放范围**：仅 127.0.0.1？还是内网全组可访问（需鉴权）？
   ✅ 已定：**监听地址仍默认 127.0.0.1，对全组开放用 `--host 0.0.0.0`；
   所有 `/api/v1/stats/*` 与页面数据均要求有效会话或含对应 scope 的 Token**（见 §5.3 与 §6）。
6. ☐ **凭证发放方式**：管理员手工编辑 `credentials.json`，还是加一个签发页面/命令？
   ✅ Portal v5 已改为**数据库初始化 + 人员管理页 / 分组管理页**。旧文件只作显式离线导入源；
   环境变量只初始化一次，不作为永久旁路。之后在人员管理页操作独立账号与 Token（§4.5.6）。
   权限使用数据库角色和 scope，不用姓名白名单；部署命令见 [数据库部署与迁移](docs/数据库部署与迁移.md)。
7. ✅ **迁移期旧目录如何处理？** 已确认并执行：`dsh-token-stats/`、`frontend/`、
   `p0-verify/`、`dsh-session-inspector/` 全部删除；`.bun-cache/`、`node_modules/` 一并清理。
   `dsh-token-stats/` 的代码先迁入 `packages/core` + `packages/cli` 并验证后才删。
8. ☐ **server 层要不要库化（引入第三方 Web 框架）？**
   现状：`packages/server` **零第三方运行时依赖**，但 HTTP 层是手写的 ——
   路由分发是 185 行顺序 `if` 链（`server/src/index.ts:390-574`）、
   `registered ? 401 : 503` 写了 3 遍（`ingest-route.ts:109` / `stats-route.ts:119` /
   `admin-route.ts:173`）、错误信封 `{ ok:false, reason }` 手写约 31 处、
   请求日志 / CORS / `Content-Type` 校验 / 压缩**全缺**、静态托管 52 行无 ETag。
   另有一段 **843 行没人调用的孤儿子系统**（`password` / `captcha` / `png` / `dot-font`）。
   **建议**：引入 `hono` + `@hono/node-server`（均 MIT、**0 依赖**）接管
   「HTTP 机械动作」，业务护栏（401/403/503 三分、上报非 2xx、凭证唯一真值…）
   留在自持代码里 —— 完整事实、选型逐项判定与分阶段方案见
   **`docs/server架构重构方案.md`（S12 系列）**。

---

## 8. 实施顺序

| 阶段 | 内容 | 产出 | 状态 |
|---|---|---|---|
| **S0** | 整体梳理 + 目录骨架 + shared 契约 | 本文 + 骨架 | ✅ 完成 |
| **S0.5** | **身份署名全链路**（契约 / 存储 / 校验 / 引导页 / 插件） | **可署名的本地服务** | ✅ 完成 |
| **S1** | 抽 `core`（迁移 CLI 逻辑，行为不变） | 可复用内核 | ✅ 完成 |
| **S3** | `server`：ingest 接口 + SQLite 幂等落库 | ④ 能打通 | ✅ 完成 |
| **S4** | `server`：`/api/local/*` 统计直查 | ① 数据就绪 | ✅ 完成 |
| **S5** | `web-local`：删 mock，接本地 API | **本地页面可用** | ✅ 完成 |
| **S6** | `cli --web`：内嵌 server + 开浏览器 | **`ai-token --web` 兑现** | ✅ 完成 |
| **S7** | `server`：`/api/v1/stats/*` 查询接口 | 部门数据就绪 | ✅ 完成 |
| **S8** | `web-portal`：部门看板（人员排行等） | **部门页面可用** | ✅ 完成 |
| **S9** | `dsh-plugin`：backend + 队列 + outbox + 全局配置 + 工具/服务 | **③ 插件上报** | ✅ 完成 |
| **S9.5** | `dsh-plugin`：浏览器半（`conversation.input.dock` 用量条 + 标题栏徽章）+ `/api/tokenReport.stats` | **④ 界面里直接看用量** | ✅ 完成 |
| **S11** | `server` + `web-portal`：**角色与人员管理**（权限列 / 签发重置吊销 / 管理员页签）+ 看板的**人员多选与自定义时间段**筛选 | **可运营：自己发 token** | ✅ 完成 |
| **S12** | `server`：**库化重构**（补分发面契约测试 ✅ → Hono 路由 ✅ → 中间件收编 ✅ → 孤儿模块裁定：删除 ✅ → 静态托管升级 ☐ → 可选 schema 化 ☐） | 更薄、更可运维的 server 层 | 🟡 S12.0~S12.2 + S12.4 完成，S12.3 / S12.5 待做（`docs/server架构重构方案.md`） |
| **S10** | 计划任务 + 凭证铺开 + 合规确认 | 可运营 | |

> **S0.5 已完成**：署名链路（含真实 HTTP 端到端验证 27 项）已可用。
>
> **S3 已完成**：`POST /api/v1/token-usage` 已落地（`server/src/ingest-route.ts`）——
> 鉴权（Bearer → 凭证表）、逐行校验、`event_id` 幂等落库、如实返回
> `accepted / duplicates / rejected`，归属写进 `usage_event` 的
> `user_id / user_name / dept` 三列（schema 版本 3；该快照列现名 `group_name`）。
> 两条端到端验证：
>
> ```bash
> bun run packages/server/test/e2e-ingest.ts        # 真实 HTTP 打上报接口（35 项）
> bun run packages/cli/verify/verify-report-ingest.ts  # 真 CLI report → 真服务端 → 库（28 项）
> ```
>
> 关键取舍见 §5.2：**鉴权失败必须是非 2xx**、**归属只信服务端**、
> **上报库绝不自动重建**。
>
> **S9 已完成**：`dsh-plugin` 的上报链路已落地 ——
> 宿主会话事件流捕获 + 内存队列 + 磁盘 outbox（两态 + 启动重放）+ 全局配置
> （`name` / `appKey` / `endpoint` / batch / outbox / 功能开关），
> 并额外提供 `token_usage` 工具与 `ctx.tokenReport` 服务。
> 安装与配置见 `packages/dsh-plugin/README.md`。
>
> ★ **0.9.0 起不再注册 `sessionTelemetry` 服务**（改订阅宿主 `session/event`）：
> 那个服务名一个进程只能注册一次，而官方 `dsh-session-telemetry-otel` 永远占着它
> （连它的 `mode: DISABLED` 都照样注册），此前装本插件必须手工停用官方后端，
> 否则 DSH 启动即失败。理由与三条实测证据见 `packages/dsh-plugin/src/capture.ts` 的文件头。
> ⚠️ **改插件后必须跑** `bun run packages/dsh-plugin/verify/verify-cordis-load.ts`：
>    它拿真 cordis 装载打包产物，并且**先让官方后端占住服务名** ——
>    「不抢名字」这件事只有这样才测得出来。
>
> **S9.5 已完成**：浏览器半（`lib/client.js`）把用量画进 DSH 界面 ——
> 输入框上方的用量条（`conversation.input.dock`）与会话标题栏的徽章
> （`conversation.session.header.utilities`），两个挂载点共用一个 store，
> 数据由宿主半的 `GET /api/tokenReport.stats` 提供。
> 该路由挂在 `/api` 前缀下，因此**复用 `dsh-client-connection` 的
> Host/Origin 栅栏与浏览器会话鉴权**（DSH 的 web 服务器本身不做鉴权）。
> 口径不变：载荷里的派生指标由宿主调 `shared/metrics.ts` 算好后透传，
> 浏览器半只做格式化与排版。host→client 的通路、缓存依据与失败模式见
> `packages/dsh-plugin/README.md` §4.3。

> **S1 已完成**：`dsh-token-stats/src/` 全部代码已迁入
> `packages/core`（decode / scanner / aggregate / range / state / format / types）
> 与 `packages/cli`（cli / deliver / report），**逻辑一字未改**，只重写 import 路径。
> 迁移后旧目录已删除，全仓测试全绿，7 个包 typecheck 全过，
> `bun run stats -- --period today` 实测跑通（扫描 185 个文件）。

> **S4 / S5 / S6 已完成**：`bun run web` 一条命令起本地页面（自动开浏览器），
> 页面数据来自 `/api/local/stats/*`，**mock 数据已全部删除**，
> 金额相关字段与组件一并移除（当时的「不展示金额」决策；该决策已于 v7 反转，见 §7 待决项 2）。
>
> **S10 已完成**：数据源从「直扫日志」换成「本地 SQLite 增量库」，
> 详见 §3.1。实测接口从 ~15 秒降到 ~50 ms。
>
> 双轨对照实测（`packages/cli/verify/verify-db-parity.ts`，
> 对真实日志同时跑 SQL 路径与直扫路径，覆盖 5 个时间窗 × 7 个分组维度 × 2 个序列粒度）：
>
> ```
> ✅ 全部通过：200 项断言，两条路径逐位一致
> ```
>
> 两者**逐位相等** —— SQL 只出原始列，派生指标仍走同一套公式，
> 这是铁律 1 的兑现方式。
>
> ⚠️ **历史坑（改动前务必先读，它们的教训仍然成立）**：
>
> 1. `Bun.serve` 的 `idleTimeout` **默认 10 秒**。当年冷扫描要约 10~13 秒，
>    不显式设大请求必被掐断，客户端报 `ECONNRESET` 而服务端毫无日志。
>    虽然现在热态只要 50 ms，但**首次冷建库仍需 ~15 秒**，
>    所以 `server/src/index.ts` 里的 120 秒**依然必须保留**。
> 2. 早期首屏并发 3~4 个请求时，服务端用 in-flight promise 合并成一次扫描，
>    而遍历时若写成 `await this.#inflight` 会在微任务空隙里拿到 `null`，
>    下游访问属性直接抛错、连接被重置。
>    **该机制已随数据源切换整体删除**（每次查询 50 ms 后无需合并），
>    但 `local-api.test.ts` 里保留了并发回归测试，防止有人把共享状态加回来。
> 3. `bun:sqlite` 的 prepared statement **必须 `finalize()`**，
>    否则 `db.close()` 不释放文件句柄，`--reset-db` 会永远报
>    `EBUSY: resource busy or locked`，且错误信息完全不提 prepared statement。

> **S7 / S8 已完成**：`server` 的 `/api/v1/stats/*` 与 `web-portal` 部门看板
> 一并落地 —— 页面由服务端静态托管（`bun run server` 会探测
> `packages/web-portal/dist`），带上身份 token 即可看到人员排行、部门趋势、
> 模型分布、用量明细、单人下钻与采集诊断。
>
> 实现要点与五条易错语义见 §5.3；门禁与两个页面的分工见 §6。
> 三条验证入口：
>
> ```bash
> bun test packages/server/test/stats-api.test.ts   # 接口 + 鉴权 + 口径（26 项）
> bun test packages/core/test/portal.test.ts        # 查询层 + 人员排行（16 项）
> bun run --filter '@ai-token-report/web-portal' verify   # SSR 真执行组件树（25 项）
> ```
>
> 关键取舍：**看板只读上报库、没有降级路径**（上报库没有可重扫的真值）；
> **鉴权失败回 401/503 而不是 200 + ok:false**（响应体里装的是数据）；
> **未归属必须成组出现在人员排行里**（否则覆盖率缺口永远浮不上来）。

> **S11 历史实现记录（Portal v4 已替换身份存储，当前规则见 §4.5）**：角色与人员管理落地 —— 凭证表多一列 `role`（缺省 `member`），
> 看板上多一个**仅管理员可见**的「人员管理」页签，可以在页面上
> 签发 / 重置 / 吊销 token；看板的筛选栏也补齐了**人员多选**与**自定义时间段**。
>
> 三条验证入口：
>
> ```bash
> bun test packages/server/test/member-admin.test.ts   # 权限 / 护栏 / 落盘（34 项）
> bun run packages/server/test/e2e-admin.ts            # 真 HTTP 全链路（53 项）
> bun run --filter '@ai-token-report/web-portal' verify # SSR 真执行组件树（含管理页断言）
> ```
>
> 关键取舍：**`role` 是权限的唯一来源**（不用姓名白名单）；
> **签发即刻生效**（三条路由共享同一个 `CredentialStore` 实例）；
> **凭证文件读不懂时拒绝一切写入**（不拿空表覆盖唯一真值）；
> **最后一个管理员不可删 / 不可降级**（否则没人能再发 token）。

> **两个交付节点**：
> - **S6** → `ai-token --web` 一条命令看到自己的真实统计（本地闭环）
> - **S8** → 部门看板可用（服务端闭环）
> - **S9** → 插件让上报无需人工干预（✅ 已交付，见 `packages/dsh-plugin/README.md`）

---

## 附：关键技术约束速查

- **插件的 `emit()` 在热路径同步执行**，只能入队，任何 `await fetch` 都会拖慢 agent loop
- **同一时刻只能挂载一个 telemetry 后端**（重复加载抛错）→ 插件因此**不注册**它，
  改为订阅宿主 `session/event`，于是与自带 OTel 后端可以共存（0.9.0 起）
- **投递是 best-effort**（游标记「已交出」不是「已送达」）→ 插件必须自建磁盘 outbox
- **只取计费字段**要在折叠时按白名单取值（`foldRecord()`）—— 插件**不碰**
  宿主的 `session-telemetry/record` 瀑布（改它等于修改官方后端收到的内容），
  保证 `includeContent: false`（只采 token 数值与模型名，不采对话内容）
- 日志为 **zstd 分帧追加**，需按 magic `28 B5 2F FD` 逐帧解压
- **Node/Bun 原生支持** `zlib.zstdDecompressSync`（已实测可用）

