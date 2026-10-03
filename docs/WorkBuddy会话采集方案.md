# WorkBuddy 会话采集方案

> 状态：**已落盘并实跑**（来源适配器 / 本地库与直扫两条路径同一个数 / 格式哨兵合成 43 项 + `--real` 53 项全绿）。
> 上报体与看板来源维度沿用 Codex / Claude Code / Trae 那一轮（`source` 列 + `--by source`），不在本文件重复。
> 口径结论全部来自**本机真实日志**（`~/.workbuddy`，5 个会话文件 / 200 行事件 / 10 条计费记录），
> 复验命令：`bun run --filter '@ai-token-report/core' verify:workbuddy -- --real`。

---

## 1. 结论先行

| 问题 | 答案 |
|---|---|
| 计费数据在哪 | `<配置目录>/projects/<cwd 压缩名>/<sessionId>.jsonl` 里带 `providerData.usage` / `providerData.rawUsage` 的行 |
| 配置目录 | `$WORKBUDDY_CONFIG_DIR` > `~/$WORKBUDDY_DATA_FOLDER_NAME` > `~/.workbuddy`（**WorkBuddy 自己的解析链**，不是我们定的） |
| 一次调用写几行 | **一行**，但**行类型不固定**：实测 4 条里 3 条挂在 `function_call`、1 条挂在 `message/assistant`（同一个 `messageId` 下的 `reasoning` 行**不带**用量） |
| 四列语义 | **`prompt_tokens` 含缓存命中** ⇒ `input = prompt − cacheRead − cacheWrite`（与 Codex / Trae 同，与 Claude Code **相反**） |
| 缓存字段取值顺序 | 🚨 `prompt_cache_hit_tokens` > `cache_read_input_tokens` > `prompt_tokens_details.cached_tokens`（实测同一行里前者 48512、后者 **0**） |
| 幂等键 | `workbuddy:<相对根路径>:<文件内序号>`（相对路径 = `<cwd 压缩名>/<sessionId>`，天然覆盖嵌套的子代理文件） |
| provider | 常量 `workbuddy`（日志里**根本没有** provider 字段，不许拿模型名猜厂商） |
| model | `providerData.model`，回退 `requestModelId`；老代际实测是 `auto`（上游真实取值，照原样记 ⇒ 配不上单价是正确表现） |
| cwd | 行的顶层 `cwd`（`ai-title` / `file-history-snapshot` / 新代际各类行都有）；**迁移过来的老会话一行都没有** ⇒ 回退 `.meta.json` 侧车 |
| 两代格式 | **新代际**（每调用一行，camelCase `usage` + `rawUsage`，有缓存字段）与**老代际**（`migratedFrom: agent-history`，snake_case `usage`，**没有**缓存字段，且**每个用户轮次只落最后一次调用**） |

---

## 2. 实测（本机真实日志）

`bun run --filter '@ai-token-report/core' verify:workbuddy -- --real` 的输出：

