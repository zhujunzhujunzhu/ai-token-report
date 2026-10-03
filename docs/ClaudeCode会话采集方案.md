# Claude Code 会话采集方案

> 状态：**P0 + P1 + P2 已落盘并实跑**（格式哨兵 / 来源适配器 / 本地库与直扫两条路径同一个数）。
> 上报体（P3）与看板来源维度（P4）沿用 Codex 那一轮，不在本文件重复。
> 口径结论全部来自**本机真实日志**（`~/.claude/projects`，9 个会话 / 21 MB / 1,114 条计费行），
> 复验命令：`bun run --filter '@ai-token-report/core' verify:claude-code -- --real`。

---

## 1. 结论先行

| 问题 | 答案 |
|---|---|
| 计费数据在哪 | `~/.claude/projects/<项目目录名>/<session-uuid>.jsonl` 里 `type:"assistant"` 且 `message.usage` 存在的行 |
| 幂等键 | `claude-code:<sessionId>:<message.id>`（**不是**行 `uuid`，也不是行号） |
| 一次调用写几行 | **1 ~ 4 行**，`message.id` 相同、`uuid` 各不相同 ⇒ **不去重则总量正好翻倍**（实测 63,842,793 → 126,348,873） |
| 四列语义 | 与 DSH **一致**（`input_tokens` 已是未命中缓存那部分）⇒ **不做减法**（与 Codex 相反） |
| 缓存写入分档 | `cache_creation.{ephemeral_1h,ephemeral_5m}_input_tokens` 是**定价分档**，之和恒等于 `cache_creation_input_tokens`（实测 0 处不符）⇒ 不单独成列 |
| provider | 常量 `anthropic`（行里只有 `message.model`，没有厂商字段） |
| 子代理 | 转写文件与父会话**共用 sessionId**、但 `message.id` 是各自的真实调用 ⇒ 正常折叠即可，**不能**按 sessionId 合并文件 |

---

## 2. 实测（本机真实日志，2026-06）

`bun run --filter '@ai-token-report/core' verify:claude-code -- --real` 的输出：

| 指标 | 实测值 | 说明 |
|---|---|---|
| 会话文件 | 9 | 全部形如 `<uuid>.jsonl` |
| 事件总数 | 4,716 | `attachment` 2,498 / `assistant` 1,117 / `user` 629 / `last-prompt` 306 / … |
| **计费行** | **1,114** | `assistant` 1,117 减去 3 条 `<synthetic>` |
| **去重后调用** | **551** | 重复行 **563**（朴素相加 = 2.0×） |
| `message.id` 缺失 | 0 | 1,114 行全部有 |
| 重复行用量分歧 | **0** | 同一次调用的多行四列逐字节相同 |
| 恒等式不符 | 0 | `total = input + output + cacheRead + cacheWrite` 逐条成立 |
| 分档之和不符 | 0 | `ephemeral_1h + ephemeral_5m == cache_creation_input_tokens` |
| 缺模型名 / 缺 cwd | 0 | — |
| 模型 | `claude-opus-4-8` / `claude-sonnet-4-6` / `claude-opus-4-7` | — |

两条由上面推出来的实操结论：

1. **重复行不保证相邻** —— 实测最大间隔 **21 行**、241 处的间隔 > 1。
   「跳过连续重复」的写法在这里是错的，必须按 `message.id` 记住整份文件。
2. **「首次获胜」与「末次获胜」等价**（分歧 0 处）。实现选**首次获胜**：与全仓
   `event_id` 主键「先到者胜」一致，也不依赖「同文件后面还有没有别的东西」。

---

## 3. 目录与字段

```
$CLAUDE_CONFIG_DIR（缺省 ~/.claude）/projects/
├── <项目目录名>/<session-uuid>.jsonl               ← 会话（一个文件一次会话）
├── <项目目录名>/subagents/agent-<hash>.jsonl       ← 子代理转写（文件名不是 uuid）
├── <项目目录名>/<session-uuid>/subagents/…         ← 另一种子代理布局
├── <项目目录名>/memory/*.md                        ← 不是 jsonl
└── …/subagents/workflows/<wf-id>/journal.jsonl     ← 工作流控制文件（无用量）
```

计费行（只列与本项目相关的字段）：

