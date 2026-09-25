/**
 * 发布产物（npm 包 `dsh-token-report`）的**双运行时端到端验证**。
 *
 * ## 为什么需要它
 *
 * 单元测试和 typecheck 都在 **Bun** 下跑，`--target=node` 的产物
 * 在 Node 上到底能不能用，它们**一个都答不了**。而这一层恰恰最容易坏：
 * `bun:sqlite` 被提到产物顶层、忘了改 shebang、`Bun.file()` 漏在静态托管里、
 * `Bun.serve` 缺少 Node 分支 —— 这些全都「Bun 下全绿、Node 下直接崩」。
 *
 * 所以本脚本对着**真正要发布的那份产物**做四件事：
 *
 * 1. **产物自检**：shebang 是 node、无顶层 `bun:` import、零运行时依赖、
 *    本地页面资源已内嵌
 * 2. **统计口径跨运行时一致**：Node 与 Bun 各自跑 `--format json`，
 *    逐字段比对四项 token（含交叉验证：Node 建的库给 Bun 读、反之亦然）
 * 3. **本地页面 API 与 CLI 口径一致**：`/api/local/stats/overview`
 *    的 `totalTokens`/`calls` 必须与 CLI 的 JSON 输出完全相同 ——
 *    这是铁律 1「口径只有一个真源」在发布形态上的落点
 * 4. **`web` 子命令在两个运行时都能起**：health、index、JS/CSS 资源、
 *    SPA 回落、非法编码回 400
 *
 * ## 前置条件
 *
 * - 需要真实会话日志（默认取 `$DSH_HOME` 或 `~/.dsh` 的 `sessions/`），
 *   脚本会把它们复制到一个临时 home，**不碰你的真实本地库**
 * - 需要本机同时有 Bun 与 Node
 *
 * 用法：`bun run --filter '@ai-token-report/cli' verify:npm`
 * 退出码：`0` 全部通过；`1` 任一检查失败。
 */

import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { cleanChildEnv, resolveNodeBin } from '../../core/verify/lib/runtime.js'

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = resolve(here, '..')
const repoRoot = resolve(pkgRoot, '..', '..')
const distDir = join(pkgRoot, 'dist')
const cliPath = join(distDir, 'cli.js')

const bunBin = process.execPath
const nodeBin = resolveNodeBin()

const failures: string[] = []
function check(name: string, ok: boolean, detail = ''): void {
  process.stdout.write(`  ${ok ? '✅' : '❌'} ${name}${detail ? ` —— ${detail}` : ''}\n`)
  if (!ok) failures.push(name)
}

if (!nodeBin) {
  process.stderr.write('❌ 找不到真正的 Node，无法验证发布产物。可用 ATR_NODE_BIN 指定。\n')
  process.exit(1)
}

// ══ 1. 构建产物 ═══════════════════════════════════════════════════════════
process.stdout.write('\n=== 1. 构建发布产物 ===\n')
const build = Bun.spawnSync([bunBin, join(pkgRoot, 'scripts', 'build-npm.ts')], {
  stdout: 'pipe',
  stderr: 'pipe',
  env: cleanChildEnv(),
})
if (build.exitCode !== 0) {
  process.stderr.write(new TextDecoder().decode(build.stderr) + '\n')
  process.exit(1)
}
process.stdout.write(new TextDecoder().decode(build.stdout))

// ══ 2. 产物自检 ═══════════════════════════════════════════════════════════
process.stdout.write('\n=== 2. 产物自检 ===\n')
const cliText = await Bun.file(cliPath).text()
const manifest = JSON.parse(await Bun.file(join(distDir, 'package.json')).text()) as {
  name: string
  version: string
  bin: Record<string, string>
  dependencies?: Record<string, string>
  engines: Record<string, string>
}

