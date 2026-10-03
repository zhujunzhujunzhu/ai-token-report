# Trae 会话采集方案

> 状态：**已落盘并实跑**（来源适配器 / 两个发行版 / 本地库与直扫两条路径同一个数）。
> 上报体与看板来源维度沿用 Codex / Claude Code 那一轮，不在本文件重复。
> 口径结论全部来自**本机真实日志**（Trae 国际版，`%APPDATA%\Trae\logs`）。
> 首次实测（2025-12 的日志）：9 个文件 / 211 条计费行 / 10,870,794 token；
> 2026-10-03 复测：**8 个文件 / 149 条 / 7,837,190 token** —— 少掉的那一份是
> **Trae 自己删掉的旧日志**（见 §6 Q4），这条差异本身就是「必须定期入库」的证据。
> 复验命令：`bun run --filter '@ai-token-report/core' verify:trae -- --real`。

---

## 1. 结论先行

| 问题 | 答案 |
|---|---|
| 计费数据在哪 | `<用户数据目录>/logs/<时间戳>/Modular/ai-agent_<n>_<启动ms>_stdout.log` 里带 `token usage: TokenUsageEvent { … }` 的行 |
| 🚨 **当前客户端还写不写** | **不写**（2026-10-03 实测）：模型跑在 Trae 云端（`do_create_cloud_agent_task` / `POST /api/agent/v3/create_agent_task`），本地日志只有工具编排。本适配器覆盖的是**本地编排那一代**（`llm_raw_chat`）。详见 §6 Q9 |
| 一次调用写几行 | **一行**（实测 211 条事件 211 个不同时间戳，没有两条共享时间戳） |
| 四列语义 | **`prompt_tokens` 含 `cache_read` / `cache_creation`** ⇒ `input = prompt - cacheRead - cacheWrite`（与 Codex 同，与 Claude Code **相反**） |
| 幂等键 | `trae:<相对日志根的路径>:<文件内序号>`（两个发行版都是 `trae:` 前缀，靠 `source` 列区分） |
| provider | 常量，与来源同名：`trae` / `trae-cn`（用量事件里**没有**厂商字段） |
| model | 只取事件自带的 `name`；实测**恒为空串** ⇒ 正常落 `(unknown)`（`traeUnnamedEvents` 计数） |
| cwd | **恒为 null**（用量事件不带工作区归属，且一个日志文件会跨多个工作区） |
| 国际 / 国内 | **两个来源**（`trae` / `trae-cn`）：两套安装、两套账号、两套模型族，目录名还推不出对方 |

---

## 2. 实测（本机真实日志）

`bun run --filter '@ai-token-report/core' verify:trae -- --real` 的输出：

| 指标 | 实测值 | 说明 |
|---|---|---|
| 计费日志文件 | 9 → **8** | `logs/*/Modular/ai-agent*_stdout.log`；**少掉的那个是 Trae 自己删的**（见 §6 Q4） |
| 有计费的会话 | 4 → **3** | 另外几个日志只有启动与配置同步，没有 LLM 调用 |
| **计费行 / 调用数** | **211 → 149** | 一行一次调用；两次实测里不同时间戳数都等于条数 |
| **总量** | **10,870,794 → 7,837,190** | `= prompt + completion` 逐条等于上游自报的 `total_tokens` |
| 未缓存输入 | 692,131 → 492,761 | `prompt - cache_read - cache_creation` |
| 输出 | 121,191 → 101,037 | 其中推理 28,224（`reasoning` 是 output 的子集） |
| 缓存读 | 10,057,472 → 7,243,392 | 占总量 **92.5%** |
| 缓存写 | **0** | 全部样本里 `cache_creation_input_tokens` **全是 0**（Trae 的后端没报这一列，字段仍在，照常映射） |
| 缓存命中率 | 93.6% | `cacheRead / (cacheRead + input)`，两次实测相同 |
| 🚨 **不拆缓存的朴素相加** | **20,928,266**（211 条时） | **1.93 倍** —— 这就是「照抄 Claude Code 的映射」会得到的数 |
| 恒等式不符 | 0 | `total == prompt + completion` 逐条成立（211/211、149/149） |
| 缓存重叠（`cache_read + cache_creation > prompt`） | 0 | 最大比值 0.9989 |
| 畸形行 / 重复行 / 零用量 | 0 / 0 / 0 | — |
| `name` 非空 | **0** | 全部样本的 `name` 都是 `""` ⇒ 模型名不可用 |
| 一个日志文件里的工作区数 | 最多 **7** | 所以 `cwd` 不许按「最近一条前置」猜 |

