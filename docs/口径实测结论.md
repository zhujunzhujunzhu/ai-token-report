# 「DSH 数字集团 token 统计」口径梳理

> 本文回答一个问题：**要把「数字集团」（阿里云 `dashscope` 网关）的 token 用量统计出来，到底该统计哪些数、从哪统计、边界在哪。**
> 所有数字来自本机 156 个真实会话日志的实测解码（61.43 MB，61,860 事件，9,845 条带 usage 的 assistant/message），不是推测。

---

## 0. 一句话结论

统计对象是**每一条 `assistant/message` 事件里的 `data.usage`**，归属字段是 `data.message.source.provider == 'dashscope'`。
**不要**用 `ctx.tokenMeter`，它是每 token 4 字符的启发式估算，官方明确定义为「不是计费数据」。

真正的统计难点不在取数，而在三件事：**口径拆分（cache 不能混进 input）、去重（重试会重复计费）、归属（DSH 原生不提供「谁」）**。

---

## 1. 统计对象：唯一权威数据源

### 1.1 计费级数据只有一处

| 候选数据源 | 性质 | 能不能用作计费统计 |
|---|---|---|
| **`assistant/message` → `data.usage`** | **provider 真实上报值** | ✅ **唯一权威源** |
| `ctx.tokenMeter.measure()` | 启发式估算（4 字符/token） | ❌ 官方原文：「不是计费数据」 |
| `tokenUsage` 投影 | 由上面 usage 折叠而来 | ⚠️ 可作对账，不另开局 |
| `sessionStats` 投影 | 轮次/步数/墙钟时间，**不含 token** | ❌ 无 token 字段 |
| 网关侧账单 | 阿里云控制台 | ✅ 用于**对账**，不用于明细归因 |

`dsh-token-meter` 的 README 写得很直白：

> 「占用是参考数字，不是计费记录」「固定每 token 四字符启发式规则会低估 CJK 文本与 JSON schema」
> 「当部署需要精确到计费级别的计数时，使用提供方分词器」

所以：**meter 只适合做 UI 占用显示，绝不适合做部门用量考核。**

### 1.2 字段结构（源码实证）

类型定义来自 `@deepseek-ai/dsh-llm`：

```ts
export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  totalTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}
```

### 1.3 实测样本

```json
{
  "type": "assistant/message",
  "seq": 16,
  "time": 1789984019944,
  "data": {
    "turn": 1,
    "step": 1,
    "message": { "source": { "kind": "model",
                             "provider": "dashscope",
                             "model": "deepseek-v4.1-flash" } },
    "usage": { "inputTokens": 7772, "outputTokens": 186,
               "totalTokens": 8982, "cacheReadTokens": 1024 }
  }
}
```

三个关键点：
- `data.usage` —— 计费数值
- `data.message.source.provider` —— **归属「数字集团」的判定字段**
- `seq` —— 会话内单调序号，**天然幂等键**

---

## 2. 口径问题：最容易算错的地方（实测数据）

### 2.1 计费恒等式（已全量验证）

9,845 条样本**无一例外**满足：

```
totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens
```

实测：9,845 条全部相等，0 条不等，0 条缺字段。**这条恒等式可以直接用来做落库时的数据质量断言。**

### 2.2 `inputTokens` 已经是「未命中缓存」的部分

这是最容易搞错的一点。实测 dashscope 数据：

| 项目 | 数值 |
|---|---|
| calls | 2,162 |
| `inputTokens` | 11,561,323 |
| `outputTokens` | 1,815,109 |
| `cacheReadTokens` | 222,614,912 |
| `cacheWriteTokens` | 0 |
| `reasoningTokens` | 0（该 provider 从不下发此字段） |
| **计费总量 `in+out+cr+cw`** | **235,991,344** |
| **缓存读占比** | **94.3%** |

⚠️ **如果把 `cacheReadTokens` 再加回 `inputTokens`（误以为 input 是「含缓存的输入」），会虚增 20.3 倍。**
反过来说：**如果只报 `input + output`（朴素口径 13,376,432），会漏掉 94.3% 的真实用量。**

