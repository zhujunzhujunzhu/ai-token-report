/**
 * 双运行时**逐位对账**：同一个产物、同一个上报库，node22 与 bun 各起一个实例，
 * 逐个 stats 端点的响应体**逐字节比对**。
 *
 * 为什么必须有这一步：Bun 走内建 `Bun.sql`、Node 走可选依赖 `mysql2`——
 * 这是两个完全不同的 MySQL 驱动。「换了驱动数字会不会变」必须先钉死，
 * 否则后面所有性能数字都建立在一个未验证的假设上。
 * （本仓已有 `verify/verify-mysql-portal.ts` 做 SQLite vs MySQL 的对账，这里是**运行时维度**。）
 *
 * 用法：node parity.mjs --a 18901 --b 18902 --token <appKey>
 */
import { writeFileSync } from 'node:fs'
import { mkdirSync } from 'node:fs'

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : fallback
}
const A = Number(arg('a', '18901'))
const B = Number(arg('b', '18902'))
const token = arg('token')
const auth = { Authorization: `Bearer ${token}` }

const Q = 'identity_view=member'
const paths = [
  '/api/health',
  `/api/v1/stats/overview?${Q}&period=last30d`,
  `/api/v1/stats/overview?${Q}&period=today`,
  `/api/v1/stats/overview?${Q}&period=last90d`,
  `/api/v1/stats/series?${Q}&period=last30d&bucket=day`,
  `/api/v1/stats/series?${Q}&period=today&bucket=hour`,
  `/api/v1/stats/series?${Q}&period=last30d&bucket=day&stack=model`,
  `/api/v1/stats/series?${Q}&period=last30d&bucket=day&stack=user`,
  `/api/v1/stats/breakdown?${Q}&period=last30d&by=user`,
  `/api/v1/stats/breakdown?${Q}&period=last30d&by=provider`,
  `/api/v1/stats/breakdown?${Q}&period=last30d&by=model`,
  `/api/v1/stats/breakdown?${Q}&period=last30d&by=provider-model`,
  `/api/v1/stats/breakdown?${Q}&period=last30d&by=project`,
  `/api/v1/stats/breakdown?${Q}&period=last30d&by=group`,
  `/api/v1/stats/breakdown?${Q}&period=last30d&by=day`,
  `/api/v1/stats/breakdown?${Q}&period=today&by=hour`,
  `/api/v1/stats/records?${Q}&period=last30d&limit=100&offset=0`,
  `/api/v1/stats/records?${Q}&period=last30d&limit=1000&offset=0`,
  `/api/v1/stats/diagnostics?${Q}&period=last30d`,
  '/api/v1/stats/groups',
  '/api/v1/stats/members',
  '/api/v1/stats/providers',
  '/api/v1/stats/pricing',
  '/',
]

let pass = 0, fail = 0
const failures = []
console.log('端点'.padEnd(62) + '状态'.padEnd(10) + 'A 字节'.padStart(10) + 'B 字节'.padStart(10) + '  逐位')
for (const path of paths) {
  const [ra, rb] = await Promise.all([
    fetch(`http://127.0.0.1:${A}${path}`, { headers: auth }),
    fetch(`http://127.0.0.1:${B}${path}`, { headers: auth }),
  ])
  const [ta, tb] = await Promise.all([ra.text(), rb.text()])
  const ok = ra.status === rb.status && ta === tb
  if (ok) pass++
  else { fail++; failures.push({ path, statusA: ra.status, statusB: rb.status, bytesA: ta.length, bytesB: tb.length }) }
  console.log(path.slice(0, 60).padEnd(62)
    + `${ra.status}/${rb.status}`.padEnd(10)
    + String(ta.length).padStart(10) + String(tb.length).padStart(10)
    + (ok ? '  ✅ 相同' : '  ❌ 不同'))
}

// 上报：给两个实例各写一批**不同 session** 的事件，ACK 必须逐位相同；
// 再各自重放同一批，两边都必须判「全部重复」。
function payload(mark, count) {
  const session = `abparity-${mark}`
  return {
    schemaVersion: 1,
    client: { userId: 'ab-fixture', userName: 'A/B 夹具' },
    generatedAt: new Date().toISOString(),
    records: Array.from({ length: count }, (_, seq) => ({
      event_id: `${session}:${seq}`, session_id: session, seq, ts: Date.now(),
      provider: 'ab-fixture', model: 'ab-fixture-model', cwd: 'ab-fixture',
      input_tokens: 20000, output_tokens: 1000, cache_read_tokens: 728000, cache_write_tokens: 1000,
      reasoning_tokens: 200, total_tokens: 750000, turn: 1, step: seq,
    })),
  }
}
async function post(port, mark, count) {
  const r = await fetch(`http://127.0.0.1:${port}/api/v1/token-usage`, {
    method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload(mark, count)),
  })
  return { status: r.status, body: await r.json() }
}
const aPost = await post(A, 'node', 50)
const bPost = await post(B, 'bun', 50)
const ackSame = aPost.status === bPost.status && JSON.stringify(aPost.body) === JSON.stringify(bPost.body)
console.log(`\n上报 ACK：node=${JSON.stringify(aPost.body)}  bun=${JSON.stringify(bPost.body)}  ${ackSame ? '✅ 相同' : '❌ 不同'}`)

const aReplay = await post(A, 'node', 50)
const bReplay = await post(B, 'bun', 50)
const replaySame = JSON.stringify(aReplay.body) === JSON.stringify(bReplay.body)
  && aReplay.body.duplicates === 50 && bReplay.body.duplicates === 50
console.log(`重放语义：node=${JSON.stringify(aReplay.body)}  bun=${JSON.stringify(bReplay.body)}  ${replaySame ? '✅ 相同且都判重复' : '❌ 不同'}`)

// 上报完成后**再读一遍统计**：两条写入路径的合计必须仍然逐位一致。
const [afterA, afterB] = await Promise.all([
  fetch(`http://127.0.0.1:${A}/api/v1/stats/overview?${Q}&period=last30d`, { headers: auth }).then((r) => r.text()),
  fetch(`http://127.0.0.1:${B}/api/v1/stats/overview?${Q}&period=last30d`, { headers: auth }).then((r) => r.text()),
])
const afterSame = afterA === afterB
console.log(`写入后合计：${afterSame ? '✅ 逐位相同' : '❌ 不同'}`)

const summary = { pass, fail, ackSame, replaySame, afterSame, failures }
const outDir = process.env['ATR_AB_OUT'] ?? '/tmp/atr-ab-results'
mkdirSync(outDir, { recursive: true })
writeFileSync(`${outDir}/parity.json`, JSON.stringify(summary, null, 2))
console.log(`\n对账：${pass} 项逐位相同 / ${fail} 项不同`)
if (fail) console.log(JSON.stringify(failures, null, 2))
if (fail || !ackSame || !replaySame || !afterSame) process.exitCode = 1
