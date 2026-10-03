/**
 * **取数范围 = 本机全部已注册来源**（DSH + Codex / Claude Code / Trae / WorkBuddy）。
 *
 * ## 为什么没有「白名单」这一项
 *
 * 这里曾经是一个**显式白名单**（`extraSources`，缺省空 = 只统计 DSH），
 * 理由是「默认并入全部来源会让面板第一次取数冷扫整台机器」。那条代价是真的
 * （本机实测 Codex 1,495 个文件 / 2.8 GB，十几秒到几分钟），但它换来的是更糟的东西：
 * **面板少算、看板也少算，而使用者完全看不出来** —— 少掉的那个来源与
 * 「我在那台客户端上本来就没用量」长得一模一样。
 *
 * 采集范围不是性能偏好，是一句会被读成结论的口径。所以现在只有一条规则：
 * **本机装了什么客户端就统计什么**，面板与历史补报共用这一条
 * （补报那一侧见 `backfill-runner.ts` 的纯文本来源阶段）。
 *
 * ## 唯一还能「关来源」的地方：环境开关
 *
 * `resolveSourceRoots()` 认每个适配器自己的开关（`SessionSourceAdapter.disableEnv`，
 * 例如 `DSH_TOKEN_REPORT_CODEX=0`），与 CLI 缺省共用同一份实现。
 * ⚠️ 面板与部署配置里都**没有**这一项 —— 「我不想统计 Codex」是一件
 *    部署策略级的事，不该和「我的服务端地址」放在同一个表单里。
 *
 * ⚠️ 代价（必须知情）：面板第一次取数、补报第一轮都会冷扫这些日志，之后按文件
 *    字节数增量。嫌慢就把那个客户端的日志目录挪走，或用它自己的环境开关关掉。
 */

import { registeredSources, resolveSourceRoots, type ResolvedSourceRoots, type SessionSource } from '@ai-token-report/core'

/**
 * 面板取数要用的**带来源的根**（全部已注册来源）。
 *
 * 🚨 DSH 的根必须把**生效配置里的那一组**传下去（`dshHomes`）：只传环境变量 / 自动发现
 *    会让「面板里改了会话日志根」在并入其它来源之后突然失效 —— 症状是
 *    「改完 DSH 的数字跟着变了，但它读的其实是另一个 home」。
 *
 * 返回的 `missing` 要一路带到页面 / 诊断里（「配了但读不到」与「本来就没装」必须能分辨）。
 */
export function resolveStatsSourceRoots(dshHomes: readonly string[]): ResolvedSourceRoots {
  return resolveSourceRoots({
    homes: dshHomes.length > 0 ? { dsh: [...dshHomes] } : {},
  })
}

/**
 * 面板**查询期**要用的来源清单（= 全部已注册来源，`dsh` 排在第一）。
 *
 * 🚨 为什么必须显式给：本地库（`usage.sqlite`）是 CLI / 本地页 / 插件 / report
 *   **共用的一个文件**，而 `openStats()` 的 `sources` 缺省语义是「库里的全部来源」。
 *   显式给全量在本仓是**与不传等价**的（`db/stats.ts` 的 `narrowSources` 只在
 *   数量**少于**已注册来源数时才收窄），所以这份清单既不丢汇总表，也不让
 *   「库里躺着的未知来源」冒充面板自己的数字。
 */
export function statsSourceIds(): SessionSource[] {
  const ids = registeredSources().map((adapter) => adapter.id)
  return ['dsh', ...ids.filter((id) => id !== 'dsh')] as SessionSource[]
}
