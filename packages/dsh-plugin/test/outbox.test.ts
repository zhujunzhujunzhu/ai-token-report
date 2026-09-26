/**
 * 磁盘 outbox 的测试。
 *
 * ★ 这里钉死的是**崩溃不丢**这条性质。coordinator 的游标记的是「已交出」
 *   而不是「已送达」，所以「进程在发送前后崩掉」这两种情形必须各自被覆盖：
 *
 *   - 发送**前**崩 → 记录还在 pending 文件里 → 下次启动照发
 *   - 发送**后**、收到回执**前**崩 → 记录在 inflight 文件里 → 下次启动捞回重发
 *
 *   后者会重发，但服务端按 `event_id` 幂等 —— 宁可重发，不可漏发。
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import * as fs from 'node:fs'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Outbox } from '../src/outbox.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'atr-outbox-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** 造一批线上格式的记录。 */
function records(n: number, prefix = 'e'): Record<string, unknown>[] {
  return Array.from({ length: n }, (_, i) => ({ event_id: `${prefix}${i}`, session_id: 's1', seq: i }))
}

/** 目录里的文件名。 */
function files(): string[] {
  return readdirSync(dir).sort()
}

describe('落盘与取回', () => {
  test('写入一批后能原样取回', () => {
    const box = new Outbox({ dir, maxBytes: 1024 * 1024 })
    const file = box.write(records(3))
    expect(file).not.toBeNull()

    const taken = box.take(10)
    expect(taken).toHaveLength(1)
    expect(taken[0]?.records).toHaveLength(3)
    expect(taken[0]?.records[0]).toEqual({ event_id: 'e0', session_id: 's1', seq: 0 })
  })

  test('空批次不落盘（避免攒出一堆空文件）', () => {
    const box = new Outbox({ dir, maxBytes: 1024 * 1024 })
    expect(box.write([])).toBeNull()
    expect(files()).toHaveLength(0)
  })

  test('多批按写入顺序取回（FIFO —— 先采的先上账）', () => {
    const box = new Outbox({ dir, maxBytes: 1024 * 1024 })
    box.write(records(1, 'a'))
    box.write(records(1, 'b'))
    box.write(records(1, 'c'))

    const taken = box.take(10)
    expect(taken.map((b) => b.records[0]?.['event_id'])).toEqual(['a0', 'b0', 'c0'])
  })

  test('take 的批次数上限被尊重', () => {
    const box = new Outbox({ dir, maxBytes: 1024 * 1024 })
    for (let i = 0; i < 5; i++) box.write(records(1, `x${i}`))
    expect(box.take(2)).toHaveLength(2)
  })
})

describe('★ 崩溃不丢', () => {
  test('标记 inflight 后崩溃 → 下次启动 recover() 捞回 pending', () => {
    const box = new Outbox({ dir, maxBytes: 1024 * 1024 })
    const file = box.write(records(2))!
    box.markInflight(file)

    // 发送前/后崩溃 —— 没有 ack 也没有 release，文件停在 inflight
    expect(files().some((f) => f.startsWith('inflight-'))).toBe(true)

    // 新进程启动
    const restarted = new Outbox({ dir, maxBytes: 1024 * 1024 })
    expect(restarted.recover()).toBe(1)
    expect(files().every((f) => f.startsWith('pending-'))).toBe(true)
    expect(restarted.take(10)[0]?.records).toHaveLength(2)
  })

  test('投递成功 ack 后文件消失', () => {
    const box = new Outbox({ dir, maxBytes: 1024 * 1024 })
    const file = box.write(records(2))!
    box.markInflight(file)
    box.ack(file)

    expect(files()).toHaveLength(0)
    expect(box.take(10)).toHaveLength(0)
  })

  test('投递失败 release 后回到 pending，可再次取出重发', () => {
    const box = new Outbox({ dir, maxBytes: 1024 * 1024 })
    const file = box.write(records(2))!
    box.markInflight(file)
    box.release(file)

    expect(files().every((f) => f.startsWith('pending-'))).toBe(true)
    expect(box.take(10)[0]?.records).toHaveLength(2)
  })

  test('ack / release 是幂等的（重复调用不抛错）', () => {
    const box = new Outbox({ dir, maxBytes: 1024 * 1024 })
    const file = box.write(records(1))!
    box.ack(file)
    box.ack(file)
    box.release(file)
    expect(files()).toHaveLength(0)
  })

  test('没有残留 inflight 时 recover() 返回 0（不误报）', () => {
    const box = new Outbox({ dir, maxBytes: 1024 * 1024 })
    box.write(records(1))
    expect(box.recover()).toBe(0)
  })
})

