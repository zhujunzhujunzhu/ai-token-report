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
 * 一次性 DSH home 对应的**一次性数据目录**（`<home>/token-report`）。
 *
 * 🚨 为什么每个起子进程的脚本都必须调用它：数据目录的缺省值是家目录下的
 *   `~/.ai-token-report`，**刻意不跟随 `DSH_HOME`**（见 `core/src/home.ts`）。
 *   于是「把子进程的 `DSH_HOME` 指到临时目录」这个用了几年的隔离办法
 *   **不再隔离任何东西** —— 身份文件、本地库、outbox、补报水位会落到使用者
 *   真实的目录里，而脚本的输出一切正常。
 *
 * 用法：`env.DSH_TOKEN_REPORT_DATA_DIR = scratchDataDir(home)`。
 * 注意 `~` 形式的数据目录只影响**本进程**，子进程要显式传这个环境变量
 * （或命令行上的 `--data-dir`）。
 */
export function scratchDataDir(home: string): string {
  return join(home, 'token-report')
}

/**
 * 一次性 DSH home 对应的**会话日志根列表**（`DSH_TOKEN_REPORT_DSH_HOMES` 的值）。
 *
 * 🚨 为什么每个起子进程的脚本也必须调用它：会话日志根现在**默认自动发现**
 *   （`$DSH_HOME` + `~/.dsh` + `~/.dsh*` + 各平台应用数据目录下的客户端目录）。
 *   于是「把子进程的 `DSH_HOME` 指到临时目录」这个老办法**不再是隔离** ——
 *   `$DSH_HOME` 只是候选之一，子进程会连带扫到使用者**真实的** home：
 *   断言随机器漂移（本机真实用量 vs 固定期望值），更糟的是插件的历史补报
 *   会把真实用量以验收身份**上报出去**。
 *
 * 用法：`env.DSH_TOKEN_REPORT_DSH_HOMES = scratchDshHomes(home)`。
 * 只想关掉发现、保留 `$DSH_HOME` 语义时用 `DSH_TOKEN_REPORT_DISCOVER='0'`。
 *
 * ⚠️ 传**多个**参数时用系统路径分隔符拼（Windows `;` / POSIX `:`）——
 *   硬编码 `:` 会在 Windows 上把盘符 `C:` 切成两半。
 */
export function scratchDshHomes(...homes: string[]): string {
  return homes.join(delimiter)
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
