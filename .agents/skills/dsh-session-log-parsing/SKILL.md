---
name: dsh-session-log-parsing
description: Read and decode DSH session logs (session.v3.jsonl.zstd) in this repo to extract billing-grade token usage events. Use when writing or debugging the log scanner, zstd frame decoding, event field extraction, or incremental watermark state; not for metric formulas or identity attribution.
version: 1.0.0
---

# DSH 会话日志解析

## 实现位置：`packages/core/src/`

内核已全部迁入 `packages/core/src/`，旧的 `dsh-token-stats/` **已删除** ——
现在只有一份实现，改这里就对了。

| 逻辑 | 文件 |
|---|---|
| zstd 分帧解码 | `packages/core/src/decode.ts` |
| 会话日志扫描 | `packages/core/src/scanner.ts` |
| 分组聚合 / 时间序列 | `packages/core/src/aggregate.ts` |
| 时间范围解析 | `packages/core/src/range.ts` |
| 增量水位线 | `packages/core/src/state.ts` |
| 终端表格渲染 | `packages/core/src/format.ts` |
| 路径解析 | `packages/core/src/home.ts` |
| HTTP 投递 / 上报编排 | `packages/cli/src/deliver.ts`、`report.ts` |

测试分居两处：`packages/core/test/`（`core.test.ts` / `identity-store.test.ts`）
与 `packages/cli/test/`（`incremental.test.ts`）。

> **迁移原则：先原样搬，不改逻辑。** 行为变更留给后续阶段 ——
> 这样一旦出问题可以立刻判断是「搬迁引入」还是「改动引入」。
>
> ⚠️ `ARCHITECTURE.md` 里画的 `legacy/`、`packages/core/src/db/`、`tools/` **都不存在**，
> 那是目标结构。动手前先列目录确认。

## 日志位置与格式

```
$DSH_HOME/sessions/<项目目录名>/session-<id>/session.v3.jsonl.zstd
```

路径解析优先级（`packages/core/src/home.ts`）：
**显式参数 > `DSH_HOME` 环境变量 > `~/.dsh`**

## 四条硬约束

### 1. zstd 是**分帧追加**的，不能整文件解压

必须按 magic number `28 B5 2F FD` 逐帧扫描、逐帧解压。
会话进行中文件会持续追加，整文件解压会在写入中途失败。

### 2. 用 Node/Bun 原生 API

```ts
import { zstdDecompressSync, zstdDecompress } from 'node:zlib'
```

Node ≥ 22 原生支持，已实测可用。不要引入第三方 zstd 包。

### 3. ★ 截断帧处理：Node 与 Bun 行为不同（最容易踩的坑）

追加写入意味着尾部可能有不完整的半帧。**两个运行时的表现实测不一致**：

| 运行时 | 对截断帧的行为 |
|---|---|
| Node | `zstdDecompressSync` **抛 `Z_BUF_ERROR`** |
| Bun | **静默返回空 Buffer**，不抛错 |

**所以不能只靠 try/catch 判断帧是否完整** —— 在 Bun 下尾部半帧会被误计为
「成功帧」，诊断数字直接失真。

正确做法：**显式解析 zstd 帧头**（参考 RFC 8878 §3.1.1.1 `Frame_Header_Descriptor`），
先做帧完整性检查再解压，让两个运行时行为一致。

```ts
for (const frame of splitFrames(buf)) {
  if (!isCompleteZstdFrame(frame)) { framesFailed++; continue }
  try { text += zstdDecompressSync(frame).toString('utf8'); framesOk++ }
  catch { framesFailed++ }
}
```

返回 `{ text, framesOk, framesFailed }` —— 保留两个计数，而不是吞掉异常。

> 另一个已知边界：magic 序列 `28 B5 2F FD` 理论上可能出现在压缩数据内部。
> 对本场景可接受，但改 `splitFrames` 时要意识到这个前提。

### 4. 同步与异步两条路径

`decode.ts` 同时提供两条路径，**改动时两条都要改**，
只改一条会导致「同一个文件、不同调用点结果不一致」：

| 导出 | 用途 |
|---|---|
| `decodeFramedZstdSync(buf)` | 同步，小块 / 热路径 |
| `decodeFramedZstd(buf)` | `async`，大块 |
| `decodeFramedZstdFrom(...)` | 增量续解 |

配套的纯工具函数（改帧逻辑时复用，不要另写一份）：
`findFrameOffsets` / `splitFrames` / `isCompleteZstdFrame` / `parseJsonl`。

## 权威数据源：`assistant/message`

