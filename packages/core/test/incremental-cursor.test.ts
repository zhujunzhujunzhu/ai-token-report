/** 增量续读必须同时满足「只读新增字节」与「分批追加不漏事件」，不能靠耗时阈值断言。 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { zstdCompressSync } from 'node:zlib'
import { decodeFramedZstd, decodeFramedZstdFrom, decodeFramedZstdSync, isCompleteZstdFrame } from '../src/decode.js'
import { ingest, openDatabaseForIngest, readWatermarks } from '../src/db/ingest.js'
import { queryRecords } from '../src/db/query.js'
import type { Database } from '../src/db/driver.js'
import { sessionFilesFromPaths } from '../src/scanner.js'

let root: string
let sessionsRoot: string
let dbPath: string
let db: Database
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'atr-cursor-'))
  sessionsRoot = join(root, 'sessions')
  mkdirSync(sessionsRoot)
  dbPath = join(root, 'usage.sqlite')
  db = openDatabaseForIngest(dbPath)
})
afterEach(() => {
  db.close()
  rmSync(root, { recursive: true, force: true })
})

const usage = (seq: number) => JSON.stringify({ type: 'assistant/message', seq, time: seq,
  data: { usage: { inputTokens: 1 }, message: { source: { provider: 'test', model: 'm' } } } })
const metadata = JSON.stringify({ type: 'session', cwd: '/cursor-project' })
const frame = (...lines: string[]) => zstdCompressSync(Buffer.from(lines.join('\n') + '\n'))
function makeFile(contents: Buffer): string {
  const dir = join(sessionsRoot, 'project', 'session')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'session.v3.jsonl.zstd')
  writeFileSync(path, contents)
  return path
}
const cycle = () => ingest({ sessionsRoot, dbPath, db })

test('长会话追加一帧只读取该帧，光标在重新打开数据库后仍生效', async () => {
  const oldFrame = frame(metadata, usage(1))
  const path = makeFile(Buffer.concat(Array.from({ length: 800 }, () => oldFrame)))
  expect((await cycle()).inserted).toBe(1)
  db.close()
  db = openDatabaseForIngest(dbPath)
  const tail = frame(usage(2))
  appendFileSync(path, tail)
  const result = await cycle()
  expect(result.inserted).toBe(1)
  expect(result.bytesRead).toBe(tail.length)
  expect(result.diagnostics.framesOk).toBe(1)
  expect(readWatermarks(db).cursorOf(path)?.byteOffset).toBe(statSync(path).size)
  expect(queryRecords(db).map((r) => r.cwd)).toEqual(['/cursor-project', '/cursor-project'])
})

for (const cut of [1, 3, 5, 12, -1]) {
  test(`尾帧在 ${cut} 处分次写入时，完成后恰好入库一次`, async () => {
    const prefix = frame(metadata, usage(1))
    const tail = frame(usage(2))
    const split = cut < 0 ? tail.length + cut : cut
    const path = makeFile(Buffer.concat([prefix, tail.subarray(0, split)]))
    expect((await cycle()).inserted).toBe(1)
    expect(readWatermarks(db).cursorOf(path)?.byteOffset).toBe(prefix.length)
    expect(readWatermarks(db).frameCountOf(path)).toBe(1)
    expect((await cycle()).bytesRead).toBe(0)
    appendFileSync(path, tail.subarray(split))
    const completed = await cycle()
    expect(completed.inserted).toBe(1)
    expect(completed.bytesRead).toBe(tail.length)
    expect(queryRecords(db).map((r) => r.seq).sort()).toEqual([1, 2])
    expect((await cycle()).inserted).toBe(0)
  })
}

test('首次只有 session 元信息，后续纯 usage 帧也保留 cwd', async () => {
  const path = makeFile(frame(metadata))
  expect((await cycle()).inserted).toBe(0)
  expect(readWatermarks(db).lastSeqOf('session')).toBe(-1)
  appendFileSync(path, frame(usage(1)))
  expect((await cycle()).inserted).toBe(1)
  expect(queryRecords(db)[0]?.cwd).toBe('/cursor-project')
})

test('热态无新增不写文件水位线、诊断或光标，首次发现时间不被后续追加覆盖', async () => {
  const path = makeFile(frame(metadata, usage(1)))
  await cycle()
  db.query('UPDATE file_watermark SET first_seen_ms = 123').run()
  const changes = () => db.query<{ n: number }>('SELECT total_changes() AS n').get()!.n
  const before = changes()
  const result = await cycle()
  expect(result.bytesRead).toBe(0)
  expect(changes()).toBe(before)
  appendFileSync(path, frame(usage(2)))
  await cycle()
  expect(db.query<{ first_seen_ms: number }>('SELECT first_seen_ms FROM file_watermark').get()?.first_seen_ms).toBe(123)
})

test('旧客户端修改原水位线后旧光标失效，恢复扫描仍不漏掉新事件', async () => {
  const path = makeFile(frame(metadata, usage(1)))
  await cycle()
  db.exec('UPDATE file_watermark SET updated_at_ms = updated_at_ms + 1')
  expect(readWatermarks(db).cursorOf(path)).toBeUndefined()
  appendFileSync(path, frame(usage(2)))
  const next = await cycle()
  expect(next.inserted).toBe(1)
  expect(next.bytesRead).toBe(statSync(path).size)
  expect(readWatermarks(db).cursorOf(path)).toBeDefined()
})

test('旧版水位线已经计入半帧时，升级仍重试最后一帧', async () => {
  const prefix = frame(metadata, usage(1))
  const tail = frame(usage(2))
  const path = makeFile(Buffer.concat([prefix, tail.subarray(0, 5)]))
  await cycle()
  db.exec('DROP TABLE local_file_cursor')
  db.exec('UPDATE file_watermark SET frame_count = 2')
  expect(readWatermarks(db).cursorOf(path)).toBeUndefined()
  appendFileSync(path, tail.subarray(5))
  expect((await cycle()).inserted).toBe(1)
  expect(queryRecords(db).map((r) => r.seq).sort()).toEqual([1, 2])
})

test('文件截断后回退全量解码，保留已入库记录并用 L3 去重', async () => {
  const path = makeFile(frame(metadata, usage(1), usage(2)))
  await cycle()
  const replacement = frame(usage(3))
  expect(replacement.length).toBeLessThan(statSync(path).size)
  writeFileSync(path, replacement)
  const result = await cycle()
  expect(result.inserted).toBe(1)
  expect(result.bytesRead).toBe(replacement.length)
  expect(readWatermarks(db).frameCountOf(path)).toBe(1)
  expect(queryRecords(db).map((r) => r.seq).sort()).toEqual([1, 2, 3])
})

/** 原始 block 让等长 JSON 的压缩帧也等长，精确覆盖「替换了但 size 不变」。 */
function rawFrame(text: string): Buffer {
  const bytes = Buffer.from(text + '\n')
  const header = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x20, bytes.length, 0, 0, 0])
  header.writeUIntLE((bytes.length << 3) | 1, 6, 3)
  return Buffer.concat([header, bytes])
}

