/**
 * 多个 DSH home 的统计语义 —— **并集**，不是「每个 home 各算一遍」。
 *
 * 同一台机器上并存多套 DSH 时（命令行版 `~/.dsh`、Desktop
 * `%APPDATA%\dsh-desktop\harness`、第三方客户端……），它们的会话日志经常互为镜像：
 * 本机实测 224 个 `sessionId` 同时出现在两个 home 里，其中 217 份文件逐字节相同。
 *
 * 因此三条语义必须钉死：
 *
 * 1. **会话日志根是一组**（`sessionsRoots`），扫描范围是它们的并集；
 * 2. **数据目录只有一份**（`dataDir`），库也只有一份 —— 分成两个库就没法表达「并集」；
 * 3. 镜像靠 `event_id`（`sessionId:seq`）去重，**直扫路径与 SQL 路径必须是同一套语义**。
 *
 * 所以「并集总量 **小于** 各根相加」是**正确结果**，不是丢数据 ——
 * 「我加了一个 home，会话数只涨了 4%」需要能被解释成镜像去重，
 * 而不是被当成漏扫。本文件就是这条解释的证据。
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'

import { inspectSessionRoots, listSessionFiles, scanAll } from '../src/scanner.js'
import { ingest, openDatabaseForIngest } from '../src/db/ingest.js'
import { openStats } from '../src/db/stats.js'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'atr-multi-home-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

/**
 * 造一个会话日志文件；同一 `sessionId` 在两个根下各写一份就是**镜像**。
 *
 * 每帧 10+2+90+3 = 105 token，所以「帧数 × 105」能直接换算成总量断言。
 */
function writeSession(root: string, sessionId: string, seqs: number[], project = 'project'): string {
  const target = join(root, project, sessionId)
  mkdirSync(target, { recursive: true })
  const file = join(target, 'session.v3.jsonl.zstd')
  const frames = seqs.map((seq) => zstdCompressSync(Buffer.from(JSON.stringify({
    type: 'assistant/message',
    seq,
    time: Date.UTC(2026, 8, 25, 4, 0, 0),
    data: {
      usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 90, cacheWriteTokens: 3 },
      message: { source: { provider: 'p', model: 'm' } },
    },
  }) + '\n')))
  writeFileSync(file, Buffer.concat(frames))
  return file
}

/**
 * 两个 home 的布局（`s1` 是**镜像**）：
 *
 * | 根 | 会话 | 帧 |
 * |---|---|---|
 * | A | `s1` | 1,2 |
 * | A | `s2` | 1 |
 * | B | `s1`（镜像，逐帧相同） | 1,2 |
 * | B | `s3` | 1 |
 *
 * 并集 = 3 个会话 / 4 条记录 / 420 token；按根相加会得到 630 —— 那是错的。
 */
function buildHomes(): { rootA: string; rootB: string } {
  const rootA = join(dir, 'a', 'sessions')
  const rootB = join(dir, 'b', 'sessions')
  writeSession(rootA, 's1', [1, 2])
  writeSession(rootA, 's2', [1])
  writeSession(rootB, 's1', [1, 2])
  writeSession(rootB, 's3', [1])
  return { rootA, rootB }
}

