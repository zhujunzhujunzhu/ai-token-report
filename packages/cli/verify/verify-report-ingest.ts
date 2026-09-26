/**
 * 端到端验证：CLI 的**真实投递器**打**真实服务端**，数据真的进库。
 *
 * ```
 * bun run packages/cli/verify/verify-report-ingest.ts
 * ```
 *
 * `packages/server/test/e2e-ingest.ts` 验的是服务端一侧（HTTP 契约）；
 * 这里验的是**④ 通路整条链**，而且用的是 CLI 自己的代码，不是手搓的 fetch：
 *
 * ```
 * 会话日志(zstd) → scanIncremental → pending(state.json)
 *                                   → createHttpDeliverer（真 fetch + Bearer）
 *                                   → POST /api/v1/token-usage
 *                                   → usage_event（带服务端认定的归属）
 *                                   → ack：清 pending
 * ```
 *
 * 这样才回答得了「CLI 能不能上报」这个问题 —— 只测服务端是不够的，
 * 两边字段对不上时（`toWireRecord` vs `record`）只有真往返才暴露。
 *
 * 覆盖四条最容易出错的语义：
 *   1. 增量：只投新增，重跑一轮不重复投递
 *   2. 幂等：服务端的 `event_id` 去重让重发无害
 *   3. 归属：以 token 为准，客户端自填的姓名不生效
 *   4. 崩溃安全：投递失败时 pending 保留（下一轮重试），不静默丢数据
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'

import { loadState, resetState, resolveStatePath } from '@ai-token-report/core'
import { EVENT_TABLE, openDb, preparePortalDatabase } from '@ai-token-report/core/db'
import { createServer } from '@ai-token-report/server'
import { IdentityRepository } from '../../server/src/identity/repository.js'

import { createHttpDeliverer } from '../src/deliver.js'
import { runReport } from '../src/report.js'

const HOME = mkdtempSync(join(tmpdir(), 'atr-verify-report-'))
const PORT = 0
const TOKEN = 'atr-zhangsan-9f3c'

mkdirSync(join(HOME, 'token-report'), { recursive: true })
const dbPath = join(HOME, 'token-report', 'portal.sqlite')
const target = { sqlitePath: dbPath }
await preparePortalDatabase(target)
await new IdentityRepository(target).importCredentials([
  { token: 'report-test-admin', name: '测试管理员', role: 'admin' },
  { token: TOKEN, name: '张三', dept: '研发一部' },
], 'verify-report-ingest')

const sessionsRoot = join(HOME, 'sessions')
const sessionDir = join(sessionsRoot, 'proj-a', 'session-1')
mkdirSync(sessionDir, { recursive: true })
const sessionFile = join(sessionDir, 'session.v3.jsonl.zstd')
writeFileSync(sessionFile, Buffer.alloc(0))

/** 会话首行（带 cwd，用于项目归属）。 */
function sessionLine(): string {
  return JSON.stringify({
    type: 'session',
    version: 3,
    id: 'session-1',
    createdAt: 1_789_545_926_716,
    cwd: 'D:\\Coding\\ai-token-report',
  })
}

/** 一条带 usage 的 assistant 消息。 */
function usageLine(seq: number, input: number, cacheRead: number): string {
  return JSON.stringify({
    type: 'assistant/message',
    seq,
    time: 1_789_545_928_088 + seq * 1000,
    data: {
      turn: 1,
      step: seq,
      message: { source: { kind: 'model', provider: 'dashscope', model: 'deepseek-v4.1-flash' } },
      usage: {
        inputTokens: input,
        outputTokens: 10,
        cacheReadTokens: cacheRead,
        cacheWriteTokens: 0,
        totalTokens: input + 10 + cacheRead,
      },
    },
  })
}

/** 追加一帧（模拟 DSH 的分帧 append）。 */
function appendFrame(lines: string[]): void {
  appendFileSync(sessionFile, zstdCompressSync(Buffer.from(lines.join('\n') + '\n', 'utf8')))
}

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

/** 库里某人的行数 / 总行数。 */
function countRows(where?: { user: string }): number {
  const db = openDb(dbPath)
  try {
    const sql = where
      ? `SELECT COUNT(*) AS c FROM ${EVENT_TABLE} WHERE user_name = ?`
      : `SELECT COUNT(*) AS c FROM ${EVENT_TABLE}`
    return db.query<{ c: number }, [string]>(sql).get(where ? [where.user] : [])?.c ?? 0
  } finally {
    db.close()
  }
}

/** 库里全部记录（按 seq 排序），用于核对四项 token 与归属。 */
function allRows(): {
  event_id: string
  user_name: string | null
  dept: string | null
  input_tokens: number
  cache_read_tokens: number
  cwd: string | null
}[] {
  const db = openDb(dbPath)
  try {
    return db
      .query<
        {
          event_id: string
          user_name: string | null
          dept: string | null
          input_tokens: number
          cache_read_tokens: number
          cwd: string | null
        },
        []
      >(
        `SELECT event_id, user_name, dept, input_tokens, cache_read_tokens, cwd
         FROM ${EVENT_TABLE} ORDER BY seq`,
      )
      .all()
  } finally {
    db.close()
  }
}

const statePath = resolveStatePath(HOME)
const pendingCount = (): number => loadState(statePath).state.pending.length

