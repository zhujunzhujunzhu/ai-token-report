---
name: token-metrics-contract
description: Compute, change, or review DSH token usage metrics (total, cache hit rate, cache leverage) in this repo. Use when touching cacheRead/input/output token math, the billing identity, dashboard metric cards, or when two surfaces report different token numbers; not for parsing raw session logs or identity attribution.
version: 1.0.0
---

# Token 指标口径契约

**口径只有一个真源：`packages/shared/src/metrics.ts`。**
任何地方要算这些指标，必须 import 它，不要各自重写。

## 为什么这条规则存在

重构前 CLI 产出 `provider` / `cache_read_tokens`，前端类型是 `apiKey` / `cost` /
`requests` —— 两端口径已经漂移。更糟的是前端模型里**根本没有 cacheRead 字段**，
即使接上真值也会漏掉 94% 的用量。两个页面显示不同的数，是这类项目最难排查的 bug。

## 四条公式（实测 9,845 条 usage 样本得出）

```ts
// 1. 计费总量恒等式 —— 样本无一例外
total = input + output + cacheRead + cacheWrite

// ⚠️ reasoning 不在恒等式内。它是 output 的子集，加进去会重复计算。
//    该 provider 恒为 0，所以实测看不出来；换 provider 后这个坑会立刻显现。

// 2. 缓存命中率 —— 成本优化的最大杠杆（实测 94.3% ~ 95.1%）
cacheHitRate = cacheRead / (cacheRead + input)

// ⚠️ 分母是 cacheRead + input，不是 input。
//    input 只是「未命中缓存」那部分。

// 3. 缓存杠杆（实测约 19.3 倍）
cacheLeverage = cacheRead / input

// 4. 平均每次调用
avgTokensPerCall = total / calls
```

## 两个必须避开的陷阱

| 错误做法 | 后果 |
|---|---|
| 只报 `input + output` | **漏掉 94.3%** 的真实用量 |
| 把 `cacheRead` 加回 `input` 当总输入 | **虚增约 20 倍** |

`packages/shared/test/metrics.test.ts` 里「朴素口径的陷阱」用例专门固化了这两条断言。

## 改动流程

1. 改 `packages/shared/src/metrics.ts`
2. **同时改 `packages/shared/test/metrics.test.ts`** —— 那里的断言固化了
   94.3% / 19.3 倍等实测结论，是防止口径漂移的最后一道防线
3. `bun test packages/shared`
4. `bun run typecheck` —— 字段对不上时 TS 会直接编译失败

新增派生指标时，加进 `deriveMetrics()` 并扩展 `UsageMetrics` 接口，
让前端卡片直接消费，而不是在 Vue 组件里再算一遍。

## 边界情况（已定行为，不要"修"）

- `cacheHitRate` 分母为 0 时返回 **0 而非 NaN** —— 否则前端图表出现空点
- `cacheLeverage` 在 `input === 0` 时返回 **0 而非 Infinity**
- `avgTokensPerCall` 在 `calls === 0` 时返回 **0 而非 NaN**

## 命名约定

- **DB 列 / HTTP 线上字段**：`snake_case`（`cache_read_tokens`）
- **TypeScript 内存类型**：`camelCase`（`cacheReadTokens`）
- 转换只发生在边界（`db/ingest.ts`、`web/src/api/`），内核一律 camelCase

## 落库约束

**必须存 4 个独立列**（input / output / cacheRead / cacheWrite），展示时再相加。
一旦采集端做了合并，后续任何拆分都无法还原。