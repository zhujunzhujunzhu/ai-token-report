/**
 * 增量上报测试：水位线推进、L1/L2/L3 三层过滤、崩溃安全语义。
 *
 * 这些测试是「不做插件也能可靠上报」这一论断的证据。重点锁死三条：
 *
 * 1. **幂等**：同一份日志连跑两次，第二次必须产出 0 条。
 * 2. **不丢**：投递失败时水位线不推进，数据留在 pending，下一轮重发。
 * 3. **追加可见**：日志新增帧后，只产出新增的记录。
 *
 *   bun test
 */

import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, appendFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'

import {
  decodeFramedZstdFrom,
  findFrameOffsets,
  loadState,
  resetState,
  saveState,
  scanIncremental,
  stageRecords,
  ackRecords,
  emptyState,
  isAlreadyHandled,
  type UsageRecord,
} from '@ai-token-report/core'
// ⚠️ 不能从包根 `@ai-token-report/cli` import —— 那会执行 cli.ts 顶层的 main()。
import { runReport } from '@ai-token-report/cli/report'

// ── 测试脚手架 ──────────────────────────────────────────────────────────────

/** 每个测试一个独立 DSH home，避免互相污染状态文件。 */
function makeHome(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-token-report-'))
}

/** 构造一个 `assistant/message` 事件行。 */
function usageLine(seq: number, opts: { provider?: string; input?: number; output?: number; cacheRead?: number } = {}): string {
  return JSON.stringify({
    type: 'assistant/message',
    seq,
    time: 1_789_545_928_088 + seq * 1000,
    data: {
      turn: 1,
      step: seq,
      message: {
        source: {
          kind: 'model',
          provider: opts.provider ?? 'dashscope',
          model: 'deepseek-v4.1-flash',
        },
      },
      usage: {
        inputTokens: opts.input ?? 100,
        outputTokens: opts.output ?? 10,
        cacheReadTokens: opts.cacheRead ?? 1000,
        cacheWriteTokens: 0,
        totalTokens: (opts.input ?? 100) + (opts.output ?? 10) + (opts.cacheRead ?? 1000),
      },
    },
  })
}

/** 会话首行。 */
function sessionLine(sessionId: string, cwd: string): string {
  return JSON.stringify({ type: 'session', version: 3, id: sessionId, createdAt: 1_789_545_926_716, cwd })
}

/** 把若干行压成一帧追加到文件（模拟 DSH 的分帧 append）。 */
function appendFrame(file: string, lines: string[]): void {
  const frame = zstdCompressSync(Buffer.from(lines.join('\n') + '\n', 'utf8'))
  appendFileSync(file, frame)
}

/** 在临时 home 下建一个会话文件，返回其路径。 */
function makeSessionFile(home: string, project: string, sessionId: string): string {
  const dir = join(home, 'sessions', project, sessionId)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'session.v3.jsonl.zstd')
  writeFileSync(file, Buffer.alloc(0))
  return file
}

/** 简易水位线查表，从 ReportState 上取。 */
function lookupFrom(state: ReturnType<typeof emptyState>) {
  return {
    sizeOf: (p: string) => state.files[p]?.size,
    frameCountOf: (p: string) => state.files[p]?.frameCount,
    lastSeqOf: (s: string) => state.lastSeqBySession[s],
  }
}

function makeRecord(sessionId: string, seq: number): UsageRecord {
  return {
    eventId: `${sessionId}:${seq}`,
    sessionId,
    seq,
    time: 1000 + seq,
    provider: 'dashscope',
    model: 'm',
    cwd: null,
    turn: 1,
    step: seq,
    usage: {
      input: 1,
      output: 2,
      cacheRead: 3,
      cacheWrite: 0,
      reasoning: 0,
      total: 6,
      calls: 1,
    },
  }
}

const roots: string[] = []
function tracked(fn: () => void | Promise<void>) {
  return async () => {
    try {
      await fn()
    } finally {
      for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
    }
  }
}

// ── 增量解码 ────────────────────────────────────────────────────────────────

test('decodeFramedZstdFrom：fromFrame=0 等价于全量解码', () => {
  const a = zstdCompressSync(Buffer.from('{"n":1}\n', 'utf8'))
  const b = zstdCompressSync(Buffer.from('{"n":2}\n', 'utf8'))
  const buf = Buffer.concat([a, b])

  const all = decodeFramedZstdFrom(buf, 0)
  assert.equal(all.frameCount, 2)
  assert.equal(all.framesOk, 2)
  assert.ok(all.text.includes('"n":1'))
  assert.ok(all.text.includes('"n":2'))
})

