# Codex 会话采集方案（DSH 之外的第二个来源）

> 状态：**方案待评审**（本文只描述设计与实施路径，尚未落地任何代码）
> 结论一句话：把「**来源（source）**」提升为一等维度，用一个**来源适配层**把 Codex 的
> rollout JSONL 折叠成与 DSH **同构**的 `UsageRecord`，复用既有的聚合 / 本地库 / 上报 / 看板链路。

---

## 0. 为什么值得做（本机实测规模）

本机 `~/.codex`（Codex CLI + Codex Desktop + VSCode 扩展共用）：

| 项 | 实测值 |
|---|---|
| rollout 文件 | **1,495 个有效**（另有 1 个 0 字节）+ `archived_sessions/` 17 个 |
| 体积 | **2,802 MB**（纯文本 JSONL） |
| 含用量的会话 | 1,462 |
| 计费调用（calls） | 58,036 |
| 时间跨度 | 2026-04-15 ~ 2026-09-27 |
| 总量 | **54.87 亿 token**（input 未命中 3.23 亿 + cacheRead 51.36 亿 + cacheWrite 136 万 + output 0.26 亿） |
| cacheRead 占比 | **93.6%** |

对照 DSH 侧实测的 94.3%：**「cacheRead 不是 input 的一部分」这条铁律在 Codex 上同样成立**，
而 Codex 甚至更极端（它的 `input_tokens` 把缓存读**包含在内**，见 §2.3）。

所以这不是「顺手多支持一个小来源」，而是**又一个与 DSH 同量级的数据入口**：
不接，任何一个人机器上的 Codex 用量在这套平台里都**等于不存在** ——
而「不存在」和「没有用」在页面上的表现完全一样（都是没有那一行），不会报错。

---

## 1. 目标与不做什么

> ## ⚙️ 进度（2026-10-03 收尾）
>
> | 阶段 | 状态 | 证据 |
> |---|---|---|
> | §2 格式实测（本机 1,512 文件 / 2.8 GB） | ✅ | 两次复测逐位一致 |
> | 内核：适配器层 + Codex 折叠与四列映射 | ✅ | 独立 golden 逐文件相等；全量 58,297 calls / 5,510,756,840 |
> | **P0 哨兵** `verify:codex-format` | ✅ | 合成 **28/28** + `--real` **32/32**（真实数字与 §2.8 逐位一致） |
> | **P1** scanner 按来源列举/解码 + CLI `--source` / `--discover` | ✅ | `--source codex` 58,297 / 5,510,756,840（与直扫一致）；`--source all` 68,072 / 7,317,100,979 |
> | **P2** 本地库 `source` 列 + 本地页两个来源 | ✅ | `usage_event.source` + `DB_SCHEMA_VERSION` 4；`ingest-plain.ts`（文件级 L1 + `event_id` 幂等）；本地页渲染成「数据来源：Codex + DSH，共 3 个会话日志根，按并集统计」 |
> | **P3 上报链路带上来源**（D8） | ✅ | 上报库 **v9**（`usage_event.source`，SQLite `TEXT` / MySQL `VARCHAR(32)`，默认 `'dsh'`）+ `WireTokenRecord.source?` + zod 形状校验 + `ATTRIBUTED_COLUMNS` 落库；`report` 的 `plainRoots` 走 `scanner.ts` 的 `scanPlainSources()`（与本地库同一份 L1）—— 实测 `report --dry-run` 采到 **69,027 条 / 12.4s**（DSH 118 个文件 + 五个非 DSH 根 1,528 个文件） |
> | **P4 看板按来源筛 / 分组**（D9） | ✅ | `by=source` + `?source=`（**精确匹配**，与 provider 的子串语义刻意相反）+ `GET /api/v1/stats/sources`（注册表 ∪ 库里出现过的值）+ 明细行带来源；web-portal 来源多选（不可新建）、「来源」分布页签、明细「来源」列 |
> | 测试隔离 | ✅ | preload 钉住 `DISCOVER=0` / `CODEX=0` / `CLAUDE=0` / `TRAE=0` / `TRAE_CN=0` / `WORKBUDDY=0`；哨兵自己也显式限定来源；spawn 出的 CLI 由 `packages/cli/test/child-env.ts` 的 `pinnedChildEnv()` 钉住 |
> | 回归 | ✅ | `typecheck` 7/7 exit 0；`bun test` **不带 MySQL：1610 pass / 13 skip / 0 fail**、**带 `ATR_V4_TEST_MYSQL_URL`：1626 pass / 0 skip / 0 fail**；`http-contract` 100/100；`e2e-ingest` 37/37；`e2e-admin` 185/185；**`verify-report-ingest` 37/37**（含★**非 DSH 来源端到端**：Codex 纯文本日志 → CLI report → 真 HTTP → `usage_event.source='codex'`，与 DSH 的 4 条分成两组、四列数值逐项核对）；`web-portal verify` 通过；插件四层验证通过；`verify:bundles` 4/4；`verify-db-parity` 160/160（隔离库） |
>
> ✅ **P3 的 MySQL 侧已在活体库上实跑**（2026-10-03，本机开发 Docker `local-database-review-mysql`，
>   MySQL 8.4 @3335）。这一轮**抓出两个只有活体 MySQL 才会暴露的真实缺陷**（都已修）：
>
> | 缺陷 | 症状 | 修法 |
> |---|---|---|
> | `portal-v9.test.ts` 的 MySQL 夹具把**管理连接**（指向 `information_schema`）当成上报库目标 | `上报库状态 unsupported，版本 0`（3 条用例失败）—— 差一点就往一个共用 schema 里建 portal 表 | 按 `portal-v5.test.ts` 的同一套夹具重写：**每个用例自己的随机隔离 schema**，用完 `DROP`（`isolatedMysql()`）；并给 `information_schema` 那条查询补 `ORDER BY ordinal_position`（列序断言不能依赖 MySQL 的返回顺序） |
> | `verify-v8-migration.ts` 写死 `version === 8`，且回滚只删 v8 那一行账本 | ① 迁移成功（版本已 9）却判失败；② 降级后 `{"status":"unsupported","version":7}` —— 整条回滚路径失效 | 断言一律对着 `PORTAL_SCHEMA_VERSION`；降级改为 `DELETE FROM portal_schema_migrations WHERE version > 7`（留着 v9 账本行会让 `current` 仍为真 ⇒ 判成 `unsupported` 而不是 `legacy`） |
> | `portal-v5.test.ts` 的 **MySQL 分支**仍断言 `usage_event` **20 列** | 真实 MySQL 上 `Expected length: 20 / Received length: 21`（v9 的 `source`）。SQLite 分支那条早就改成 21 列了，**只改一处** | 同步为 21 列并显式断言含 `PORTAL_SOURCE_COLUMN`。同一件事在**两个方言各有一份**断言，改 schema 时两处都要动 —— 又一次「SQLite 上测过了不构成证据」 |
>
> 实跑结果（2026-10-03，`ATR_V4_TEST_MYSQL_URL` 指向本机开发容器）：
> `portal-v9.test.ts` **9/9**（含 `[mysql]` 全新库列序 / v8→v9 补列 / 加列幂等）；
> `portal-v5.test.ts` **26/26**（含 `[mysql]` v4→v5 真实迁移）；
> `verify-v8-migration.ts` **18/18**（SQLite + MySQL 各一轮，含 `v7→v8→当前版本` 连续升级与两轮回滚-再迁移）；
> `core verify:mysql` **17/17**、`verify:mysql:bun-auth` **12/12**、`verify:mysql:node` **49+6**、
> 双后端逐位对账 `verify-mysql-portal.ts` **62/62**；
> **全仓 `bun test` = 1626 pass / 0 skip / 0 fail**（那 13 条 MySQL 用例这次实跑，
> 不带连接时是 1610 pass / 13 skip）。
> ⚠️ `ATR_V4_TEST_MYSQL_URL` 是**管理连接**（所以本机指向 `information_schema`），
> **不是目标库** —— 任何 MySQL 用例都必须自己建随机隔离 schema。
>
> ### 两条必须记住的运维/验证事实
>
> 1. **`verify-db-parity` 默认改用「冻结窗口」（右端在昨天 24:00）**。
>    原先按 `today / last7d` 对照，而这条脚本要**取数两次**（库一次、直扫一次）——
>    机器上正在进行的工作本身就在写日志，两次之间落进来的新事件足以让断言失败。
>    实测症状是**失败项在两次运行之间来回变**（先 `today`、后 `(全部)`），与口径无关；
>    改冻结窗口后 160 项断言逐位通过。要看实时窗口加 `--live`（信息性）。
> 2. 🚨 **本地 `usage.sqlite` 会被「还在跑的旧版客户端」反复重建回旧版本**。
>    实测：本机有一个 DSH 会话里加载着**改动之前**的插件，它的
>    `DB_SCHEMA_VERSION` 还是旧的 ⇒ 它每次取数都会把库 `rebuildSchema` 回去，
>    而新代码下一次运行又建回 v4。库是日志派生物、不丢数据，但表现是
>    「偶尔 `no such column: source` / 偶尔走直扫」。
>    **升级后需要重启 DSH**（或至少重启那个客户端的进程）才能消除这个churn。