> ⚠️ **第三次复跑（2026-10-03 下午）：本机真实样本已经是 0 条用量行**
> （日志根下只剩当天新建的两个会话目录 —— Trae 会自己清理旧日志，见 §6 Q9）。
> 这时 `--real` 里那条「减法确实生效：总量严格小于不拆缓存的朴素相加」会退化成
> `0 < 0`，**那是样本的问题、不是适配器的问题** —— 哨兵现在按仓内约定
> **如实跳过**它（并打一条观察项说明这一节只验证了「跑不炸」），不再报失败。
> 上表的 211 / 149 条样本与 1.93 倍那条结论仍然成立（它们记录的是当时读到的真实日志），
> 只是**重建不出**：要复核请等真机上再跑出一次 Trae 用量。

两条由上面推出来的实操结论：

1. **`prompt_tokens` 是「含缓存的总输入」**，不只是字段名像 OpenAI，还有三条互相独立的证据：
   ① `total_tokens == prompt_tokens + completion_tokens` 逐条成立（211/211）——
   若 `prompt` 是「未命中部分」，Trae 自报的 `total_tokens` 就会漏掉全部缓存读，
   字段名与恒等式都不可能自洽；
   ② `cache_read ≤ prompt` **无例外**（最大比值 0.9989）—— 含在里面才有的上界；
   ③ 上下文单调增长（21,563 → 22,143 → 23,492 …）而 `cache_read` 紧跟上一次的 `prompt`
   （21,563 的下一次读到 21,888）：前缀缓存的签名就是「缓存读 ⊂ 本次输入」。
2. **累计字段一概不采**：`prompt_tokens_total` / `completion_tokens_total` 是**会话内累计**，
   实测第 3 条事件的 `prompt_tokens_total` = 前 3 条 `prompt_tokens` 之和
   （11,097 + 11,681 + 13,967 = 36,745）。采它 = 总量按平方级膨胀（与 Codex 的累计快照同一条教训）。

---

## 3. 目录与字段

```
<用户数据目录>/logs/
├── <YYYYMMDDTHHMMSS>/Modular/ai-agent_<n>_<启动ms>_stdout.log   ← ★ 唯一含用量的文件
├── <YYYYMMDDTHHMMSS>/Modular/ai-agent_<n>_<启动ms>_stderr.log   ← 同一个进程的 stderr，不含用量
├── <YYYYMMDDTHHMMSS>/Modular/ckg_*_stdout.log                   ← 代码知识图谱子进程，不含用量
├── <YYYYMMDDTHHMMSS>/window*/…                                   ← 窗口与扩展宿主日志，不含用量
└── aha_log/…                                                     ← 客户端自身日志，不含用量
```

`<用户数据目录>`（Electron 的 `userData`）按平台与发行版各自解析：

| 发行版 | 来源 id | Windows | macOS | Linux |
|---|---|---|---|---|
| 国际版 | `trae` | `%APPDATA%\Trae` | `~/Library/Application Support/Trae` | `~/.config/Trae` |
| 国内版 | `trae-cn` | `%APPDATA%\TraeCN` | `~/Library/Application Support/TraeCN` | `~/.config/TraeCN` |

🚨 **目录名推不出对方**，所以两个都各自钉住：

- 家目录下的配置目录是 `.trae` / `.trae-cn`（那里只有 `extensions` 与 `skills`，**没有日志**）；
- 用户数据目录名是 VSCode 系 `product.json` 的 **`nameShort`**：国际版 `Trae`、
  国内版 **`TraeCN`**（既不是 `.trae-cn`，也不是带空格的 `Trae CN`）；