test('decodeFramedZstdFrom：从第 1 帧续读只拿到新增内容', () => {
  const a = zstdCompressSync(Buffer.from('{"n":1}\n', 'utf8'))
  const b = zstdCompressSync(Buffer.from('{"n":2}\n', 'utf8'))
  const buf = Buffer.concat([a, b])

  const tail = decodeFramedZstdFrom(buf, 1)
  assert.equal(tail.frameCount, 2, 'frameCount 始终是总帧数')
  assert.equal(tail.framesOk, 1)
  assert.ok(!tail.text.includes('"n":1'), '不应包含已处理的帧')
  assert.ok(tail.text.includes('"n":2'))
})

test('decodeFramedZstdFrom：水位线超前时回退到全量，而不是返回空', () => {
  const buf = zstdCompressSync(Buffer.from('{"n":1}\n', 'utf8'))
  // 模拟「文件被截断重建」后水位线（比如 5）大于实际帧数（1）
  const r = decodeFramedZstdFrom(buf, 5)
  assert.equal(r.framesOk, 1, '必须能从头发起，否则水位线会永久卡死')
  assert.ok(r.text.includes('"n":1'))
})

test('decodeFramedZstdFrom：frameCount 与 framesOk+framesFailed 恒等', () => {
  const a = zstdCompressSync(Buffer.from('{"n":1}\n', 'utf8'))
  // 半个帧：截断的 zstd 数据
  const half = zstdCompressSync(Buffer.from('{"n":2}\n', 'utf8')).subarray(0, 6)
  const buf = Buffer.concat([a, half])

  const r = decodeFramedZstdFrom(buf, 0)
  assert.equal(r.frameCount, r.framesOk + r.framesFailed, '帧总数必须等于成功+失败')
})

// ── 三层过滤 ────────────────────────────────────────────────────────────────

test('scanIncremental：首次扫描产出全部记录，二次扫描产出 0 条（幂等）', tracked(async () => {
  const home = makeHome(); roots.push(home)
  const file = makeSessionFile(home, '--proj--', 'sess-1')
  appendFrame(file, [sessionLine('sess-1', 'D:\\proj')])
  appendFrame(file, [usageLine(1), usageLine(2), usageLine(3)])

  const state = emptyState()
  const first = await scanIncremental(join(home, 'sessions'), { watermarks: lookupFrom(state) })
  assert.equal(first.records.length, 3, '首轮应产出 3 条')
  assert.equal(first.skippedUnchanged, 0)
  assert.equal(first.records[0]!.cwd, 'D:\\proj', '应带上会话首行的 cwd')

  // 落盘水位线
  for (const f of first.files) {
    state.files[f.filePath] = { size: f.size, frameCount: f.frameCount, mtimeMs: f.mtimeMs, firstSeenMs: 0 }
  }
  stageRecords(state, first.records)

  const second = await scanIncremental(join(home, 'sessions'), { watermarks: lookupFrom(state) })
  assert.equal(second.records.length, 0, '二次扫描必须为 0 条（幂等）')
  assert.equal(second.skippedUnchanged, 1, 'L1 应跳过该文件，零解压')
  assert.equal(second.diagnostics.filesScanned, 0, '不应解压任何文件')
}))

test('scanIncremental：追加新帧后只产出新增记录', tracked(async () => {
  const home = makeHome(); roots.push(home)
  const file = makeSessionFile(home, '--proj--', 'sess-1')
  appendFrame(file, [sessionLine('sess-1', 'D:\\proj')])
  appendFrame(file, [usageLine(1)])

  const state = emptyState()
  const first = await scanIncremental(join(home, 'sessions'), { watermarks: lookupFrom(state) })
  assert.equal(first.records.length, 1)
  for (const f of first.files) {
    state.files[f.filePath] = { size: f.size, frameCount: f.frameCount, mtimeMs: f.mtimeMs, firstSeenMs: 0 }
  }
  stageRecords(state, first.records)

  // 追加两个新事件
  appendFrame(file, [usageLine(2), usageLine(3)])

  const second = await scanIncremental(join(home, 'sessions'), { watermarks: lookupFrom(state) })
  assert.equal(second.records.length, 2, '只应产出新增的 2 条')
  assert.deepEqual(second.records.map((r) => r.seq), [2, 3])
  assert.equal(second.skippedUnchanged, 0, '文件变了，不能跳过')
  assert.equal(second.diagnostics.filesScanned, 1)
}))

