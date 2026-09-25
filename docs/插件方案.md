# DSH Token 上报插件 —— 实现方案

> 目标：统计部门每个人的 token 使用量，通过一个 DSH 插件持续上报到自有后台。
> 本文基于对本机 DSH `0.1.5-rc.1` 实际安装包的源码勘察，不是通用设想。

---

## 1. 先说结论：不要从零造轮子

DSH 已经内置了这条链路的**两个关键环节**，插件要做的是「填充中间一段」，而不是重写全部：

| 环节 | DSH 已有能力 | 我们的插件是否要写 |
|---|---|---|
| token 计量 | `ctx.tokenMeter`（`@deepseek-ai/dsh-token-meter`） | ❌ 复用 |
| 会话事件捕获 | `ctx.sessionTelemetry` + `SessionTelemetryCoordinator` | ❌ 复用 |
| **上报后端（HTTP 到自有平台）** | 只有 OTel 后端，**没有通用 HTTP 后端** | ✅ **这就是插件本体** |
| 人员身份 | **只有匿名安装级 UUID** | ⚠️ 需自行补（见 §5） |

**核心结论**：插件 = **一个 `SessionTelemetryBackend` 实现**。约 200~300 行。

这比「自己监听事件、自己算 token、自己发 HTTP」省掉大量工作量，且天然获得 DSH 官方保证的
「一条会话事件 = 一条上报记录」的完整性与顺序性。

---

## 2. 数据从哪来：已实证的字段

我解码了本工作区真实会话日志
`~/.dsh/sessions/--D-Coding-ai-token-report--/session-044004d8.../session.v3.jsonl.zstd`
（zstd 分帧追加，74 帧 / 138 事件），确认了上报所需的全部数值字段。

### 2.1 `assistant/message` —— 计费级 usage（真实样本）

```json
{
  "type": "assistant/message",
  "seq": 16,
  "time": 1789984019944,
  "data": {
    "turn": 1, "step": 1,
    "message": { "source": { "kind": "model",
                             "provider": "dashscope",
                             "model": "deepseek-v4.1-flash" } },
    "usage": { "inputTokens": 7772, "outputTokens": 186,
               "totalTokens": 8982, "cacheReadTokens": 1024 }
  }
}
```

- `data.usage` 是 **provider 真实上报值**，不是估算 → 可直接作为计费依据。
- `data.message.source` 给出 `provider` / `model` → 路由归属，用于分模型计价。
- 该会话实测累计：input 57,685 / output 5,366 / cacheRead 708,864。
  注意 **cacheRead 远大于 input**，缓存命中率是必须单独上报的指标。

### 2.2 其他有用事件

| 事件 | 用途 |
|---|---|
| `request/context` | `{provider, model, contextWindow}` → 上下文占用率分母 |
| `turn/start` / `turn/end` | 划分「一轮对话」的统计窗口 |
| `assistant/attempt` | 含**失败/重试**的 attempt，用于统计重试浪费（实测样本中有 `429 RATE_LIMIT`） |
| `session` (首行) | `id` / `cwd` / `createdAt`，用于归因到项目 |
| `step/start` / `step/end` | 步数统计 |

### 2.3 投影（projection）备选

`dsh-token-meter` 已注册三个投影单元，若走「读取最终值」路线可直接用：

- `tokenUsage` → `{uncachedInputTokens, outputTokens, cacheReadTokens, cacheWriteTokens}`
- `contextPressure` → `{pressureTokens, projectedTokens, contextWindow}`
- `contextBreakdown` → `{systemTokens, toolsTokens, messageTokens}`

**建议**：以 `assistant/message.data.usage` 为**准**（计费级、逐次），
投影作为对账校验（同一 turn 内两者应一致）。

---

## 3. 插件架构

### 3.1 挂载点：实现 `SessionTelemetryBackend`

参照官方 `dsh-session-telemetry-otel` 的写法（`lib/index.js:105`）：