- 国际版的 `dataFolderName` 是 `.trae`、国内版是 `.trae-cn`，而 `nameShort` 却是 `Trae` / `TraeCN`
  —— 拿 `dataFolderName` 去拼用户数据目录，会得到一个**永远不存在**的根，
  而它看起来与「这台机器没装那个发行版」一模一样。

计费行（只列与本项目相关的字段）：

```text
2025-12-02T07:46:05.223268+08:00  INFO ai_agent::domain::model::llm_stream: \
  token usage: TokenUsageEvent { name: "", \
    prompt_tokens: 10527,                 // ★ 含 cache_read / cache_creation
    completion_tokens: 826,               // 含 reasoning_tokens
    total_tokens: 11353,                  // == prompt + completion（恒等式，逐条成立）
    reasoning_tokens: Some(768),          // output 的子集
    cache_creation_input_tokens: Some(0), // 实测恒 0
    cache_read_input_tokens: Some(9472),
    prompt_tokens_total: Some(0),         // ⚠️ 累计值，**不采**
    completion_tokens_total: Some(0) }    // ⚠️ 累计值，**不采**
```

字段映射（实现只在 `sources/trae.ts` 的 `mapTraeUsage()` 一处）：

| 本仓四列 | Trae | 变换 |
|---|---|---|
| `input` | `prompt_tokens` | **减去** `cache_read_input_tokens` + `cache_creation_input_tokens`（夹 0） |
| `output` | `completion_tokens` | 原样 |
| `cacheRead` | `cache_read_input_tokens` | 原样 |
| `cacheWrite` | `cache_creation_input_tokens` | 原样（实测恒 0） |
| `reasoning` | `reasoning_tokens` | `None` / 缺字段 ⇒ 0 |
| `provider` | —— | 常量，与来源同名（`trae` / `trae-cn`） |
| `model` | `name` | 非空时原样；为空 ⇒ `(unknown)` 并计 `traeUnnamedEvents` |
| `cwd` | —— | **恒 null** |

---

## 4. 实现落点

| 文件 | 内容 | 状态 |
|---|---|---|
| `packages/core/src/sources/trae.ts` | 列举 / 折叠 / 四列映射（**唯一语义差异点**）+ 两个发行版的根解析 | ✅ |
| `packages/core/src/sources/registry.ts` | `registerSource(traeSource)` + `registerSource(traeCnSource)` | ✅ |
| `packages/core/src/types.ts` | `SessionSource` 增 `'trae' \| 'trae-cn'`；新增 8 个诊断计数 | ✅ |
| `packages/core/test/trae-source.test.ts` | 合成夹具（32 项） | ✅ |
| `packages/core/verify/verify-trae-format.ts` | 格式哨兵（合成 46 项 + `--real` 9 项） | ✅ |
| `packages/cli/src/cli.ts` | `--source trae\|trae-cn` / `--trae-home(s)` / `--trae-cn-home(s)` / `--no-trae` / `--no-trae-cn`；`--discover` 逐根报 | ✅ |
| `packages/web-local/src/composables/usage-view-model.ts` | 来源展示名 `Trae` / `Trae CN` | ✅ |
| `scripts/test-preload.ts` | 钉住 `DSH_TOKEN_REPORT_TRAE=0` 与 `DSH_TOKEN_REPORT_TRAE_CN=0`（否则 `bun test` 会扫真实 Trae 日志） | ✅ |
| `packages/core/src/sources/{codex,claude-code}.ts` | 顺带接上 `DSH_TOKEN_REPORT_{CODEX,CLAUDE}_HOMES`（**此前只声明、没人读**，而 `--help` 已把它写成可用开关） | ✅ |

**没有**改 schema / 协议 / 路由：本地库的 `source` 列与 `ingestPlainSources()`
（`db/ingest-plain.ts`）在前两轮已就位，Trae 只是又接上一个来源。
`encoding` 复用 `'plain-jsonl'`（该取值表达的是「纯文本逐行日志」，与 zstd 分帧相对；
Trae 的日志是 Rust tracing 文本、不是 JSON，但走的是同一条通路与水印语义，见 `sources/types.ts` 的注释）。

诊断计数（`ScanDiagnostics`，由 `verify:trae` 与后续面板消费；本机实测值）：

