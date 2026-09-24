# AI Token Report —— 平台整体梳理

> 本文是**目录与职责的顶层约定**：平台由哪几块组成、各自边界在哪、数据怎么流。
> 口径细节见 `TOKEN-STATS-DESIGN.md`，插件方案见 `PLAN.md`，本文不重复。
>
> **已确认决策**：Bun 作为包管理器与运行时 / `--web` 起服务并自动开浏览器 /
> 本地页与服务端页是**两个独立 web 应用** / **插件与 CLI 互补上报** /
> 本地页**用本地 SQLite 增量库**（由日志派生，库不可用时降级直扫日志）。

---

## 0. 一句话架构

**四种形态，三个数据源，一条主线。**

```
① dsh-token --web        → 本地页面：只看这台机器（本地增量库，零依赖）
② 服务端 portal          → 部门页面：看全部门很多人（读数据库）
③ DSH 插件               → 无人值守实时上报（装在 DSH 内）
④ dsh-token report       → 定时补齐历史 + 离线机器兜底
```

**核心结构决策**：本地与服务端**彻底解耦** —— 本地用自己的库
（`$DSH_HOME/token-report/usage.sqlite`），**只装本机数据、从不出网**。
这让「本地」名副其实：断网也能用，且服务端挂掉不影响任何人看自己的数据。

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
| 服务端 | —— | ⚠️ 骨架已就位，ingest 接口待 S3 |
| DSH 插件 | —— | ✅ 身份解析与上报后端均已落地（S9，见 `packages/dsh-plugin/README.md`） |

### 1.1 三个必须修的裂缝

**裂缝 A：前端是假数据。** ✅ **已修复（S5）**
`frontend/src/mock/usage.ts` 曾硬编码 `¥4.56 / 461 次请求 / 80,642,909 tokens`，
与真实日志无关。UI 再完整，接不上真值就没有意义。
现已删除整个 `mock/` 目录，本地页改为从 `/api/local/stats/*` 取真实数据；
金额相关字段（`cost` / `CNY`）与组件一并移除，符合「不展示金额」决策。

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
├─ PLAN.md / TOKEN-STATS-DESIGN.md    # 历史文档，保留
│
├─ packages/
│  ├─ shared/                  # ★ 契约单一真源（两端 + 插件都 import）
│  │   ├─ src/protocol.ts      #   上报 DTO + 查询响应类型
│  │   ├─ src/metrics.ts       #   口径公式（缓存命中率 / 恒等式校验）
│  │   └─ src/price.ts         #   单价表（可选，见 §7 待决项 2）
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
│  ├─ web-portal/              # ★ ② 部门看板页面（新建）
│  │   ├─ src/api/portal.ts    #   调服务端的 /api/v1/stats/*
│  │   ├─ src/views/
│  │   │   ├─ DeptOverview.vue #     部门总览
│  │   │   ├─ UserRanking.vue  #     ★ 人员排行（核心诉求）
│  │   │   ├─ UserDetail.vue   #     单人下钻
│  │   │   └─ Diagnostics.vue  #     采集覆盖率 / 未归属监控
│  │   └─ vite.config.ts
│  │
│  ├─ server/                  # ★ ② 服务端
│  │   ├─ src/index.ts         #   createServer()（Bun.serve）
│  │   ├─ src/local-api.ts     #   /api/local/*  ← 本地页专用（本地增量库）
│  │   ├─ src/routes/
│  │   │   ├─ ingest.ts        #   POST /api/v1/token-usage  ← 插件 & CLI
│  │   │   └─ stats.ts         #   GET  /api/v1/stats/*      ← 部门页
│  │   └─ src/static.ts        #   托管两个 web 的构建产物
│  │
│  └─ dsh-plugin/              # ★ ③ DSH 插件（PLAN.md §3）
│      ├─ src/index.ts         #   SessionTelemetryBackend 实现
│      ├─ src/queue.ts         #   非阻塞队列（热路径只能入队！）
│      ├─ src/outbox.ts        #   磁盘 outbox（崩溃不丢）
│      └─ src/identity.ts      #   方案 A 三级回退
│
├─ tools/
│  └─ install-task.ps1         # ④ 计划任务注册（每 10 分钟 report）—— 待 S10
```

> `dsh-session-inspector/` 曾是独立 DSH 插件，与本项目无耦合，**现已移除**。
>
> **尚未落地**：`tools/`、`packages/web-portal/src/views/`。
> （`packages/core/src/db/` 已在 S10 落地，见 §3.1。）
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
                    部门看板页面（看全员）
```