test('scanIncremental：增量块缺 session 行时仍保留 cwd（继承水印）', tracked(async () => {
  const home = makeHome(); roots.push(home)
  const file = makeSessionFile(home, '--proj--', 'sess-1')
  appendFrame(file, [sessionLine('sess-1', 'D:\\proj'), usageLine(1)])

  const state = emptyState()
  const first = await scanIncremental(join(home, 'sessions'), { watermarks: lookupFrom(state) })
  assert.equal(first.records[0]!.cwd, 'D:\\proj')
  for (const f of first.files) {
    state.files[f.filePath] = { size: f.size, frameCount: f.frameCount, mtimeMs: f.mtimeMs, firstSeenMs: 0 }
  }
  stageRecords(state, first.records)
  assert.equal(state.cwdBySession['sess-1'], 'D:\\proj', 'stage 应记住 cwd')

  // 追加的帧里只有 usage，没有 session 行
  appendFrame(file, [usageLine(2)])

  // 走真实的 lookupFor 路径，验证 cwd 从持久化状态继承
  const lastCwd = new Map(Object.entries(state.cwdBySession))
  const second = await scanIncremental(join(home, 'sessions'), {
    watermarks: { ...lookupFrom(state), cwdOf: (s: string) => lastCwd.get(s) },
  })
  assert.equal(second.records.length, 1)
  assert.equal(second.records[0]!.cwd, 'D:\\proj', '增量块不应丢掉项目归属')
}))

test('state：stage 不用 null 覆盖已记住的 cwd', tracked(() => {
  const s = emptyState()
  stageRecords(s, [{ ...makeRecord('s1', 1), cwd: 'D:\\proj' }])
  assert.equal(s.cwdBySession['s1'], 'D:\\proj')

  // 增量块没解析出 cwd（null）时，必须保留旧值
  stageRecords(s, [{ ...makeRecord('s1', 2), cwd: null }])
  assert.equal(s.cwdBySession['s1'], 'D:\\proj', 'null 不得冲掉已知的 cwd')

  // 全新的会话且 cwd 未知，才记为 null
  stageRecords(s, [{ ...makeRecord('s2', 1), cwd: null }])
  assert.equal(s.cwdBySession['s2'], null)
}))

test('runReport：跨轮次保留项目归属（cwd 持久化生效）', tracked(async () => {
  const home = makeHome(); roots.push(home)
  const file = makeSessionFile(home, '--proj--', 'sess-1')
  appendFrame(file, [sessionLine('sess-1', 'D:\\proj'), usageLine(1)])

  const statePath = join(home, 'state.json')
  const deliver = async (recs: UsageRecord[]) => ({ accepted: recs.length, duplicates: 0, rejected: 0 })

  const first = await runReport({ sessionsRoot: join(home, 'sessions'), statePath, deliver })
  assert.equal(first.records[0]!.cwd, 'D:\\proj')

  // 新一帧只有 usage，没有 session 行；从磁盘状态继承 cwd
  appendFrame(file, [usageLine(2)])
  const second = await runReport({ sessionsRoot: join(home, 'sessions'), statePath, deliver })
  assert.equal(second.records.length, 1)
  assert.equal(second.records[0]!.cwd, 'D:\\proj', '持久化的 cwd 必须跨轮次生效')
}))

test('scanIncremental：文件被截断时回退重扫该文件', tracked(async () => {
  const home = makeHome(); roots.push(home)
  const file = makeSessionFile(home, '--proj--', 'sess-1')
  appendFrame(file, [sessionLine('sess-1', 'D:\\proj'), usageLine(1), usageLine(2)])

  const state = emptyState()
  const first = await scanIncremental(join(home, 'sessions'), { watermarks: lookupFrom(state) })
  assert.equal(first.records.length, 2)
  for (const f of first.files) {
    state.files[f.filePath] = { size: f.size, frameCount: f.frameCount, mtimeMs: f.mtimeMs, firstSeenMs: 0 }
  }
  stageRecords(state, first.records)

  // 重建文件（更小），只有一条记录
  writeFileSync(file, Buffer.alloc(0))
  appendFrame(file, [sessionLine('sess-1', 'D:\\proj'), usageLine(1)])
  assert.ok(statSync(file).size < (state.files[file]!.size), '前提：新文件更小')

  const second = await scanIncremental(join(home, 'sessions'), { watermarks: lookupFrom(state) })
  assert.equal(second.diagnostics.filesScanned, 1, '截断文件必须被重扫，不能静默跳过')
  // L3 仍会挡住已上报的 seq=1
  assert.equal(second.records.length, 0, 'L3 水位线挡住重复的 seq')
}))