```ts
import { SessionTelemetryBackend, SessionTelemetryCoordinator }
  from '@deepseek-ai/dsh-session-telemetry'
import z from '@deepseek-ai/schemastery'

export const name = 'token-report'

export class TokenReportBackend extends SessionTelemetryBackend {
  static inject = ['sessions']
  static Config = Config

  sharing = 'full' as const          // 必须声明，见 §4.3

  constructor(ctx, config) {
    super(ctx)
    // emit 必须是「非阻塞入队」：它在 session/event 热路径上被同步调用
    const coordinator = new SessionTelemetryCoordinator(ctx, {
      emit: (record) => this.#enqueue(record),
      flush: () => this.#flushHint(),
      shutdown: () => this.#drain(),
    }, { capture: 'live', includeHistory: true })
  }

  emit(record) { /* 非阻塞入队 */ }
  async shutdown() { /* 排空队列后 resolve */ }
}

export const Config = z.object({ /* 见 §4.1 */ })
export default TokenReportBackend
```

🚨 **硬约束**：`emit()` 在会话事件热路径上**同步**调用，只能做「入队」。
任何 `await fetch(...)` 都会拖慢 agent loop。必须「内存队列 + 独立定时批量发送」。

### 3.2 数据流

```
session/event (热路径, 同步)
      │
      ▼
Coordinator 过滤/深拷贝 → session-telemetry/record 瀑布(脱敏)
      │
      ▼
emit(record) ──► 内存队列 (只做 push, O(1))
                      │
                      │  ← 聚合器：把同一 session 的 usage 累加成「增量快照」
                      ▼
                 批量发送器 (定时 / 满 N 条 / turn 结束触发)
                      │  HTTP POST + 重试 + 本地磁盘 outbox
                      ▼
                 部门后台 (DeepSeek Token 看板)
```

### 3.3 关键设计点：发「增量」而不是「全量」

`tokenUsage` 是**整个会话日志的累计值**。如果每次事件都发全量，后台需要做
last-write-wins 去重，且并发会话会互相覆盖。

**推荐**：以 `(sessionId, turn, step)` 为幂等键，只上报**本次新增**的 usage 增量：

```json
{
  "event_id": "ses_044004d8:16",     // sessionId:seq —— 后台按此去重
  "session_id": "session-044004d8-...",
  "seq": 16,
  "ts": 1789984019944,
  "turn": 1, "step": 1,
  "provider": "dashscope",
  "model": "deepseek-v4.1-flash",
  "usage": { "input": 7772, "output": 186,
             "cache_read": 1024, "cache_write": 0, "total": 8982 },
  "cwd": "D:\\Coding\\ai-token-report",
  "user": { "dsh_user_id": "...", "display_name": "..." }
}
```

这样后台天然幂等、可重放、可审计，不用猜「这次比上次多了多少」。

---

## 4. 配置与部署

### 4.1 插件配置（`Config` schema）

```yaml
- id: token-report
  name: 'dsh-token-report'
  config:
    endpoint: https://your-portal.example.com/api/v1/token-usage
    token: !!js `Bearer ${process.env.DSH_REPORT_TOKEN}`
    batch:
      maxRecords: 50
      flushIntervalMillis: 10000
    outbox:
      dir: ~/.dsh/token-report-outbox   # 崩溃后不丢数据
      maxBytes: 33554432
    includeContent: false               # 只发数值，不发对话内容
    user:
      id: zhangsan
      name: 张三
```

### 4.2 挂载位置

本机 profile 结构（已勘察）：

- `~/.dsh/profiles/web/package.json` → `dsh.profile.bundles: [dsh-base, dsh-web-app]`
- `~/.dsh/profiles/web/cordis.patch.yml` → **当前是 `[]`**，这就是我们要写的地方
- `~/.dsh/profiles/web/pnpm-workspace.yaml` → `nodeLinker: hoisted`

**部署步骤**：
1. 把插件放进 `~/.dsh/profiles/web/`（本地包用 `file:` 依赖，如现有 `dsh-git-rollback` 的写法）
2. 写 `cordis.patch.yml`，插入插件条目
3. 重启 DSH web（`patchReload: live` 对 patch 生效，但新增依赖包需重启）

⚠️ 官方明示限制：**同进程内替换已挂载包的 manifest 不受支持**，升级插件版本要重启。

### 4.3 `sharing` 字段的语义陷阱

`sharing: 'full' | 'feedback-only' | 'disabled'` 是**部署策略声明**，
不是投递回执。写 `'full'` 表示「本部署全量共享」。这一点在合规评审时会被问到，
建议在内部文档里明确：部门设备统一安装，员工已知情。