test('同路径被等大小文件替换时不能被 L1 跳过', async () => {
  const previous = rawFrame(usage(1))
  const replacement = rawFrame(usage(2))
  expect(replacement.length).toBe(previous.length)
  const path = makeFile(previous)
  await cycle()
  writeFileSync(`${path}.replacement`, replacement)
  renameSync(`${path}.replacement`, path)
  const result = await cycle()
  expect(result.inserted).toBe(1)
  expect(result.bytesRead).toBe(replacement.length)
  expect(queryRecords(db).map((r) => r.seq).sort()).toEqual([1, 2])
})

test('同步、异步与增量解码对不完整 block 和部分 magic 一致', async () => {
  const prefix = frame(usage(1))
  const tail = frame(usage(2))
  for (const suffix of [tail.subarray(0, 3), tail.subarray(0, tail.length - 1)]) {
    const buf = Buffer.concat([prefix, suffix])
    const sync = decodeFramedZstdSync(buf)
    expect(await decodeFramedZstd(buf)).toEqual(sync)
    const incremental = decodeFramedZstdFrom(buf, 0)
    expect(incremental.text).toBe(sync.text)
    expect(incremental.framesOk).toBe(1)
    expect(incremental.byteOffset).toBe(prefix.length)
  }
  expect(isCompleteZstdFrame(tail.subarray(0, tail.length - 1))).toBe(false)
})

test('帧完整性同时检查 RLE block 和可选 checksum 的实际长度', () => {
  const rle = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x20, 3, 27, 0, 0, 65])
  expect(decodeFramedZstdSync(rle).text).toBe('AAA')
  const checksummed = Buffer.from(rle)
  checksummed[4] = 0x24
  expect(isCompleteZstdFrame(checksummed)).toBe(false)
  expect(isCompleteZstdFrame(Buffer.concat([checksummed, Buffer.alloc(4)]))).toBe(true)
})