| 指标 | 实测值 | 说明 |
|---|---|---|
| 会话文件 | **5** | `projects/<cwd 压缩名>/<sessionId>.jsonl`；另有 `.meta.json` / `.file-rollback.ndjson` / `.quickask` 等邻居文件（都不算会话） |
| 事件行数 | 200 | `session-meta` / `message` / `reasoning` / `function_call` / `function_call_result` / `ai-title` / `file-history-snapshot` … |
| **计费记录 / 调用数** | **10 / 10** | 5 条来自老代际（每轮一条），4 条来自一次新代际会话，1 条来自另一个老会话 |
| **总量** | **2,420,880** | 四列之和逐条等于上游自报的 `total_tokens`（10/10） |
| 未缓存输入 | 2,270,188 | `prompt − 缓存`；其中 **2,256,632 来自老代际那 6 条**（没有缓存字段 ⇒ 整段上下文计入 input） |
| 输出 | 22,308 | 其中推理 3,618（`reasoning` 是 output 的子集，**不进恒等式**） |
| 缓存读 | 128,384 | **全部来自新代际的 4 条**（老代际一条都没有） |
| 缓存写 | **0** | 10 条里 `prompt_cache_write_tokens` / `cache_creation_input_tokens` 全是 0（字段在，照常映射） |
| 缓存命中率 | 5.4% | `cacheRead / (cacheRead + input)` —— 🚨 **被系统性低估**，见下面第 3 条 |
| 🚨 **不拆缓存的朴素相加** | **2,549,264** | 1.05 倍 —— 这就是「照抄 Claude Code 的映射」会得到的数（本机样本里缓存占比不高，差距看起来不大；换成缓存重的会话会明显放大） |
| 恒等式不符 | 0 | 四列之和 == 上游 `total_tokens` 逐条成立 |
| 缓存重叠（`cacheRead + cacheWrite > prompt`） | 0 | 「缓存含在输入内」这条前提无例外 |
| `prompt_cache_miss_tokens` 与「prompt − 缓存」不符 | **0** | 4/4 相符，是这条前提**直接**的证据（比恒等式更早发现语义翻转） |
| 坏时间戳（`timestamp: 0`） | 0（**另有一个文件 16/16 行都是 0**） | 那 16 行里没有一条带用量，所以不影响总量；但规则必须挡住（见第 5 节坑 4） |
| 模型分布 | `auto`×6 / `deepseek-v4.1-flash`×4 | `auto` 是老代际的取值 ⇒ 这 6 条配不上任何单价 |
| 子代理文件 | 0 | 本机没用到子代理，那条路径只由合成夹具兜住（见第 6 节） |

三条由上面推出来的实操结论：

1. **`prompt_tokens` 是「含缓存的总输入」**，三条互相独立的证据：
   ① `prompt_cache_miss_tokens + prompt_cache_hit_tokens == prompt_tokens` **逐条精确成立**
   （3425 + 48512 = 51937 等，4/4）；② `total_tokens == prompt_tokens + completion_tokens`
   逐条成立（10/10，含老代际）—— 若 `prompt` 是「未命中部分」，上游自报的 `total_tokens`
   就会漏掉全部缓存读；③ WorkBuddy 自己的 `toolCallUpdate` 就是把 `prompt_tokens` 当
   `promptTokens`、把 `prompt_cache_hit_tokens` 当缓存命中分开摆的（`cachedTokenCount()`
   的字段优先级），它自己都没做减法 —— 因为两边是**并列**的两块。
2. **缓存字段的取值顺序必须照抄上游**：实测同一条新代际记录里
   `prompt_cache_hit_tokens = 48512` 而 `cache_read_input_tokens = 0`（后者在 DeepSeek 这条
   网关路径上恒为 0）。先读后者 = 把缓存读当成 0、把整段上下文当成未命中 ——
   输入与缓存整块对调，页面上数字看着完全正常。
3. **老代际（`migratedFrom: agent-history`）没有缓存字段**，所以它的 `input` 只能是整段上下文、
   `cacheRead` 只能是 0。**这不是采集漏项**，是上游老格式的缺口；但「命中率被低估」必须能被看见，
   于是逐条计入 `workbuddyUsageWithoutCache`（本机 **6/10**）。看 WorkBuddy 的命中率时必须按这个
   数字打折扣，否则会把「上游没给」读成「这个客户端真的不用缓存」。

---

## 3. 目录与字段

```
<配置目录>/                      ← $WORKBUDDY_CONFIG_DIR > ~/$WORKBUDDY_DATA_FOLDER_NAME > ~/.workbuddy
├── projects/
│   └── <cwd 压缩名>/                              ← CWD 经**有损**压缩（`/` `\` `:` → `-`，超长再截断+哈希）
│       ├── <sessionId>.jsonl                      ← ★ 计费真源：一个会话一个文件
│       ├── <sessionId>.meta.json                  ← 可选：**迁移过来的老会话**才有（cwd / createdAt）
│       ├── <sessionId>.file-rollback.ndjson       ← 文件回滚记录（不含用量，不采）
│       ├── <sessionId>.quickask                   ← 划词临时会话的空标记文件（不采）
│       ├── <sessionId>.acp-session.json           ← ACP 会话 id 映射（不采）
│       └── <sessionId>/subagents/<taskId>.jsonl   ← 子代理（团队）会话，用量独立落自己的文件
├── logs/                                          ← 运行日志（启动 / 网关 / SDK），**一行逐次用量都没有**
├── sessions/<pid>.json                      ← 进程心跳（pid / 端口 / cwd），不是会话
└── workbuddy.db                             ← sessions / session_usage 两张表，**不是计费真源**（见第 5 节坑 1）
```

