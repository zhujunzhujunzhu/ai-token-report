/**
 * Node 侧（`mysql2`）MySQL 后端的**活体验证** —— 真的在 Node 上跑，不进 `bun test`。
 *
 * ```bash
 * bun run --filter '@ai-token-report/server' verify:mysql:node
 * # 指定连接串（别的机器 / CI）：$env:ATR_MYSQL_URL='mysql://…'
 * ```
 *
 * ## 为什么必须有它（Bun 侧那两个脚本一个都替代不了）
 *
 * `packages/server/verify/verify-mysql-portal.ts`（53 项）与 core 的
 * `verify:mysql`（17 项）**都跑在 Bun 上**，走的全是内建 `Bun.sql`。
 * Node 那条路（可选依赖 `mysql2`）因此一行都没被执行过 —— 而它恰恰是
 * 「部门服务端部署在 Node 上」时**唯一生效**的那条。驱动换了，坑也换了：
 *
 * | 关注点 | `Bun.sql` | `mysql2` |
 * |---|---|---|
 * | `allowPublicKeyRetrieval` | **必需**（8.4 的 caching_sha2_password） | **不认**（传了会打告警，且它并不需要） |
 * | 多语句 DDL（`exec()`） | `unsafe()` 直接跑 | 必须 `query()` + `multipleStatements: true` |
 * | 结果头字段 | `affectedRows` | `affectedRows`（实测一致，`INSERT IGNORE` 撞主键都是 0） |
 * | 默认字符集 | utf8mb4 | utf8mb4（实测） |
 *
 * ## 做法：同一个文件两种模式
 *
 * 1. **编排模式**（`bun run` 起的默认模式）：用 `bun build --target=node` 把**本文件**
 *    打成一个临时 `.mjs`（放 `%TEMP%`，**不落仓**），再用 **Node** 运行它，
 *    最后把子进程的退出码原样作为自己的退出码。
 * 2. **断言模式**（子进程里，由 `ATR_MYSQL_NODE_VERIFY_CHILD=1` 打开）：连真 MySQL，
 *    用 core 的**真实导出**跑断言 —— `openPortalStore()`（门面：DDL + 版本闸门 + 方言）
 *    / `sharedMysqlBackend()`（驱动层）/ `MYSQL_DIALECT`（方言层）。
 *
 * ★ 编排与断言写在同一个文件里，是为了让两者**不可能漂移**：断言跑的就是打进去的那份源码。
 *
 * ## ★ 顺带钉住一处真实的驱动差异
 *
 * `changes` 是本仓**唯一**被消费的驱动语义（`ingest.ts` 的「`changes > 0` 即新插入」
 * 去重判据）。脚本用**逐字相同**的语句在两个驱动上各量一遍并并排打印，实测：
 *
 * | 语句 | `Bun.sql` | `mysql2` |
 * |---|---|---|
 * | `INSERT IGNORE` 新插入 / 撞主键 | 1 / **0** | 1 / **0** | ← ★ 本仓消费这一行，两边一致 |
 * | ODKU 真的改了值 | 2 | 2 |
 * | ODKU / `UPDATE`「匹配上但值没变」 | **0** | **1** |
 *
 * 最后一行不一致（mysql2 默认带 `CLIENT_FOUND_ROWS`，给的是匹配行数），
 * 本仓不消费它 —— 但这类差异**不会报错**，所以钉在输出里而不是留在人的记忆里。
 *
 * ## ⚠️ 为什么临时产物旁边要放一个指向 mysql2 的 junction
 *
 * 本仓 `bun install` 是**隔离式布局**：`mysql2` 只装在
 * `packages/server/node_modules`，**根 `node_modules` 里没有它**（实测）。
 * 而裸说明符是按**导入它的那个文件**所在目录逐级向上找的，所以 `%TEMP%` 里的产物
 * 默认解析不到 mysql2。⇒ 在临时目录里造一个**真实**的 `node_modules/`，再把
 * `mysql2` 以 junction 指到服务端包里那一份 —— 这正是**部署形态**
 * （`packages/server/dist/*.mjs`）所处的解析环境。
 *
 * 🚨 不能图省事把整个 `node_modules` 做成 junction：实测 Node 的解析器**不穿越**
 *   「本身是 junction 的 `node_modules`」（`ERR_MODULE_NOT_FOUND`），而穿越
 *   「`node_modules/mysql2` 是 junction」完全正常（pnpm 的布局正是后者）。
 *   两种布局都实测过（`atr-jB` 失败 / `atr-jE` 成功并真的连上了库）。
 *
 * 每次由编排进程创建随机 atr_http_v4_* 隔离库；Node 子进程只允许这个目标，
 * 完成后编排进程删除该隔离库，不访问既有业务库。
 */

import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createIsolatedMysql } from './mysql-isolation.js'

import {
  closeAllMysqlBackends,
  MYSQL_DIALECT,
  openPortalStore,
  sharedMysqlBackend,
  type PortalStore,
} from '@ai-token-report/core/db'

// ── 配置 ────────────────────────────────────────────────────────────────────

/**
 * 管理连接使用 ATR_V4_TEST_MYSQL_URL 或本机开发容器，子进程只继承随机隔离目标。
 */
const isolation = process.env.ATR_MYSQL_NODE_VERIFY_CHILD === '1' ? null : await createIsolatedMysql()
const MYSQL_URL = isolation?.url ?? process.env.ATR_MYSQL_URL!
if (!MYSQL_URL || !/^\/atr_http_v4_\d+_[a-f0-9]{8}$/.test(new URL(MYSQL_URL).pathname)) throw new Error('只允许本次创建的隔离测试库')