test('光标写入失败时原始事件和两层水位线一起回滚，解除故障后可完整重试', async () => {
  const path = makeFile(frame(metadata, usage(1)))
  await cycle()
  const previous = readWatermarks(db).cursorOf(path)
  appendFileSync(path, frame(usage(2)))
  db.exec(`CREATE TRIGGER reject_cursor BEFORE UPDATE ON local_file_cursor
    BEGIN SELECT RAISE(ABORT, 'cursor-write-failed'); END`)
  await expect(cycle()).rejects.toThrow('cursor-write-failed')
  expect(queryRecords(db).map((r) => r.seq)).toEqual([1])
  expect(readWatermarks(db).cursorOf(path)).toEqual(previous)
  expect(readWatermarks(db).lastSeqOf('session')).toBe(1)
  db.exec('DROP TRIGGER reject_cursor')
  expect((await cycle()).inserted).toBe(1)
  expect(queryRecords(db).map((r) => r.seq).sort()).toEqual([1, 2])
})

test('定向入库只处理指定文件，水位线查询也限定到这些文件和会话', async () => {
  const first = makeFile(frame(metadata, usage(1)))
  const dir = join(sessionsRoot, 'project', 'other-session')
  mkdirSync(dir)
  const other = join(dir, 'session.v3.jsonl.zstd')
  writeFileSync(other, frame(metadata, usage(1)))
  await cycle()
  const tail = frame(usage(2))
  appendFileSync(first, tail)
  appendFileSync(other, tail)
  const reads: string[] = []
  const observed = new Proxy(db, {
    get(target, name) {
      if (name === 'query') return (sql: string) => { reads.push(sql); return target.query(sql) }
      const value = Reflect.get(target, name)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  const changed = await ingest({ sessionsRoot, dbPath, db: observed, changedFiles: [first, first] })
  expect(changed.inserted).toBe(1)
  expect(changed.skippedUnchanged).toBe(0)
  expect(changed.bytesRead).toBe(tail.length)
  expect(reads.filter((sql) => sql.includes('FROM file_watermark')).every((sql) => sql.includes('WHERE f.file_path IN (?)'))).toBe(true)
  expect(reads.filter((sql) => sql.includes('FROM session_state')).every((sql) => sql.includes('WHERE session_id IN (?)'))).toBe(true)
  expect((await ingest({ sessionsRoot, dbPath, db, changedFiles: [] })).bytesRead).toBe(0)
  // 完整对账会补上另一个文件，不能让定向扫描冒充全目录已更新。
  expect((await cycle()).inserted).toBe(1)
  expect(queryRecords(db).length).toBe(4)
})

test('定向扫描对大量路径分批查水位线，新文件仍继承同会话 L3', async () => {
  const paths: string[] = []
  for (let i = 0; i < 205; i++) {
    const dir = join(sessionsRoot, 'project', `session-${i}`)
    mkdirSync(dir, { recursive: true })
    const path = join(dir, 'session.v3.jsonl.zstd')
    writeFileSync(path, frame(metadata, usage(1)))
    paths.push(path)
  }
  expect((await ingest({ sessionsRoot, dbPath, db, changedFiles: paths })).inserted).toBe(205)
  expect((await ingest({ sessionsRoot, dbPath, db, changedFiles: paths })).skippedUnchanged).toBe(205)
  const split = join(sessionsRoot, 'project', 'session-0', 'session.v4.jsonl.zstd')
  writeFileSync(split, frame(usage(1), usage(2)))
  expect((await ingest({ sessionsRoot, dbPath, db, changedFiles: [split] })).inserted).toBe(1)
  expect(queryRecords(db).find((r) => r.sessionId === 'session-0' && r.seq === 2)?.cwd).toBe('/cursor-project')
})

test('定向扫描拒绝相对路径、外部路径及目录路径', () => {
  for (const path of ['session.v3.jsonl.zstd', join(root, 'outside', 'session', 'session.v3.jsonl.zstd'),
    join(sessionsRoot, 'project', 'session'), join(sessionsRoot, '..', 'project', 'session', 'session.v3.jsonl.zstd')]) {
    expect(() => sessionFilesFromPaths(sessionsRoot, [path])).toThrow()
  }
})

test('首文件只有元信息时，新分段文件定向扫描继承 cwd 且不漏 seq=0', async () => {
  makeFile(frame(metadata))
  await cycle()
  const split = join(sessionsRoot, 'project', 'session', 'session.v4.jsonl.zstd')
  writeFileSync(split, frame(usage(0)))
  expect((await ingest({ sessionsRoot, dbPath, db, changedFiles: [split] })).inserted).toBe(1)
  expect(queryRecords(db)[0]?.cwd).toBe('/cursor-project')
  expect(queryRecords(db)[0]?.seq).toBe(0)
})