| 计数 | 含义 | 本机实测 |
|---|---|---|
| `traeFiles` | 采到的计费日志文件数 | 9 |
| `traeUsageLines` | 认出标记且**可用**（字段齐 + 时间戳可解析）的行数 | 211 |
| `traeMalformedLines` | 认出标记但不可用的行数 | 0 |
| `traeDuplicateEvents` | 整行指纹重复而被跳过的行数 | 0 |
| `traeIdentityViolations` | 四列之和 ≠ 上游自报 `total_tokens` | 0 |
| `traeOverlapAnomalies` | `cache_read + cache_creation > prompt_tokens` | 0 |
| `traeZeroUsage` | 四列全 0 而被跳过的行 | 0 |
| `traeUnnamedEvents` | `name` 为空（模型落 `(unknown)`）的行 | **211** |

⚠️ **`totalEvents` / `eventTypes` 对 Trae 恒为 0/空**：Trae 的日志没有「事件」概念，
把它那 80 万行日志算成事件会让诊断块里的「事件总数」失去意义（真实日志单文件最大 130 MB）。
「扫到了多少」由 `traeFiles` 与 `traeUsageLines` 回答 —— **文件 > 0 而用量行 = 0**
正是「日志文件名或结构变了」的唯一信号。

---

## 5. 坑（按危险程度排序）

1. **🚨 照抄 Claude Code 的「原样」映射 ⇒ 缓存读被算两遍**：本机 211 条实测
   10,870,794 → **20,928,266**（1.93 倍）。两家上游的 `prompt/input` 语义**相反**：
   Trae 含缓存、Claude Code 不含。
2. **🚨 采累计字段 `prompt_tokens_total`** ⇒ 总量按平方级膨胀，且**每一条看起来都合理**
   （它单调递增，画出来的趋势像是「用量在涨」）。
3. **🚨 把国际版与国内版合成一个来源** ⇒ 再也分不开「这个数字是谁的」：
   两套账号、两套模型族、两套计价。合并是**信息被销毁**，不是「看得更简洁」。
4. **🚨 拿 `dataFolderName`（`.trae` / `.trae-cn`）去拼用户数据目录** ⇒ 根永远不存在，
   而输出是「0 条」，和「没装」长得一样。Windows 上是 `%APPDATA%\Trae` 与 `%APPDATA%\TraeCN`。
5. **🚨 拿家目录（`~/.trae` / `~/.trae-cn`）当日志根** ⇒ 那里只有 `extensions` / `skills`，
   同样是一个「看起来正常、实际永远 0 条」的根。
6. **🚨 按「最近一条前置的 `CurrentConfigInfo { config_name: … }` 归属模型」**
   ⇒ 实测 4 个文件里分别有 **7 / 2 / 10 / 24** 条用量事件**前面一条都没有**，
   命中的那些距离最大到 **1,939 行**。单价按 `(provider, model)` 精确匹配，
   记错模型 = 金额**错**且不报错。宁可为 `(unknown)`。
7. **🚨 按「最近一条前置的 `workspace_folder`」归属项目** ⇒ 实测**一个日志文件里出现过 7 个不同工作区**。
   与第 6 条同理：宁可为空。
8. **把 `Modular/` 写死进列举逻辑** ⇒ 上游一旦改目录名就是静默 0 条。实现只按**文件名**
   （`ai-agent*_stdout.log`）筛，不写死中间目录。
9. **把 `_stderr.log` 一起采** ⇒ 同一个进程的两份日志，一旦哪天 stderr 也开始写用量就是双计。
   只认 `_stdout.log`。
10. **测试不钉 `DSH_TOKEN_REPORT_TRAE` / `DSH_TOKEN_REPORT_TRAE_CN`** ⇒ `bun test`
    会连带扫开发者真实的 Trae 日志（本机 9 个文件 / 约 180 MB / 1,100 万 token），
    断言随机器漂移而**不报错**。
11. **`--trae-home` 给的是 `logs` 目录而不是用户数据目录** ⇒ 会得到 `<…>/logs/logs`，
    一个不存在的根（`--discover` 会把它标成 `[✗]`）。验证脚本自己就踩过一次：
    适配器返回 0 条而独立实现返回 211 条 —— **「逐条比对」那条断言当场抓住了它**。

