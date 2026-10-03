/**
 * **spawn 出来的 CLI 子进程**要用的环境：把「本次读哪些来源」钉死。
 *
 * ## 为什么必须有这一层
 *
 * 两个事实叠在一起，结果是「单测连带扫使用者真实的日志」：
 *
 * 1. `bun test` 的 preload（`scripts/test-preload.ts`）设的那些
 *    `DSH_TOKEN_REPORT_<来源>=0` / `DSH_TOKEN_REPORT_DISCOVER=0`
 *    **不会被 `Bun.spawn` 继承**（实测 Bun 1.4.2：父进程读得到，子进程读到 `undefined`）；
 * 2. CLI 的缺省来源是**全部已注册来源**（本机 Codex 实测 1,513 个文件 / 2.8 GB）。
 *
 * 于是只要有一个用例 spawn 出 CLI 而不钉来源，它就会去冷扫开发者真实的
 * `~/.codex` / `~/.claude` / Trae / `~/.workbuddy` —— 表现**不是报错**，
 * 而是「这条用例慢到 5 秒超时」（本机 2026-10-03 实测 `cost-cli` 8 条全超时），
 * 或者数字里多出别的来源。两种都极难归因。
 *
 * ## 名单不手抄
 *
 * 关闭开关**由适配器自己声明**（`SessionSourceAdapter.disableEnv`），这里只遍历注册表：
 * 每加一个来源不必回来补一行 —— 漏一行的症状正是上面那两种。
 *
 * ⚠️ 这与 `packages/cli/verify/verify-npm-package.ts` 的 `pinnedEnv()` 是同一件事
 *   （那份是脚本、这份是 `bun test` 用的）。两边都保留：verify 脚本不进 CI，
 *   而单测必须自己站得住。
 */
import { registeredSources } from '@ai-token-report/core'

/** 钉住全部非 DSH 来源 + 关掉 DSH home 自动发现；`overrides` 用来单独放开某个来源。 */
export function pinnedChildEnv(overrides: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value
  }
  // DSH 的会话日志根默认**自动发现**（会 readdir 家目录与各平台应用数据目录）。
  env['DSH_TOKEN_REPORT_DISCOVER'] = '0'
  for (const adapter of registeredSources()) {
    if (adapter.id === 'dsh') continue
    if (adapter.disableEnv !== undefined) env[adapter.disableEnv] = '0'
  }
  return { ...env, ...overrides }
}
