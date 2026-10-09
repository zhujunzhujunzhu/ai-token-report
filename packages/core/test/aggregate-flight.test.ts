/** 在途合并必须隔离数据库/筛选/价格，失败与成功都不能留下旧结果。 */
import { describe, expect, test } from 'bun:test'
import { aggregateFlight, readAggregate } from '../src/db/aggregate-flight.js'
import type { PortalStore } from '../src/db/portal-connection.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail })
  return { promise, resolve, reject }
}
function reader(all: () => Promise<unknown[]>): Pick<PortalStore, 'kind' | 'all'> {
  return { kind: 'mysql', all: <Row>() => all() as Promise<Row[]> }
}
const target = { sqlitePath: 'unused', mysqlUrl: 'mysql://account@localhost/flight' }
const query = { sql: 'SELECT SUM(input_tokens) FROM usage_event WHERE member_id=$member', params: { $member: '甲' } }

describe('聚合在途合并', () => {
  test('趋势计算合并包含金额门禁、粒度与完整价表；完成后不留结果', async () => {
    const pending = deferred<{ amount: number }>()
    let calls = 0
    const work = async () => { calls++; return pending.promise }
    const identity = ['series', 'day', true, [{ rate: 7 }]]
    const results = Array.from({ length: 16 }, () => aggregateFlight(target, 'mysql', identity, work))
    for (const variant of [['series', 'hour', true, [{ rate: 7 }]], ['series', 'day', false, null], ['series', 'day', true, [{ rate: 9 }]]]) results.push(aggregateFlight(target, 'mysql', variant, work))
    expect(calls).toBe(4)
    pending.resolve({ amount: 11 })
    expect((await Promise.all(results)).every(row => row.amount === 11)).toBe(true)
    expect(await aggregateFlight(target, 'mysql', identity, async () => ({ amount: 23 }))).toEqual({ amount: 23 })
  })
  test('16 个相同读取只执行一次，完成后的新请求重新读库', async () => {
    const task = deferred<unknown[]>()
    let calls = 0
    const store = reader(async () => { calls++; return calls === 1 ? task.promise : [{ input: 200 }] })
    const batch = Array.from({ length: 16 }, () => readAggregate<{ input: number }>(target, store, query))
    expect(calls).toBe(1)
    task.resolve([{ input: 100 }])
    expect((await Promise.all(batch)).every((rows) => rows[0]?.input === 100)).toBe(true)
    expect(await readAggregate(target, store, query)).toEqual([{ input: 200 }])
    expect(calls).toBe(2)
  })

  test('人员、来源、供应商、规则、价格快照和数据库账号不能串结果', async () => {
    const task = deferred<unknown[]>()
    let calls = 0
    const store = reader(async () => { calls++; return task.promise })
    const reads = [readAggregate(target, store, query)]
    const scopes: Record<string, string | number>[] = [
      { $member: '乙' }, { $member: '甲', $source: 'codex' },
      { $member: '甲', $provider: 'openai' }, { $member: '甲', $alias: 'new-name' },
      { $member: '甲', $price: 2000 },
    ]
    for (const params of scopes) reads.push(readAggregate(target, store, { ...query, params }))
    reads.push(readAggregate({ ...target, mysqlUrl: 'mysql://another@localhost/flight' }, store, query))
    reads.push(readAggregate({ ...target, mysqlUrl: 'mysql://account@localhost/another' }, store, query))
    expect(calls).toBe(reads.length)
    task.resolve([])
    await Promise.all(reads)
  })

  test('失败同时传给等待者，下一次请求能正常重试', async () => {
    const task = deferred<unknown[]>()
    let calls = 0
    const store = reader(async () => { calls++; return calls === 1 ? task.promise : [] })
    const batch = [readAggregate(target, store, query), readAggregate(target, store, query)]
    const results = Promise.allSettled(batch)
    task.reject(new Error('数据库暂时不可用'))
    expect((await results).every((result) => result.status === 'rejected')).toBe(true)
    expect(await readAggregate(target, store, query)).toEqual([])
    expect(calls).toBe(2)
  })

  test('64 个不同在途任务后正常读取，相同任务仍能合并', async () => {
    const task = deferred<unknown[]>()
    let calls = 0
    const store = reader(async () => { calls++; return task.promise })
    const batch = Array.from({ length: 65 }, (_, i) => readAggregate(target, store, { ...query, params: { $member: String(i) } }))
    batch.push(readAggregate(target, store, { ...query, params: { $member: '0' } }))
    expect(calls).toBe(65)
    task.resolve([])
    await Promise.all(batch)
  })
})