>
> **架构已按「多客户端」调整**（见 §1.1）：不是给 Codex 加一个分支，而是
> **来源适配器 + 一条统一上报链路**，`dsh / codex / claude-code / workbuddy`
> 走同一机制 —— 新增一个客户端只需要加一个适配器文件、一个 id、注册一行。

**做**：

1. CLI / 本地页面能统计 Codex 用量，并与 DSH 用量**分开**呈现；
2. 本地增量库、上报链路、部门看板把 `source` 作为可筛选 / 可分组的维度；
3. 口径与 DSH 完全同源（同一套 `shared/metrics.ts`、同一张单价表、同一套幂等键语义）。

**不做**（明确划出去，避免方案膨胀）：

- ❌ 采集**对话内容**（prompt / 回答 / 工具输出）。本仓 `includeContent` 恒为 `false`
  （只采 token 数值与模型名）。Codex 的 rollout 里有完整对话，但**不读、不存、不上报**。
- ❌ 复用 DSH 插件。Codex 没有 cordis 宿主，插件的宿主半 / 浏览器半都无法装载。
- ❌ 用 `provider` 名字冒充来源（例如 `codex:openai`）—— 见 §3 D1 的理由。
- ❌ 读 `~/.codex/state_5.sqlite` / `thread_history_1.sqlite` 当计费源：
  实测它们只有 `threads.tokens_used`（整会话一个数，无模型/无时间/无四类拆分），
  连「四列必须分开存」都满足不了。**rollout JSONL 是唯一计费真源。**

---

## 1.1 架构：来源适配器 + 一条统一上报链路

要采集的不只是 Codex（还有 Claude Code、WorkBuddy ……），而它们之间**只有
「日志长什么样、怎么折叠成计费记录」不同**。所以扩展点只开一个，画得很窄：

```ts
// packages/core/src/sources/types.ts
interface SessionSourceAdapter {
  readonly id: SessionSource                 // 'dsh' | 'codex' | 'claude-code' | 'workbuddy'
  roots(homes: readonly string[]): SourceRoot[]            // 本机有哪些日志根（含次要副本）
  list(root, opts?): Promise<SessionMeta[]>                // 根下有哪些会话文件
  readonly encoding: 'zstd-frames' | 'plain-jsonl'         // 怎么解码
  createFolder(meta, diagnostics, records): SourceFolder   // 怎么折叠成 UsageRecord
}
```

| 层 | 是否区分来源 |
|---|---|
| 列举 / 解码 / 折叠（**每个来源各一份**） | ✅ 只有这里 |
| 幂等键构造（除来源前缀）、去重、筛选、水位线、入库、聚合、分桶、上报、计价 | ❌ **全部共用一份** |

- 注册表 `sources/registry.ts` 是「本机支持哪些来源」的**唯一真源**；
  查不到适配器时**必须报错**，绝不静默返回 0 条 ——
  「这个来源还没实现」与「这个来源没有用量」在输出上完全一样，是这类系统里最会骗人的失败。
- `SessionSource` 是**受控枚举**（不是 `string`）：来源名写错要在编译期就暴露，
  而不是在库里悄悄多出一个谁也叫不出名字的来源。
- **新增一个客户端 = 3 步**：加 `sources/<id>.ts` → 在 `SessionSource` 加 id → 注册一行。
  不改 schema、不改协议、不改任何路由（除非该来源带来新的**计费字段语义**，
  那也只出现在它自己的字段映射函数里，例如 Codex 的「cached 含在 input 内」）。

**统一上报**：`UsageRecord` 带 `source` 字段，CLI 与插件共用同一条 deliver；
线上契约只加一个可选 `source` 字段（缺省 `dsh`，老客户端零改动，见 D8）。
**插件的角色**：实时 `emit()` 那条路只有 DSH 有（harness 事件流），
但**只要填了上报，插件的补报线程应当把本机所有已启用来源一起上报** ——
这正是「采集方只是一个字段、上报只有一条链路」的落点。

---

## 2. Codex 落盘事实（本机只读实测）