`dsh-token-meter` 的投影键名 `uncachedInputTokens` 正是为了强调这一点——**input 是不含缓存的那部分**。

### 2.3 三个口径必须同时上报，不要合成一个数

| 口径 | 公式 | 实测值 | 用途 |
|---|---|---|---|
| 计费总量 | `in+out+cr+cw` | 235,991,344 | 对外报总量 |
| 非缓存输入 | `in` | 11,561,323 | 成本主要变量 |
| 缓存命中率 | `cr/(cr+in)` | 94.3% | 成本优化杠杆 |
| 输出 | `out` | 1,815,109 | 单价最贵的一项 |

**强烈建议落库存 4 个独立列，展示时再按需相加。** 一旦在采集端就合并，后续任何拆分口径都无法还原。

---

## 3. 去重问题：重试与 attempt

### 3.1 实测发现

```
assistant/attempt  87 条   ← 带 usage 的: 0 条
llm/retry          54 条
llm/retry-started  54 条
```

**关键结论：`assistant/attempt` 不含 `usage` 字段（只有 `turn`/`step`/`stream`）。**
所以：

- ✅ **不存在「同一次尝试被计两次」的风险** —— 计费只认 `assistant/message.usage`，一条就是一次计费
- ⚠️ 但 `llm/retry-started` 会开启新的计费区间 —— `dsh-token-meter` README 明确说：「`llm/retry-started` 会结束该替换范围，因此同一步骤中的重试会贡献另一次计费用量」
- 📊 54 次重试 / 2,162 次调用 ≈ **2.5% 的调用是重试**

### 3.2 唯一需要的幂等键

```
event_id = `${session.id}:${event.seq}`
```

用它可以：
- 客户端重试安全（at-least-once）
- outbox 崩溃重放安全
- 后台 `INSERT ... ON CONFLICT DO NOTHING` 天然去重

`dsh-session-telemetry` 官方也建议接收方按 `(session.id, session.format_version, event.seq)` 去重——**与我们的幂等键设计一致，可直接沿用**。

---

## 4. 边界问题：「数字集团」到底指什么范围

这是**最需要先确认**的一件事，因为它决定统计口径的分母。

### 4.1 实测：本机有 4 个 provider，数字集团只是其中之一

| provider | calls | input | output | cacheRead | 缓存命中 |
|---|---|---|---|---|---|
| deepseek-official | 7,309 | 9,424,283 | 5,517,522 | 1,018,293,888 | 99.1% |
| **dashscope（数字集团）** | **2,154** | **11,544,221** | **1,810,746** | **221,936,640** | **95.1%** |
| deeprouter | 332 | 6,418,016 | 104,270 | 27,619,819 | 81.1% |
| tokenrun | 46 | 1,143,654 | 14,298 | 1,633,544 | 58.8% |

按 token **总量**看，`deepseek-official` 是最大头（约 10.3 亿）；
按 **计费口径**看，`dashscope` 是 2.36 亿。

> ⚠️ **必须明确「数字集团 token」是指**：
> - (a) 只算走 `dashscope` 网关的流量 → `provider == 'dashscope'`，2,154 次调用
> - (b) 指「数字集团这个部门的员工用的所有 token」→ **全部 provider，需要按人归属**
>
> 这两个口径差别巨大（2.36 亿 vs 全部约 10 亿+）。**建议在开工前书面确认。**

### 4.2 dashscope 按天实测

| 日期 | calls | input | output | cacheRead |
|---|---|---|---|---|
| 2026-09-18 | 621 | 3,400,296 | 563,635 | 63,090,688 |
| 2026-09-19 | 1,200 | 6,132,859 | 980,310 | 141,093,632 |
| 2026-09-20 | 69 | 505,699 | 71,531 | 3,499,904 |
| 2026-09-21 | 264 | 1,505,367 | 195,270 | 14,252,416 |

### 4.3 模型维度实测