// ── 状态与崩溃安全 ──────────────────────────────────────────────────────────

test('state：原子落盘后可完整读回', tracked(() => {
  const home = makeHome(); roots.push(home)
  const p = join(home, 'state.json')
  const s = emptyState()
  s.files['/a'] = { size: 1, frameCount: 2, mtimeMs: 3, firstSeenMs: 4 }
  s.lastSeqBySession['s1'] = 42
  stageRecords(s, [makeRecord('s1', 43)])
  saveState(p, s)

  const back = loadState(p).state
  assert.equal(back.files['/a']?.frameCount, 2)
  assert.equal(back.lastSeqBySession['s1'], 43, 'stage 会推进 L3')
  assert.equal(back.pending.length, 1)
}))

test('state：损坏/缺失/版本不符都退回空状态，不抛错', tracked(() => {
  const home = makeHome(); roots.push(home)
  const p = join(home, 'state.json')

  assert.equal(loadState(p).state.pending.length, 0, '缺失 → 空状态')

  writeFileSync(p, '{ 这不是 JSON')
  const broken = loadState(p)
  assert.equal(broken.state.pending.length, 0)
  assert.ok(broken.note, '应给出告警说明')

  writeFileSync(p, JSON.stringify({ version: 999, pending: [{ x: 1 }] }))
  const versioned = loadState(p)
  assert.equal(versioned.state.pending.length, 0, '版本不符不得沿用旧数据')
  assert.ok(versioned.note)
}))

test('state：ack 按 eventId 移除，不误删后追加的记录', tracked(() => {
  const s = emptyState()
  const batch = [makeRecord('s1', 1), makeRecord('s1', 2)]
  stageRecords(s, batch)
  // 投递期间又进来一条
  stageRecords(s, [makeRecord('s1', 3)])
  assert.equal(s.pending.length, 3)

  ackRecords(s, batch, 12345)
  assert.equal(s.pending.length, 1, '只应移除已确认的两条')
  assert.equal(s.pending[0]!.seq, 3)
  assert.equal(s.totalDelivered, 2)
  assert.equal(s.lastFlushMs, 12345)
}))

test('state：L3 判定用 > 而非 >=', () => {
  const s = emptyState()
  stageRecords(s, [makeRecord('s1', 5)])
  assert.equal(isAlreadyHandled(s, makeRecord('s1', 5)), true, '等于水位线的已处理过')
  assert.equal(isAlreadyHandled(s, makeRecord('s1', 6)), false)
  assert.equal(isAlreadyHandled(s, makeRecord('s2', 1)), false, '别的会话不受影响')
})

test('state：L3 是会话级而非文件级（跨文件连续）', tracked(() => {
  const s = emptyState()
  stageRecords(s, [makeRecord('same-session', 10)])
  // 该会话的第二个文件（如格式版本升级）里 seq 从 11 继续
  assert.equal(isAlreadyHandled(s, makeRecord('same-session', 11)), false)
  assert.equal(isAlreadyHandled(s, makeRecord('same-session', 9)), true)
}))

// ── runReport 端到端 ────────────────────────────────────────────────────────