describe('损坏数据', () => {
  test('★ 单行坏掉只丢该行，不整批丢弃（一次断电不该抹掉几百条用量）', () => {
    const box = new Outbox({ dir, maxBytes: 1024 * 1024 })
    const file = box.write(records(3))!

    // 手工把中间那行改坏，模拟写盘时断电留下的半行
    const lines = ['{"event_id":"a"}', '{坏 JSON', '{"event_id":"c"}']
    writeFileSync(join(dir, file), lines.join('\n') + '\n', 'utf8')

    const taken = box.take(10)
    expect(taken[0]?.records.map((r) => r['event_id'])).toEqual(['a', 'c'])
  })

  test('外部已经删除的文件不再出现在待发送队列中', () => {
    const box = new Outbox({ dir, maxBytes: 1024 * 1024 })
    box.write(records(1))
    // 目录在，但文件被外部删掉（模拟手工清理）
    const file = files()[0]!
    rmSync(join(dir, file))

    expect(box.take(10)).toHaveLength(0)
    expect(files()).toHaveLength(0)
  })
})

describe('容量上限', () => {
  test('★ 超过字节上限时丢最旧的批，并如实计数（静默丢弃不可接受）', () => {
    // 上限设得极小：每条记录约 40 字节，一批 1 条也存不下几批
    const box = new Outbox({ dir, maxBytes: 120 })
    const written: string[] = []
    for (let i = 0; i < 5; i++) {
      const file = box.write(records(1, `k${i}:`))
      if (file) written.push(file)
    }

    const stats = box.stats()
    expect(stats.droppedBatches).toBeGreaterThan(0)
    expect(stats.droppedBatches).toBeLessThan(written.length)

    // 保留的必须是**最新**的那批：内网断三天时，最近的用量比三天前的更有价值
    const kept = box.take(10).map((b) => b.records[0]?.['event_id'])
    expect(kept).toContain('k4:0')
    expect(kept).not.toContain('k0:0')
  })

  test('stats 如实反映待投递的批次与条数', () => {
    const box = new Outbox({ dir, maxBytes: 1024 * 1024 })
    box.write(records(3, 'a'))
    box.write(records(2, 'b'))

    const stats = box.stats()
    expect(stats.pendingBatches).toBe(2)
    expect(stats.pendingRecords).toBe(5)
    expect(stats.pendingBytes).toBeGreaterThan(0)
    expect(stats.droppedBatches).toBe(0)
  })
})

describe('目录不可用时的降级', () => {
  test('★ 目录建不出来也不抛错（outbox 是兜底，不该把主流程拖死）', () => {
    // 用一个「父路径是文件」的目录，mkdirSync 必然失败
    const filePath = join(dir, 'not-a-dir')
    writeFileSync(filePath, 'x', 'utf8')

    const box = new Outbox({ dir: join(filePath, 'sub'), maxBytes: 1024 })
    expect(box.stats().pendingBatches).toBe(0)
    // 写盘失败返回 null，调用方据此降级为「仅内存投递」
    expect(box.write(records(1))).toBeNull()
  })

  test('clear() 清空所有批', () => {
    const box = new Outbox({ dir, maxBytes: 1024 * 1024 })
    const file = box.write(records(2))!
    box.markInflight(file)
    box.write(records(1))
    box.clear()
    expect(files()).toHaveLength(0)
    expect(existsSync(dir)).toBe(true)
  })
})