**为什么这些目录形状不是猜的**：WorkBuddy 自己的源码里写着这条布局 ——
`resolveLocalSessionJsonlPath()` = `join(homeDir, "projects", compressWorkspacePathName(cwd), id + ".jsonl")`，
`resolveHistoryPaths()` 里另有 `childDir = <projectDir>/<conversationId>/subagents`，
`WORKBUDDY_PLATFORM_OWNED_PROJECT_FILE_PATTERNS = ["projects/*/*.jsonl", "projects/*/*.meta.json",
"projects/*/*.file-rollback.ndjson"]`。本机实测逐项吻合。

### 3.1 一条模型响应的形状（新代际）

```jsonc
{"id":"01a0ffae-12db-…","parentId":"…","timestamp":1790995997736,"type":"reasoning",
 "sessionId":"d992a024-…","cwd":"c:\\Users\\…",
 "providerData":{"conversationRequestId":"01a0ffae0148…","messageId":"01a0ffae12db…",
                 "model":"deepseek-v4.1-flash"}}                 // ← 不带用量

{"id":"01a0ffae-243d-…","type":"function_call","timestamp":1790995997759,"sessionId":"…",
 "providerData":{"messageId":"01a0ffae12db…","model":"deepseek-v4.1-flash",
   "usage":{"requests":1,"inputTokens":36596,"outputTokens":450,"totalTokens":37046,
            "inputTokensDetails":[{"cached_tokens":0}],
            "outputTokensDetails":[{"reasoning_tokens":304}]},
   "rawUsage":{"prompt_tokens":36596,"completion_tokens":450,"total_tokens":37046,
               "prompt_cache_hit_tokens":0,"prompt_cache_miss_tokens":36596,
               "prompt_cache_write_tokens":0,"cache_read_input_tokens":0,
               "cache_creation_input_tokens":0,"completion_thinking_tokens":304,
               "prompt_tokens_details":{"cached_tokens":0},"credit":0.55}}}   // ← 用量在这一行
```

同一个 `messageId` 的多行是**一次响应的多个输出项**（推理 / 文本 / 多个工具调用），
用量只出现在其中一行（实测是「该响应最后处理的那一行」）：

```
messageId=m1: reasoning(无用量) → function_call(★用量)
messageId=m2: reasoning(无用量) → message/assistant(无用量) → function_call(★用量)
messageId=m3: reasoning(无用量) → message/assistant(★用量)
```

⚠️ 所以**不能写死「只认 `message/assistant` 行」**：本机 4 条新代际记录里 3 条会因此丢掉。
实现是**按字段认行**（谁带 `usage` / `rawUsage` 就认谁）+ 用 `messageId` 去重。

### 3.2 老代际的形状

```jsonc
{"id":"845c177f4e204291b4112bc1a8cf7615","type":"message","role":"assistant",
 "timestamp":1775534024502,"sessionId":"59a10a52…",
 "providerData":{"model":"auto",
   "usage":{"input_tokens":26219,"output_tokens":17,"total_tokens":26236}}}
```

没有 `messageId`、没有 `rawUsage`、没有缓存字段；幂等键回退到行的 `id`。
**每个用户轮次只有最后一次调用落盘**（本机 Claw 会话：4 个用户轮次 / 39 条 assistant 行，
但**只有 5 条用量记录**，都紧跟在轮次的最后一条 assistant 消息上）——
中间的工具轮次一条都没有，这是上游的缺口，改适配器补不回来。

### 3.3 字段 → 四列映射