---

## 6. 待决 / 已知缺口

| # | 事项 | 现状 |
|---|---|---|
| Q1 | **模型名拿不到** | 用量事件自带的 `name` 实测恒为空串（211/211）⇒ 模型恒为 `(unknown)`，**这一源配不上单价**（`unpricedRate` 必然是 100%）。日志里确实有 `CurrentConfigInfo { config_name: "gpt-5-medium" }`，但它**不是**每个调用一条（见坑 6），所以不做归属。哪天 `traeUnnamedEvents` 变成 0 就说明上游开始写模型名了 |
| Q2 | **项目归属拿不到** | `cwd` 恒为 null ⇒ 「按项目」维度下 Trae 全落 `(未知)`。理由同 Q1（坑 7）。要按项目拆，只能从**会话快照**（`ModularData/ai-agent/snapshot/<project_id>`）反查，而那是另一种数据源 |
| Q3 | **日志按「进程启动」切，不按会话切** | 会话 id 取相对日志根的路径（`<时间戳>/Modular/ai-agent_<n>_<启动ms>_stdout`），所以一次启动里多轮对话算**一个会话**。日志里的 `session_id` 出现在 `SnapshotFileListInfo` / `SlardarEvent` 等别的 span 里，与用量事件没有稳定关联（实测「最近一条前置」的距离 1~310 行不等），**不猜** |
| Q4 | **日志会被 Trae 清理 —— 已实测（而且很凶）** | 🚨 2026-10-03 当天观察到的两次收缩：① 15:20 启动 Trae 后，当时最大的 `logs/20251201T153127/`（130 MB / **62 条计费行 / 3,033,604 token**）从磁盘消失；② 到 16:05，`logs/` 下**只剩今天那两次启动**（`20261003T152004` / `20261003T152305`）与 `aha_log/`，2025-12 / 2026-05 / 2026-08 的会话**全部没了**，`--source trae` 当场从 149 条掉到 **0 条**（只剩 1 个日志文件、0 条计费行）。结论：**Trae 的日志是短命的**，没入库的用量会随日志一起消失（本地库只是日志的派生物，重扫不回来；回收站里也没有）。所以 Trae 的采集**必须高频**：面板/本地页每次取数都会 ingest（插件面板开着时每 30 秒一轮），或定期跑 `stats` / `report`。**这一条比适配器本身更重要** |
| Q5 | **近实时** | 不做。与 Codex / Claude Code 同结论：本形态是**按需扫描**（`stats` / `report` / 本地页 / `--source trae`） |
| Q6 | **插件实时上报** | 不覆盖。DSH 插件的热路径挂在 DSH 会话事件上，Trae 的用量只能经 CLI 入库 |
| Q7 | **大文件的重解析成本** | 纯文本来源的 L1 水位线是「字节数未变则整份跳过」，一旦变化就**整份重解析**（130 MB / 约 80 万行）。适配器内部用 `indexOf` 直接跳候选行、不逐行 `split`，冷扫 9 个文件约 0.2 s；但**活着的日志每轮都会重解析**，这是刻意的取舍（半路续读会丢掉累计快照那类上下文，与 Codex 同一条教训，见 `db/ingest-plain.ts` 文件头） |
| Q8 | **`totalEvents` / `eventTypes` 对 Trae 恒 0** | 见 §4 末尾。若将来要有「Trae 扫了多少行」的面板指标，应当新增计数而不是把这个通用字段填成行数 |
| Q9 | **当前 Trae 客户端的用量不在本地 —— 已确认（2026-10-03）** | 🚨 本机 3.3.2 那次会话**确实聊过**（`handle_ipc_connection:route:chat` **155** 行、`[ChatService] chat start` / `create message` / `ChatPromptBuilder`、`stream` 64 行），但：`do_create_cloud_agent_task` **83** 次、`cloud_agent` **86** 次、HTTP 打的是 `POST /api/agent/v3/create_agent_task` 与 `/api/agent/v3/{query,sync}_history_state`，而 **`llm_raw_chat` 0 次、`TokenUsageEvent` 0 行**。⇒ **模型在 Trae 的云端跑，本地进程只做工具编排**，token 用量从头到尾没有落到本地（`Modular/*.alaudalog` 是列式压缩的二进制日志，`ModularData/ai-agent/database.db` 是加密的）。本适配器覆盖的是**本地编排那一代**（Builder/Chat v3 的 `llm_raw_chat`，也就是本机 3.2.2 / 3.3.0 的 211 条样本）。**这不是 bug，是数据不在本地** —— 与「日志会被删」是两件独立的事 |
| Q10 | **多客户端上报（部门看板）** | **未接通**。`report` 只扫 DSH 的会话根（`runReportCommand(opts, paths.sessionsRoots)`），`--source` / `--no-*` 对它无效 —— 所以 Trae / Codex / Claude Code / WorkBuddy 的用量**进不了上报库**，看板上自然也没有。接通它要把 `report.ts` 从 `scanIncremental`（DSH 的帧级水位线）扩到 `scanAllSources`，属于另一轮改动 |
| Q11 | **（若将来仍要 Trae 的数据）** | 本地日志这条路的两个前提都被推翻了：日志会被删（Q4）+ 当前客户端不往本地写用量（Q9）。剩下的来源只有 **Trae 账号用量页 / 接口**（服务端口径、按天或按积分，**不是**逐次四列 token）—— 那会是一个**新来源形态**（拉取式、而非日志式），需要先确认口径再动手（见 §8 末） |

