/** DSH 迁移保留旧副本且会重编号 seq：来源选择、旧缓存重建与新格式增量必须一致。 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { zstdCompressSync } from 'node:zlib'
import { listSessionFiles, scanAll, scanIncremental, selectSessionLogFiles, SESSION_SCAN_REVISION } from '../src/scanner.js'
import { emptyState, stageRecords } from '../src/state.js'
import { ingest, openDatabaseForIngest, openPortalDb } from '../src/db/ingest.js'
import { PORTAL_SCHEMA_VERSION } from '../src/db/portal-db.js'
import { openDb } from '../src/db/schema.js'
import { queryRecords } from '../src/db/query.js'
import { readLocalRollup } from '../src/db/local-rollup.js'
import type { Database } from '../src/db/driver.js'

let home: string
let sessionsRoot: string
let dbPath: string
let db: Database
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'atr-log-generations-'))
  sessionsRoot = join(home, 'sessions')
  mkdirSync(sessionsRoot)
  dbPath = join(home, 'usage.sqlite')
  db = openDatabaseForIngest(dbPath)
})
afterEach(() => {
  db.close()
  rmSync(home, { recursive: true, force: true })
})
const event = (seq: number, input = 10) => ({ type: 'assistant/message', seq, time: 1_790_000_000_000 + seq,
  data: { usage: { inputTokens: input, outputTokens: 2, cacheReadTokens: 100, cacheWriteTokens: 3 },
    message: { source: { provider: 'test', model: 'm' } } } })
const frame = (events: unknown[]) => zstdCompressSync(Buffer.from(events.map(value => JSON.stringify(value)).join('\n') + '\n'))
function file(name: string, events: unknown[], session = 's1'): string {
  const path = join(sessionsRoot, 'project', session, name)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, frame([{ type: 'session', cwd: '/project' }, ...events]))
  return path
}
const cycle = (changedFiles?: string[]) => ingest({ sessionsRoot, dbPath, db, ...(changedFiles ? { changedFiles } : {}) })

test('标准日志按数值版本选最高代，分段和既有非规范名字不受影响', () => {
  expect(selectSessionLogFiles(['session.jsonl.zstd', 'session.v3.jsonl.zstd', 'session.v10.jsonl.zstd',
    'session.v9.jsonl.zstd', 'session.part-2.jsonl.zstd', 'session.v03.jsonl.zstd', 'session.v0.jsonl.zstd', 'other.zstd']))
    .toEqual(['session.v10.jsonl.zstd', 'session.part-2.jsonl.zstd', 'session.v03.jsonl.zstd', 'session.v0.jsonl.zstd'])
})

test('全量与定向扫描只读新代，旧副本内容保持不变', async () => {
  const old = file('session.jsonl.zstd', [event(100, 900)])
  const oldBytes = readFileSync(old)
  const current = file('session.v3.jsonl.zstd', [event(1, 12)])
  expect((await listSessionFiles(sessionsRoot)).map(meta => meta.filePath)).toEqual([current])
  expect((await scanAll(sessionsRoot)).records.map(row => [row.seq, row.usage.input])).toEqual([[1, 12]])
  const targeted = await scanIncremental(sessionsRoot, { changedFiles: [old],
    watermarks: { sizeOf: () => undefined, frameCountOf: () => undefined, lastSeqOf: () => 999 } })
  expect(targeted.files.map(meta => meta.filePath)).toEqual([current])
  expect(targeted.records.map(row => row.seq)).toEqual([1])
  expect(readFileSync(old).equals(oldBytes)).toBe(true)
})

test('CLI 遗留高 seq 既不能过滤新格式首次扫描，也不能过滤下一轮新格式追加', async () => {
  file('session.jsonl.zstd', [event(999)])
  const current = file('session.v3.jsonl.zstd', [event(1)])
  const state = emptyState()
  state.lastSeqBySession.s1 = 999
  const lookup = { sizeOf: (path: string) => state.files[path]?.size,
    frameCountOf: (path: string) => state.files[path]?.frameCount,
    cursorOf: (path: string) => state.files[path]?.cursor,
    lastSeqOf: (session: string) => state.lastSeqBySession[session] }
  const first = await scanIncremental(sessionsRoot, { watermarks: lookup })
  expect(first.records.map(row => row.seq)).toEqual([1])
  for (const item of first.files) state.files[item.filePath] = {
    size: item.size, frameCount: item.frameCount, mtimeMs: item.mtimeMs, firstSeenMs: 0, cursor: item.cursor,
  }
  stageRecords(state, first.records)
  expect(state.lastSeqBySession.s1).toBe(999)
  appendFileSync(current, frame([event(2)]))
  const next = await scanIncremental(sessionsRoot, { watermarks: lookup })
  expect(next.records.map(row => row.seq)).toEqual([2])
})

test('已有旧缓存缺少扫描版本时整库重新派生，schema 仍为 v3，rollup 同时失效', async () => {
  file('session.jsonl.zstd', [event(1, 900), event(100, 800)])
  await cycle()
  expect(readLocalRollup(db).counts.input).toBe(1700)
  db.exec('DROP TABLE local_scan_meta; DROP TABLE local_scan_source')
  file('session.v3.jsonl.zstd', [event(1, 12)])
  // 首次新版即便只收到空变更提示，也必须发现旧缓存并完整重建。
  await cycle([])
  expect(queryRecords(db).map(row => [row.seq, row.usage.input])).toEqual([[1, 12]])
  expect(readLocalRollup(db).counts.input).toBe(12)
  expect(db.query<{ user_version: number }>('PRAGMA user_version').get()?.user_version).toBe(3)
  expect(db.query<{ revision: number }>('SELECT revision FROM local_scan_meta WHERE id = 1').get()?.revision).toBe(SESSION_SCAN_REVISION)
  expect((await cycle()).bytesRead).toBe(0)
})

test('运行中格式升级重建全部本地来源，同 seq 新内容和其它会话都保留', async () => {
  const old = file('session.jsonl.zstd', [event(1, 900), event(100, 800)])
  file('session.v3.jsonl.zstd', [event(5, 5)], 'other')
  await cycle()
  const current = file('session.v3.jsonl.zstd', [event(1, 12)])
  await cycle([current])
  expect(queryRecords(db).map(row => [row.sessionId, row.seq, row.usage.input]).sort())
    .toEqual([['other', 5, 5], ['s1', 1, 12]])
  appendFileSync(old, frame([event(101, 999)]))
  await cycle([old])
  expect(queryRecords(db)).toHaveLength(2)
})

test('旧 CLI 再次写入已淘汰文件时，即使来源标记未变也重新派生', async () => {
  const old = file('session.jsonl.zstd', [event(100, 999)])
  file('session.v3.jsonl.zstd', [event(1, 12)])
  await cycle()
  db.query(`INSERT INTO usage_event (event_id, session_id, seq, ts, provider, model, input_tokens)
    VALUES ('s1:100', 's1', 100, 1, 'test', 'm', 999)`).run()
  db.query(`INSERT INTO file_watermark VALUES (?, 's1', 1, 1, 0, 0, 0)`).run([old])
  expect(queryRecords(db)).toHaveLength(2)
  await cycle()
  expect(queryRecords(db).map(row => row.seq)).toEqual([1])
})

test('新版日志损坏时不退回旧代，不提交不完整的缓存重建', async () => {
  file('session.jsonl.zstd', [event(100, 900)])
  await cycle()
  const current = file('session.v3.jsonl.zstd', [event(1)])
  writeFileSync(current, frame([event(1)]).subarray(0, 8))
  await expect(cycle([current])).rejects.toThrow('重建已延后')
  expect(queryRecords(db).map(row => row.seq)).toEqual([100])
  expect((await scanAll(sessionsRoot)).records).toEqual([])
})

test('传入 portal 路径而不传连接也必须在任何自动重建之前拒绝', async () => {
  const portalPath = join(home, 'portal.sqlite')
  const portal = openPortalDb(portalPath)
  portal.exec('CREATE TABLE only_copy (value TEXT); INSERT INTO only_copy VALUES (\'must survive\')')
  portal.close()
  await expect(ingest({ sessionsRoot, dbPath: portalPath })).rejects.toThrow('唯一副本')
  const after = openDb(portalPath)
  try {
    // ★ 跟着常量走，不要硬编码版本号：写死 4 会在上报库升 v5 时红掉，
    //   而这行断言真正要证明的是「portal 库被建成了当前版本、没被当成要重建的本地库」。
    expect(after.query<{ user_version: number }>('PRAGMA user_version').get()?.user_version).toBe(PORTAL_SCHEMA_VERSION)
    expect(after.query<{ value: string }>('SELECT value FROM only_copy').get()?.value).toBe('must survive')
    expect(after.query("SELECT name FROM sqlite_master WHERE name = 'local_scan_meta'").get()).toBeNull()
  } finally { after.close() }
})