// ── 1. 起真实服务端 ─────────────────────────────────────────────────────────
console.log('\n【1】启动部门服务端（真实 HTTP）')
const portal = await createServer({
  port: PORT,
  host: '127.0.0.1',
  dshHome: HOME,
  dbPath,
  mysqlUrl: '',
  enableLocalApi: false,
})
console.log(`  服务端: ${portal.url}`)

// ── 2. 造会话日志并跑第一轮上报 ─────────────────────────────────────────────
console.log('\n【2】造日志 → runReport → 真实投递')
appendFrame([sessionLine(), usageLine(1, 7_772, 1_024), usageLine(2, 120, 98_976)])

const deliver = createHttpDeliverer({
  endpoint: `${portal.url}/api/v1/token-usage`,
  token: TOKEN,
  // ★ 归属由服务端按 token 决定；这里**故意**填一个错的姓名，
  //   验证它不会覆盖服务端的判定（与 e2e-identity 的「张三三」同款手法）
  userName: '李四（客户端自称）',
  userId: 'lisi',
})

const first = await runReport({ sessionsRoot, dshHome: HOME, statePath, deliver })
check('扫描出 2 条记录', first.records.length === 2, String(first.records.length))
check('服务端接受 2 条', first.delivered?.accepted === 2, JSON.stringify(first.delivered))
check('无重复', first.delivered?.duplicates === 0)
check('无拒收', first.delivered?.rejected === 0)
check('★ 投递成功后 pending 被清空', pendingCount() === 0)
check('库里有 2 行', countRows() === 2)
check('★ 归属以服务端凭证为准（张三），不是客户端自称的李四', countRows({ user: '张三' }) === 2)

const rows = allRows()
check(
  '四项 token 分列落库且数值一致',
  rows[0]?.input_tokens === 7_772 && rows[0]?.cache_read_tokens === 1_024 && rows[1]?.cache_read_tokens === 98_976,
  JSON.stringify(rows),
)
check('部门落库', rows[0]?.dept === '研发一部')
check('项目归属（cwd）落库', rows[0]?.cwd === 'D:\\Coding\\ai-token-report')
check('幂等键就是 sessionId:seq', rows[0]?.event_id === 'session-1:1')

// ── 3. 再跑一轮：无新增、不重复投递 ─────────────────────────────────────────
console.log('\n【3】没有新日志时再跑一轮')
const second = await runReport({ sessionsRoot, dshHome: HOME, statePath, deliver })
check('本轮无新增记录（水位线已是最新）', second.records.length === 0)
check('未发起重复投递（accepted=0）', (second.delivered?.accepted ?? 0) === 0)
check('库里仍是 2 行', countRows() === 2)

// ── 4. 追加新日志：只投增量 ─────────────────────────────────────────────────
console.log('\n【4】追加一帧后只投增量')
appendFrame([usageLine(3, 500, 2_000)])
const third = await runReport({ sessionsRoot, dshHome: HOME, statePath, deliver })
check('只产出新增的那 1 条', third.records.length === 1, String(third.records.length))
check('服务端接受 1 条', third.delivered?.accepted === 1)
check('库里 3 行（旧的没有重发）', countRows() === 3)

// ── 5. 投递失败：pending 保留，不静默丢数据 ─────────────────────────────────
console.log('\n【5】token 无效时投递失败 → pending 必须保留')
appendFrame([usageLine(4, 300, 900)])
const badDeliver = createHttpDeliverer({
  endpoint: `${portal.url}/api/v1/token-usage`,
  token: 'wrong-token',
})

let threw = false
try {
  await runReport({ sessionsRoot, dshHome: HOME, statePath, deliver: badDeliver })
} catch {
  threw = true
}
check('★ 投递失败会抛错（CLI 据此返回退出码 3）', threw)
check('★ pending 保留 1 条，下一轮会重试', pendingCount() === 1, String(pendingCount()))
check('库里没有多出这一条', countRows() === 3)

// 换成正确的 token，下一轮应把保留的那条补上去
const fourth = await runReport({ sessionsRoot, dshHome: HOME, statePath, deliver })
check('★ 下一轮把 pending 里的记录补投成功', fourth.delivered?.accepted === 1, JSON.stringify(fourth.delivered))
check('pending 已清空', pendingCount() === 0)
check('库里 4 行', countRows() === 4)

// ── 6. 全量重发 → 服务端按 event_id 全部去重 ────────────────────────────────
console.log('\n【6】清掉水位线后全量重发（幂等键的最终收益）')
// `report --reset` 就是这个效果：下次全量重扫，把已入库的记录再发一遍。
// 这在真实运维里很常见（换了状态文件、机器重装、手工 --reset），
// 而它**必须是安全的** —— 否则一次误操作就会让全部门用量翻倍。
resetState(statePath)

const replay = await runReport({ sessionsRoot, dshHome: HOME, statePath, deliver })
check('全量重扫出 4 条', replay.records.length === 4, String(replay.records.length))
check('★ 服务端全部判为重复（accepted=0）', replay.delivered?.accepted === 0, JSON.stringify(replay.delivered))
check('★ duplicates=4', replay.delivered?.duplicates === 4)
check('★ 库里仍是 4 行（没有重复计费）', countRows() === 4)
check('重发也正常 ack（pending 清空）', pendingCount() === 0)

// ── 清理 ────────────────────────────────────────────────────────────────────
await portal.stop()
rmSync(HOME, { recursive: true, force: true })

console.log(`\n${'─'.repeat(50)}`)
console.log(`结果：${passed} 项通过，${failed} 项失败`)
process.exit(failed > 0 ? 1 : 0)
