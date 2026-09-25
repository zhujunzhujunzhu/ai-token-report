/**
 * 指标口径 —— 全平台唯一的计算公式来源。
 *
 * ★ 这些公式不是随便写的，全部来自 `docs/口径实测结论.md` §2
 *   对 156 个真实会话（9,845 条 usage 样本）的实测结论。
 *
 * 任何地方要算这些指标，**必须调用这里**，不要各自重写。
 * 一旦两端口径不一致，看板和 CLI 就会给出不同的数，且极难排查。
 */

/** provider 真实上报的 token 用量。字段名与 `@deepseek-ai/dsh-llm` 的 TokenUsage 一致。 */
export interface TokenUsage {
  /**
   * 未命中缓存的输入 token。
   *
   * ⚠️ **不是总输入**。`cacheRead` 是另外一项，两者相加才是完整输入。
   * 实测该 provider：input 11,561,323 / cacheRead 222,614,912 —— 差 19 倍。
   */
  input: number
  /** 输出 token。单价最贵的一项。 */
  output: number
  /**
   * 缓存读取 token。
   *
   * ★ 实测占总用量 **94.3%**。前端旧模型里没有这个字段，
   *   导致接上后端后会漏掉 94% 的用量 —— 这是本次重构最需要修的裂缝。
   */
  cacheRead: number
  /** 缓存写入 token。实测该 provider 恒为 0，但字段必须保留。 */
  cacheWrite: number
  /** 推理 token。实测该 provider 从不下发，恒为 0。 */
  reasoning: number
  /** provider 上报的总量，仅用于校验恒等式，不用于展示。 */
  total: number
}

export function emptyUsage(): TokenUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0 }
}

/**
 * 计费总量恒等式（实测 9,845 条样本无一例外）：
 *
 * ```
 * total = input + output + cacheRead + cacheWrite
 * ```
 *
 * ⚠️ 注意 `reasoning` **不在**恒等式内 —— 它是 output 的子集，
 * 加进去会重复计算。（该 provider 恒为 0，所以实测看不出来，
 * 但换 provider 后这个坑会立刻显现。）
 */
export function computeTotal(u: Omit<TokenUsage, 'total'>): number {
  return u.input + u.output + u.cacheRead + u.cacheWrite
}

/**
 * 校验一条记录的 token 恒等式是否成立。
 *
 * 用途：落库前的数据质量断言（对应 SQL 的 CHECK 约束）。
 * 不成立说明解析出错或 provider 口径变化，**应当告警而非静默接受**。
 */
export function verifyIdentity(u: TokenUsage): boolean {
  return u.total === computeTotal(u)
}

/**
 * 缓存命中率 —— **成本优化的最大杠杆**。
 *
 * ```
 * cacheRead / (cacheRead + input)
 * ```
 *
 * 实测约 94%~95%（`docs/口径实测结论.md` 两次取样分别是 94.3% 与 95.1%，
 * 差异来自取样时点不同）。这个数字越高越好：命中缓存的部分单价远低于未命中输入。
 * 分母用 `cacheRead + input` 而非 `input`，因为 input 只是「未命中」那部分。
 */
export function cacheHitRate(u: Pick<TokenUsage, 'input' | 'cacheRead'>): number {
  const denom = u.cacheRead + u.input
  // 无调用时返回 0 而非 NaN —— 否则前端图表会出现空点
  return denom === 0 ? 0 : u.cacheRead / denom
}

/**
 * 缓存杠杆：命中缓存的部分相对未命中输入有多少倍。
 *
 * 用于看板展示「缓存帮你省了多少」的直观倍数（实测约 19.3 倍）。
 */
export function cacheLeverage(u: Pick<TokenUsage, 'input' | 'cacheRead'>): number {
  return u.input === 0 ? 0 : u.cacheRead / u.input
}

/**
 * 未归属占比 —— 采集覆盖率的反向指标（部门看板专用）。
 *
 * ```
 * unattributedRate = 未归属调用数 / 总调用数
 * ```
 *
 * 为什么它必须在共享口径里：这个数字唯一的作用就是回答
 * 「看板上的数是不是少了」。若某一端自己算一遍（哪怕只是换个分母），
 * 它就会变成第二个口径 —— 而且因为它**不会报错**，
 * 只会让「覆盖率 98%」和「覆盖率 60%」两个页面同时存在。
 *
 * 无调用时返回 0 而非 NaN（与 `cacheHitRate` 同一条约定：
 * NaN 会让前端图表出现空点）。
 */
export function unattributedRate(unattributedCalls: number, totalCalls: number): number {
  return totalCalls === 0 ? 0 : unattributedCalls / totalCalls
}

/** 合并多条用量（累加）。禁止在采集端做任何「合并口径」的加工。 */
export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    reasoning: a.reasoning + b.reasoning,
    total: a.total + b.total,
  }
}

/** 一组用量的派生指标，供看板卡片直接消费。 */
export interface UsageMetrics {
  /** 计费总量 */
  total: number
  /** 缓存命中率（0~1） */
  cacheHitRate: number
  /** 缓存杠杆倍数 */
  cacheLeverage: number
  /** 平均每次调用消耗 */
  avgTokensPerCall: number
}

export function deriveMetrics(u: TokenUsage, calls: number): UsageMetrics {
  return {
    total: u.total,
    cacheHitRate: cacheHitRate(u),
    cacheLeverage: cacheLeverage(u),
    avgTokensPerCall: calls === 0 ? 0 : u.total / calls,
  }
}