check('shebang 是 node', cliText.startsWith('#!/usr/bin/env node'))
check(
  '无顶层 bun: import',
  !/^[ \t]*import[^;\n]*from[ \t]*["']bun:/m.test(cliText),
  '否则 Node 在 import 阶段就崩',
)
check('零运行时依赖', !manifest.dependencies || Object.keys(manifest.dependencies).length === 0)
check('包名正确', manifest.name === 'dsh-token-report', manifest.name)
check('bin 指向 cli.js', Object.values(manifest.bin).every((v) => v === 'cli.js'))
check(
  'engines 声明了 Node 下限',
  />=22\.15/.test(manifest.engines['node'] ?? ''),
  manifest.engines['node'],
)
const webIndex = join(distDir, 'web-local', 'index.html')
check('本地页面资源已内嵌', existsSync(webIndex))

// ══ 3. 准备隔离的 fixture home ════════════════════════════════════════════
process.stdout.write('\n=== 3. 准备 fixture ===\n')
const realHome = process.env['DSH_HOME'] ?? join(homedir(), '.dsh')
const realSessions = join(realHome, 'sessions')
if (!existsSync(realSessions)) {
  process.stderr.write(
    `❌ 找不到真实会话日志：${realSessions}\n` +
      `   本脚本需要真实日志才能验证口径一致；请设置 DSH_HOME。\n`,
  )
  process.exit(1)
}

// 每次重来：确保「Node 建库 → Bun 读」这类交叉验证真的发生，
// 而不是复用到上一次的库。
const fixture = mkdtempSync(join(tmpdir(), 'atr-npm-verify-'))
cpSync(realSessions, join(fixture, 'sessions'), { recursive: true })
const dbPath = join(fixture, 'token-report', 'usage.sqlite')
process.stdout.write(`  fixture: ${fixture}\n`)

/** 跑一次 CLI，返回退出码与合并输出。 */
function runCli(bin: string, args: string[]): { code: number; out: string } {
  const proc = Bun.spawnSync([bin, cliPath, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: cleanChildEnv(),
  })
  return {
    code: proc.exitCode,
    out:
      new TextDecoder().decode(proc.stdout) + new TextDecoder().decode(proc.stderr),
  }
}

/** 跑一次 CLI 并解析 JSON 输出。 */
function runCliJson(bin: string, args: string[]): Record<string, unknown> | null {
  const r = runCli(bin, [...args, '--format', 'json', '--quiet'])
  if (r.code !== 0) {
    process.stderr.write(`  CLI 退出码 ${r.code}：\n${r.out.slice(0, 500)}\n`)
    return null
  }
  try {
    // JSON 可能被日志行包着，取第一个 { 到最后一个 }
    const start = r.out.indexOf('{')
    const end = r.out.lastIndexOf('}')
    return JSON.parse(r.out.slice(start, end + 1)) as Record<string, unknown>
  } catch {
    process.stderr.write(`  JSON 解析失败：\n${r.out.slice(0, 500)}\n`)
    return null
  }
}

type Totals = { input: number; output: number; cacheRead: number; cacheWrite: number; total: number; calls: number }
const totalsKey = (t: Totals): string => JSON.stringify(t)

// ══ 4. 统计口径：Node 建库 → Bun 读；Bun 建库 → Node 读 ═══════════════════
process.stdout.write('\n=== 4. 统计口径跨运行时一致 ===\n')
const STATS_ARGS = ['--dsh-home', fixture, '--period', 'today']

// 4a. Node 冷建库
const nodeCold = runCliJson(nodeBin, STATS_ARGS)
check('Node 冷建库并出数', nodeCold !== null)
// 库必须落在 fixture 里，不能碰到用户真实的 $DSH_HOME/token-report
check(
  '建库落在隔离 fixture 内（未污染真实 DSH home）',
  existsSync(dbPath) && dbPath.startsWith(fixture),
  dbPath,
)
const nodeTotals = (nodeCold?.['totals'] ?? null) as Totals | null

// 4b. Bun 读 Node 建的库
const bunWarm = runCliJson(bunBin, STATS_ARGS)
const bunTotals = (bunWarm?.['totals'] ?? null) as Totals | null
check(
  'Bun 读 Node 建的库，四项 token 逐字段一致',
  nodeTotals !== null && bunTotals !== null && totalsKey(nodeTotals) === totalsKey(bunTotals),
  nodeTotals && bunTotals ? `calls=${nodeTotals.calls} total=${nodeTotals.total}` : '',
)

// 4c. 重置后用 Bun 冷建库、Node 读（反方向）
const reset1 = runCli(bunBin, ['--dsh-home', fixture, '--reset-db'])
check('Bun --reset-db 成功', reset1.code === 0 && !existsSync(dbPath), reset1.out.trim().split('\n')[0])

const bunCold = runCliJson(bunBin, STATS_ARGS)
const nodeWarm = runCliJson(nodeBin, STATS_ARGS)
const bunColdTotals = (bunCold?.['totals'] ?? null) as Totals | null
const nodeWarmTotals = (nodeWarm?.['totals'] ?? null) as Totals | null
check(
  'Node 读 Bun 建的库，四项 token 逐字段一致',
  bunColdTotals !== null &&
    nodeWarmTotals !== null &&
    totalsKey(bunColdTotals) === totalsKey(nodeWarmTotals),
)
check(
  '冷/热两个方向的数字都相同（不是「恰好都为空」）',
  nodeTotals !== null && bunColdTotals !== null && totalsKey(nodeTotals) === totalsKey(bunColdTotals),
  nodeTotals ? `total=${nodeTotals.total} calls=${nodeTotals.calls}` : '',
)
check(
  '确实有计费记录（防止空库假通过）',
  (nodeTotals?.calls ?? 0) > 0 && (nodeTotals?.total ?? 0) > 0,
)

// ══ 5. web 子命令 + 与 CLI 口径一致 ══════════════════════════════════════
process.stdout.write('\n=== 5. web 子命令（两个运行时）===\n')

/**
 * 起 `web` 子命令并探测一组端点。
 *
 * ⚠️ `web` 必须是**第一个**参数 —— 参数解析只认首 token 作为子命令
 *   （`--dsh-home X web` 会被当成未知参数，这是既有的解析约定）。
 */
async function probeWeb(
  label: string,
  bin: string,
  port: number,
): Promise<{ ok: boolean; apiTotals: { calls: number; total: number } | null }> {
  const proc = Bun.spawn(
    [bin, cliPath, 'web', '--dsh-home', fixture, '--no-open', '--port', String(port)],
    { stdout: 'pipe', stderr: 'pipe', env: cleanChildEnv() },
  )
  const base = `http://127.0.0.1:${port}`

  let ready = false
  for (let i = 0; i < 60; i++) {
    await Bun.sleep(500)
    try {
      if ((await fetch(`${base}/api/health`)).ok) {
        ready = true
        break
      }
    } catch {
      /* 还没起来 */
    }
  }

  if (!ready) {
    check(`${label} web 在 30 秒内就绪`, false)
    proc.kill()
    return { ok: false, apiTotals: null }
  }

  let ok = true
  let apiTotals: { calls: number; total: number } | null = null
  try {
    const health = (await (await fetch(`${base}/api/health`)).json()) as {
      ok: boolean
      localApi: boolean
    }
    ok &&= health.ok === true && health.localApi === true

    const idx = await fetch(`${base}/`)
    const idxText = await idx.text()
    ok &&= idx.status === 200 && idxText.includes('<div id=')

    const asset = idxText.match(/assets\/index-[A-Za-z0-9_-]+\.js/)?.[0]
    if (asset) {
      const a = await fetch(`${base}/${asset}`)
      const len = (await a.arrayBuffer()).byteLength
      ok &&= a.status === 200 && len > 0
    } else {
      ok = false
    }

    // SPA 回落：深层路由也要返回 index.html
    const spa = await fetch(`${base}/deep/route`)
    ok &&= spa.status === 200 && (await spa.text()).includes('<div id=')

    // 非法百分号编码必须是 400（不是被兜底成 500）
    ok &&= (await fetch(`${base}/%zz`)).status === 400

    // 本地 API 口径
    const ov = (await (await fetch(`${base}/api/local/stats/overview?period=today`)).json()) as {
      calls: number
      totalTokens: number
    }
    apiTotals = { calls: ov.calls, total: ov.totalTokens }
  } catch (err) {
    process.stderr.write(`  ${label} 探测异常：${err instanceof Error ? err.message : String(err)}\n`)
    ok = false
  } finally {
    proc.kill()
  }

  check(`${label} web：health / index / 资源 / SPA 回落 / 400`, ok)
  return { ok, apiTotals }
}

const nodeWeb = await probeWeb('node', nodeBin, 8899)
const bunWeb = await probeWeb('bun', bunBin, 8901)

// ★ 铁律 1 在发布形态上的落点：页面 API 与 CLI 必须给出同一个数
if (nodeTotals && nodeWeb.apiTotals) {
  check(
    '本地页面 API 与 CLI 口径一致（totalTokens / calls）',
    nodeWeb.apiTotals.total === nodeTotals.total && nodeWeb.apiTotals.calls === nodeTotals.calls,
    `api=${nodeWeb.apiTotals.total}/${nodeWeb.apiTotals.calls} cli=${nodeTotals.total}/${nodeTotals.calls}`,
  )
} else {
  check('本地页面 API 与 CLI 口径一致（totalTokens / calls）', false, '取数失败')
}
if (nodeWeb.apiTotals && bunWeb.apiTotals) {
  check(
    '两个运行时的本地 API 数字一致',
    nodeWeb.apiTotals.total === bunWeb.apiTotals.total &&
      nodeWeb.apiTotals.calls === bunWeb.apiTotals.calls,
  )
}

// ══ 6. Node 侧 --reset-db ═════════════════════════════════════════════════
process.stdout.write('\n=== 6. Node --reset-db（EBUSY 陷阱）===\n')
runCli(nodeBin, [...STATS_ARGS, '--quiet'])
const reset2 = runCli(nodeBin, ['--dsh-home', fixture, '--reset-db'])
check(
  'Node --reset-db 成功且不留 wal/shm',
  reset2.code === 0 &&
    !existsSync(dbPath) &&
    !existsSync(`${dbPath}-wal`) &&
    !existsSync(`${dbPath}-shm`),
  reset2.out.trim().split('\n')[0],
)

// ══ 收尾 ═════════════════════════════════════════════════════════════════
rmSync(fixture, { recursive: true, force: true })

process.stdout.write('\n' + '─'.repeat(60) + '\n')
if (failures.length > 0) {
  process.stderr.write(`❌ 未通过 ${failures.length} 项：\n  - ${failures.join('\n  - ')}\n`)
  process.exit(1)
}
process.stdout.write('✅ 发布产物双运行时端到端验证全部通过\n')
