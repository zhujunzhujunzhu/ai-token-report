/**
 * 性能摸底：造数（隔离 MySQL 库）。
 *
 * ```bash
 * bun run packages/server/verify/perf/seed.ts --scale 1e6
 * bun run packages/server/verify/perf/seed.ts --scale 3e6
 * bun run packages/server/verify/perf/seed.ts --scale 1e6 --dispose
 * ```
 *
 * ★ **只创建 / 删除自己随机命名的隔离库**（`atr_http_v5_*`），不碰任何既有业务库。
 *   状态落在 `.artifacts/perf/<scale>.json`（含 appKey 明文 —— 仅本地临时夹具，
 *   文件在 `.gitignore` 覆盖的 `.artifacts` 下，用完 `--dispose` 即删）。
 *
 * ## 两段式：为什么中间要起一次服务端
 *
 * 人员与 appKey 必须经**真实管理 HTTP 接口**签发（token 只存摘要，手工写库
 * 拿不到明文），所以先用 `createServer()` 空转一次，用管理员凭证建人 + 签发，
 * 再**关掉服务端**直接灌事件 —— 300 万条走 HTTP 太慢，而造数不是被测对象。
 * 压测阶段再重新起服务端，那时表已经灌满。
 *
 * ## 事件归属
 *
 * `usage_event.report_token_id` 有真实外键，所以造数**读回** `report_tokens`
 * 里刚签发的那批 token_id（按 member_id 关联），不自己编 UUID。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'

import { closeAllMysqlBackends, openPortalStore } from '@ai-token-report/core/db'
import { createServer } from '../../src/index.js'
import { createIsolatedMysql } from '../mysql-isolation.js'
import { seedEvents } from './lib-seed.js'

const STATE_DIR = resolve('.artifacts/perf')
const PREFIX = 'perf-member-'

interface PerfState {
  schema: string
  url: string
  adminToken: string
  members: { memberId: string; tokenId: string; token: string }[]
  events: number
  memberCount: number
  createdAt: number
}

function arg(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : fallback
}

function statePath(scale: string): string {
  if (!/^[0-9a-z]+$/.test(scale)) throw new Error(`scale 只允许小写字母数字：${scale}`)
  return join(STATE_DIR, `${scale}.json`)
}

function load(scale: string): PerfState {
  const file = statePath(scale)
  if (!existsSync(file)) throw new Error(`没有 ${file}，先跑 seed.ts --scale ${scale}`)
  return JSON.parse(readFileSync(file, 'utf8')) as PerfState
}

function save(scale: string, state: PerfState): void {
  mkdirSync(STATE_DIR, { recursive: true })
  writeFileSync(statePath(scale), JSON.stringify(state, null, 2))
}

/** 守卫：绝不对非隔离库执行任何写 / 删操作。 */
function assertIsolated(url: string): string {
  const name = new URL(url).pathname.replace(/^\//, '')
  if (!/^atr_http_v5_\d+_[a-f0-9]{8}$/.test(name)) throw new Error(`拒绝操作非隔离库：${name}`)
  return name
}

/** 待测规模：默认 100 万（= 一个月 10 万调用 × 10 个月，也是 300 万的前一站）。 */
const scale = arg('scale', '1e6')!
const events = Number(arg('events', scale))!
const members = Number(arg('members', '200'))!
const days = Number(arg('days', '365'))!
const batch = Number(arg('batch', '2000'))!
/**
 * 事件 `ts` 与插入顺序的关系 —— 直接影响「按时间窗扫描」是顺序读还是随机读。
 *
 * - `random`（默认）：历史补报 / 乱序到达的形态；
 * - `ordered`：**生产形态**（插件与 CLI 在会话进行中实时上报，`received_at_ms ≈ ts`）。
 */
const order = (arg('order', 'random') === 'ordered' ? 'ordered' : 'random') as 'random' | 'ordered'

if (process.argv.includes('--dispose')) {
  const state = load(scale)
  const schema = assertIsolated(state.url)
  const drop = (await import('node:child_process')).spawnSync('docker', ['exec', 'local-database-review-mysql', 'sh', '-c',
    `mysql -uroot -p"$MYSQL_ROOT_PASSWORD" -e "DROP DATABASE IF EXISTS \\\`${schema}\\\`"`], { encoding: 'utf8', windowsHide: true })
  if (drop.status !== 0) throw new Error(`删除隔离库失败：${drop.stderr || drop.stdout}`)
  rmSync(statePath(scale), { force: true })
  await closeAllMysqlBackends()
  console.log(`已删除隔离库 ${schema} 与状态文件`)
  process.exit(0)
}

let state: PerfState
// ── 1. 隔离库 + 结构 + 身份（首次）─────────────────────────────────────────
if (!existsSync(statePath(scale))) {
  const isolation = await createIsolatedMysql()
  const adminToken = 'atr-perf-admin-' + randomBytes(12).toString('hex')
  const home = join(STATE_DIR, `home-${scale}`)
  mkdirSync(home, { recursive: true })
  const server = await createServer({
    host: '127.0.0.1', port: 0, dshHome: home, dataDir: join(home, 'data'),
    dbPath: join(home, 'portal.sqlite'),
    mysqlUrl: isolation.url,
    adminToken, adminName: '性能夹具管理员',
    adminUsername: '', adminPassword: '', captchaHmacKey: '', portalOrigin: '', requestLog: false,
  })
  console.log(`隔离库已建：${isolation.url.replace(/:[^:@/]+@/, ':***@')}（服务端 ${server.url}）`)
  const created: { memberId: string; tokenId: string; token: string }[] = []
  try {
    const rolesRes = await fetch(`${server.url}/api/v1/admin/roles`, { headers: { Authorization: `Bearer ${adminToken}` } })
    const roles = await rolesRes.json() as { roles: { role_id: string; code: string }[] }
    const memberRole = roles.roles.find((role) => role.code === 'member')!
    /**
     * 先建一个分组，再在**建人时**就把 `group_ids` 带上。
     *
     * 为什么要造：`by=group` 与「按分组筛选」在**没有任何关联行**时走的是
     * 子查询返回空集的最快路径 —— 拿空分组去测「分组排行」会得到一个
     * 与真实负载无关的好数字。
     * ⚠️ `group_ids` 只在 `admin/members`（创建）与 `admin/members/update`（全量替换）
     *   上接受，**没有**独立的「加人进组」端点 —— 建完再一个个加会多打 300 次请求。
     */
    const groupRes = await fetch(`${server.url}/api/v1/admin/groups`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '性能造数分组' }),
    })
    const groupBody = await groupRes.json() as { ok?: boolean; group?: { group_id: string }; reason?: string }
    const groupId = groupBody.group?.group_id
    if (!groupId) throw new Error(`建分组失败：${groupBody.reason ?? groupRes.status}`)
    for (let index = 0; index < members; index++) {
      const res = await fetch(`${server.url}/api/v1/admin/members`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: `${PREFIX}${index}`, role_ids: [memberRole.role_id], group_ids: [groupId] }),
      })
      const body = await res.json() as { ok: boolean; member?: { member_id: string }; reason?: string }
      if (!body.ok || !body.member) throw new Error(`建人员失败：${body.reason ?? res.status}`)
      const keyRes = await fetch(`${server.url}/api/v1/admin/members/appkey`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ member_id: body.member.member_id }),
      })
      const key = await keyRes.json() as { ok: boolean; token_secret?: string; reason?: string }
      if (!key.ok || !key.token_secret) throw new Error(`签发 appKey 失败：${key.reason ?? keyRes.status}`)
      created.push({ memberId: body.member.member_id, tokenId: '', token: key.token_secret })
      if ((index + 1) % 50 === 0) console.log(`  身份 ${index + 1}/${members}（已挂进 1 个分组）`)
    }
  } finally {
    await server.stop()
  }
  // 读回刚签发的 token_id（外键要求真实存在，不能自己编）。
  const store = await openPortalStore({ sqlitePath: join(STATE_DIR, 'unused.sqlite'), mysqlUrl: isolation.url })
  try {
    const rows = await store.all<{ member_id: string; token_id: string }>('SELECT member_id, token_id FROM report_tokens')
    const byMember = new Map(rows.map((row) => [String(row.member_id), String(row.token_id)]))
    for (const member of created) member.tokenId = byMember.get(member.memberId) ?? ''
    if (created.some((member) => !member.tokenId)) throw new Error('有人员读不到 token_id，造数的归属会缺列')
  } finally {
    await store.close()
  }
  state = { schema: assertIsolated(isolation.url), url: isolation.url, adminToken, members: created, events: 0, memberCount: members, createdAt: Date.now() }
  save(scale, state)
  console.log(`身份就绪：${created.length} 人（appKey 明文只在本文件里）`)
} else {
  state = load(scale)
  assertIsolated(state.url)
  console.log(`复用已有隔离库 ${state.schema}（已灌 ${state.events} 条）`)
}