describe('多个 DSH home 的扫描', () => {
  test('两个根都进扫描范围；镜像文件因**路径不同**各算一个文件', async () => {
    const { rootA, rootB } = buildHomes()
    const files = await listSessionFiles([rootA, rootB])
    expect(files).toHaveLength(4)
    expect(files.filter((f) => f.filePath.startsWith(rootA))).toHaveLength(2)
    expect(files.filter((f) => f.filePath.startsWith(rootB))).toHaveLength(2)
  })

  test('单根行为不变（同一个函数，单根就是一元数组）', async () => {
    const { rootA } = buildHomes()
    expect(await listSessionFiles(rootA)).toHaveLength(2)
    expect(await listSessionFiles([rootA])).toHaveLength(2)
  })

  test('★ 镜像会话按 event_id 去重：并集是 4 条 / 420 token，而不是按根相加的 6 条 / 630', async () => {
    const { rootA, rootB } = buildHomes()
    const { records } = await scanAll([rootA, rootB])
    expect(records).toHaveLength(4)
    expect(records.reduce((sum, r) => sum + r.usage.total, 0)).toBe(420)
    // 会话数按 sessionId 去重 —— 镜像只算一个
    expect(new Set(records.map((r) => r.sessionId)).size).toBe(3)
    // 具体是哪些被去掉了：B 的 s1 两帧与 A 的 s1 逐帧相同
    expect(records.filter((r) => r.sessionId === 's1')).toHaveLength(2)
  })

  test('★ 库路径与直扫路径给出同一个并集（多根的口径只有一份实现）', async () => {
    const { rootA, rootB } = buildHomes()
    const dbPath = join(dir, 'usage.sqlite')
    const sql = await openStats({ sessionsRoot: [rootA, rootB], dbPath })
    const scan = await openStats({ sessionsRoot: [rootA, rootB], dbPath, forceScan: true })
    try {
      expect(sql.source).toBe('sql')
      expect(sql.totals().total).toBe(420)
      expect(scan.totals().total).toBe(420)
      expect(sql.sessions).toBe(3)
      expect(scan.sessions).toBe(3)
      // 两条路径都报出**同一组**根
      expect(sql.sessionsRoots).toEqual(scan.sessionsRoots)
      expect(sql.sessionsRoots).toHaveLength(2)
      expect(sql.missingRoots).toEqual([])
    } finally {
      sql.close()
      scan.close()
    }
  })

  test('★ 逐根可见：inspectSessionRoots 报出每个根的会话数与存在性', async () => {
    const { rootA, rootB } = buildHomes()
    const missing = join(dir, 'no-such-home', 'sessions')
    const infos = await inspectSessionRoots([rootA, rootB, missing])

    expect(infos).toHaveLength(3)
    expect(infos[0]).toMatchObject({ root: rootA, exists: true, sessions: 2, files: 2 })
    expect(infos[1]).toMatchObject({ root: rootB, exists: true, sessions: 2, files: 2 })
    // 镜像文件**仍各算一个**：可见性说的是「读到了什么」，不是「并集是多少」
    expect(infos[0]!.latestMs).toBeGreaterThan(0)
    expect(infos[2]).toMatchObject({ root: missing, exists: false, sessions: 0, files: 0 })
    expect(infos[2]!.error).toContain('不存在')
  })
})

describe('多个 DSH home 的入库', () => {
  test('★ 缺失的根逐项报出（missingRoots），且不因此让整轮入库失败', async () => {
    const { rootA } = buildHomes()
    const missing = join(dir, 'gone', 'sessions')
    const dbPath = join(dir, 'usage.sqlite')
    const db = openDatabaseForIngest(dbPath)
    try {
      const result = await ingest({ sessionsRoot: [rootA, missing], dbPath, db })
      expect(result.missingRoots).toEqual([missing])
      expect(result.inserted).toBeGreaterThan(0)
    } finally {
      db.close()
    }
  })

  test('★ 跨根的镜像只入库一次（event_id 主键就是去重键）', async () => {
    const { rootA, rootB } = buildHomes()
    const dbPath = join(dir, 'usage.sqlite')

    const first = await ingest({ sessionsRoot: [rootA], dbPath })
    const afterFirst = await openStats({ sessionsRoot: [rootA], dbPath })
    const firstTotal = afterFirst.totals().total
    afterFirst.close()

    // 加上 B：并集只多出 B 独有的 s3（一帧 105），镜像的 s1 不重复计入
    const second = await ingest({ sessionsRoot: [rootA, rootB], dbPath })
    const union = await openStats({ sessionsRoot: [rootA, rootB], dbPath })
    try {
      expect(first.inserted).toBe(3)
      expect(firstTotal).toBe(315)
      expect(union.totals().total).toBe(420)
      expect(union.sessions).toBe(3)
      // 第二轮新增的就是 s3 那一帧；镜像帧被主键挡掉
      expect(second.inserted).toBe(1)
      expect(second.duplicates).toBe(2)
    } finally {
      union.close()
    }
  })
})