**计费级 usage 只认这个事件。** 它是 provider 真实上报值，不是估算。

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

字段映射：

| 日志字段 | 去往 |
|---|---|
| `seq` | 与 session id 组成幂等键 |
| `time` | `ts`（epoch 毫秒） |
| `data.usage.*` | token 四元组（见 `token-metrics-contract` skill） |
| `data.message.source.provider` / `.model` | 路由归属 |
| `data.turn` / `data.step` | 轮次统计 |

## 其他事件（按用途）

| 事件 | 用途 |
|---|---|
| `session`（首行） | `id` / `cwd` / `createdAt` → 项目归因 |
| `request/context` | `{provider, model, contextWindow}` → 上下文占用率分母 |
| `turn/start` / `turn/end` | 划分一轮对话的统计窗口 |
| `assistant/attempt` | 含失败/重试（实测存在 `429 RATE_LIMIT`）→ 统计重试浪费 |
| `step/start` / `step/end` | 步数统计 |

## 幂等键

```
event_id = `${sessionId}:${seq}`
```

与 DSH 官方建议的 `(session.id, format_version, seq)` 去重口径一致。
**上报方只保证 at-least-once 即可**，重试与 outbox 重放天然安全。

## 增量水位线（三层，`state.ts`）

让「扫描」变成「增量扫描」的关键。**因为日志是分帧追加、从不重写**，
「文件字节数没变」⇒「内容逐字节没变」，热态扫描只需一次 `stat`。

| 层 | 依据 | 作用 |
|---|---|---|
| L1 | `size` | 整个文件跳过，不读不压 |
| L2 | `frameCount` | 只解压新增的帧 |
| L3 | `lastSeqBySession` | 事件级兜底，防帧边界判错 |

两个容易做错的点：

1. **L3 必须按 `sessionId` 存，不能按文件存** —— 一个会话可能被拆成多个
   `session*.jsonl.zstd` 文件（格式版本升级、分段），而 `seq` 是**会话内**单调的，
   跨文件仍然连续。
2. **`mtimeMs` 仅用于诊断，不参与跳过判定** —— 判定只看 `size` / `frameCount`。

### 崩溃安全：水位线不早于投递推进

`report` 的推进顺序是 **先入 pending → 再投递 → 投递成功才推水位线**。
中途崩溃最坏结果是「重发已发过的记录」，服务端按 `event_id` 幂等去重，重复投递无害。
**宁可重发，不可漏发。**

同样地，重扫时必须靠 `event_id` 幂等，而不是靠水位线的精确性。

> `STATE_VERSION` 结构变动时递增，触发 `--reset` 重建。

## 性能参考

### 直扫日志的成本结构（196 文件 / 80.81 MB 实测）

| 阶段 | 耗时 | 占比 |
|---|---|---|
| 列目录 + stat | 56 ms | 0.3% |
| **读文件 IO** | **577 ms** | **3.7%** |
| **zstd 解压** | **12,102 ms** | **76.9%** |
| **JSON 解析** | **3,061 ms** | **19.5%** |
| 合计 | **~15.7 s** | 100% |

解压后文本 262.8 MB / 96,282 行 JSON → 16,021 条计费记录。

> ⚠️ 旧版本写的「156 文件 / 61 MB 约 1~2 秒」**已过期**，真实是 15.7 秒。

**结论：瓶颈是 CPU 不是 IO。** 因此本地端的数据源已从「每次直扫」
改成「**本地 SQLite 增量库**」（`packages/core/src/db/`）——
解析一次、复用多次。落库后 today 查询 0.26 ms、全量分组 20 ms。

### 两条路径必须同源

- `db/ingest.ts` **直接复用 `scanIncremental()`**，绝不另写一套解析
- `db/query.ts` 只做 `SUM(原始列)`，派生指标仍走 `derive()`
- `packages/core/test/db.test.ts` 断言两条路径**逐位相等**

⚠️ **时间分桶（`day`/`hour`）必须在 JS 侧做**（用 `toDayKey()` / `toHourKey()`）：
SQLite 的 `'localtime'` 按操作系统时区、JS 按进程 TZ 解析，
在 `bun test` 下实测相差 8 小时。详见 `ARCHITECTURE.md` §3.1 的时区陷阱。

⚠️ **`bun:sqlite` 的 prepared statement 必须 `finalize()`**：
否则 `db.close()` 不释放文件句柄，删库时抛 `EBUSY`。

## 相关

- 指标公式 → `token-metrics-contract` skill
- 上报与查询契约 → `packages/shared/src/protocol.ts`
- 身份处理 → `identity-attribution` skill