```jsonc
{
  "type": "assistant",
  "timestamp": "2026-06-12T15:45:54.454Z",
  "cwd": "D:\\Coding_agent\\demo",
  "sessionId": "1bbad279-…",          // ⚠️ 与文件名不一致时**以文件名为准**（见 §5 坑 5）
  "uuid": "d2817fcb-…",               // ⚠️ 每行都不同，**不能当幂等键**
  "message": {
    "id": "msg_0169Tu1SuTwEqpnmS3k8mwNL",   // ★ 一次 API 调用的身份
    "model": "claude-opus-4-8",
    "usage": {
      "input_tokens": 16166,                 // 已是「未命中缓存」那部分
      "output_tokens": 301,
      "cache_read_input_tokens": 0,
      "cache_creation_input_tokens": 26795,
      "cache_creation": { "ephemeral_1h_input_tokens": 26795, "ephemeral_5m_input_tokens": 0 }
    }
  }
}
```

字段映射（实现只在 `sources/claude-code.ts` 的 `mapClaudeUsage()` 一处）：

| 本仓四列 | Claude Code | 变换 |
|---|---|---|
| `input` | `message.usage.input_tokens` | **原样**（已是未命中部分） |
| `output` | `message.usage.output_tokens` | 原样 |
| `cacheRead` | `message.usage.cache_read_input_tokens` | 原样 |
| `cacheWrite` | `message.usage.cache_creation_input_tokens` | 原样（**不拆** 1h/5m 分档） |
| `reasoning` | —— | 恒 0（Claude Code 不单列；`output_tokens` 已含思考） |
| `provider` | —— | 常量 `anthropic` |
| `model` | `message.model` | 原样；`<synthetic>` 行整行跳过 |

---

## 4. 实现落点

| 文件 | 内容 | 状态 |
|---|---|---|
| `packages/core/src/sources/claude-code.ts` | 列举 / 折叠 / 四列映射（**唯一语义差异点**） | ✅ |
| `packages/core/src/sources/registry.ts` | `registerSource(claudeCodeSource)` | ✅ |
| `packages/core/src/types.ts` | `SessionSource` 已含 `'claude-code'`；新增 7 个诊断计数 | ✅ |
| `packages/core/test/claude-code-source.test.ts` | 合成夹具（26 项） | ✅ |
| `packages/core/verify/verify-claude-code-format.ts` | 格式哨兵（合成 15 项 + `--real` 7 项） | ✅ |
| `packages/cli/src/cli.ts` | `--source claude-code` / `--claude-home(s)` / `--no-claude-code`；`--discover` 逐根报；`sourceHomes` 收成一张表 | ✅ |
| `packages/server/src/index.ts` | 本地页的 `resolveSourceRoots()` 现在**跟着调用方给的 `dshHomes` 走**（原先只喂给 `resolvePaths()`，页面会去读缺省 home，数字与同进程的 CLI 对不上） | ✅ |
| `scripts/test-preload.ts` | 钉住 `DSH_TOKEN_REPORT_CLAUDE=0`（否则 `bun test` 会扫真实 `~/.claude`） | ✅ |
| `packages/cli/verify/verify-npm-package.ts` | spawn 子进程时必须自己钉住**全部来源开关**（preload 不被 `Bun.spawn` 继承；不钉的话 web 会扫真实 `~/.claude` 并写进 fixture 的库，差 4 倍且看起来像口径 bug） | ✅ |

**没有**改 schema / 协议 / 路由：本地库的 `source` 列与 `ingestPlainSources()`
（`db/ingest-plain.ts`）在 Codex 那一轮已就位，Claude Code 只是又接上一个来源。

诊断计数（可在 `verify-claude-code` 与后续面板里看到）：

| 计数 | 含义 | 本机实测 |
|---|---|---|
| `claudeFiles` | 采到的文件数 | 9 |
| `claudeDuplicateWrites` | 🚨 被 `message.id` 去重吸收的行数 | 563 |
| `claudeAssistantWithoutUsage` | 没有 usage 的 assistant 行 | 0 |
| `claudeSyntheticRows` | `<synthetic>` 行 | 3 |
| `claudeZeroUsage` | 四列全 0 而被跳过的行 | 0 |
| `claudeIdentityViolations` | 上游自报 `total_tokens` 与四列不符 | 0（该字段当前不存在 ⇒ 不校验） |
| `claudeMissingModel` | 缺模型名的计费行 | 0 |

---

## 5. 坑（按危险程度排序）