| 通路 | 触发 | 数据源 | 覆盖 | 延迟 |
|---|---|---|---|---|
| ① 本地页 | `dsh-token --web` | **本地增量库**（日志派生） | 仅本机 | **~50 ms** |
| ② 插件 | DSH 运行时自动 | 实时事件 | 装了插件的机器 | 实时 |
| ③ 终盘 | `dsh-token` | **本地增量库**（日志派生） | 仅本机 | **~50 ms** |
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
| `cost` | token 数 | **移除金额**：无单价来源（见 §7 待决 2） |
| `requests` | `calls` | 统一命名 |
| `inputTokens` | `inputTokens` | ⚠️ 语义收窄 = **未命中缓存**的输入 |
| `outputTokens` | `outputTokens` | 不变 |
| —— | `cacheReadTokens` | **★ 新增，占用量 94.3%** |
| —— | `cacheWriteTokens` | 新增（该 provider 恒为 0） |
| —— | `cacheHitRate` | **★ 新增，成本优化核心指标** |

### 4.2 三个绝不能搞错的口径

来自 `TOKEN-STATS-DESIGN.md` §2 的实测结论，已固化在 `shared/src/metrics.ts`：

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

- 服务端 `PRIMARY KEY` + `INSERT ... ON CONFLICT DO NOTHING`
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
| 入口 | 配置文件 | **页面引导页** |
| 合规 | 需另行书面告知 | **员工知情且主动**，更干净 |

**填写内容**：`姓名` + `token`（管理员发放）+ `部门`（选填）。

### 4.5.2 关键设计：token 是身份凭证，不是普通鉴权

```
用户填「张三」+ token
        │
        ▼
本地服务 POST /api/v1/identity/verify ──► 部门服务端凭证表
        │                                      │
        │  ◄── { ok, name: "张三", dept } ─────┘
        ▼
以【服务端返回的姓名】落盘 ← ★ 不采信用户输入
```

**为什么必须这样**：如果服务端直接采信客户端声明的姓名，
任何人改一下本地配置就能以他人名义上报，部门看板的数据立刻失去意义。

由此得到的性质：
- 客户端「我填了张三」不算数，**服务端以 token 解析出的身份为准**
- 即使本地身份文件被篡改，**也无法冒用他人身份**上报
- 姓名填错时以服务端为准，不会产生重复人员

> 实证：端到端测试里故意提交「张三三（用户打错）」，落盘结果是「张三」。

### 4.5.3 未署名 = 不采集也不上报

★ **已确认的行为约定**，实现落在三处：

| 位置 | 行为 |
|---|---|
| 本地页面 | 仍可查看本机总量（那是用户自己的数据），但不写归属、不发任何请求 |
| CLI `report` | 无署名时**跳过上报**，不静默记成 `unknown` |
| DSH 插件 | **不注册上报后端**，只提示一次「去哪里填」 |

> 为什么不按 `unknown` 兜底上报？因为那是**未授权的数据采集**。
> 宁可数据缺失（可在看板上看到「有 N 人未署名」），也不要偷偷采集。

### 4.5.4 身份文件

```
$DSH_HOME/token-report/identity.json
```

**本地页与插件共用同一份** —— 员工在哪里填一次就够了。

```json
{ "name": "张三", "token": "...", "dept": "研发一部",
  "createdAt": 1789984019944, "updatedAt": 1789984019944 }
```

实现要点（`packages/core/src/identity-store.ts`）：

| 约束 | 原因 |
|---|---|
| **原子写入**（临时文件 + rename） | 写一半被杀死会留下截断 JSON，用户会看到「我明明填过了」 |
| **权限 0600** | 文件含 token（凭证） |
| **解析失败不抛错**，降级为「未署名」 | 抛错会让页面白屏，而用户此时最需要看到引导页 |

### 4.5.5 管理员准备凭证

服务端启动前放置 `<dshHome>/token-report/credentials.json`：

```jsonc
// 推荐：一 token 一人
[ { "token": "atr-zhangsan-9f3c", "name": "张三", "dept": "研发一部" } ]

// 或简写
{ "张三": "atr-zhangsan-9f3c" }
```

> 凭证文件损坏时服务端**照常启动**（空表 + 告警），
> 不会因为一份文件写错就让已署名的员工全部失效。

### 4.5.6 提示文案的三条原则

未署名时的提示写了什么，直接决定这个功能会不会被接受：