> 全部结论来自本机 1,495 个真实文件的一次性只读探查（脚本见附录 B），
> 不是抄文档。外部格式说明只用作交叉对照（[skiplevel schema notes](https://raw.githubusercontent.com/repowise-dev/skiplevel/main/docs/schema-notes-codex.md)）。

### 2.1 目录结构：**与 DSH 不同形**，不能靠通配猜

```
$CODEX_HOME（缺省 ~/.codex）/
├── sessions/YYYY/MM/DD/rollout-<ISO8601>-<uuid>.jsonl   ← 一个会话一个文件
└── archived_sessions/YYYY/MM/DD/rollout-*.jsonl         ← 归档副本
```

| | DSH | Codex |
|---|---|---|
| 日志根 | `<home>/sessions` | `<home>/sessions` **和** `<home>/archived_sessions` |
| 结构 | `<project>/<sessionId>/<file>` | `<YYYY>/<MM>/<DD>/<file>` |
| 压缩 | zstd **分帧**追加 | **无压缩**纯 JSONL 追加 |
| 一个会话 | 可能多个 `session*.jsonl.zstd`（格式分段） | 通常一个文件 |
| 判据 | 文件名 `session[.vN].jsonl.zstd` | 文件名 `rollout-*.jsonl` |

实测归档与活动目录**无同名文件**（17/17 不重叠），但仍按「相对路径去重、活动副本优先」处理 ——
归档会在用户清理时被搬走，两边都扫必然出现同一会话两份。

### 2.2 行信封与事件

每行：`{"timestamp": ISO8601, "ordinal": <文件内单调整数>, "type": T, "payload": {...}}`

实测类型分布（抽样 36 个文件）与用途：

| type | 用途 | 计费 |
|---|---|---|
| `session_meta` | 首行：`session_id` / `id` / `cwd` / `originator` / `cli_version` / `source` / `model_provider` / `git` / `forked_from_id` | — |
| `turn_context` | 每轮一次：**`model`** / `cwd` / `workspace_roots` / `effort` | — |
| `event_msg` → `token_count` | **计费真源 A**（老代际） | ✅ |
| `token_usage_record` | **计费真源 B**（新代际，实测 84 个文件有；带 `response_id`） | ✅ |
| `response_item` | 消息 / 工具调用 / 推理（占绝大多数行） | ❌ |
| `world_state` / `compacted` | 界面状态 / 上下文压缩 | ❌ |

- **`ordinal` 实测：15,581 个事件全部单调、无重复、无缺失**（= 完美的文件内幂等序号）。
- `timestamp` 是 ISO8601（UTC），带毫秒，可直接 `Date.parse` → epoch ms。
- 旧格式（2025-09 之前无 `token_count`；更早是裸行无信封）**分类跳过并计入诊断**，不猜字段。

### 2.3 ★ 计费字段语义（最容易做错、错了不报错的一处）

`token_count` / `token_usage_record` 里的用量对象：

```json
{"input_tokens":40525,"cached_input_tokens":39424,"cache_write_input_tokens":0,
 "output_tokens":94,"reasoning_output_tokens":0,"total_tokens":40619}
```

实测得到的三条硬事实：

| # | 事实 | 证据与强度 |
|---|---|---|
| 1 | `total_tokens == input_tokens + output_tokens` **恒成立** | 逐条成立，含 `cache_write>0` 的样本（`34070 + 341 = 34411`）。**强** |
| 2 | `cached_input_tokens` **是** `input_tokens` 的**子集** | `input=34070, cached=0, cw=34067` 时 total 仍 = input + output ⇒ cached 不可能在 input 之外。**强** |
| 3 | `cache_write_input_tokens` **也**在 `input_tokens` 之内 | 4 个真实 cw>0 样本（`cached + cw ≤ input` 全部成立：`33245+7296=40541 ≤ 41366` 等）；且若 cw 在 input 之外，事实 1 就等于「total 漏计 cache write」，与价目口径矛盾。**较强（样本少，靠不变式兜底）** |

→ **唯一正确映射**（本仓四列语义：`input` = 未命中缓存的输入）：

| 本仓列 | Codex 来源 | 备注 |
|---|---|---|
| `input`（未命中） | `input_tokens − cached_input_tokens − cache_write_input_tokens` | **必须做减**；负值夹到 0 并计入诊断 |
| `cacheRead` | `cached_input_tokens` | 与 DSH 的 `cacheReadTokens` 同义 |
| `cacheWrite` | `cache_write_input_tokens` | 与 DSH 的 `cacheWriteTokens` 同义 |
| `output` | `output_tokens` | |
| `reasoning` | `reasoning_output_tokens` | **是 output 的子集**，不在恒等式内 |

映射后本仓恒等式 `total = input + output + cacheRead + cacheWrite` **逐条精确等于 Codex 自己上报的 `total_tokens`**。
这条等式就是 P1 阶段的验收断言：它一旦不成立，说明上游语义变了（而不是「差不多就行」）。
事实 3 样本较少，所以实现上必须**显式断言 `cached + cw ≤ input`**：一旦被违反，
说明 Codex 换了语义（cw 变成 input 之外），那时**夹 0 只会掩盖错误**，必须让诊断数字跳出来。

> ⚠️ 一个很容易写错的分支：**只减 `cached`、不减 `cw`**。
> 那样四列之和会比 Codex 的 `total_tokens` 多出 `cw` —— 本机 cw 只占 0.02%（136 万 / 54.9 亿），
> 数字上看不出来，但 §2.3 那条恒等式会**逐条失败**。这正是「用不变式兜住口径」的价值。

> 🚨 这正是本仓第一条铁律在第二个来源上的复现。**减这一次，只能写在解析层一处**，
> 且必须加中文注释说明「Codex 的 cached 含在 input 内，与 DSH 相反」——
> 写错的表现是缓存与输入整块对调，页面上数字看着完全正常。

### 2.4 ★ 双写与两代遥测：为什么不能「每条 token_count 都算一笔」

**实测（同一文件内的真实序列）**：

```
ordinal 15  ltu=input 15630 cached 5504 out 245   ttu=input 15630 ...
ordinal 24  ltu=input 15630 cached 5504 out 245   ttu=input 15630 ...   ← 同值重复
ordinal 34  ltu=input 17552 cached 15744 out 332  ttu=input 33182 ...   ← 累计 33182 = 15630 + 17552
```

- 同一次模型调用会写**两条同值**的 `token_count`（一次调用事件 + 一次 `item_completed`）。
  逐行相加 ⇒ **翻倍**（本机实测 `sum(last_token_usage)` ≈ 文件末累计值的 **2.0×**，逐字段吻合）。
- 正确规则：**按 `total_token_usage` 快照推进** —— 快照未变 = 同一次调用的第二次写入 ⇒ 跳过；
  快照回退 ⇒ 重置基线并记 0（不记负数）。
- **可验证性实测**（这是本方案最重要的一个数字）：

  | 口径 | 结果 |
  |---|---|
  | ≤3 MB 的 1,257 个含用量文件（另一口径比对） | **1,247 个逐字段精确相等**，10 个不齐 |
  | **全量** 1,462 个含用量会话 | **1,442 个逐字段精确相等**，20 个不齐（≈1.4%） |

  → 对不齐的那 20 个**不静默**：计入诊断 `codexCounterDrift`，与 DSH 的 `totalTokenMismatches` 同款处理。
  它们的成因尚未逐个归因（累计快照含未被 `last_token_usage` 覆盖的调用、或压缩后重置），
  P0 阶段要把这 20 个文件的样本固化下来，作为「诊断项真的会被触发」的证据。

**第二代遥测 `token_usage_record`**（新版本 Codex 才有，实测 84 个文件、与 `token_count` **共存**）：

```json
{"type":"token_usage_record","payload":{"session_id":"…","turn_id":"…","response_id":"resp_…",
 "usage":{…本次调用…},"turn_token_usage":{…本轮累计…},"thread_token_usage":{…线程累计…}}}
```

- `usage` = **本次调用**（可计费）；`turn_token_usage` / `thread_token_usage` = 累计（**求和即错**）。
  实测 `sum(usage) == last(thread_token_usage)` 逐字段成立。
- `response_id` 唯一（实测 4 条 4 个不同值）⇒ 天然的幂等键。
- **共存时的取舍**：同一文件若存在 `token_usage_record`，则**只采它、忽略 `token_count`**。
  实测同一文件两种口径给出同一个数（`97897`），说明二者描述同一批调用 —— 同时采就是双计。
  这与 DSH 侧「同一会话只读最高格式的标准日志」是**同一条规则**，实现上也应放在同一个地方。

### 2.5 归属字段从哪来

| 维度 | 来源 | 实测情况 |
|---|---|---|
| `model` | `turn_context.payload.model`（按序继承给其后的计费事件） | 44,510 个 token_count 中仅 **1 个**没有模型上下文 |
| `provider` | `session_meta.payload.model_provider` | 实测只有 `openai` / `custom` 两种；`custom` = 用户配了代理（本机 config.toml 走 `127.0.0.1` 中转） |
| `cwd` | `session_meta.payload.cwd`（`turn_context` 也有） | 项目归因 |
| 时间 | 信封 `timestamp` | ISO8601 UTC → epoch ms |
| 轮次 | `turn_context.turn_id` / `token_usage_record.turn_id` | 本仓 `turn` 是数字，可自增序号或留 `null` |
| 会话 | `session_meta.payload.session_id`（= 文件名里的 uuid） | 幂等键主体 |

实测出现过的模型：`gpt-5.5` / `gpt-5.6-sol` / `gpt-5.6-terra` / `gpt-5.4` / `gpt-6-astra` /
`codex-auto-review` / `glm-5`（最后一个说明**代理后面接的不一定是 OpenAI**）。

### 2.6 边界条件（全部实测到）

| 边界 | 实测 | 处理 |
|---|---|---|
| `payload.info == null` | 有（抽样 5 例） | 跳过 + 计数 |
| 零用量事件（input=output=0） | 有（14 例） | 跳过 + 计数 |
| 空文件（0 字节） | 1 个 | 当作「无用量」，不报错 |
| fork（`forked_from_id`） | 1 个；按「事件时间 < session_meta 时间」判定时重放数为 0 | 以 session_meta 时刻为水位；累计基线重置 |
| 归档副本 | 17 个，与活动目录无同名 | 相对路径去重、活动副本优先 |
| 旧格式 | 本机最早 2026-04，无裸行样本 | 分类跳过 + `unknownEventTypes` 诊断 |
| `archived_sessions` 存在与否 | 存在 | 两个根都要报出来（缺了不能静默） |

### 2.7 冷扫成本实测（决定本地库的定位）

150 个文件 / 325 MB 抽样，全行 `JSON.parse`：

| 做法 | 抽样耗时 | 推算全量 2.8 GB |
|---|---|---|
| 全行解析 | 539 ms | **约 4.6 s**（页缓存热态） |
| 子串预筛后解析 | 459 ms | 约 4.0 s（**只快 1.2×**） |

- 与 DSH 的 15.7 s / 80 MB（其中 **76.9% 花在 zstd 解压**）形成鲜明对比：
  **Codex 没有解压成本，行少而长（42k 行 / 325 MB），直扫本身就便宜。**
- 结论：预筛**不做**（复杂度换 20% 不划算）；本地库**仍要做**，
  但它的动机变成「统一查询入口 + 增量 + 与 DSH 同一张表」，而**不是**「直扫太慢」。

---

## 2.8 内核实测结论（P0 已落盘并通过独立核对）

**逐文件核对**（期望值由另一套独立实现算出，不是被测代码自己给的）：
挑 5 个「最难的」真实文件（双写、B 代际、`cache_write>0`、fork、>1 MB），
**calls 与四列逐位全部相等**。

**全量核对**（`sessions` 根，1,495 文件 / 2.8 GB）：

| 口径 | calls | total |
|---|---|---|
| 独立探针（只认 A 代际，本机全量） | 58,036 | 5,486,897,106 |
| **适配器（B 优先）** | **58,053** | **5,492,035,205** |

差异 **+0.03% / +0.09%**：来自 84 个「含 B 代际」的文件 —— 那些文件改用
`token_usage_record` 的 `usage`（带 `response_id` 的逐次调用值）后，比 A 代际的
「累计快照去重」多认出 17 次调用。**这是以 B 优先的正确方向**，但差异必须写进说明：
同一台机器上两种口径**不会给出完全相同的数**，看板与页面不可能「逐位一致」地跨版本比较。

**诊断计数（真实值，全部可见）**：

| 计数 | 本机实测 | 含义 |
|---|---|---|
| `codexIdentityViolations` / `codexZeroUsage` | 5 / 5 | 极少数事件只有 `total_tokens`、四类全 0（**不可拆分的重置标记**）⇒ 跳过，不替上游编造四列 |
| `codexOverlapAnomalies` | 0 | `cached + cache_write > input` 一次都没出现 ⇒ §2.3 的映射前提成立 |
| `codexNullInfo` | 467 | 旧版写的空 `info`，跳过 |
| `codexCounterDriftFiles` | 17（≈1.1%） | 逐条求和 ≠ 文件末累计快照的文件数 ⇒ **允许非 0，但必须显示** |
| `codexOtherGenerationSkipped` | 5,161 | 同文件里另一代际的事件数（先出现的代际说了算） |
| `codexMetaMismatch` | **51** | 信封 `session_id` ≠ 文件名 uuid（见下） |
| `codexReplayedEvents` | 0 | fork 重放保护触发次数 |

### 🚨 由此新增的第 4 条硬规则：幂等键主体必须是**文件名里的 uuid**

实测 51 个文件的信封 `session_id` 与文件名 uuid 不一致，而且**多个文件共用同一个信封 id**
（续写 / 分叉会话：文件名是新 uuid，信封里还是原线程 id）。

而 `ordinal` 是**文件内**计数、每个文件都从 0 开始。因此若用信封 id 做幂等键主体：
`codex:<信封id>:<ordinal>` 在两个同 id 文件之间**必然相撞**，而落库是 `INSERT OR IGNORE`
⇒ 后一个文件的记录被**静默丢弃**（不是报错，是少了用量）。

→ 结论：`event_id` 用**文件名 uuid**；信封 id 只用于诊断（`codexMetaMismatch`）。
这条与「DSH 的 `event_id` 不许改」同级，都写进 §6 的坑清单。

---

### D1 `source` 是一等维度：`'dsh' | 'codex'`

- **理由 1（可解释）**：出问题时第一个问题永远是「这个数字是谁的」。合并总量后无法回答。
- **理由 2（必然要分）**：单价按 `(provider, model)` 精确匹配，两个来源的模型族完全不同
  （`gpt-5.5` vs `deepseek-v4.1-flash`），未计价率必须能分开看；筛选栏也一定会有人问「只看 Codex」。
- **代价**：本地库 +1 列（可重建，无痛）；**上报库要显式迁移**（见 D8，这是本方案唯一的重活）。
- **不选「塞进 provider 名」**：那会让 `(provider, model)` 精确匹配的单价表整片错配，
  且供应商归一化（`provider_alias`）会把它当规则对象 —— 一个错误被伪装成一条配置。
- **不选「只合并总量」**：改动最小，但引入一个**无法事后拆开**的信息缺口
  （与「采集端一旦合并，后续任何拆分都无法还原」同一条教训）。

### D2 根要带类型，**绝不复用** `dshHomes` / `sessionsRoots` 的语义

```ts
interface SessionRoot { path: string; kind: 'dsh' | 'codex' }
```

- 新增 `codexHomes` / `codexSessionsRoots`（`$CODEX_HOME` > `~/.codex`，含 `archived_sessions`），
  `PathOptions` / `ResolvedPaths` 相应扩展。
- **把 Codex 塞进 `dshHomes` 会让四件事同时含义漂移**：`--dsh-home` 的语义、
  「会话日志根 vs 数据目录」的既有区分、多 home 并集 / 镜像去重的解释、
  以及 62 项多 home 验证 + 11 项 benchmark 的断言。
- 自动发现**不需要**改：`discoverDshHomesDetailed()` 的判据是「有 `sessions` 子目录」，
  而 `~/.codex` 既不匹配 `.dsh*`、也不在 `%APPDATA%` 下以 `dsh` 开头，
  **实测当前不会误收**。但要加一条回归断言把这件事钉住（将来放宽发现规则时不能被顺手收进来）。

### D3 解析入口唯一：复用 `collectEvents()` / `scanIncremental()`

只把三件事按来源分支：**列举文件**、**解码（zstd 分帧 vs 纯文本）**、**字段映射**。
其余（聚合、分桶、诊断、水位线推进、入库、上报）全部复用。

> 🚨 绝不另写一套「Codex 解析器」。两套实现会随时间漂移，表现是
> 「增量结果 ≠ 全量结果」——本仓公认最难查的一类 bug（`db/ingest.ts` 文件头已写明）。

### D4 幂等键：**DSH 一律不动**，Codex 用 `codex:${sessionId}:${ordinal}`

- 🚨 **DSH 侧保持 `${sessionId}:${seq}` 原样**，不要为了「风格统一」给两边都加前缀：
  `event_id` 是**上报库的主键**，改它等于让服务端把历史事件当成新事件再插一遍
  （`--reset` / 全量补报时就会发生），表现是**看板数字翻倍**且不报错。
  来源信息由新加的 `source` 列承载，不该由主键承载。
- Codex 侧：`codex:<sessionId>:<ordinal>`。前缀的价值是让两个来源在主键层面天然隔离
  （Codex 的会话 id 也是 UUID，不撞，但隔离让「同一会话被两个来源各读一次」不可能发生）。
- `seq` 列对 Codex 存 `ordinal`（数字、文件内单调）；`response_id` 留作追溯时再另加列，
  P1/P2 先不加（避免动上报表）。
- ⚠️ **绝不能改成 `filePath:ordinal`**：归档副本 + fork 重放会让同一会话被算两遍。

### D5 水位线：L1 + 字节光标 + 会话内 ordinal

| 层 | DSH | Codex |
|---|---|---|
| L1 | `size` 不变即跳过 | **同样成立**（两侧都是追加写、从不重写） |
| L2 | `frameCount` / `FileCursor` 续解压 | **不适用**：换成「`byteOffset` + 已消费行数」 |
| L3 | `lastSeqBySession` | 同构：会话内最大 `ordinal` |

- 水位线存表的主键要带上来源（`file_watermark` 按 `file_path` 天然区分，但
  `session_state` 的 `last_seq` 必须按 `(source, session_id)` 存）。
- `STATE_VERSION` / `SESSION_SCAN_REVISION` 变更会触发重建 / 全量重扫 —— 这是**期望行为**，
  但要在发布说明里写清「首次运行会重扫一次」。

### D6 口径验证写进诊断（不静默）

| 诊断项 | 含义 | 正常值 |
|---|---|---|
| `codexIdentityViolations` | 映射后四列之和 ≠ 上报 `total_tokens` | 0 |
| `codexCounterDrift` | `sum(去重后用量) ≠ 文件末累计快照` 的文件数 | 实测 20/1462（≈1.4%），**要能看见** |
| `codexOverlapAnomalies` | `cached + cw > input`（映射会出负值，夹 0） | 0 |
| `codexNullInfo` / `codexZeroUsage` / `unknownEventTypes` | 跳过原因分类 | 展示 |
| 按来源分组的 `filesScanned / filesFailed / sessions / events` | 「谁解压失败、谁一条没读到」 | 展示 |

> 这一组数字是本方案「**宁可报告不一致，也不假装一致**」的落点：
> 未定价不当作 0、漂移不当作 0，是同一个原则。

### D7 本地库：加列 + 升版本 + 重建，**不写迁移**

- `usage_event` 加 `source TEXT NOT NULL DEFAULT 'dsh'` + `idx_usage_source`；
  `DB_SCHEMA_VERSION` 3 → 4；`SESSION_SCAN_REVISION` 2 → 3。
- 依据：本地库是**日志的派生物**，`needsRebuild()` / `rebuildSchema()` 就是为这种变更准备的；
  写迁移代码比重建更容易出错且更难测试（`db/schema.ts` 文件头已写明）。
- 🚨 SQL 仍**只做 `SUM(原始列)`**：`source` 只作为筛选 / 分组维度，绝不参与任何公式；
  时间分桶继续走 JS 侧 `toDayKey()` / `toHourKey()`。

### D8 上报与上报库：加字段 + **显式迁移**（本方案唯一的重活）—— ✅ 已落地

> **落地实况（与下面这版设计的差异，改代码前先看这里）**
>
> | 本文原计划 | 实际实现 | 为什么 |
> |---|---|---|
> | `portal-schema-v9.ts` 里放 `_V9_ADDITIONS` 字符串 | 那一列**不进** `_V9_ADDITIONS`，而是由 `portalV9UsageEventStatement()` **拼接**进受控定义；迁移用 `portalV9AddColumnStatement()` 一条 ALTER | `portalSchemaChecksumV6/V7` 按 v5 文本的**当前全文**求摘要 —— 把列写进 v5 常量会让已迁到 v6/v7 的库变成 `unsupported`（服务端拒绝启动） |
> | SQLite 侧要**重建事实表**并前后重比指纹 | **不重建**：带默认值的 `ADD COLUMN` 不改写任何既有行，与 v6/v7/v8 同一档（无需备份证明之外的额外步骤） | 重建只对 v4/v5 那条路有意义（要去掉一列）；v8→v9 只是加列 |
> | `WireTokenRecord.source?: 'dsh' \| 'codex'`（严格枚举） | `source?: string` + zod **只校验形状** `[a-z0-9-]{1,32}` | 客户端比服务端新时严格枚举会让**整批**上报被拒，而 CLI 会把 pending 一直重发 —— 采集在那台机器上永久停住；未知值原样入库并经 `/api/v1/stats/sources` 列出来 |
> | `StatsQuery.source?: string[]` | core 侧叫 `filter.sources`（与本地库同一个字段），线上是重复的同名参数 `?source=a&source=b`（也认逗号） | 与 `provider` / `member_id` / `group_id` 的既有写法一致 |
>
> 位置提醒：`upgradeV8ToV9()` 在升级链里排在 **v5 事实表重建之前**（MySQL 的
> `alignMysqlEventColumns()` 要求「实际列数 == 受控定义列数」，所以列必须先加），
> 因此它必须**幂等**，且只在事实表已是 v5 形态时逐列核对。

- 契约：`WireTokenRecord.source?: string`，**缺省 = `dsh`**（老客户端一个字都不用改）。
  ⚠️ `packages/shared/src/schemas.ts` 是严格 `z.object`，**未声明的键会被静默丢掉** ——
  必须显式加字段，否则表现是「客户端发了、服务端存的全是 dsh」，且不报错。
- 上报库：**计划时** portal 是 **v8**（`portal-schema-v5.ts`；v8 = 看板汇总表，只增表不改事实表），
  `usage_event` **没有任何来源 / 客户端语义列**，v8 汇总表的主键里也没有。
  （**落地后起点是 v8、终点是 v9**，实际做法见上面的差异表。）
  加一列 = **受控 DDL 全文变更** ⇒ `PORTAL_SCHEMA_VERSION` 8 → **9** + 新建
  `portal-schema-v9.ts` + **冻结 v8 摘要**（`portalSchemaChecksumV8`，
  否则已迁到 v8 的库会从「可迁移起点」退化成 `unsupported`）+ 走
  `packages/server/scripts/migrate-db.ts` 的显式 inspect / migrate / resume。
  - **不可自愈**：SQLite 侧**不必**重建事实表（带默认值的 `ADD COLUMN` 不改写任何既有行，
    见差异表）；MySQL 侧需要离线确认与**备份证明**；两头都**不改写任何事件原值**。
  - MySQL 侧本身只需 `ALTER TABLE ADD COLUMN`（既有六条「只有活体 MySQL 才暴露」的坑集中在
    DROP / RENAME / 唯一约束解析，加列不触发），但**仍必须带 `ATR_V4_TEST_MYSQL_URL` 实跑** ——
    「SQLite 上测过了」在迁移这条路上**不构成证据**。
- 落库与查询的最小集（漏一处就是静默错数）：
  `schema/迁移` → `shared/schemas.ts:104` → `core/src/db/ingest.ts:805/826`（插入列与绑定）
  → `core/src/db/query.ts`（`buildWhere` + 维度表达式）→
  **`core/src/db/portal.ts:128` 的 `isTimeWindowOnly`** ← 🚨 **漏改这一处，按来源筛选会静默按全来源出数**
  → `server/src/stats-route.ts:223` 的 `GROUP_BYS` + `parseWindow()`。
- 汇总表（rollup）是否纳入来源维度，是 P4 内的一个**显式子决策**：
  - 纳入 ⇒ rollup 的 cell_key 要加来源、`VERSION` +1、全量重建汇总；
  - 不纳入 ⇒ `isTimeWindowOnly` 那一类「能否走汇总表」的判定**必须显式带上来源条件**。
    这正是上一条那个 🚨：判定失守的表现是「筛了 Codex 却拿到全量数字」，**不报错**。

### D9 看板：来源作为筛选与分组维度 —— ✅ 已落地

- ~~`StatsQuery.source?: string[]`~~ → core 的 `QueryFilter.sources`（多选、**精确匹配**，
  与人员筛选同款；provider / model 才是子串匹配）；线上 `?source=` 重复同名参数。
- `GroupBy` 增加 `'source'` ✅；候选目录 `GET /api/v1/stats/sources`（`stats:read`）——
  返回值是**注册表 ∪ 库里出现过的值**（前者让「本机还没跑过 Codex」也能筛出如实的 0 行，
  后者兜住「更新版客户端上报了本进程不认识的来源」）。
- 🚨 汇总表（rollup）**没有**来源维度：按来源筛选 / 分组必须**显式**退原始表 ——
  由 `portal.ts` 的 `isTimeWindowOnly()` 与 `#rollupUsable()` 两处判掉
  （漏判会带着 `source = ?` 去查汇总表，靠 `try/catch` 静默回退，数字看着仍对）。
  回归：`packages/core/test/rollup.test.ts` 的「★ v9 来源维度与汇总表」。
- 筛选栏加「来源」；概览与分布能分来源看；明细行带来源列：
  - 明细表要改的是 **`web-portal/src/views/RecordsTable.vue:65-142` 的模板**，
    ⚠️ `web-portal/src/types/portal.ts:92` 的 `RECORD_COLUMNS` 是**无人引用的死常量** ——
    改它不会生效（看着改完了，页面上什么都没有）。
  - `web-portal/src/utils/cost.ts` 的 `costSeriesOf()` **确认无需改动**：
    它按 `points[].cost` 的币种集合分发，与 `by=` 维度无关；金额列显隐由 `rows.some(r => r.cost)` 决定，
    同样与维度无关。**不要顺手改它**（多币种不相加那条规则的唯一实现）。
- 本地页同理（`--by source`、`/api/local/stats/*` 的 `sources` 字段按来源分组；
  本地侧对应 `db/stats.ts` 的入参形状与 `db/local-rollup.ts:42` 的 `keyOf` 小时键）。
- 金额：Codex 的模型要**单独配价**（`(provider, model)` 精确匹配）。
  没配时 `unpricedRate` 会**显式**很高 —— 这是正确表现，不要为了好看去动口径。

### D10 近实时：默认不做，作为可选增强

- Codex **没有插件宿主**，DSH 那套 `emit()` → outbox → 上报无法复用。
- 若将来真想复用插件里的零件：`outbox` / `reporter` / `identity` / `paths` 这几块
  （纯本地状态与 HTTP 投递，与宿主无关）**可以复用**；但 `index.ts` 的宿主挂载
  （`ctx.sessionTelemetry` / 工具注册 / 界面面板）与 `backfill-runner.ts` 对 scanner 的假设
  **必须换掉** —— 前者在 Codex 里根本不存在，后者假定的是 DSH 的日志结构。
  即便如此，本方案仍**不走**插件路线：为一个「按需扫描」的来源背上插件的发布与 peer 版本窗口，
  收益与代价不成比例（见 `packages/dsh-plugin/README.md` 的 peer 兼容窗口那一段）。
- Codex 有 hooks（`SessionStart` / `PostToolUse` / `Stop` / `PreCompact` …，2026-04 起 stable）
  与独立的 `notify` 配置（见 [Codex hooks 参考](https://raw.githubusercontent.com/CodeAlive-AI/ai-driven-development/main/skills/hooks-management/references/codex-hooks.md)）。
  但 **hook 输入里只有 `session_id` / `transcript_path` / `cwd` / `model`，没有 token 用量** ——
  钩子只能「触发一次增量采集 + 上报」，不能直接提供用量。
- 且非受管的 command hook 需要用户在 `/hooks` 里 review 信任（改了定义还要重新 review）。
- → **默认形态 = 按需扫描**（`stats` / `report` / 本地页触发）；hook 作为 P5 可选项，
  且必须在文档里写清「钩子不装也能用，装了只是更实时」。

---

## 4. 分期实施（每期独立可验收）

| 期 | 内容 | 验收（把命令跑通即可判） |
|---|---|---|
| **P0** | 证据固化：把 §2 的实测结论 + 只读 probe 落进 `packages/core/verify/verify-codex-format.ts`（合成夹具 + `--real` 只读复验），当格式漂移哨兵 | 合成夹具全绿；`--real` 只打印实测统计不写任何库 |
| **P1** | 来源适配层 + Codex 列举 / 解码 / 字段映射；CLI 直扫出数 | `bun run stats -- --source codex --no-db` 出数；两条不变式断言（§2.3 / §2.4）逐条通过 |
| **P2** | 本地库 `source` 列 + 复合水位线 + `SESSION_SCAN_REVISION` 提升 + 本地页来源行 | `verify-db-parity` 在 Codex 日志上「库查询 == 直扫」逐位一致；本地页「数据来源」显示两个来源 |
| **P3** | 上报 DTO + 服务端接收 + zod 字段 | `packages/server/test/e2e-ingest.ts`（+ 新增 source 用例）、`http-contract.test.ts` 全绿 |
| **P4** | portal **v8→v9** 迁移 + 看板来源维度/筛选 + Codex 单价配置 | 迁移脚本 inspect/migrate/resume 三态；`verify-mysql-portal.ts` 双后端逐位对账；看板金额门禁断言不破 |
| **P5**（可选） | Codex hook 近实时 + `--discover` 展示 Codex 根与归档目录 + 诊断面板 | 钩子脚本幂等（重复触发不多算）；`--discover` 逐项打印 Codex 根 |

**建议先做完 P0 ~ P2**（本机闭环，不动数据库、不动协议，风险最低），
看真实数字是否符合预期，再决定 P3 / P4 的节奏。

---

## 5. 要改的文件（按包）

### `packages/core`

| 文件 | 改什么 | 状态 |
|---|---|---|
| `src/types.ts` | `SessionSource` 受控枚举；`UsageRecord.source` / `SessionMeta.source`；Codex 专有诊断计数 | ✅ 已落盘 |
| `src/sources/types.ts` | **适配器接口**（扩展点唯一入口） | ✅ 已落盘 |
| `src/sources/registry.ts` | 注册表 + 未注册来源**明确报错** | ✅ 已落盘 |
| `src/sources/dsh.ts` | DSH 包成适配器（复用既有 `listSessionFiles` / `eventCollector`，行为零变化） | ✅ 已落盘 |
| `src/sources/codex.ts` | Codex 列举 + 两代折叠 + 四列映射（唯一语义差异点） | ✅ 已落盘，已通过独立核对 |
| `src/home.ts` | ~~新增 `codexHomes`~~ | ✅ **刻意没做**：来源根解析整体搬到 `src/sources/roots.ts`（见下一行），`home.ts` 只管 DSH home，`dshHomes` 语义一字未动 |
| `src/scanner.ts` | 按来源列举 / 解码分支 / 增量水位线接进注册表 | ✅ `listSourceFiles` / `scanSourceFile` / `scanAllSources` + **`scanPlainSources()`（纯文本来源的唯一 L1 实现，全量与增量两条路共用）** |
| `src/sources/roots.ts` | 来源根解析（存在性 / 缺失 / 关闭开关 / 顺序确定） | ✅ 已落盘（`resolveSourceRoots()`；`codexHomes` 那类语义落在这里，不新增平行字段） |
| `src/decode.ts` | 复用 `parseJsonl`；新增「纯文本尾部续读 + 行号」 | ✅ **但没做字节光标**：纯文本来源按**文件级 L1**（字节大小）判定变更，变了就整文件重解析，靠 `event_id` 幂等吸收重复（实测热态成本只随**文件数**走，见 `benchmark:sources`）；只有 DSH 有 `frameCount` 光标 |
| `src/state.ts` | 水位线按 `(source, sessionId)` 隔离 | ✅ 换成**按文件路径**隔离（`state.files[path]`）：不同客户端天然不同路径，同一文件不会跨来源；纯文本来源写 `frameCount: 0` 且**没有光标** |
| `src/db/schema.ts` | `usage_event.source` + 索引；`DB_SCHEMA_VERSION` 3 → 4 | ✅ 已落盘（`idx_usage_source`；**本地库靠 `rebuildSchema()` 重建，不写迁移**） |
| `src/db/ingest.ts` | 本机入库加列与绑定（**门户那条不碰**） | ✅ 已落盘：本机 `ingest()` 的 INSERT 显式列出 `source` 并绑定；上报走 `ATTRIBUTED_COLUMNS`（末尾加 `source`，缺省 `PORTAL_SOURCE_DEFAULT`）；**种子入口 `insertRecords()` 刻意仍不写这一列**，并拒绝显式非 DSH 来源（避免出现第二条没有采集证据的写入路径） |
| `src/db/query.ts` | `buildWhere` 来源筛选 + 投影读列 + 分组维度 | ✅ 已落盘（读真实 `source` 列，**临时的 `'dsh'` 写死与 TODO 已删除**） |
| `src/db/stats.ts` / `local-rollup.ts` | 根入参按来源分组；小时键是否含来源 | ✅ 已落盘（`sources` 作为查询期清单；小时键**不含**来源，来源是独立分组维度） |
| `verify/verify-codex-format.ts` | P0 哨兵（合成夹具 + `--real` 只读复验） | ✅ 已落盘（同款哨兵另有 `verify:claude-code` / `verify:trae` / `verify:workbuddy`；跨来源性能基线是 `benchmark:sources`） |

### `packages/shared` / `packages/cli` / `packages/server` / `packages/web-*`

> 下表原样保留「计划」，前面加 ✅ / ⏳ 表示**今天是否已落地**；偏离计划的地方就地写明。

| 文件 | 改什么 | 状态 |
|---|---|---|
| `shared/src/protocol.ts` | `WireTokenRecord.source?`；`StatsQuery.sources?`；`GroupBy` 加 `'source'`；`RecordRow.source`；`StatsSourcesResponse` | ✅ 已落盘（**没有** `StatsQuery.source?` 单数形态，也没有 `LocalStatsSources` 新类型） |
| `shared/src/schemas.ts:104` | 显式加 `source`（严格 `z.object` 会丢未声明键） | ✅ 已落盘，且只校验**形状**（`^[a-z0-9][a-z0-9-]{0,31}$`），未知但合法的值原样入库 |
| `core/src/db/ingest.ts:805/826` | 上报落库的两条 INSERT | ✅ 已落盘（见上一张表） |
| `core/src/db/portal.ts:128` | 🚨 `isTimeWindowOnly`：判定「能否走汇总表」时必须带上来源条件 | ✅ 已落盘，且**是两处**：`isTimeWindowOnly()` 与 `#rollupUsable()` 都要判（漏一处就是静默用汇总表出数） |
| `cli/src/cli.ts` | `--source`（含 `all`）/ `--codex-home(s)` / `--no-codex`；`--discover` 按来源逐根报 | ✅ 已落盘并实跑 |
| `cli/src/report.ts` + `core/src/db/portal.ts` | `report` 连**非 DSH 来源**一起上报 | ✅ 已落盘（`runReport({ plainRoots })` 走 `scanPlainSources()`，`state.json` 的纯文本文件写 `frameCount: 0`、无光标） |
| `web-local/src/**` | 「数据来源」一行按来源渲染 | ✅ 已落盘（`describeSources()`：单个来源写名字、多个写 `A + B`，并说明按并集统计） |
| `server/src/stats-route.ts:223` | `GROUP_BYS` 加 `source`；`parseWindow()` 解析来源 | ✅ 已落盘，另加 `GET /api/v1/stats/sources` 候选目录（`KNOWN_SUBS`） |
| `web-portal/src/views/RecordsTable.vue:65-142` | 明细表加「来源」列 | ✅ 已落盘（改的是**模板**；`types/portal.ts` 的 `RECORD_COLUMNS` 仍是**无人引用的死常量**，改它不生效） |
| `web-portal/src/**` 筛选栏 / 概览 / 分布 | 「来源」筛选与分来源呈现 | ✅ 已落盘（筛选栏多选且**不允许新建** —— 来源是客户端事实，不是用户自建标签；`BREAKDOWN_TABS` 加「来源」页签） |
| `scripts/test-preload.ts` | **必须同时钉住 Codex 根**（见 §6 坑 10） | ✅ 已落盘（`DSH_TOKEN_REPORT_CODEX=0`） |

---

## 6. 风险与坑（按危险程度排序）

1. **🚨 幂等键用 `filePath` 或「按文件存 seq」** ⇒ 归档副本 + fork 重放 ⇒ 同一会话算两遍，
   且因为主键不同**不会**被去重吸收。必须 `source:sessionId:ordinal`。
2. **🚨 `cached ⊂ input` 做错**（照抄 DSH 的「cacheRead 不在 input 内」）⇒ 输入与缓存整块对调，
   数字看着正常。必须减，且只在解析层减一次。
3. **🚨 逐行累加 `last_token_usage`** ⇒ 同一次调用双写 ⇒ 总量**正好翻倍**（实测 2.0×）。
   必须按累计快照推进。
4. **🚨 两代遥测同时采**（`token_count` + `token_usage_record`）⇒ 双计。文件内只选一代。
5. **把 Codex 根混进 `dshHomes` / `sessionsRoots`** ⇒ `--dsh-home` 语义、多 home 镜像去重解释、
   62 项多 home 验证全部漂移。必须新增平行的 `codexHomes`。
6. **L2 帧水位线套用到纯文本** ⇒ 热态要么每次重解压、要么永久跳过（漏数据）。
7. **上报库「顺手」自愈 / 跳步迁移** ⇒ 上报库是唯一副本，删掉 = 全员历史永久消失。
   必须走 `migrate-db.ts` 的显式流程；且升 v9 时**必须冻结 v8 摘要**，否则已迁到 v8 的库会被判成
   `unsupported`（表现是「迁移明明做完了却不算成功」）。
8. **🚨 查询层的「能否走汇总表」判定漏带来源**（`core/src/db/portal.ts:128` 的 `isTimeWindowOnly`）
   ⇒ 按来源筛选却拿到全来源数字，**不报错**。这是本方案里最隐蔽的一条。
9. **SQL 里写公式或加 `total` / `cost` 列** ⇒ 第二个口径真源，静默错误。
10. **🚨 测试与验证脚本不钉 Codex 根** ⇒ 全部 `bun test` 会连带扫开发者真实的 `~/.codex`
    （本机 1,495 个文件 / 2.8 GB），断言漂移、变慢，而且**不报错**。
    `scripts/test-preload.ts` 现在只固定 `dataDir` 与 `DSH_TOKEN_REPORT_DISCOVER`，
    spawn 子进程还要自己传 —— Codex 侧同理必须给 `DSH_TOKEN_REPORT_CODEX_HOMES`（或 `--no-codex`）。
11. **改到死常量上**（`web-portal/src/types/portal.ts:92` 的 `RECORD_COLUMNS` 无人引用）
    ⇒ 以为改完了，页面上什么都没有。改模板要看 `RecordsTable.vue`。
12. **`COUNT(DISTINCT session_id)` 跨来源相加** ⇒ 会话数口径错（两个来源都是 UUID，不会撞，
    但「会话数」的含义变成「两个来源之和」，需要在 UI 上说清）。
13. **把对话内容当「顺便也存下来」** ⇒ 违反本仓「只采数值不采内容」的既定边界。
14. **旧格式硬猜字段** ⇒ 猜错不报错。分类跳过 + 计入 `unknownEventTypes`。

---

## 7. 待决项（需要拍板）

| # | 问题 | 选项 |
|---|---|---|
| Q1 | **本轮做到哪一期？** | A) P0~P2 本机闭环（不动库、不动协议，最快看到数）／B) 一直做到 P4（含上报库 v9 迁移与看板维度）／C) 先只做 P0 证据固化 |
| Q2 | **看板上「来源」是不是一等维度？** | A) 是（筛选 + `by=source` + 明细列，推荐）／B) 否（只并入总量，改动最小但事后无法拆分） |
| Q3 | **要不要近实时（P5）？** | A) 先不做（默认按需扫描／上报）／B) 做 Codex hook，装了就实时、不装也能用 |
| Q4 | **Codex 的 provider 怎么记？** | A) 记原值（`openai` / `custom`）+ 查询期用 `provider_alias` 归一（推荐，与既有机制一致）／B) 采集期固化成 `codex-openai` 之类（会让单价匹配多一层约定） |