---

## 5. ⚠️ 最大风险：身份归属（必须先决策）

这是整个方案**唯一无法靠技术绕过**的问题。

DSH 的身份体系**故意是匿名的**：
- `~/.dsh/.anonymous-user-id` 是 `crypto.randomUUID()`，
- 官方 README 明确写道：**"never derived from the hostname, network address, git remote"**，
- 并且 **"Do not use it to identify a user"**。

也就是说：**DSH 原生不提供「这是谁」的信息。**

### 三个可选方案

| 方案 | 做法 | 优点 | 缺点 |
|---|---|---|---|
| **A. 配置文件署名**（推荐起步） | 安装时在插件 config / 环境变量写入 `user.id` | 简单、可控、可审计 | 需人工配置；可被篡改 |
| **B. 团队网关反查** | 上报带 `anonymous_user_id` + 主机名/登录名，后台映射表落库 | 客户端零配置 | 需要 IT 侧维护映射；涉及终端标识信息 |
| **C. 统一网关集中计量** | 全员走同一个 LLM 网关，网关侧按 key 计量 | 数据最准、无法绕过 | 前提是所有流量都走网关；你已在用 `dashscope` 网关，值得评估 |

**建议**：先做 A 打通链路，同时评估 C（你们已配置了阿里云 `token-plan` 网关，
`settings.yaml` 里可见 `baseURL: https://token-plan.cn-beijing.maas.aliyuncs.com/...`），
C 能拿到网关侧真值，可与插件上报做**双向对账**。

> 无论哪种方案，都属于**员工行为数据采集**，上线前需走内部合规确认。

---

## 6. 后台侧（对账与存储）

### 6.1 接口

```
POST /api/v1/token-usage
Authorization: Bearer <token>
Content-Type: application/json

{ "records": [ {record}, ... ] }     // 支持批量
→ 200 { "accepted": 50, "duplicates": 0 }
```

幂等键：`event_id = sessionId:seq`（后台唯一索引）。重复投递返回 `duplicates` 计数。

### 6.2 建议表结构

| 表 | 关键字段 |
|---|---|
| `token_event` | `event_id`(UK), `session_id`, `seq`, `ts`, `user_id`, `provider`, `model`, `input`, `output`, `cache_read`, `cache_write`, `cwd` |
| `user_dim` | `user_id`, `display_name`, `dept` |
| `daily_rollup` | `date`, `user_id`, `model`, `sum(input/output/cache_read)`, `turn_count` |

用 `daily_rollup` 做看板聚合，避免每次扫全表。

### 6.3 看板要展示

- 人均 token（按 input / output / cache_read 拆分）
- 部门总量与趋势
- **缓存命中率** `cache_read / (cache_read + input)` —— 实测 708,864 vs 57,685，
  这个指标比总量更能反映成本优化空间
- 按模型 / 按项目（`cwd`）分布
- **重试浪费**（`assistant/attempt` 中的失败次数）—— 实测存在 `429`

---

## 7. 可靠性设计

| 要求 | 做法 |
|---|---|
| 不拖慢主循环 | `emit()` 只入队；发送全在后台异步 |
| 崩溃不丢数据 | 本地磁盘 outbox（append-only JSONL），进程启动时重放 |
| 网络抖动 | 指数退避重试 + 上限；超过则留在 outbox |
| 停机排空 | `shutdown()` 排空队列；官方建议给外层超时（OTel 后端用 3000ms） |
| 重复投递 | 后台按 `event_id` 幂等；客户端 at-least-once |
| 主动降级 | 后台不可达时**只记本地**，绝不阻塞或抛错影响 agent（Coordinator 会兜住异常） |

> 官方明示：seam 的投递是 **best-effort**，cursor 记录的是「已交出」不是「已送达」。
> 所以 outbox 是我们**必须自己补**的一环。

---

## 8. 建议的实施阶段

| 阶段 | 内容 | 产出 |
|---|---|---|
| **P0** | 只读验证：写脚本解析本机会话日志，输出每日汇总 | 验证字段口径，无需插件 |
| **P1** | 插件骨架 + 本地 outbox + `console` 后端 | 端到端跑通，不上网 |
| **P2** | HTTP 上报 + 后台接收接口 + 幂等去重 | 链路打通 |
| **P3** | 看板（人均 / 模型 / 缓存命中 / 重试） | 可见性 |
| **P4** | 身份方案落地（A→C 演进）+ 合规确认 | 可运营 |