```
dashscope/deepseek-v4.1-flash   2,150 calls
dashscope/qwen3.6-plus              4 calls
```

模型 ID 直接取自 `data.message.source.model`，可用于分模型计价。

---

## 5. 归属问题：DSH 不提供「谁」

### 5.1 硬约束（官方原文）

`@deepseek-ai/dsh-anonymous-user-id` README：

> 「**随机生成，绝不派生。** id 来自 `crypto.randomUUID()`；绝不从 hostname、网络地址、git remote 或任何其他可识别来源派生」
> 「**不要用它来识别用户**，也不要用它关联不同 home 之间的记录」

即 `~/.dsh/.anonymous-user-id` **只能做「同一台安装」的关联，不能做人员归属**。

### 5.2 三条可选路径

| 方案 | 做法 | 评价 |
|---|---|---|
| **A. 客户端署名** | 插件 config / 环境变量写 `user.id` | 简单可控，**建议起步**；可被篡改 |
| **B. 终端反查** | 上报带匿名 id + 主机名，后台维护映射表 | 客户端零配置；涉及终端标识，需合规 |
| **C. 网关侧计量** | 全员走同一网关，网关按 key 计费 | **数据最准、无法绕过**；前提是流量都走网关 |

### 5.3 关于方案 C 的实测提示

`settings.yaml` 中 `dashscope` 的 `apiKeyEnv: DASHSCOPE_API_KEY` —— **全员共用同一个环境变量名**。
如果每人的 key 不同，**阿里云控制台侧的费用数据就是一份天然的、无法篡改的真值**，
只要在后台按 key ↔ 人做一次映射即可。

> 💡 **这是最值得先做的一步**：去阿里云控制台看「数字集团」这个网关的账单能不能导出按 key / 按天的明细。
> 如果能，**你甚至不需要写插件就能先拿到部门总量的真值**，插件只用来补「明细归因」。
> 建议优先验证这条路，成本远低于自建链路。

---

## 6. 三条统计路径对比

| 路径 | 数据来源 | 覆盖范围 | 是否需要插件 | 适用场景 |
|---|---|---|---|---|
| **① 网关账单** | 阿里云控制台 | 该网关全部流量 | ❌ 不需要 | **总量对账 / 起步** |
| **② 本地日志扫描** | `~/.dsh/sessions/**/session.v3.jsonl.zstd` | 仅本机 | ❌ 不需要 | **P0 验证口径**、历史回溯 |
| **③ 插件实时上报** | `SessionTelemetryBackend` | 装了插件的机器 | ✅ 需要 | 多机明细归因、看板 |

**推荐组合**：**① 做总量真值 + ③ 做明细归因 + ② 做历史补齐与对账**。

三者交叉验证：`①总量 ≈ Σ③明细`，差额就是「未装插件/绕过客户端」的部分——**这个差额本身就是最有价值的监控指标**。

### 6.1 路径 ② 的技术要点（已实测可用）

日志是 **zstd 分帧追加**，需按 magic `28 B5 2F FD` 逐帧解压：

```js
import { zstdDecompressSync } from 'node:zlib'   // Node 原生支持，已验证
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
// 定位所有 magic 偏移 → 逐帧解压 → 拼接为 JSONL
```

本次梳理就是用它跑出来的（当时的探针脚本 `p0-verify/probe.mjs` 已完成使命，
随迁移一并删除；等价的正式实现在 `packages/core/src/decode.ts`）。

### 6.2 路径 ③ 的技术要点

插件 = **一个 `SessionTelemetryBackend` 实现**，复用 DSH 已有的捕获链路：

```
session/event (同步热路径)
      ↓
SessionTelemetryCoordinator（过滤 + 深拷贝 + 脱敏瀑布）
      ↓
emit(record) ← 必须非阻塞入队！（同步调用，不能 await fetch）
      ↓
内存队列 → 聚合 → 批量 HTTP POST → 后台
```