| 本仓列 | WorkBuddy 来源 | 备注 |
|---|---|---|
| `input`（未命中） | `prompt_tokens − cacheRead − cacheWrite`（夹 0） | **必须做减**；老代际没有缓存字段 ⇒ 等于整段上下文 |
| `cacheRead` | `prompt_cache_hit_tokens` → `cache_read_input_tokens` → `prompt_tokens_details.cached_tokens` / `inputTokensDetails[0].cached_tokens` | 顺序即上游 `cachedTokenCount()` 的顺序 |
| `cacheWrite` | `prompt_cache_write_tokens` → `cache_creation_input_tokens` | 实测恒为 0（字段在，照常映射） |
| `output` | `completion_tokens` / `outputTokens` | |
| `reasoning` | `completion_tokens_details.reasoning_tokens` / `outputTokensDetails[0].reasoning_tokens` | **是 output 的子集**，不在恒等式内 |
| `total` | 由四列相加（= 上游 `total_tokens`，逐条校验） | |

---

## 4. 实现落点

| 文件 | 改了什么 |
|---|---|
| `packages/core/src/sources/workbuddy.ts` | **新增**：根解析（`$WORKBUDDY_CONFIG_DIR` 链 + `projects` 层）/ 列举（只认 `.jsonl`，含嵌套子代理文件）/ 折叠（按字段认行 + `messageId` 去重 + 侧车 cwd）/ 巡检 |
| `packages/core/src/sources/registry.ts` | 注册一行 |
| `packages/core/src/types.ts` | 13 个 `workbuddy*` 诊断计数 + `emptyDiagnostics()` |
| `packages/cli/src/cli.ts` | `--workbuddy-home(s)` / `--no-workbuddy` / `--discover` 与 `--help` 文案 |
| `scripts/test-preload.ts` | `DSH_TOKEN_REPORT_WORKBUDDY=0`（**不钉住就会扫开发者真实日志**） |
| `packages/core/test/workbuddy-source.test.ts` | 单测 32 项（根 / 列举 / 映射 / 折叠 / 入库） |
| `packages/core/verify/verify-workbuddy-format.ts` | 格式哨兵：合成 43 项 + `--real` 10 项（独立实现逐条对账） |
| `packages/core/package.json` | `verify:workbuddy` 脚本 |

`SessionSource` 里 `'workbuddy'` **本来就占着位**（从 Codex 那一轮起就是受控枚举的一员），
所以这一轮不需要动 schema、协议、路由 —— 新增一个来源的三步（适配器 + id + 注册）之外，
只多了一处「根从哪个环境变量来」。

---

## 5. 坑（按危险程度排序）

1. 🚨 **`workbuddy.db` 的 `session_usage` 不是计费真源**。它只有
   `session_id / used / size / updated_at / credit_json` 一行一个会话：`used` 是**当前上下文大小**
   （实测 51937 = 最后一次调用的 `inputTokens`），不是累计计费量；`credit_json` 是**积分**
   （`{"<请求 id>":1.05}`，WorkBuddy 自己的计价单位），不是我们口径的金额。
   拿它当用量会得到一个「永远等于最后一次上下文」的数，而且**不会报错**。
   本地会话 JSONL 是唯一能拆四列、能定时间的真源。
2. 🚨 **缓存字段顺序写反**（先读恒为 0 的 `cache_read_input_tokens`）⇒ 缓存与输入整块对调。
   见第 2 节结论 2，`verify:workbuddy` 里有一条专门钉这个顺序的断言。
3. 🚨 **只认 `message/assistant` 行** ⇒ 漏掉工具轮次的用量（本机 4 条里丢 3 条）。
   用量挂在「该响应的最后一行」，行类型不固定。
4. 🚨 **`timestamp: 0` 不许退化成 1970**。迁移过来的老会话整文件时间戳为 0
   （本机 `1a02ca59…` 16/16 行），只有末尾的 `custom-title` 用 `createdAt`。
   当成 1970 ⇒ 用量落在任何时间窗之外（页面显示「这段时间没有用量」）或污染「全部时间」，
   两种表现都不报错。规则：**跳过 + 计数**（`workbuddyInvalidTimestamps`）。
5. 🚨 **把 `.meta.json` / `.file-rollback.ndjson` / `.quickask` / 0 字节文件当成会话** ⇒
   会话数与日志数虚高（列表页与诊断都会偏）。判据只认 `<name>.jsonl` 且非 0 字节。