---

## 7. 验收命令

```bash
# 格式哨兵：合成夹具（46 项）+ 本机真实日志只读复验（9 项，需要本机有 Trae）
bun run --filter '@ai-token-report/core' verify:trae
bun run --filter '@ai-token-report/core' verify:trae -- --real

# 单测
bun test packages/core/test/trae-source.test.ts

# 本机有哪些来源目录（逐根报会话数 / 最新写入 / 是否存在）
bun run stats -- --discover

# 只统计 Trae（国际版）；库路径与直扫路径必须给出同一个数
bun run stats -- --source trae --by model
bun run stats -- --source trae --by model --no-db

# 两个发行版一起统计（表格自动多一列「来源」）
bun run stats -- --source trae --source trae-cn --by source-provider-model
```

实测（本机 Trae 国际版）：

- 2025-12 的日志（首次实测）：**211 次调用 / 10,870,794 token**，缓存读 10,057,472（占 92.5%）、命中率 93.6%；
- 2026-10-03 复测：**149 次调用 / 7,837,190 token** —— 差额全部来自 Trae 自己删掉的那一个旧日志（见 §6 Q4）；
- 2026-10-03 傍晚：**0 条** —— Trae 把当天之前的会话目录**全删了**（见 §6 Q4）。
  这正是「必须高频采集」的现场证据：适配器没问题，**数据源是短命的**。
- 三次实测里模型恒为 `(unknown)`。

**四个形态各自能不能看到 Trae**（2026-10-03 实测 + 当天补齐的取数改动）：

| 形态 | 能否看到 Trae | 说明 |
|---|---|---|
| CLI `--source trae` / `--source all` | ✅ | 库路径与直扫路径同数 |
| CLI **缺省**（不给 `--source`） | ✅（2026-10-03 起） | 缺省已翻成**全部已注册来源**（想回到旧口径：`--source dsh`）。逐个去掉用 `--no-trae` 或 `DSH_TOKEN_REPORT_TRAE=0` |
| 本地页面 `/api/local/*`（`bun run web`） | ✅ | 一直按 `resolveSourceRoots()` **全部来源**取数 |
| **DSH 插件面板** | ✅（缺省就算，也一起上报） | 面板、`token_usage` 工具与**历史补报**都按 `resolveSourceRoots()` 的**全部已注册来源**取数，**不需要任何配置**（0.8.0 起；旧的 `extraSources` 白名单已废弃，写了会在启动日志里告警）。代价是首次取数与首轮补报要冷扫那些日志（本机 Codex 有 1,495 个文件 / 2.8 GB），之后按文件字节数增量；要收窄只能用来源自己的环境开关（`DSH_TOKEN_REPORT_TRAE=0`） |
| 部门看板 | ❌（未接通） | `report` 只按 DSH 的会话根扫描（`runReportCommand(opts, paths.sessionsRoots)`），`--source` 对它无效 —— 多客户端上报还没接（见 §6 Q10） |