1. **说明去哪里填**，而不是抱怨「你没填」—— 后者让用户卡住
2. **明确承诺不采集** —— 含糊其辞会让人怀疑在偷采，反而更容易被拒绝
3. **区分「token 填错了」与「管理员还没发凭证」** ——
   后者用户做什么都没用，混为一谈会让人反复重试

---

## 5. 接口契约

### 5.1 本地服务（`--web` 起，仅供本地页）

| 接口 | 说明 |
|---|---|
| `GET /api/local/identity` | **署名状态**（★ 响应不含 token） |
| `POST /api/local/identity` | **提交署名**（会向部门服务端校验 token） |
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
→ { "ok": true, "name": "张三", "dept": "研发一部", "registered": true }
```

- 同时接受 header 与 body 里的 token（header 优先），兼容不同 HTTP 客户端
- **纯查询，不写库不落日志** —— 让「验证一下 token」这个无害动作不产生审计噪音
- ★ 返回的 `name` **只可能来自凭证表**，绝不回显客户端提交的内容

> 校验失败返回 **200 + `ok:false`**，而不是 401。
> 用 401 会让前端把「token 填错了」和「网络坏了」混为一谈。

### 5.2 服务端上报（② 插件 & ④ CLI 共用）

```http
POST /api/v1/token-usage
Authorization: Bearer <DSH_REPORT_TOKEN>
Content-Type: application/json