**P0 现在就能做**，且能立刻验证「上什么数」，风险最低。

---

## 9. 已确认决策

> 以下为 2026-09 与需求方确认的结论，后续设计以此为准。

| # | 决策项 | 结论 |
|---|---|---|
| 1 | **身份归属** | ✅ **方案 A**：配置文件 / 环境变量署名（`user.id`） |
| 2 | **后台现状** | ✅ **尚无**，需一并设计并实现接收端 |
| 3 | **覆盖范围** | ✅ **先只做 DSH** |

由此确定的范围：本仓库 = **插件（DSH 端） + 后台（接收/存储/看板）** 两部分。

### 方案 A 的具体落地（身份）

签名信息不进插件代码，改为三级回退，优先级从高到低：

```yaml
- id: token-report
  name: 'dsh-token-report'
  config:
    endpoint: https://your-portal.example.com/api/v1/token-usage
    token: !!js `Bearer ${process.env.DSH_REPORT_TOKEN}`
    user:
      id: zhangsan          # 1. 显式配置（最高优先级）
      name: 张三
      dept: 研发一部
```

1. **插件 config**（如上）
2. **环境变量** `DSH_REPORT_USER_ID` / `DSH_REPORT_USER_NAME`
3. **兜底**：`~/.dsh/token-report-user.json` 由安装脚本写入

若三级都缺失 → **不静默丢弃**，而是以 `user_id = "unknown"` 上报并打 warning，
同时在后台看板里单独列出，避免「数据悄悄少了」这种最难排查的故障。

> ⚠️ 仍需合规确认：这是员工行为数据采集。建议上线前书面告知，
> 并在文档中明确「只采集 token 数值与模型名，不采集对话内容」——由 §4.1 的
> `includeContent: false` 在代码层面保证。

---

## 附：关键技术约束速查

- `emit()` **同步热路径**，必须非阻塞入队
- 日志为 **zstd 分帧追加**（`session.v3.jsonl.zstd`），需按 magic `28 B5 2F FD` 逐帧解压
- Node 原生支持：`zlib.zstdDecompressSync`（已验证可用）
- `session-telemetry/record` 瀑布可挂脱敏规则；**默认不脱敏**，改装前必须自己加
- 同一时刻只能挂载**一个** telemetry 后端（重复加载抛错）→ 与 OTel 后端**互斥**
- Provider 凭据不会出现在日志中（是构造参数），结构上安全

---

## 10. 后台设计（本仓库第二部分）

### 10.1 技术选型建议

**建议直接用 Node/TypeScript 单体**，理由是：

- 插件端已是 TS，**上报 DTO 的 schema 可以两端共享**（一个 `packages/shared` 定义 zod schema，
  插件和后台各自 import），这是最实际的收益——字段口径不会漂移。
- 单体部署简单，部门内部看板量级（几十人 × 每天几千条事件）**不需要分布式**。
- 存储建议 **SQLite → PostgreSQL**：SQLite 起步零运维，量大了平滑迁移。
  唯一索引做幂等，聚合用 SQL 就够。

不建议上消息队列 / 时序库，过度设计。

### 10.2 目录结构

```
ai-token-report/
├─ packages/
│  ├─ shared/              # ★ 两端共享：上报 DTO 的 zod schema + 类型
│  │   └─ src/schema.ts
│  ├─ dsh-plugin/          # DSH 插件（§3）
│  │   ├─ src/index.ts       # TokenReportBackend
│  │   ├─ src/queue.ts       # 非阻塞队列 + 批量器
│  │   ├─ src/outbox.ts      # 磁盘 outbox（崩溃不丢）
│  │   └─ src/identity.ts    # 方案 A 三级回退
│  └─ server/              # 后台
│      ├─ src/api/ingest.ts   # POST /api/v1/token-usage
│      ├─ src/db/schema.sql
│      └─ src/rollup.ts       # 每日聚合任务
└─ web/                    # 看板前端（可用任意栈）
```

### 10.3 接收接口契约