⚠️ `packages/cli/dist/cli.js`（发布产物）与源码**不是同一份东西**：它是构建时刻的快照，
源码里加了来源之后必须重新 `bun run --filter '@ai-token-report/cli' build:npm`，
否则用产物跑 `--source trae` 会得到「未注册的来源：trae」（2026-10-03 实测：旧产物里
「trae」出现 **0** 次，重建后 **90** 次）。

---

## 8. 运维：三条必须记住的事实（2026-10-03 现场踩过）

**① `--source trae` 显示 0，先看「本机还有没有用量日志」，不要先怀疑适配器。**
链路本身当场可证（`bun run .tmp/trae-demo.ts` 造一份真形状夹具后）：

```bash
# 冷跑：ingest → 库；热跑：读库。两轮必须同数
bun run stats -- --source trae --trae-home <夹具>/Trae --data-dir <夹具>/data --by model
# → 2 次调用 / 27,666 token（未缓存输入 5,859 / 缓存读 20,736 / 命中率 78.0%）
```

终端里那句 `本地库 …（0 条记录）` 与诊断块的 `库内记录 0` 都是**按当前筛选**算的 ——
`--source trae` 时它们只回答「库里有多少**属于 trae** 的行」，**不是**整库行数
（实测同一时刻整库有 10,351 行别的来源）。真正的判断依据是直扫的
`计费事件` / `traeUsageLines`：文件在、行数 0 ⇒ 本机确实没有 Trae 用量日志。

**② Trae 的日志会被它自己删掉，所以采集必须高频 —— 而「本地库版本抖动」会把已采到的 Trae 行吃掉。**
本地库（`usage.sqlite`）的版本由**正在跑的那个客户端**决定：一个还在跑的**旧版 DSH**
（它的 `DB_SCHEMA_VERSION` 是旧的）每次取数都会把库**重建**回旧版本，而新代码下一次又建回来。
其它来源的行能在重建后从日志重扫回来，**Trae 的行不能** —— 它的日志那时已经不存在了。
所以：**升级插件后第一件事是重启 DSH**，让它加载新 bundle（`packages/dsh-plugin/lib/*`；
不重启的表现是「面板里还是旧口径」+ 库在 v3/v4 之间来回抖）。

**③ 想让 Trae 的用量稳定留下来，只有一条路：在日志还活着的时候 ingest。**
可行的三种频率（从密到疏）：插件面板开着（30 秒一轮；0.8.0 起缺省就含全部来源，
不必再配 `extraSources`）→
计划任务跑 `bun run stats -- --source trae`（分钟级）→ 每次用完 Trae 手动跑一次。
**没有**任何「事后补采」的办法：日志没了就是没了（§6 Q4 的现场记录）。

**④ 但先确认「本机到底有没有 Trae 的用量」——当前客户端很可能一条都不写。**
2026-10-03 实测：3.3.2 的会话走**云端 agent**（`do_create_cloud_agent_task` 83 次、
`POST /api/agent/v3/create_agent_task`、`llm_raw_chat` **0** 次）⇒ 本地日志里没有任何用量行。
判断只需一条命令（脚本在 `.tmp/trae-check.ts`，逐文件列「大小 / 计费行 / chat 行 / llm 行」）：

```bash
bun run .tmp/trae-check.ts
# 计费行 > 0  ⇒ 直接采：bun run stats -- --source trae --by model
# chat > 0 而计费行 = 0 ⇒ 当前客户端不往本地写用量（Q9）——本地这条路到此为止
# chat = 0 ⇒ 还没聊过，先在 Trae 里聊一轮再看
```

若结论是第二种，**不要再等它**：本地日志拿不到就是拿不到（`.alaudalog` 是列式压缩、
`database.db` 是加密的）。要 Trae 的数据只能换形态 —— 拉 Trae 账号的用量页/接口，
那是**按天或按积分**的口径，与「逐次四列 token」不是一回事，需要先定口径再动手（Q11）。