⚠️ **四个硬约束**：
1. `emit()` 在热路径同步执行，**只能入队**，任何 `await fetch` 都会拖慢 agent loop
2. **同一时刻只能挂载一个 telemetry 后端**（重复加载抛错）→ 与自带 OTel 后端互斥
3. 投递是 **best-effort**：游标记的是「已交出」不是「已送达」→ **必须自建磁盘 outbox**
4. `sessionTelemetry/record` 瀑布**默认不脱敏**，记录会原样带出文件内容与命令输出 → 必须自己挂脱敏规则

---

## 7. 落地建议：按此顺序做

| 阶段 | 动作 | 成本 | 产出 |
|---|---|---|---|
| **P0** | 跑只读探针（`p0-verify/probe.mjs`，已删除）确认口径 | 已完成 | 口径 ✅ |
| **P1** | 确认「数字集团」边界 (§4.1 a/b) | 半天 | **口径决策** |
| **P2** | 查阿里云控制台能否导出按 key 的账单 | 半天 | **可能省掉整个插件** |
| **P3** | 插件：backend + 队列 + outbox + 身份 | 1~2 天 | 明细上报 |
| **P4** | 后台：接收 + 幂等落库 + 每日聚合 | 1~2 天 | 可查询 |
| **P5** | 看板 + 三方对账 | 1~2 天 | 可运营 |

> **P2 优先级应该高于 P3** —— 如果网关侧能出账单，插件就不再是「唯一数据源」，而是「归因补充」，
> 整体风险与工作量都大幅下降。

---

## 8. 看板指标（口径已定）

| 指标 | 公式 | 实测参考值 |
|---|---|---|
| 总量 | `Σ(in+out+cr+cw)` | 235,991,344 |
| 缓存命中率 | `cr/(cr+in)` | **94.3%** ← 成本优化最大杠杆 |
| 非缓存输入 | `Σ in` | 11,561,323 |
| 输出 | `Σ out` | 1,815,109 |
| 重试率 | `retry/(retry+calls)` | ≈ 2.5% |
| 人均用量 | 按 `user.id` 聚合 | 需先解决 §5 |
| 模型分布 | `group by model` | 99.8% 是 `deepseek-v4.1-flash` |
| 未归属占比 | `user_id='unknown'` 比例 | 监控采集覆盖率 |
| **网关-明细差额** | `① - Σ③` | **最有价值的监控项** |

---

## 9. 层建议表结构（口径对齐 §2.3）

```sql
CREATE TABLE token_event (
  event_id     TEXT PRIMARY KEY,   -- sessionId:seq，幂等键
  session_id   TEXT NOT NULL,
  seq          INTEGER NOT NULL,
  ts           INTEGER NOT NULL,   -- epoch ms
  user_id      TEXT NOT NULL,
  provider     TEXT,               -- 'dashscope' = 数字集团
  model        TEXT,
  input_tokens       INTEGER NOT NULL DEFAULT 0,  -- 未命中缓存
  output_tokens      INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens   INTEGER NOT NULL DEFAULT 0,
  total_tokens       INTEGER NOT NULL DEFAULT 0,  -- 校验用
  cwd          TEXT,
  turn         INTEGER,
  step         INTEGER,
  created_at   INTEGER NOT NULL
);
```

**写入时断言**（对应 §2.1 恒等式）：

```sql
CHECK (total_tokens = input_tokens + output_tokens
                     + cache_read_tokens + cache_write_tokens)
```

---

## 附：确认清单（开工前需拍板）

1. ☐ 「数字集团 token」= 只算 `dashscope` 流量，还是算数字集团**员工**的全部流量？
2. ☐ 阿里云控制台能否导出按 API key / 按天的用量明细？（**决定要不要写插件**）
3. ☐ 人员归属走方案 A（客户端署名）还是 C（网关 key 映射）？
4. ☐ 合规：明确「只采集 token 数值 + 模型名，不采集对话内容」（`includeContent: false`）
5. ☐ 是否需要补齐 156 个历史会话（路径 ②）作为基线？