6. 🚨 **测试与验证脚本不钉 WorkBuddy 根** ⇒ 全部 `bun test` 会连带扫开发者真实的
   `~/.workbuddy/projects`（本机 5 个文件），断言随机器漂移、而且**不报错**。
   `scripts/test-preload.ts` 里已加 `DSH_TOKEN_REPORT_WORKBUDDY=0`；spawn 子进程还要自己传。
7. **把 `logs/` 当成根**（而不是 `projects/`）⇒ 永远是 0 条：运行日志里一行逐次用量都没有，
   而「目录挑错了」与「这台机器没用过」在输出上完全一样。
8. **拿模型名猜 provider**（`deepseek-v4.1-flash` ⇒ `deepseek`）⇒ 单价按 `(provider, model)`
   精确匹配，猜错就是金额错且不报错。日志里没有 provider 字段，就记常量 `workbuddy`。
9. **`--no-workbuddy` 与「只选别的来源的 `--source`」同时给**：与 `--no-codex` 等既有开关同一套
   冲突判定（抛 `UsageError`），不要为了「静默减掉」而放过它。
10. **老代际的 `model: "auto"` 被改写成 `(unknown)`** ⇒ 丢掉上游的真实取值。
    照原样记，它配不上单价是**正确表现**（`unpricedRate` 会显式变高）。

---

## 6. 待决 / 已知缺口

| # | 事项 | 现状 |
|---|---|---|
| Q1 | **子代理会话是否与父会话重复计费** | 未验证。布局（`<sessionId>/subagents/<taskId>.jsonl`）来自 WorkBuddy 自己的源码，本机没有样本。实现**采它**（子会话各算各的，`event_id` 不同 ⇒ 若父会话也记了一遍就会双计），并在 `workbuddyNestedSessionFiles` 里把条数报出来；第一次在真机上用到子代理时**必须复验这一点** |
| Q2 | **老代际只有每轮最后一次调用** | 上游缺口，无法补。表现为 WorkBuddy 的历史用量系统性偏小；`workbuddyUsageWithoutCache` 是唯一的外部信号 |
| Q3 | **`cache_creation_input_tokens > 0` 的语义**（是否含在 `prompt_tokens` 内） | 本机样本恒为 0，未能实测。当前按 Codex 的结论处理（**含**在 prompt 内 ⇒ 减掉）；若上游改成 Anthropic 那种「不含」，`workbuddyIdentityViolations` 会立刻非 0（四列之和会多出 cacheWrite），不会被静默吸收 |
| Q4 | **近实时（事件触发采集）** | 不做。WorkBuddy 是 Electron 桌面端，没有 DSH 那种 cordis 宿主可以挂 `emit()`；按需扫描（`stats` / 本地页触发）已经够用 |
| Q5 | **云端会话**（`sessions.transport = "cloud"`） | **本地没有 JSONL**（本机一个 `workbuddy-mp` 会话只在库里有一行），采集不到。这类会话的用量在服务端，不进本平台 |

---

## 7. 验收命令

```bash
# 格式哨兵：合成夹具（43 项）+ 本机真实日志只读复验（10 项，需要本机有 WorkBuddy）
bun run --filter '@ai-token-report/core' verify:workbuddy
bun run --filter '@ai-token-report/core' verify:workbuddy -- --real

# 单测
bun test packages/core/test/workbuddy-source.test.ts

# 本机有哪些来源目录（逐根报会话数 / 最新写入 / 是否存在）
bun run stats -- --discover

# 只统计 WorkBuddy；库路径与直扫路径必须给出同一个数
bun run stats -- --source workbuddy --by model --no-db
bun run stats -- --source workbuddy --by model

# 多客户端一起统计（表格自动多一列「来源」）
bun run stats -- --source all --by source
```

本机实测（2026-10-03）：`--source workbuddy --by model --no-db` 给出
`10` 次调用 / `2,420,880` token，按模型分成 `auto`（2.24M）与 `deepseek-v4.1-flash`（184.0K）；
`--discover` 逐根报出 `[✓] [workbuddy] C:\Users\Administrator\.workbuddy\projects  会话 5 / 日志 5`。