---

## 附录 A：最小可跑的核算脚本（只读，用于复核本文数字）

探查脚本已在本机跑过（临时目录，不进仓库；P0 会把它们整理成
`packages/core/verify/verify-codex-format.ts`）。核心逻辑：

```ts
// 1) 逐文件按累计快照去重，只认推进的那一条
const key = JSON.stringify(info.total_token_usage)
if (key === prevKey) continue          // 同一次调用的第二次写入 ⇒ 跳过
prevKey = key
// 2) 映射到本仓四列（input 必须减掉 cached 与 cache_write）
const cacheRead  = l.cached_input_tokens ?? 0
const cacheWrite = l.cache_write_input_tokens ?? 0
const input      = Math.max(0, (l.input_tokens ?? 0) - cacheRead - cacheWrite)
// 3) 不变式：input + output + cacheRead + cacheWrite === l.total_tokens
```

## 附录 B：实测命令（PowerShell，只读）

```powershell
# 文件规模与目录形状
Get-ChildItem "$env:USERPROFILE\.codex\sessions" -Recurse -File | Measure-Object -Property Length -Sum

# 单个文件的信封与事件分布
Get-Content <rollout.jsonl> -TotalCount 2

# 计费字段样本（含 cache_write > 0 的关键样本）
Select-String -Path <files> -Pattern '"cache_write_input_tokens":[1-9]'
```

## 附录 C：外部参考（仅作交叉对照，不作为契约）

- [Codex rollout schema notes（第三方解析器汇总）](https://raw.githubusercontent.com/repowise-dev/skiplevel/main/docs/schema-notes-codex.md)
- [Codex session storage spike（第三方实测）](https://raw.githubusercontent.com/garrytan/gstack/main/docs/spikes/codex-session-format.md)
- [Codex hooks 参考（notify / 生命周期事件）](https://raw.githubusercontent.com/CodeAlive-AI/ai-driven-development/main/skills/hooks-management/references/codex-hooks.md)