describe('增量元数据与共享目录', () => {
  test('已有积压时写新批与读统计不重读、解析或逐个 stat 历史文件', () => {
    const box = new Outbox({ dir, maxBytes: 1024 * 1024, now: () => 0 })
    for (let i = 0; i < 64; i++) box.write(records(2, `${i}:`))
    const read = spyOn(fs, 'readFileSync')
    const stat = spyOn(fs, 'statSync')
    const parse = spyOn(JSON, 'parse')
    try {
      box.write(records(3))
      expect(box.stats().pendingRecords).toBe(131)
      expect(read).not.toHaveBeenCalled()
      expect(parse).not.toHaveBeenCalled()
      // 只允许目录戳和新文件的固定次数检查，不能随 64 个积压文件增长。
      expect(stat.mock.calls.length).toBeLessThan(10)
    } finally {
      read.mockRestore(); stat.mockRestore(); parse.mockRestore()
    }
  })

  test('同毫秒创建的两个实例不能覆盖彼此的批次', () => {
    const first = new Outbox({ dir, maxBytes: 1024 * 1024 })
    const second = new Outbox({ dir, maxBytes: 1024 * 1024 })
    const clock = spyOn(Date, 'now').mockReturnValue(123456)
    try {
      expect(first.write(records(2, 'a'))).not.toBe(second.write(records(3, 'b')))
    } finally { clock.mockRestore() }
    const reopened = new Outbox({ dir, maxBytes: 1024 * 1024 })
    expect(reopened.stats().pendingRecords).toBe(5)
  })

  test('低频核对能看见另一实例的新增、领取、释放和确认', () => {
    let now = 0
    const first = new Outbox({ dir, maxBytes: 1024 * 1024, now: () => now })
    const second = new Outbox({ dir, maxBytes: 1024 * 1024, now: () => now })
    const file = first.write(records(3))!
    now += 30_000
    expect(second.stats().pendingRecords).toBe(3)
    expect(first.markInflight(file)).toBe(true)
    expect(second.markInflight(file)).toBe(false)
    expect(second.stats().pendingBatches).toBe(0)
    first.release(file)
    now += 30_000
    expect(second.take(1)[0]?.records).toHaveLength(3)
    second.markInflight(file)
    second.ack(file)
    now += 30_000
    expect(first.stats().pendingRecords).toBe(0)
  })

  test('原地修改不改变目录戳时，也会在低频核对后更新计数', () => {
    let now = 0
    const box = new Outbox({ dir, maxBytes: 1024 * 1024, now: () => now })
    const file = box.write(records(2))!
    writeFileSync(join(dir, file), JSON.stringify({ event_id: 'after' }) + '\n')
    now += 30_000
    expect(box.stats().pendingRecords).toBe(1)
  })

  test('未发布的写入临时文件不进入待发送统计和队列', () => {
    writeFileSync(join(dir, '.writing-pending-interrupted.jsonl'), '{未完成')
    const box = new Outbox({ dir, maxBytes: 1024 * 1024 })
    expect(box.stats().pendingBatches).toBe(0)
    expect(box.take(1)).toHaveLength(0)
  })

  test('重复领取和释放保持一个队列条目，容量淘汰后计数仍准确', () => {
    const box = new Outbox({ dir, maxBytes: 300 })
    const file = box.write(records(1))!
    for (let i = 0; i < 5; i++) {
      expect(box.take(1)).toHaveLength(1)
      box.markInflight(file)
      expect(box.stats().pendingRecords).toBe(0)
      box.release(file)
      expect(box.take(10)).toHaveLength(1)
    }
    for (let i = 0; i < 10; i++) box.write(records(1, `new${i}:`))
    const pending = box.take(100)
    expect(box.stats().pendingRecords).toBe(pending.reduce((n, batch) => n + batch.records.length, 0))
    expect(box.stats().pendingBytes).toBeLessThanOrEqual(300)
  })
})