test('runReport：投递成功后清空 pending', tracked(async () => {
  const home = makeHome(); roots.push(home)
  const file = makeSessionFile(home, '--proj--', 'sess-1')
  appendFrame(file, [sessionLine('sess-1', 'D:\\proj'), usageLine(1), usageLine(2)])

  const statePath = join(home, 'state.json')
  let sent: UsageRecord[] = []
  const r = await runReport({
    sessionsRoot: join(home, 'sessions'),
    statePath,
    deliver: async (recs) => {
      sent = recs
      return { accepted: recs.length, duplicates: 0, rejected: 0 }
    },
  })

  assert.equal(r.records.length, 2)
  assert.equal(sent.length, 2)
  assert.equal(r.pendingRemaining, 0, '投递成功后 pending 应清空')

  const persisted = loadState(statePath).state
  assert.equal(persisted.pending.length, 0)
  assert.equal(persisted.totalDelivered, 2)

  // 再跑一次：应无新增
  const again = await runReport({
    sessionsRoot: join(home, 'sessions'),
    statePath,
    deliver: async (recs) => ({ accepted: recs.length, duplicates: 0, rejected: 0 }),
  })
  assert.equal(again.records.length, 0, '第二轮无新增')
}))

test('runReport：投递失败时 pending 与水印保留，下一轮重发', tracked(async () => {
  const home = makeHome(); roots.push(home)
  const file = makeSessionFile(home, '--proj--', 'sess-1')
  appendFrame(file, [sessionLine('sess-1', 'D:\\proj'), usageLine(1), usageLine(2)])

  const statePath = join(home, 'state.json')
  let attempts = 0

  // 第一轮：投递失败
  await assert.rejects(
    runReport({
      sessionsRoot: join(home, 'sessions'),
      statePath,
      deliver: async () => {
        attempts++
        throw new Error('网络不可达')
      },
    }),
    /网络不可达/,
  )

  const afterFail = loadState(statePath).state
  assert.equal(afterFail.pending.length, 2, '失败必须保留 pending，绝不丢数据')
  assert.equal(afterFail.totalDelivered, 0)
  assert.equal(afterFail.lastFlushMs, 0, '失败不应推进投递时间')
  // 关键：水位线已推进（数据在 pending 里），所以下一轮不会重复扫描
  assert.equal(afterFail.lastSeqBySession['sess-1'], 2)

  // 第二轮：投递成功，应重发 pending 里的 2 条
  let resent: UsageRecord[] = []
  const r2 = await runReport({
    sessionsRoot: join(home, 'sessions'),
    statePath,
    deliver: async (recs) => {
      resent = recs
      return { accepted: recs.length, duplicates: 0, rejected: 0 }
    },
  })

  assert.equal(resent.length, 2, '上一轮失败的记录必须重发')
  assert.deepEqual(resent.map((x) => x.seq).sort(), [1, 2])
  assert.equal(r2.records.length, 0, '本轮无新增记录')
  assert.equal(r2.pendingRemaining, 0)
}))

test('runReport：dryRun 不投递但会落盘 pending', tracked(async () => {
  const home = makeHome(); roots.push(home)
  const file = makeSessionFile(home, '--proj--', 'sess-1')
  appendFrame(file, [sessionLine('sess-1', 'D:\\proj'), usageLine(1)])

  const statePath = join(home, 'state.json')
  let called = false
  const r = await runReport({
    sessionsRoot: join(home, 'sessions'),
    statePath,
    dryRun: true,
    deliver: async (recs) => {
      called = true
      return { accepted: recs.length, duplicates: 0, rejected: 0 }
    },
  })

  assert.equal(called, false, 'dry-run 绝不能发起投递')
  assert.equal(r.records.length, 1)
  assert.equal(r.delivered, undefined)
  assert.equal(loadState(statePath).state.pending.length, 1, 'pending 应已落盘')
}))

test('runReport：noSave 完全不写状态文件', tracked(async () => {
  const home = makeHome(); roots.push(home)
  const file = makeSessionFile(home, '--proj--', 'sess-1')
  appendFrame(file, [sessionLine('sess-1', 'D:\\proj'), usageLine(1)])

  const statePath = join(home, 'state.json')
  const r = await runReport({
    sessionsRoot: join(home, 'sessions'),
    statePath,
    noSave: true,
    dryRun: true,
  })

  assert.equal(r.records.length, 1, '仍能观察到增量')
  const s = loadState(statePath).state
  assert.equal(Object.keys(s.files).length, 0, 'noSave 不应写水位线')
  assert.equal(s.pending.length, 0)
}))