1. **🚨 不去重 ⇒ 总量正好翻倍**。这是最容易被「看起来很正常」掩盖的一条：
   数字是整数倍、没有报错、每个模型都同比放大。幂等键必须是 `message.id`。
2. **🚨 拿行 `uuid` 当幂等键** ⇒ 完全不去重（同一次调用的每行 uuid 都不同）。
3. **🚨 照抄 Codex 做 `input - cacheRead - cacheWrite`** ⇒ 输入变负 / 恒等式不成立。
   两家上游的 `input_tokens` 语义**相反**：Codex 含缓存，Claude Code 不含。
4. **🚨 「跳过连续重复」** ⇒ 实测重复行最大间隔 21 行，241 处不相邻。
5. **文件名才是会话身份**：`sessionId` 字段可能指向别的会话（续写 / 分叉），
   与 Codex 的信封 `session_id` 是同一条教训。
6. **`.jsonl` 一网打尽** ⇒ `agent-<hash>.jsonl`（子代理）与 `journal.jsonl`（工作流控制文件）
   会被算进某个真实会话或凭空产生一个来源。只认文件名就是 uuid 的那些。
7. **`<synthetic>` 也采** ⇒ 那 3 条是 Claude Code 自造的消息，不是 API 调用。
8. **把 1h/5m 缓存分档摊成两列** ⇒ 全仓四列口径分叉（且恒等式要重写）。
9. **测试不钉 `DSH_TOKEN_REPORT_CLAUDE`** ⇒ `bun test` 连带扫开发者真实的 `~/.claude`
   （本机 9 个文件 / 21 MB），断言漂移而**不报错**。
10. **根既可以是目录、也可以是一个文件**：`readdir()` 对文件路径抛 `ENOTDIR`，
    被 `catch` 吞掉之后就是**一份空列举** —— 验证脚本会「全部比对通过（0 条）」。
    实现里 `listSessionJsonl()` 显式分流（这条是被 `--real` 当场抓出来的）。

---

## 6. 待决 / 已知缺口

| # | 事项 | 现状 |
|---|---|---|
| Q1 | **近实时**（Claude Code 有 hooks：`SessionStart` / `PostToolUse` / `Stop` / `SessionEnd`） | 不做。与 Codex 同结论：hook 输入里没有 token 用量，只能触发一次增量采集；本形态是**按需扫描**（`stats` / `report` / 本地页） |
| Q2 | **插件实时上报** | 不覆盖。DSH 插件的热路径挂在 DSH 会话事件上，Claude Code 的用量只能经 CLI 入库（`--source claude-code` / `--source all`） |
| Q3 | **重复行若将来真的开始分歧** | 当前「首次获胜」。若哪天 `claudeDuplicateWrites` 与「四列分歧」同时非 0，需要重新评估是否改成「末次获胜」——`verify-claude-code -- --real` 会把这条打成**观察项** |
| Q4 | **子代理按父会话归属** | 子代理转写文件的 `sessionId` 与父相同 ⇒ 会话数会把父子算成一个。这对「用量」没有影响；若要按 agent 拆分，需要从路径取 `<parent_uuid>/<child_suffix>`（未做） |
| Q5 | **Claude Code 的 provider 归一** | 记常量 `anthropic`。若将来要做「同一模型经代理跑」的区分，走既有的 `provider_alias` 查询期归一（不要改采集期值） |

---

## 7. 验收命令

```bash
# 格式哨兵：合成夹具（15 项）+ 本机真实日志只读复验（7 项，需要本机有 ~/.claude）
bun run --filter '@ai-token-report/core' verify:claude-code
bun run --filter '@ai-token-report/core' verify:claude-code -- --real

# 单测
bun test packages/core/test/claude-code-source.test.ts

# 本机有哪些来源目录（逐根报会话数 / 最新写入 / 是否存在）
bun run stats -- --discover

# 只统计 Claude Code；库路径与直扫路径必须给出同一个数
bun run stats -- --source claude-code --by model
bun run stats -- --source claude-code --by model --no-db

# 全部来源（DSH + Codex + Claude Code），表格会自动多一列「来源」
bun run stats -- --source all --by source-provider-model
```

实测（本机 2026-06，Claude Code 部分）：**551 次调用 / 63,842,793 token**，
库路径 85 ms、直扫路径同数；缓存读 61,927,515（占 97.0%）。