// ── 2. 灌事件（增量：只补差额）─────────────────────────────────────────────
if (state.events < events) {
  const target = events - state.events
  console.log(`开始灌 ${target} 条事件（batch=${batch}，${members} 人，${days} 天跨度，顺序=${order}）…`)
  const store = await openPortalStore({ sqlitePath: join(STATE_DIR, 'unused.sqlite'), mysqlUrl: state.url })
  try {
    const started = performance.now()
    const result = await seedEvents(store, {
      events: target,
      members: state.memberCount,
      days,
      batch,
      order,
      prefix: PREFIX,
      seed: 20260101 + state.events,
      memberIds: state.members.map((m) => m.memberId),
      tokenIds: state.members.map((m) => m.tokenId),
    })
    const elapsed = performance.now() - started
    console.log(`灌数完成：${result.inserted} 条 / ${(elapsed / 1000).toFixed(1)}s = ${Math.round(result.inserted / (elapsed / 1000))} 条/秒`)
    state.events += result.inserted
    save(scale, state)
  } finally {
    await store.close()
    await closeAllMysqlBackends()
  }
} else {
  console.log(`事件数已达标（${state.events}），跳过灌数`)
}

// ── 3. 报告表体积（EXPLAIN 与压测的基线）────────────────────────────────────
const store = await openPortalStore({ sqlitePath: join(STATE_DIR, 'unused.sqlite'), mysqlUrl: state.url })
try {
  const size = await store.get<Record<string, unknown>>(
    `SELECT table_rows, ROUND(avg_row_length,0) AS avg_row_length, ROUND(data_length/1024/1024,1) AS data_mb,
            ROUND(index_length/1024/1024,1) AS index_mb, ROUND(data_free/1024/1024,1) AS free_mb
     FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'usage_event'`,
  )
  const exact = await store.get<{ c: unknown }>('SELECT COUNT(*) AS c FROM usage_event')
  console.log(`usage_event：精确 ${Number(exact?.c)} 行；${JSON.stringify(size)}`)
} finally {
  await store.close()
  await closeAllMysqlBackends()
}