{
  "schemaVersion": 1,
  "client": { "name": "dsh-token-stats", "userId": "zhangsan",
              "userName": "张三", "dept": "研发一部" },
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

### 5.3 服务端查询（部门页用）

| 接口 | 用途 |
|---|---|
| `GET /api/v1/stats/overview?from&to&provider&user` | 部门总览卡片 |
| `GET /api/v1/stats/series?bucket=day\|hour` | 部门趋势 |
| `GET /api/v1/stats/breakdown?by=user\|model\|provider\|cwd` | **★ 人员排行** |
| `GET /api/v1/stats/records?limit&offset` | 明细（分页） |
| `GET /api/v1/stats/diagnostics` | 覆盖率 / 未归属 / 机器在线 |

**响应结构在 `packages/shared/src/protocol.ts` 定义，前后端共用** —— 防漂移的关键。

---

## 6. 页面职责划分（两个独立应用）

| | `web-local` 本地页 | `web-portal` 部门页 |
|---|---|---|
| 使用者 | 我自己 | 管理者 / 全组 |
| 数据范围 | 本机 | 全员 |
| 数据源 | `/api/local/*`（本地增量库） | `/api/v1/stats/*`（读库） |
| 鉴权 | 无（仅 127.0.0.1） | Bearer token |
| 部署 | CLI 内置，随命令启动 | 独立部署 |
| 核心视图 | **首次署名引导** / 我的用量 / 我的项目分布 | **人员排行** / 部门趋势 / 模型分布 / 单人下钻 / 采集诊断 |
| 金额 | ❌ **不展示**（已确认，无单价来源） | ❌ **不展示**（已确认） |
| 特色指标 | 我的缓存命中率、我的项目消耗 | **未署名占比**、**掉了哪些机器** |

两者共享 `shared` 的类型与 `web-local/src/components` 里的 UI 组件（图表卡片等），
但**构建产物、路由、部署方式完全独立**。

---

## 7. 待决项

1. ☐ **`--web` 起服务后端口被占用怎么办？** ✅ 已实现：自动 +1 重试（最多 10 次），
   并在启动信息里明确提示「端口 X 被占用，已改用 Y」。
   配套决策：`--web` **不允许改 host**（恒为 `127.0.0.1`），避免一次参数误用
   就把全员数据暴露在内网。
2. ☐ **部门页要不要金额？** ✅ 已确认：**不要**。只展示 token 数（可审计的真值）。
3. ☐ **身份落地方式？** ✅ 已确认：**用户主动署名 + token 作为身份凭证**（§4.5）。
4. ☐ **「数字集团 token」口径**：只算 `dashscope`，还是员工全部流量？
   （`TOKEN-STATS-DESIGN.md` §4.1，差 2.36 亿 vs 10 亿+）—— **仍需拍板**
5. ☐ **部门页开放范围**：仅 127.0.0.1？还是内网全组可访问（需鉴权）？
6. ☐ **凭证发放方式**：管理员手工编辑 `credentials.json`，还是加一个签发页面/命令？
7. ✅ **迁移期旧目录如何处理？** 已确认并执行：`dsh-token-stats/`、`frontend/`、
   `p0-verify/`、`dsh-session-inspector/` 全部删除；`.bun-cache/`、`node_modules/` 一并清理。
   `dsh-token-stats/` 的代码先迁入 `packages/core` + `packages/cli` 并验证后才删。

---

## 8. 实施顺序

| 阶段 | 内容 | 产出 | 状态 |
|---|---|---|---|
| **S0** | 整体梳理 + 目录骨架 + shared 契约 | 本文 + 骨架 | ✅ 完成 |
| **S0.5** | **身份署名全链路**（契约 / 存储 / 校验 / 引导页 / 插件） | **可署名的本地服务** | ✅ 完成 |
| **S1** | 抽 `core`（迁移 CLI 逻辑，行为不变） | 可复用内核 | ✅ 完成 |
| **S3** | `server`：ingest 接口 + SQLite 幂等落库 | ④ 能打通 | |
| **S4** | `server`：`/api/local/*` 统计直查 | ① 数据就绪 | ✅ 完成 |
| **S5** | `web-local`：删 mock，接本地 API | **本地页面可用** | ✅ 完成 |
| **S6** | `cli --web`：内嵌 server + 开浏览器 | **`dsh-token --web` 兑现** | ✅ 完成 |
| **S7** | `server`：`/api/v1/stats/*` 查询接口 | 部门数据就绪 | |
| **S8** | `web-portal`：部门看板（人员排行等） | **部门页面可用** | |
| **S9** | `dsh-plugin`：backend + 队列 + outbox + 全局配置 + 工具/服务 | **③ 插件上报** | ✅ 完成 |
| **S10** | 计划任务 + 凭证铺开 + 合规确认 | 可运营 | |

> **S0.5 已完成**：署名链路（含真实 HTTP 端到端验证 27 项）已可用。
>
> **S9 已完成**：`dsh-plugin` 的上报后端已落地 ——
> `SessionTelemetryBackend` + 内存队列 + 磁盘 outbox（两态 + 启动重放）+ 全局配置
> （`name` / `appKey` / `endpoint` / batch / outbox / 功能开关），
> 并额外提供 `token_usage` 工具与 `ctx.tokenReport` 服务。
> 安装与配置见 `packages/dsh-plugin/README.md`。
>
> ⚠️ **与官方 `dsh-session-telemetry-otel` 互斥**：同一时刻只能挂一个 telemetry 后端。
> ⚠️ **改插件后必须跑** `bun run packages/dsh-plugin/verify/verify-cordis-load.ts`：
>    cordis 的 `ctx.get()` 返回服务代理，私有字段穿不过 Proxy，
>    单测（拿到真实例）发现不了这类问题。

> **S1 已完成**：`dsh-token-stats/src/` 全部代码已迁入
> `packages/core`（decode / scanner / aggregate / range / state / format / types）
> 与 `packages/cli`（cli / deliver / report），**逻辑一字未改**，只重写 import 路径。
> 迁移后旧目录已删除，全仓测试全绿，7 个包 typecheck 全过，
> `bun run stats -- --period today` 实测跑通（扫描 185 个文件）。

> **S4 / S5 / S6 已完成**：`bun run web` 一条命令起本地页面（自动开浏览器），
> 页面数据来自 `/api/local/stats/*`，**mock 数据已全部删除**，
> 金额相关字段与组件一并移除。
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

> **两个交付节点**：
> - **S6** → `dsh-token --web` 一条命令看到自己的真实统计（本地闭环）
> - **S8** → 部门看板可用（服务端闭环）
> - **S9** → 插件让上报无需人工干预（✅ 已交付，见 `packages/dsh-plugin/README.md`）

---

## 附：关键技术约束速查

- **插件的 `emit()` 在热路径同步执行**，只能入队，任何 `await fetch` 都会拖慢 agent loop
- **同一时刻只能挂载一个 telemetry 后端**（重复加载抛错）→ 与自带 OTel 后端互斥
- **投递是 best-effort**（游标记「已交出」不是「已送达」）→ 插件必须自建磁盘 outbox
- **`sessionTelemetry/record` 瀑布默认不脱敏** → 必须自己挂脱敏规则，
  并保证 `includeContent: false`（只采 token 数值与模型名，不采对话内容）
- 日志为 **zstd 分帧追加**，需按 magic `28 B5 2F FD` 逐帧解压
- **Node/Bun 原生支持** `zlib.zstdDecompressSync`（已实测可用）