/** 只用于断言「门面描述里绝不出现密码」。⚠️ 别把它打印出来。 */
const PASSWORD = /\/\/[^:/?#]+:([^@]*)@/.exec(MYSQL_URL)?.[1] ?? ''

/** 本脚本造的行统一带这个前缀；清理时按它精确 DELETE。 */
const SESSION_PREFIX = 'verify-mysql-node'

/** 子进程模式的开关（编排模式会设上它）。 */
const CHILD_ENV = 'ATR_MYSQL_NODE_VERIFY_CHILD'

/** 子进程把 `changes` 实测值写到这个文件，编排侧读回来做**两驱动对照**。 */
const CHILD_METRICS_ENV = 'ATR_MYSQL_NODE_METRICS_FILE'

// ── 断言脚手架 ──────────────────────────────────────────────────────────────

let passed = 0
let failed = 0

function check(label: string, cond: boolean, extra = ''): void {
  if (cond) {
    passed++
    console.log(`  ✅ ${label}`)
  } else {
    failed++
    console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ''}`)
  }
}

/** 把连接串里的密码抹掉（日志会被人贴进工单）。 */
function redact(url: string): string {
  return url.replace(/\/\/([^:/?#]+):([^@]*)@/, '//$1:***@')
}

// ── 两个驱动的 `changes` 对照 ───────────────────────────────────────────────

/** `measureChanges()` 需要的最小能力（`PortalStore` 与 `MysqlBackend` 都满足）。 */
interface ChangeProbe {
  run(sql: string, params?: Record<string, unknown>): Promise<{ changes: number }>
}

/** ★ 本仓**唯一**消费 `changes` 的语义就是这两条（`ingest.ts` 的去重判据）。 */
const CONSUMED_CHANGES = new Set(['INSERT IGNORE 新插入', 'INSERT IGNORE 撞主键'])

/**
 * 量一组固定语句的 `changes`。
 *
 * ★ **Bun 侧与 Node 侧跑的是逐字相同的 SQL**（都用 `MYSQL_DIALECT` 拼），
 *   所以两列数字的差异只可能来自驱动。
 *
 * ⚠️ 实测到的差异（见输出里的对照表）：`INSERT IGNORE` 的 0/1 两边一致，
 *   而「匹配上但值没变」的 `UPDATE` / ODKU 是 **Bun 0 / mysql2 1**（mysql2 默认带
 *   `CLIENT_FOUND_ROWS`）。本仓不消费后者的返回值，但必须把它钉在输出里 ——
 *   这类差异不会报错，只会让将来某个「靠 changes 判有没有写进去」的人踩坑。
 */
async function measureChanges(probe: ChangeProbe, sessionId: string): Promise<Record<string, number>> {
  const insertIgnore =
    `${MYSQL_DIALECT.insertIgnore('usage_event')} ` +
    '(event_id, session_id, seq, ts, provider, model, cwd, input_tokens) ' +
    'VALUES ($eventId, $sessionId, $seq, $ts, $provider, $model, $cwd, $input)'
  const upsert = MYSQL_DIALECT.render({
    table: 'usage_event',
    columns: ['event_id', 'session_id', 'seq', 'ts', 'provider', 'model', 'cwd', 'input_tokens'],
    values: '$eventId, $sessionId, $seq, $ts, $provider, $model, $cwd, $input',
    keyColumn: 'event_id',
    assignments: [
      `input_tokens = ${MYSQL_DIALECT.scalarMax(
        'usage_event.input_tokens',
        `${MYSQL_DIALECT.incoming}.input_tokens`,
      )}`,
      `cwd = COALESCE(${MYSQL_DIALECT.incoming}.cwd, usage_event.cwd)`,
    ],
  })

  const row = (n: number): Record<string, unknown> => ({
    $eventId: `${sessionId}:${n}`,
    $sessionId: sessionId,
    $seq: 1,
    $ts: Date.now(),
    $provider: 'dashscope',
    $model: 'qwen-max',
    $cwd: 'D:\\changes',
    $input: 100,
  })

  const out: Record<string, number> = {}
  out['INSERT IGNORE 新插入'] = (await probe.run(insertIgnore, row(1))).changes
  out['INSERT IGNORE 撞主键'] = (
    await probe.run(insertIgnore, { ...row(1), $input: 999_999 })
  ).changes
  out['UPDATE 匹配但值没变'] = (
    await probe.run('UPDATE usage_event SET input_tokens = $v WHERE event_id = $id', {
      $id: row(1)['$eventId'],
      $v: 100,
    })
  ).changes
  out['ODKU 真的改了值'] = (
    await probe.run(upsert, { ...row(1), $input: 200, $cwd: 'D:\\changes-2' })
  ).changes
  out['ODKU 匹配但值没变'] = (
    await probe.run(upsert, { ...row(1), $input: 200, $cwd: 'D:\\changes-2' })
  ).changes
  return out
}

// ─────────────────────────────────────────────────────────────
// 模式一：编排（在 Bun 下运行）
// ─────────────────────────────────────────────────────────────

/** 删掉一个「指向目录的链接」本身，绝不跟随它。 */
function removeDirLink(path: string): void {
  if (!existsSync(path)) return
  // ⚠️ Windows 上删「目录链接」要用 rmdir（unlink 会 EPERM），
  //   Unix 上符号链接要用 unlink（rmdir 会 ENOTDIR）。两种都试一遍。
  try {
    rmdirSync(path)
    return
  } catch {
    /* 落到 unlink */
  }
  try {
    unlinkSync(path)
  } catch {
    /* 删不掉也不影响结论，后面 rmSync 还会兜一次 */
  }
}

/** 找到的 Node（外加被跳过的那几个冒充者，用于打印事实）。 */
interface RealNode {
  bin: string
  version: string
  /** 被跳过的候选（`typeof Bun !== 'undefined'` 的那些）。 */
  rejected: string[]
}

/**
 * 找到**真** Node。
 *
 * 🚨 **不能直接 spawn `node`**：经 `bun run <package.json 里的脚本>` 启动时，
 *   Bun 会把它自己的一份**副本**（`%TEMP%\bun-node-<hash>\node.exe`，86 MB，
 *   与 `bun.exe` 同体积）当作 `node` 放到 PATH 前面 —— 于是「用 Node 跑一遍」
 *   会静默变成「再用 Bun 跑一遍」，走的还是 `Bun.sql`，而脚本会**看起来通过**。
 *   本脚本第一次运行就是被自己的 `typeof Bun` 断言抓出来的。
 *   ⇒ 认「真 Node」的唯一可靠办法是**跑一次问它**：`node -p "typeof Bun"` 必须是
 *     `undefined`。（`ATR_NODE_BIN` 可以显式指定。）
 */
function findRealNode(): RealNode | null {
  const exe = process.platform === 'win32' ? 'node.exe' : 'node'
  const candidates: string[] = []
  const explicit = process.env['ATR_NODE_BIN']
  if (explicit) candidates.push(explicit)
  // Bun 自己知道哪个才是真 node（实测 `Bun.which('node')` 会跳过它那个副本）
  const viaBun = (globalThis as { Bun?: { which?: (name: string) => string | null } }).Bun?.which?.(
    'node',
  )
  if (typeof viaBun === 'string' && viaBun !== '') candidates.push(viaBun)
  for (const dir of (process.env['PATH'] ?? '').split(process.platform === 'win32' ? ';' : ':')) {
    if (dir.trim() !== '') candidates.push(join(dir, exe))
  }
  for (const dir of ['C:\\Program Files\\nodejs', '/usr/local/bin', '/usr/bin', '/opt/homebrew/bin']) {
    candidates.push(join(dir, exe))
  }

  const rejected: string[] = []
  const seen = new Set<string>()
  for (const bin of candidates) {
    if (seen.has(bin) || !existsSync(bin)) continue
    seen.add(bin)
    const probe = spawnSync(bin, ['-p', 'typeof Bun'], { encoding: 'utf8' })
    if (probe.status !== 0) continue
    const kind = (probe.stdout ?? '').trim()
    if (kind !== 'undefined') {
      rejected.push(`${bin}（typeof Bun = ${kind} —— 这是 Bun 给自己准备的 node 副本）`)
      continue
    }
    const version = spawnSync(bin, ['--version'], { encoding: 'utf8' })
    return { bin, version: (version.stdout ?? '').trim(), rejected }
  }
  return null
}

/**
 * 编排侧的 **Bun.sql 对照列**：同一批语句在 Bun 上 `changes` 是多少。
 *
 * ★ 全程在**一个事务里跑完就抛错回滚** —— 这一步只为量数，绝不能真往业务表里写东西。
 *   （`usage_event` 若还不存在，`openPortalStore()` 会先把 schema 建好；DDL 不在事务里。）
 */
async function measureBunChanges(store: PortalStore): Promise<Record<string, number>> {
  const sessionId = `${SESSION_PREFIX}-changes-bun`
  let measured: Record<string, number> = {}
  await store
    .transaction(async (tx) => {
      measured = await measureChanges(tx, sessionId)
      throw new Error('__atr_measure_rollback__')
    })
    .catch((err: unknown) => {
      if (!(err instanceof Error) || err.message !== '__atr_measure_rollback__') throw err
    })
  const left = await store.get<{ c: unknown }>(
    'SELECT COUNT(*) AS c FROM usage_event WHERE session_id LIKE $p',
    { $p: `${sessionId}%` },
  )
  check('★ Bun 侧对照测量已在事务里回滚干净（一行都没留下）', Number(left?.c ?? -1) === 0, String(left?.c))
  return measured
}

async function orchestrate(): Promise<number> {
  const selfPath = fileURLToPath(import.meta.url)
  const serverRoot = resolve(dirname(selfPath), '..')
  const tmpRoot = mkdtempSync(join(tmpdir(), 'atr-verify-mysql-node-'))
  const bundle = join(tmpRoot, 'verify-mysql-node.mjs')
  /** 真实的 `node_modules/`（junction 不能落在它自己身上，见文件头）。 */
  const tmpModules = join(tmpRoot, 'node_modules')
  const mysql2Link = join(tmpModules, 'mysql2')
  let childCode = 1

  console.log('='.repeat(72))
  console.log('Node 侧 MySQL 后端验证：bun build --target=node → 真 Node 运行')
  console.log('='.repeat(72))
  console.log(`入口      : ${selfPath}`)
  console.log(`临时产物  : ${bundle}`)
  console.log(`MySQL     : ${redact(MYSQL_URL)}`)

  // ── 0. 先找到真 Node（见 findRealNode：`bun run` 会让 node 变成 Bun 的副本）──
  const node = findRealNode()
  if (node === null) {
    console.log(
      '\n❌ 找不到真 Node（Node 没有内建 MySQL 客户端，这条通路只能在 Node 上验）。\n' +
        '   安装 Node ≥ 22，或用 ATR_NODE_BIN 指到 node 可执行文件。',
    )
    return 1
  }
  for (const item of node.rejected) {
    console.log(`  ⚠️ 已跳过冒充 node 的 Bun 副本：${item}`)
  }
  console.log(`Node      : ${node.bin}（${node.version}）`)

  // ── 0b. 从**部门服务端包**的角度解析 mysql2 的位置（与运行期同一条解析路径）──
  let mysql2Dir: string | null = null
  try {
    mysql2Dir = dirname(createRequire(join(serverRoot, 'package.json')).resolve('mysql2/promise'))
  } catch {
    mysql2Dir = null
  }
  if (mysql2Dir === null) {
    console.log(
      '\n❌ 从 packages/server 解析不到 mysql2 —— Node 侧那条路没法验。\n' +
        '   安装：cd packages/server && bun add mysql2',
    )
    return 1
  }
  console.log(`mysql2    : ${mysql2Dir}`)

  try {
    // ── 1. 打包（与 npm 产物同一条通路：`bun build --target=node`）──────────
    const build = spawnSync(
      process.execPath,
      ['build', selfPath, '--target=node', `--outfile=${bundle}`],
      { encoding: 'utf8' },
    )
    if (build.status !== 0) {
      failed++
      console.log(`\n❌ 打包失败（exit ${String(build.status)}）：\n${build.stderr ?? ''}`)
      return 1
    }
    if (build.stderr && build.stderr.trim() !== '') {
      console.log(`  （bun build 的提示：${build.stderr.trim()}）`)
    }

    // ★ 产物层面的硬证据：说明符必须**构建期不可静态分析** ——
    //   一旦被折叠成字面量，打包器就会把 mysql2 与它的传递依赖塞进产物，
    //   而 `verify:npm` 断言发布产物零运行时依赖。
    const text = readFileSync(bundle, 'utf8')
    check(
      '★ 产物里没有 mysql2 的静态 import（说明符不可静态分析）',
      !/from\s*['"]mysql2/.test(text) && !/require\(\s*['"]mysql2/.test(text),
    )
    check('产物里保留了运行期才求值的说明符 mysql2/promise', text.includes('mysql2/promise'))

    // ── 2. 让临时产物与**部署形态**处在同一个解析环境 ─────────────────────
    // ⚠️ `node_modules` 本身必须是真的目录，junction 只做在 `mysql2` 这一层（见文件头）。
    mkdirSync(tmpModules, { recursive: true })
    symlinkSync(mysql2Dir, mysql2Link, process.platform === 'win32' ? 'junction' : 'dir')

    // ── 3. 用 Node 跑（🚨 先清代理变量：末尾带 LF 的 HTTP_PROXY 会让 Node
    //       在 node:http 求值阶段抛 ERR_PROXY_INVALID_CONFIG）───────────────
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) env[key] = value
    }
    for (const key of [
      'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY',
      'http_proxy', 'https_proxy', 'all_proxy',
    ]) {
      delete env[key]
    }
    env[CHILD_ENV] = '1'
    env.ATR_MYSQL_URL = MYSQL_URL
    const metricsFile = join(tmpRoot, 'changes.json')
    env[CHILD_METRICS_ENV] = metricsFile

    // ── 4. Bun.sql 对照列（在同一事务里量完就回滚，不留痕）───────────────
    const bunChanges = await measureBunChanges(
      await openPortalStore({ sqlitePath: join(tmpdir(), 'atr-verify-mysql-node-orch.sqlite'), mysqlUrl: MYSQL_URL }),
    )

    // ── 5. 用真 Node 跑产物 ────────────────────────────────────────────────
    const child = spawnSync(node.bin, [bundle], { encoding: 'utf8', env, cwd: tmpRoot })
    process.stdout.write(child.stdout ?? '')
    process.stderr.write(child.stderr ?? '')
    childCode = child.status ?? 1
    if (child.error) {
      failed++
      console.log(`\n❌ 无法用 Node 运行产物：${child.error.message}`)
    }

    // ── 6. 两驱动对照：同一批语句的 `changes` ─────────────────────────────
    let nodeChanges: Record<string, number> | null = null
    try {
      nodeChanges = JSON.parse(readFileSync(metricsFile, 'utf8')) as Record<string, number>
    } catch {
      nodeChanges = null
    }
    console.log('\n【对照】同一批语句的 `changes`：Bun.sql vs mysql2')
    if (nodeChanges === null) {
      failed++
      console.log('  ❌ 子进程没有回报 changes 实测值（metrics 文件缺失或读不懂）')
    } else {
      for (const [label, bunValue] of Object.entries(bunChanges)) {
        const nodeValue = nodeChanges[label]
        const consumed = CONSUMED_CHANGES.has(label)
        const same = bunValue === nodeValue
        const mark = same ? '✅' : consumed ? '❌' : '⚠️'
        console.log(
          `  ${mark} ${label}：Bun=${String(bunValue)} / mysql2=${String(nodeValue)}` +
            (same ? '' : consumed ? '  ← 🚨 去重判据不一致！' : '  ← 本仓不消费（见 core/src/db/mysql.ts）'),
        )
        if (consumed) {
          check(`★ ${label} 两个驱动一致（= ${String(bunValue)}）`, same)
        }
      }
    }
  } finally {
    // ⚠️ 先摘掉 junction 本身，再递归删临时目录：任何「跟随链接」的删除实现
    //   都会把 packages/server/node_modules/mysql2 整个删掉。
    removeDirLink(mysql2Link)
    try {
      rmSync(tmpRoot, { recursive: true, force: true })
    } catch {
      /* 临时目录删不掉不影响结论 */
    }
    check('★ junction 的**目标**没有被误删（packages/server 里的 mysql2 还在）', existsSync(mysql2Dir))
  }

  console.log('\n' + '='.repeat(72))
  console.log(`编排退出码  : ${childCode}（0 = 全部断言通过）`)
  console.log(`编排自身断言: ${failed === 0 ? '通过' : `${failed} 项失败`}`)
  console.log('='.repeat(72))
  return childCode !== 0 || failed > 0 ? 1 : 0
}

// ─────────────────────────────────────────────────────────────
// 模式二：断言（在 Node 里运行）
// ─────────────────────────────────────────────────────────────

async function runAssertions(): Promise<number> {
  console.log('='.repeat(72))
  console.log('Node + mysql2 + 我们的驱动/门面（真 MySQL，非 mock）')
  console.log('='.repeat(72))
  console.log(`Node    : ${process.version}（${process.execPath}）`)
  console.log(`MySQL   : ${redact(MYSQL_URL)}`)

  /** 一个**不会被创建**的 SQLite 路径：用来证明没有偷偷退化成 SQLite。 */
  const sqlitePath = join(tmpdir(), `atr-verify-mysql-node-${process.pid}.sqlite`)
  const prefixParams = { $prefix: `${SESSION_PREFIX}%` }
  let store: PortalStore | null = null

  try {
    // ── 【1】运行时与后端身份 ──────────────────────────────────────────────
    console.log('\n【1】确实在 Node 上，且拿到的是 mysql2 后端')
    check(
      '★ 真的跑在 Node 上（globalThis.Bun 不存在）',
      typeof (globalThis as { Bun?: unknown }).Bun === 'undefined',
      `Bun=${String(typeof (globalThis as { Bun?: unknown }).Bun)}`,
    )
    check(
      'Node 主版本 ≥ 22（发布产物 engines 的下限）',
      Number(process.versions.node.split('.')[0]) >= 22,
      process.versions.node,
    )

    const promise = sharedMysqlBackend(MYSQL_URL)
    const backend = await promise
    check('★ 驱动是 mysql2（不是 Bun.sql）', backend.driver === 'mysql2', backend.driver)
    check(
      '★ 连接池在进程内共享（第二次取回同一个 Promise）',
      sharedMysqlBackend(MYSQL_URL) === promise,
    )
    const version = await backend.get<{ v: unknown }>('SELECT VERSION() AS v')
    check(
      'version() 能查（连接真的通了）',
      typeof version?.v === 'string' && /^\d+\.\d+\.\d+/.test(String(version.v)),
      JSON.stringify(version),
    )

    store = await openPortalStore({ sqlitePath, mysqlUrl: MYSQL_URL })
    check('门面 kind 是 mysql', store.kind === 'mysql', store.kind)
    check(
      '🚨 门面描述里没有密码（启动横幅会打印它）',
      PASSWORD !== '' && !store.label.includes(PASSWORD),
      store.label,
    )
    check('★ 没有走 SQLite 退路（那个库文件根本没被创建）', !existsSync(sqlitePath), sqlitePath)

    // ── 【2】exec() 的多语句通路 ──────────────────────────────────────────
    console.log('\n【2】exec() 的多语句通路（MySQL 的 DDL 就是多条语句拼一起）')
    let multiOk = true
    try {
      await store.exec('SELECT 1; SELECT 2')
    } catch (err) {
      multiOk = false
      console.log(`     ${err instanceof Error ? err.message : String(err)}`)
    }
    check('★ exec() 接受多语句（multipleStatements 真的生效了）', multiOk)

    const tables = await store.all<{ t: string }>(
      'SELECT table_name AS t FROM information_schema.tables WHERE table_schema = DATABASE()',
    )
    const names = tables.map((r) => r.t)
    check(
      '三张业务表都在（说明那串多语句 DDL 真的跑过了）',
      ['usage_event', 'ingest_run', 'portal_meta'].every((t) => names.includes(t)),
      JSON.stringify(names),
    )

    // ── 【3】INSERT IGNORE 幂等 ───────────────────────────────────────────
    console.log('\n【3】★ INSERT IGNORE 幂等：首插 changes=1 / 重插 changes=0 / 归属不被覆盖')
    // ★ 用真实的方言层拼语句，不在脚本里另写一份 SQL
    const insertSql =
      `${MYSQL_DIALECT.insertIgnore('usage_event')} ` +
      '(event_id, session_id, seq, ts, provider, model, cwd, user_id, user_name, dept, input_tokens) ' +
      'VALUES ($eventId, $sessionId, $seq, $ts, $provider, $model, $cwd, $userId, $userName, $dept, $input)'
    check(
      '幂等前缀是 INSERT IGNORE INTO（不是 SQLite 的 INSERT OR IGNORE）',
      insertSql.startsWith('INSERT IGNORE INTO'),
      insertSql.slice(0, 32),
    )

    const dedupEvent = `${SESSION_PREFIX}:dedup:1`
    const dedupBase = {
      $eventId: dedupEvent,
      $sessionId: `${SESSION_PREFIX}-dedup`,
      $seq: 1,
      $ts: Date.now(),
      $provider: 'dashscope',
      $model: 'qwen-max',
      $cwd: 'D:\\proj',
      $input: 1000,
    }
    const first = await store.run(insertSql, {
      ...dedupBase,
      $userId: 'u-1',
      $userName: '张三',
      $dept: '研发一部',
    })
    check('首插 changes=1', first.changes === 1, String(first.changes))

    const dup = await store.run(insertSql, {
      ...dedupBase,
      $userId: 'u-9',
      $userName: '李四',
      $dept: '研发二部',
      $input: 999_999,
    })
    check('★ 重插 changes=0（这就是去重判据，与 Bun 侧一致）', dup.changes === 0, String(dup.changes))

    const kept = await store.get<{ user_name: unknown; dept: unknown; input_tokens: unknown }>(
      'SELECT user_name, dept, input_tokens FROM usage_event WHERE event_id = $id',
      { $id: dedupEvent },
    )
    check(
      '★ 归属以先到的为准（没被李四覆盖）',
      kept?.user_name === '张三' && kept?.dept === '研发一部',
      JSON.stringify(kept),
    )
    check('token 数也没被覆盖', Number(kept?.input_tokens) === 1000, JSON.stringify(kept))

    // ── 【4】SUM(BIGINT) 返回字符串 ───────────────────────────────────────
    console.log('\n【4】★ SUM(BIGINT) 经 mysql2 返回**字符串** → 必须 Number() 归一')
    await store.run(insertSql, {
      ...dedupBase,
      $eventId: `${SESSION_PREFIX}:sum:2`,
      $seq: 2,
      $input: 2000,
      $userId: 'u-1',
      $userName: '张三',
      $dept: '研发一部',
    })
    const agg = await store.get<{ calls: unknown; input: unknown }>(
      `SELECT COUNT(*) AS calls, SUM(input_tokens) AS input
       FROM usage_event WHERE session_id LIKE $prefix`,
      { $prefix: `${SESSION_PREFIX}-dedup%` },
    )
    check('COUNT(*) 是数字（对照：只有 SUM 是字符串）', typeof agg?.calls === 'number', typeof agg?.calls)
    check(
      '🚨 SUM(BIGINT) 返回字符串 —— 这就是那个最容易静默出错的地方',
      typeof agg?.input === 'string',
      `${typeof agg?.input} ${String(agg?.input)}`,
    )
    check(
      '★ Number() 归一后是有限数字，且等于脚本手算的 3000',
      Number.isFinite(Number(agg?.input)) && Number(agg?.input) === 3000,
      String(agg?.input),
    )
    const empty = await store.get<{ s: unknown }>(
      'SELECT SUM(input_tokens) AS s FROM usage_event WHERE session_id LIKE $p',
      { $p: `${SESSION_PREFIX}-none%` },
    )
    check('空结果集的 SUM 是 null（驱动不会给 0）', empty?.s === null, JSON.stringify(empty))
    check('null 归一后应是 0 而不是 NaN', Number(empty?.s ?? 0) === 0, String(Number(empty?.s ?? 0)))

    // ── 【5】provider-model 拼接键 ────────────────────────────────────────
    console.log('\n【5】★ provider-model 的拼接键是 `a/b`，不是 0/1')
    const concatExpr = MYSQL_DIALECT.concat(['provider', "'/'", 'model'])
    check(
      '方言层给的是 CONCAT（且不含 ||）',
      concatExpr.includes('CONCAT') && !concatExpr.includes('||'),
      concatExpr,
    )
    const orRow = await store.get<{ k: unknown }>("SELECT $a || '/' || $b AS k", {
      $a: 'dashscope',
      $b: 'qwen-max',
    })
    check(
      '🚨 裸 `||` 在 MySQL 里确实是逻辑或（返回 0）—— 这条证明方言层不是多此一举',
      Number(orRow?.k) === 0,
      JSON.stringify(orRow),
    )
    for (const [seq, provider, model] of [
      [1, 'dashscope', 'qwen-max'],
      [2, 'openai', 'gpt-4o'],
    ] as const) {
      await store.run(insertSql, {
        ...dedupBase,
        $eventId: `${SESSION_PREFIX}:pm:${seq}`,
        $sessionId: `${SESSION_PREFIX}-pm`,
        $seq: seq,
        $provider: provider,
        $model: model,
        $input: 10 * seq,
        $userId: 'u-1',
        $userName: '张三',
        $dept: '研发一部',
      })
    }
    const grouped = await store.all<{ grp_key: string; calls: unknown }>(
      `SELECT ${concatExpr} AS grp_key, COUNT(*) AS calls
       FROM usage_event WHERE session_id LIKE $p GROUP BY grp_key ORDER BY grp_key`,
      { $p: `${SESSION_PREFIX}-pm%` },
    )
    const keys = grouped.map((r) => r.grp_key)
    check(
      '★ 分组键是真实拼接结果',
      JSON.stringify(keys) === JSON.stringify(['dashscope/qwen-max', 'openai/gpt-4o']),
      JSON.stringify(keys),
    )
    check(
      '🚨 键里没有 "0"/"1"（逻辑或的典型症状）',
      !keys.includes('0') && !keys.includes('1'),
      JSON.stringify(keys),
    )
    check('每个键都含分隔符 "/"', keys.every((k) => k.includes('/')), JSON.stringify(keys))

    // ── 【6】upsert（dialect.render()）────────────────────────────────────
    console.log('\n【6】★ upsert：GREATEST 取最大 / COALESCE 的 cwd 语义')
    const upsert = MYSQL_DIALECT.render({
      table: 'usage_event',
      columns: [
        'event_id', 'session_id', 'seq', 'ts', 'provider', 'model',
        'cwd', 'user_id', 'user_name', 'dept', 'input_tokens',
      ],
      values:
        '$eventId, $sessionId, $seq, $ts, $provider, $model, $cwd, $userId, $userName, $dept, $input',
      keyColumn: 'event_id',
      assignments: [
        `input_tokens = ${MYSQL_DIALECT.scalarMax(
          'usage_event.input_tokens',
          `${MYSQL_DIALECT.incoming}.input_tokens`,
        )}`,
        `cwd = COALESCE(${MYSQL_DIALECT.incoming}.cwd, usage_event.cwd)`,
      ],
    })
    check(
      '模板用 GREATEST 而不是 MAX（MySQL 的 MAX() 是聚合函数）',
      upsert.includes('GREATEST') && !upsert.includes('MAX('),
      upsert.slice(-150),
    )
    check(
      '模板用 AS new ON DUPLICATE KEY UPDATE（8.4 已废弃 VALUES()）',
      upsert.includes('AS new ON DUPLICATE KEY UPDATE'),
      upsert.slice(-110),
    )

    const upsertEvent = `${SESSION_PREFIX}:upsert:1`
    const upsertBase = {
      $eventId: upsertEvent,
      $sessionId: `${SESSION_PREFIX}-upsert`,
      $seq: 1,
      $ts: Date.now(),
      $provider: 'dashscope',
      $model: 'qwen-max',
      $userId: 'u-1',
      $userName: '张三',
      $dept: '研发一部',
    }
    const upFirst = await store.run(upsert, { ...upsertBase, $cwd: 'D:\\first', $input: 500 })
    check('首次 upsert 是插入（changes=1）', upFirst.changes === 1, String(upFirst.changes))

    // 更小的值 + cwd=null：GREATEST 不能回退，COALESCE 不能冲掉已知值
    const upSmallChanges = (
      await store.run(upsert, { ...upsertBase, $cwd: null, $input: 100 })
    ).changes
    const upSmall = await store.get<{ input_tokens: unknown; cwd: unknown }>(
      'SELECT input_tokens, cwd FROM usage_event WHERE event_id = $id',
      { $id: upsertEvent },
    )
    check('★ GREATEST 取最大值（100 不会把 500 改小）', Number(upSmall?.input_tokens) === 500, JSON.stringify(upSmall))
    check('★ cwd 的 null 不冲掉已知值', upSmall?.cwd === 'D:\\first', JSON.stringify(upSmall))

    // 更大的值 + 非空 cwd：两者都该更新
    const upBigChanges = (
      await store.run(upsert, { ...upsertBase, $cwd: 'D:\\second', $input: 900 })
    ).changes
    const upBig = await store.get<{ input_tokens: unknown; cwd: unknown }>(
      'SELECT input_tokens, cwd FROM usage_event WHERE event_id = $id',
      { $id: upsertEvent },
    )
    check('★ 更大的值能覆盖（900 > 500）', Number(upBig?.input_tokens) === 900, JSON.stringify(upBig))
    check('★ 非空 cwd 能覆盖', upBig?.cwd === 'D:\\second', JSON.stringify(upBig))

    // ⚠️ 实测记录（**都不是**「必须等于某个数」的断言，只把真实值钉在输出里）：
    //   mysql2 默认带 `CLIENT_FOUND_ROWS`（`connection_config.js` 的
    //   `getDefaultFlags` 里就有它），所以「匹配上但值没变」的行，
    //   `affectedRows` 给的是**匹配行数**而不是改动行数（`UPDATE` 也一样）。
    //   本仓只在 `INSERT IGNORE` 的 0/1 上消费 `changes`（去重判据，上面已钉住 = 0），
    //   UPSERT 的返回值从不被消费（见 `ingest.ts` 的 `recordIngestMoment`）
    //   ⇒ 两个驱动在这里即使不同也不影响正确性。**两个驱动的完整对照表由本脚本
    //     自己量出来并并排打印**（见下面的【6b】与编排侧的对照），不靠人肉记忆。
    const upNoop = await store.run(upsert, { ...upsertBase, $cwd: 'D:\\second', $input: 900 })
    console.log(
      `     （实测 changes：插入=${first.changes}｜更小值+null=${upSmallChanges}｜` +
        `更大值+新 cwd=${upBigChanges}｜完全重复=${upNoop.changes}）`,
    )
    check(
      `完全重复的 upsert 返回有限数字 changes=${upNoop.changes}（该值不被本仓消费，仅记录）`,
      Number.isFinite(upNoop.changes),
      String(upNoop.changes),
    )

    // ── 【6b】本侧（mysql2）的 changes 实测列 ─────────────────────────────
    // 编排侧会用**逐字相同**的语句量一遍 Bun.sql，然后并排打出来。
    console.log('\n【6b】changes 实测（mysql2 这一列；Bun 对照列由编排侧量出后并排打印）')
    const changes = await measureChanges(store, `${SESSION_PREFIX}-changes-node`)
    for (const [label, value] of Object.entries(changes)) {
      console.log(`  · ${label}：${String(value)}`)
    }
    check(
      '★ INSERT IGNORE 撞主键 = 0（本仓的去重判据，两个驱动都必须一致）',
      changes['INSERT IGNORE 撞主键'] === 0,
      String(changes['INSERT IGNORE 撞主键']),
    )
    check('INSERT IGNORE 新插入 = 1', changes['INSERT IGNORE 新插入'] === 1, String(changes['INSERT IGNORE 新插入']))
    const metricsFile = process.env[CHILD_METRICS_ENV]
    if (metricsFile) {
      writeFileSync(metricsFile, JSON.stringify(changes), 'utf8')
    } else {
      failed++
      console.log('  ❌ 没拿到 metrics 文件路径（编排侧环境变量缺失）')
    }

    // ── 【7】事务：同一个连接 + 抛错必须回滚 ──────────────────────────────
    console.log('\n【7】★ 事务：回调里的语句必须跑在**同一条连接**上，抛错必须回滚')
    const txRow = {
      ...dedupBase,
      $sessionId: `${SESSION_PREFIX}-tx`,
      $userId: 'u-1',
      $userName: '张三',
      $dept: '研发一部',
      $input: 1,
    }
    const thrown = await store
      .transaction(async (tx) => {
        const connA = await tx.get<{ id: unknown }>('SELECT CONNECTION_ID() AS id')
        await tx.run(insertSql, { ...txRow, $eventId: `${SESSION_PREFIX}:tx:1` })
        const connB = await tx.get<{ id: unknown }>('SELECT CONNECTION_ID() AS id')
        check(
          '事务内两次查询在同一条连接上（CONNECTION_ID 相同）',
          connA?.id !== undefined && connA.id === connB?.id,
          `${String(connA?.id)} vs ${String(connB?.id)}`,
        )
        throw new Error('verify-mysql-node: 故意抛错以验证回滚')
      })
      .then(
        () => null,
        (err: unknown) => err,
      )
    check(
      '★ 事务里的抛错被原样抛出（没有被吞掉）',
      thrown instanceof Error && thrown.message.includes('故意抛错'),
      String(thrown),
    )
    const leftTx = await store.get<{ c: unknown }>(
      'SELECT COUNT(*) AS c FROM usage_event WHERE session_id LIKE $p',
      { $p: `${SESSION_PREFIX}-tx%` },
    )
    check(
      '★ 回滚后那批行**不存在**（这同时证明 BEGIN 与 INSERT 在同一条连接上）',
      Number(leftTx?.c) === 0,
      String(leftTx?.c),
    )

    // 对照组：正常提交的事务必须真的写进去（防「事务里什么都没干」）
    await store.transaction(async (tx) => {
      await tx.run(insertSql, { ...txRow, $eventId: `${SESSION_PREFIX}:tx:2` })
    })
    const committed = await store.get<{ c: unknown }>(
      'SELECT COUNT(*) AS c FROM usage_event WHERE event_id = $id',
      { $id: `${SESSION_PREFIX}:tx:2` },
    )
    check('对照组：提交的事务写进去了', Number(committed?.c) === 1, String(committed?.c))
    check(
      '事务结束后连接已还回池（后续查询照常）',
      (await backend.get<{ one: unknown }>('SELECT 1 AS one'))?.one === 1,
    )

    // ── 【8】嵌套事务不重发 BEGIN ─────────────────────────────────────────
    console.log('\n【8】★ 嵌套事务不重发 BEGIN（`START TRANSACTION` 会**隐式提交**外层）')
    const nestedRow = { ...txRow, $eventId: `${SESSION_PREFIX}:nested:1` }
    const nestedThrown = await store
      .transaction(async (tx) => {
        await tx.transaction(async (inner) => {
          await inner.run(insertSql, nestedRow)
        })
        const inside = await tx.get<{ c: unknown }>(
          'SELECT COUNT(*) AS c FROM usage_event WHERE event_id = $id',
          { $id: nestedRow.$eventId },
        )
        check('嵌套写入的行在同一个事务里可见', Number(inside?.c) === 1, String(inside?.c))
        throw new Error('verify-mysql-node: 故意抛错')
      })
      .then(
        () => null,
        (err: unknown) => err,
      )
    check('外层也抛错了', nestedThrown instanceof Error, String(nestedThrown))
    const leftNested = await store.get<{ c: unknown }>(
      'SELECT COUNT(*) AS c FROM usage_event WHERE event_id = $id',
      { $id: nestedRow.$eventId },
    )
    check(
      '★ 外层回滚把嵌套写入的行也带走了（证明嵌套没有隐式提交）',
      Number(leftNested?.c) === 0,
      String(leftNested?.c),
    )

    // ── 【9】utf8mb4 默认字符集 ───────────────────────────────────────────
    console.log('\n【9】默认字符集（4 字节字符往返）')
    const connCharset = await store.get<{ c: unknown }>('SELECT @@character_set_client AS c')
    check('连接字符集是 utf8mb4（与 Bun.sql 一致）', connCharset?.c === 'utf8mb4', String(connCharset?.c))
    const roundTrip = await store.get<{ v: unknown }>('SELECT $v AS v', { $v: '张三🐙abc' })
    check('★ 4 字节字符往返无损', roundTrip?.v === '张三🐙abc', JSON.stringify(roundTrip))
  } catch (err) {
    failed++
    console.log(`\n❌ 未捕获异常：${err instanceof Error ? err.stack ?? err.message : String(err)}`)
  } finally {
    // ── 【10】清理：只删自己造的行，一张表都不碰 ──────────────────────────
    console.log('\n【10】清理（只按 session_id 前缀删自己造的行，绝不 DROP 表）')
    try {
      if (store) {
        const del = await store.run('DELETE FROM usage_event WHERE session_id LIKE $prefix', prefixParams)
        check('已按前缀精确删掉自己造的行', del.changes >= 1, `changes=${del.changes}`)
        const left = await store.get<{ c: unknown }>(
          'SELECT COUNT(*) AS c FROM usage_event WHERE session_id LIKE $prefix',
          prefixParams,
        )
        check('库里已无本脚本的行', Number(left?.c) === 0, String(left?.c))

        const business = await store.all<{ t: string }>(
          'SELECT table_name AS t FROM information_schema.tables ' +
            "WHERE table_schema = DATABASE() AND table_name IN ('usage_event','ingest_run','portal_meta')",
        )
        check('三张业务表都还在（绝不 DROP）', business.length === 3, String(business.length))
        const mine = await store.all<{ t: string }>(
          'SELECT table_name AS t FROM information_schema.tables ' +
            "WHERE table_schema = DATABASE() AND (table_name LIKE 'verify%' OR table_name LIKE '%mysql_node%')",
        )
        check(
          '本脚本没有建过任何表（造数全写进 usage_event）',
          mine.length === 0,
          JSON.stringify(mine.map((r) => r.t)),
        )
      }
    } catch (err) {
      failed++
      console.log(`  ❌ 清理失败：${err instanceof Error ? err.message : String(err)}`)
    }
    // MySQL 后端的 close() 是空操作（连接来自共享池），退出前统一关池
    await closeAllMysqlBackends().catch(() => undefined)
  }

  console.log('\n' + '='.repeat(72))
  if (failed === 0) {
    console.log(`✅ 全部通过：${passed} 项断言（真 Node + 真 mysql2 + 真 MySQL）`)
  } else {
    console.log(`❌ ${failed} 项失败 / 共 ${passed + failed} 项`)
  }
  console.log('='.repeat(72))
  return failed > 0 ? 1 : 0
}

// ─────────────────────────────────────────────────────────────
// 入口：按环境变量二选一
// ─────────────────────────────────────────────────────────────

let code = 1
try { code = process.env[CHILD_ENV] === '1' ? await runAssertions() : await orchestrate() }
finally { await isolation?.dispose() }
process.exit(code)