test('runReport：reset 后全量重扫（幂等由服务端保证）', tracked(async () => {
  const home = makeHome(); roots.push(home)
  const file = makeSessionFile(home, '--proj--', 'sess-1')
  appendFrame(file, [sessionLine('sess-1', 'D:\\proj'), usageLine(1), usageLine(2)])

  const statePath = join(home, 'state.json')
  const deliver = async (recs: UsageRecord[]) => ({ accepted: recs.length, duplicates: 0, rejected: 0 })

  const first = await runReport({ sessionsRoot: join(home, 'sessions'), statePath, deliver })
  assert.equal(first.records.length, 2)

  resetState(statePath)
  assert.equal(loadState(statePath).state.pending.length, 0, 'reset 后状态为空')

  const second = await runReport({ sessionsRoot: join(home, 'sessions'), statePath, deliver })
  assert.equal(second.records.length, 2, 'reset 后应重扫出全部记录')
}))

test('runReport：部分拒收不能按位置确认，重放时允许接受与重复混合', tracked(async () => {
  const home = makeHome(); roots.push(home)
  const file = makeSessionFile(home, '--proj--', 'sess-1')
  appendFrame(file, [sessionLine('sess-1', 'D:\\proj'), usageLine(1), usageLine(2)])
  const statePath = join(home, 'state.json')
  const options = { sessionsRoot: join(home, 'sessions'), statePath }

  await assert.rejects(runReport({ ...options, deliver: async () => ({ accepted: 1, duplicates: 0, rejected: 1 }) }), /拒收 1 条/)
  const retained = loadState(statePath).state
  assert.deepEqual(retained.pending.map(r => r.seq), [1, 2], '没有拒收 event_id 时整批都必须保留')
  assert.equal(retained.totalDelivered, 0)
  assert.equal(retained.lastFlushMs, 0)

  await runReport({ ...options, deliver: async records => {
    assert.deepEqual(records.map(r => r.seq), [1, 2])
    return { accepted: 1, duplicates: 1, rejected: 0 }
  } })
  assert.equal(loadState(statePath).state.pending.length, 0)
  assert.equal(loadState(statePath).state.totalDelivered, 2)
}))

test('runReport：不完整或非法确认计数不得清空 pending', tracked(async () => {
  const home = makeHome(); roots.push(home)
  const file = makeSessionFile(home, '--proj--', 'sess-1')
  appendFrame(file, [sessionLine('sess-1', 'D:\\proj'), usageLine(1), usageLine(2)])
  const statePath = join(home, 'state.json')
  for (const outcome of [
    { accepted: 1, duplicates: 0, rejected: 0 },
    { accepted: 3, duplicates: -1, rejected: 0 },
    { accepted: 1.5, duplicates: 0.5, rejected: 0 },
  ]) {
    await assert.rejects(runReport({ sessionsRoot: join(home, 'sessions'), statePath, deliver: async () => outcome }), /确认计数不完整/)
    assert.equal(loadState(statePath).state.pending.length, 2)
    assert.equal(loadState(statePath).state.totalDelivered, 0)
  }
}))

test('runReport：完整帧字节光标跨轮次保存，半帧完成后仍可重试投递', tracked(async () => {
  const home = makeHome(); roots.push(home)
  const file = makeSessionFile(home, '--proj--', 'sess-1')
  appendFrame(file, [sessionLine('sess-1', 'D:\\proj')])
  const statePath = join(home, 'state.json')
  const options = { sessionsRoot: join(home, 'sessions'), statePath }
  const deliver = async (records: UsageRecord[]) => ({ accepted: records.length, duplicates: 0, rejected: 0 })
  await runReport({ ...options, deliver })
  const prefixSize = statSync(file).size
  expectCursor(prefixSize)
  const tail = zstdCompressSync(Buffer.from(usageLine(1) + '\n'))
  appendFileSync(file, tail.subarray(0, 5))
  const partial = await runReport({ ...options, deliver })
  assert.equal(partial.records.length, 0)
  expectCursor(prefixSize)
  appendFileSync(file, tail.subarray(5))
  await assert.rejects(runReport({ ...options, deliver: async () => { throw new Error('temporary failure') } }), /temporary failure/)
  const state = loadState(statePath).state
  assert.equal(state.pending[0]?.cwd, 'D:\\proj')
  expectCursor(statSync(file).size)
  const retried = await runReport({ ...options, deliver })
  assert.equal(retried.scan.bytesRead, 0, '重试投递只用 pending，无需重读已完整暂存的帧')
  assert.equal(retried.pendingRemaining, 0)

  function expectCursor(offset: number): void {
    assert.equal(loadState(statePath).state.files[file]?.cursor?.byteOffset, offset)
  }
}))