```http
POST /api/v1/token-usage
Authorization: Bearer <DSH_REPORT_TOKEN>
Content-Type: application/json

{ "records": [ /* TokenUsageRecord[] */ ] }
```

响应：

```json
{ "accepted": 48, "duplicates": 2, "rejected": 0,
  "rejectedReasons": [] }
```

**幂等策略**：`token_event.event_id` 加 **UNIQUE 索引**，
插入用 `INSERT ... ON CONFLICT (event_id) DO NOTHING`，
`accepted` / `duplicates` 由影响行数统计。
这样客户端重试、outbox 重放都不会污染数据——**客户端只需保证 at-least-once**。

**鉴权建议**：单一 `DSH_REPORT_TOKEN` 起步即可（内网 + HTTPS）。
若要区分机器，可演进为每台一个 token 并在服务端绑定 `user_id`，
这样**即使客户端 config 被篡改，也无法冒用他人身份**——是方案 A 的加固路径。

### 10.4 表结构（SQLite 版）

```sql
CREATE TABLE token_event (
  event_id     TEXT PRIMARY KEY,      -- sessionId:seq，幂等键
  session_id   TEXT NOT NULL,
  seq          INTEGER NOT NULL,
  ts           INTEGER NOT NULL,      -- epoch ms
  user_id      TEXT NOT NULL,
  user_name    TEXT,
  dept         TEXT,
  provider     TEXT,
  model        TEXT,
  input_tokens       INTEGER NOT NULL DEFAULT 0,
  output_tokens      INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens       INTEGER NOT NULL DEFAULT 0,
  cwd          TEXT,
  turn         INTEGER,
  step         INTEGER,
  created_at   INTEGER NOT NULL
);
CREATE INDEX idx_event_ts   ON token_event(ts);
CREATE INDEX idx_event_user ON token_event(user_id, ts);

-- 每日聚合（看板只查这张表）
CREATE TABLE daily_rollup (
  date TEXT NOT NULL, user_id TEXT NOT NULL, model TEXT NOT NULL,
  input_tokens INTEGER, output_tokens INTEGER,
  cache_read_tokens INTEGER, cache_write_tokens INTEGER,
  turn_count INTEGER, attempt_count INTEGER, retry_count INTEGER,
  PRIMARY KEY (date, user_id, model)
);
```

`daily_rollup` 由定时任务（或写入后触发）增量刷新，看板查询不走明细表。

### 10.5 看板指标（对应 §6.3）

| 指标 | 计算 | 为什么重要 |
|---|---|---|
| 人均 token | `sum(input+output)` by user | 核心诉求 |
| **缓存命中率** | `cache_read / (cache_read + input)` | 实测 708,864 : 57,685，**成本优化的最大杠杆** |
| 模型分布 | `group by model` | 发现高价模型滥用 |
| 项目分布 | `group by cwd` | 定位消耗大户 |
| **重试浪费** | `retry_count / attempt_count` | 实测存在 `429`，重试是纯浪费 |
| 未归属占比 | `user_id = 'unknown'` 比例 | 监控采集覆盖率，防「数据悄悄少了」 |

---

## 11. 下一步

已确认范围后，建议按此顺序推进（P0 可立即开始，零风险）：

1. **P0 · 验证口径**（半天）
   写一个只读脚本解析 `~/.dsh/sessions/**/session.v3.jsonl.zstd`，
   按人（先用 `cwd` 代替）输出每日汇总。验证「上什么数」是否正确，不碰插件。
2. **P1 · 插件骨架**（1 天）
   `packages/shared` 定义 schema；插件实现 backend + 内存队列 + outbox，
   后端先用 `console.log` 打出来，端到端跑通但不上网。
3. **P2 · 打通链路**（1 天）
   实现 `packages/server` 接收接口 + SQLite 幂等落库；插件接 HTTP + 重试。
4. **P3 · 看板**（1~2 天）
   §10.5 的六个指标。
5. **P4 · 铺开与合规**
   安装脚本写身份配置（方案 A）；书面告知；评估网关侧对账（方案 C 作为长期加固）。

> 建议先确认 **P0 是否现在就开始**——它能用最小成本验证整条链路的数据口径，
> 且完全不接触插件与网络，是风险最低的起点。