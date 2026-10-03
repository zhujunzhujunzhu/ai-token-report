/**
 * **面板的「其它来源」**：把 DSH 之外的多客户端日志并入面板统计。
 *
 * ## 为什么默认关（`extraSources` 缺省为空）
 *
 * 面板今天**只统计 DSH**：`StatsContext.sessionsRoots` 就是 `reportPaths(config)` 给的
 * 那一组 DSH 会话根，`openStats()` 拿不到 `sourceRoots` 时只会 ingest DSH。
 * 这不是漏了一行，而是刻意的 —— 一旦默认并入**全部**已注册来源，面板第一次取数就会
 * 冷扫整台机器（本机实测：Codex 1,495 个文件 / 2.8 GB，一次十几秒到几分钟），
 * 而面板是每 30 秒探一次的东西。所以这里做成**显式白名单**：
 *
 * ```yaml
 * - id: token-report
 *   config:
 *     extraSources: [trae, trae-cn]     # 只并入这两个来源（默认 [] = 只统计 DSH）
 *     # extraSources: [all]             # 或者：全部已注册来源（含 Codex，冷扫很贵）
 * ```
 *
 * ## 与 CLI 的 `--source` 是同一套语义
 *
 * `['all']` / 逐个 id（`codex` / `claude-code` / `trae` / `trae-cn` / `workbuddy`）。
 * 差别只有一条：**`dsh` 永远在**（面板的主体就是 DSH 用量），写它等于没写。
 *
 * ⚠️ 未知的 id **不报错、不静默**：它进 `unknown` 由调用方告警后丢弃。
 *    一个拼错的来源名若被静默忽略，症状是「配了 trae 但面板数字没变」——
 *    而它与「那个来源本来就没用量」长得一模一样。
 */

import { registeredSources, resolveSourceRoots, type ResolvedSourceRoots, type SessionSource } from '@ai-token-report/core'

import type { EffectiveConfig } from './config.js'

/** 白名单的解析结果（纯函数，便于单测逐个断言）。 */
export interface ExtraSourcesPlan {
  /** 实际要并入的来源：已注册、去掉 `dsh`、去重、顺序稳定。 */
  sources: SessionSource[]
  /** 配了但不认识的 id（调用方负责告警；绝不静默当成「没用过那个客户端」）。 */
  unknown: string[]
}

/** `all` 的字面量（与 CLI 的 `--source all` 同义）。 */
export const ALL_SOURCES = 'all'

/**
 * 把配置里的白名单解析成「实际要并入哪些来源」。
 *
 * 规则只有三条：`all` = 全部已注册来源；`dsh` 永远在（写不写都一样）；
 * 其余按已注册来源过滤，拼错的进 `unknown`。
 */
export function planExtraSources(config: Pick<EffectiveConfig, 'extraSources'>): ExtraSourcesPlan {
  const raw = config.extraSources ?? []
  const registered = new Set<string>(registeredSources().map((adapter) => adapter.id))
  const wantsAll = raw.some((id) => id === ALL_SOURCES)
  const unknown: string[] = []
  const picked: SessionSource[] = []
  for (const id of raw) {
    if (id === ALL_SOURCES) continue
    if (id === 'dsh') continue
    if (!registered.has(id)) { unknown.push(id); continue }
    const source = id as SessionSource
    if (!picked.includes(source)) picked.push(source)
  }
  if (!wantsAll) return { sources: picked, unknown }
  // `all` 与逐个列出可以混写：并起来仍然是「全部已注册来源」。
  const all = registeredSources()
    .map((adapter) => adapter.id)
    .filter((id) => id !== 'dsh')
  const union = [...picked]
  for (const id of all) if (!union.includes(id)) union.push(id)
  return { sources: union, unknown }
}

/**
 * 面板取数要用的**带来源的根**。
 *
 * 返回 `undefined` = 「白名单为空」（调用方就别给 `openStats` 传 `sourceRoots`）——
 * 那种情况下取数与改动前**逐字一致**，这是「默认关」在代码上的落点。
 *
 * ⚠️ DSH 的根必须把**生效配置里的那一组**传下去（`dshHomes`）：只传环境变量/自动发现
 *    会让「面板里改了会话日志根」在并入其它来源之后突然失效 —— 症状是
 *    「改完 DSH 的数字跟着变了，但它读的其实是另一个 home」。
 */
export function resolveStatsSourceRoots(
  config: EffectiveConfig,
  dshHomes: readonly string[],
): ResolvedSourceRoots | undefined {
  const plan = planExtraSources(config)
  if (plan.sources.length === 0) return undefined
  return resolveSourceRoots({
    sources: ['dsh', ...plan.sources],
    homes: dshHomes.length > 0 ? { dsh: [...dshHomes] } : {},
  })
}

/**
 * 面板**查询期**要用的来源清单（`dsh` 永远在，且排在第一）。
 *
 * 🚨 为什么「只给根」不够：本地库（`usage.sqlite`）是 CLI / 本地页 / 插件 / report
 *   **共用的一个文件**，而 `openStats()` 的 `sources` 缺省语义是
 *   「**库里的全部来源**」。于是：
 *
 *   - 默认关（白名单为空）时若不传这份清单，面板会把库里 Codex / workbuddy 的行
 *     **当成 DSH 的**显示（本机实测：库里一旦有过别的来源，`--source dsh` 与
 *     `--source all` 的总量逐位相同，326,041,147）；
 *   - 白名单非空时不传，面板会把**白名单之外**的来源也算进来
 *     （配了 `[trae]` 却把 Codex 的数字一起显示）。
 *
 *   两种都是「数字看起来完全正常，只是不属于这个来源」，不会报错。
 *
 * 依赖方向：`planExtraSources` 是同一份配置解析，所以清单与根**永远同源**。
 *
 * ⚠️ **代价**：显式收窄来源会让 `openStats` 绕过汇总表（`usage_rollup_*` /
 *   `local_usage_cell*` 的键里没有来源，见 `openStats` 的 `scoped`）——
 *   面板的大库查询因此从「读小表」回到「聚合 `usage_event`」。
 *   这是**刻意接受**的：另一条路是把别的来源的行当成面板自己的数字（不报错、看起来完全正常）。
 *   顺带一提，本地页在「本机没装齐六个来源」时早就是这个行为，不是插件独有的新代价。
 */
export function statsSourceIds(config: Pick<EffectiveConfig, 'extraSources'>): SessionSource[] {
  return ['dsh', ...planExtraSources(config).sources]
}
