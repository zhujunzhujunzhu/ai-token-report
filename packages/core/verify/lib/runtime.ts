/**
 * 验证脚本共用的运行时工具。
 *
 * 这些坑都**只在「跨运行时验证」这个场景**才存在，所以刻意放在 `verify/lib/`
 * 而不是 `src/` —— 它们不是产品代码，不该污染任何包的公开 API。
 */

import { existsSync } from 'node:fs'
import { join, delimiter } from 'node:path'

/** 当前进程是否跑在 Bun 上。 */
export function isBunRuntime(): boolean {
  return typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined'
}

/**
 * 子进程环境：剔除会让 Node **直接崩掉**的代理变量。
 *
 * 🚨 本机实测（Node 22.21.1 / Windows）：只要 `NODE_USE_ENV_PROXY=1`，
 *   **任何** `node` 进程都会在加载 `node:http` 时抛
 *   `ERR_PROXY_INVALID_CONFIG: Invalid proxy URL`，连 `node -e "console.log(1)"`
 *   都跑不起来。而本项目的服务端要用 `node:http`，所以验证脚本
 *   必须把这个变量从子进程环境里摘掉，否则 Node 那一侧会全线误报失败。
 *
 * 顺便摘掉 `*_proxy`：它们在被测代码里没有用处，只会引入不必要的变量。
 */
export function cleanChildEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    const lower = key.toLowerCase()
    if (lower === 'node_use_env_proxy') continue
    if (lower === 'http_proxy' || lower === 'https_proxy' || lower === 'all_proxy') continue
    env[key] = value
  }
  return env
}

/** 判断一个候选可执行文件是不是**真的 Node**（而不是 Bun 冒充的）。 */
export function isRealNode(bin: string): boolean {
  const probe = Bun.spawnSync([bin, '-p', '[process.version, typeof Bun].join("|")'], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: cleanChildEnv(),
  })
  if (probe.exitCode !== 0) return false
  const line = new TextDecoder().decode(probe.stdout).trim().split('\n').pop() ?? ''
  return /^v\d+\.\d+/.test(line) && line.endsWith('|undefined')
}

/**
 * 找出一个真的 Node 可执行文件；找不到返回 null。
 *
 * 🚨 为什么不能直接 `spawn(['node', ...])`：实测（Bun 1.4.2 / Windows）
 *   在 `bun run <file>` 里执行 `Bun.spawnSync(['node', ...])`，
 *   **子进程是 Bun 而不是 Node**。后果是「跨运行时验证」静默退化成
 *   「同一个运行时跑两遍」，两边当然一致，却什么也没验证到。
 *
 * 因此这里逐个候选**真的执行并检查输出**，只认报得出
 * `process.version` 且 `typeof Bun === 'undefined'` 的那个。
 *
 * 候选顺序：显式覆盖 → `Bun.which('node')` → PATH 里逐个目录拼出来的 node。
 */
export function resolveNodeBin(): string | null {
  const isWindows = process.platform === 'win32'
  const candidates: string[] = []

  const override = process.env['ATR_NODE_BIN']
  if (override) candidates.push(override)

  const which = Bun.which('node')
  if (which) candidates.push(which)

  for (const dir of (process.env['PATH'] ?? '').split(delimiter)) {
    if (dir) candidates.push(join(dir, isWindows ? 'node.exe' : 'node'))
  }

  for (const candidate of candidates) {
    if (existsSync(candidate) && isRealNode(candidate)) return candidate
  }
  return null
}
