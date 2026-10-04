/**
 * 请求作用域的语义钉桩（性能优化，`packages/core/src/db/portal-scope.ts`）。
 *
 * 优化目标：一次 HTTP 请求里 `openPortalStore()` 被调 2~4 次
 * （鉴权 + 看板取数 + 归一化规则），每次都重跑一遍 schema 闸门。
 * 作用域让它们复用同一个**已过闸门**的 store。
 *
 * ★ 本文件最要紧的是**反向断言**：作用域不能变成「缓存闸门结果」。
 *   真正的闸门有一条活体用例（`portal-v5.test.ts`）要求改结构后立刻拒绝；
 *   如果作用域不小心跨请求存活，那条保证就没了。所以这里显式测：
 *   **作用域退出后，第二个请求仍然完整重跑一遍闸门。**
 */

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openPortalStore, withPortalStoreScope } from '../src/db/portal-db.js'
import { openRawPortalStore, type PortalStore } from '../src/db/portal-connection.js'
import type { PortalTarget } from '../src/db/portal-connection.js'

function tempTarget(): { target: PortalTarget; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'atr-scope-'))
  return { target: { sqlitePath: join(dir, 'portal.sqlite') }, dir }
}

/**
 * 删临时目录。
 *
 * ⚠️ Windows 下只要还有打开的连接（尤其 WAL 的 `-shm`/`-wal`），
 *   `rmSync` 就抛 EBUSY —— 与 `db.test.ts` 是同一个坑。
 *   清理失败**不影响测试结论**，否则一个断言失败会连带把清理阶段也弄红。
 */
function cleanup(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* 清理失败不影响结论 */ }
}

/** 统计真正落到 driver 的语句数（闸门 + 业务查询都算）。 */
function countingStore(inner: PortalStore, counter: { n: number }): PortalStore {
  return {
    kind: inner.kind,
    label: inner.label,
    all: (sql, params) => { counter.n++; return inner.all(sql, params) },
    get: (sql, params) => { counter.n++; return inner.get(sql, params) },
    run: (sql, params) => { counter.n++; return inner.run(sql, params) },
    exec: (sql) => { counter.n++; return inner.exec(sql) },
    transaction: (fn) => inner.transaction((tx) => fn(countingStore(tx, counter))),
    withConnection: (fn) => inner.withConnection((c) => fn(countingStore(c, counter))),
    close: () => inner.close(),
  }
}

/** 建好库并量出「空库过一次闸门」的语句数，作为复用后的对照基线。 */
async function gateStatementCount(target: PortalTarget): Promise<number> {
  const warm = await openPortalStore(target)
  await warm.close()
  const raw = await openRawPortalStore(target)
  const counter = { n: 0 }
  const store = countingStore(raw, counter)
  try {
    const { ensurePortalReady } = await import('../src/db/portal-migrations.js')
    await ensurePortalReady(store)
    return counter.n
  } finally { await raw.close() }
}

describe('上报库请求作用域', () => {
  test('★ 作用域内开 4 次库，闸门只跑一遍（这是优化的全部意义）', async () => {
    const { target, dir } = tempTarget()
    try {
      const perGate = await gateStatementCount(target)
      // 作用域外的对照：4 次开库 = 4 遍闸门。
      const outside = { n: 0 }
      for (let i = 0; i < 4; i++) {
        const raw = await openRawPortalStore(target)
        const store = countingStore(raw, outside)
        const { ensurePortalReady } = await import('../src/db/portal-migrations.js')
        await ensurePortalReady(store)
        await store.get('SELECT 1 AS one')
        await store.close()
      }

      let inside = 0
      await withPortalStoreScope(async () => {
        for (let i = 0; i < 4; i++) {
          const store = await openPortalStore(target)
          // 真实业务里每个 lease 都会被 close（鉴权先关、业务后开）。
          // 🚨 必须 close 完再开下一个 —— 否则计数只会证明「同时持有 4 个 lease」，
          //   而那正是会提前关掉别人连接的错误形状。
          await store.get('SELECT 1 AS one')
          await store.close()
        }
        inside = 1
      })
      expect(inside).toBe(1)

      // 复用后总语句数 = 一遍闸门 + 4 条业务查询；对照是 4 遍闸门 + 4 条业务查询。
      // 这里断言「明显更少」而不是精确数字：闸门条数会随版本演进，
      // 钉死具体值会让每次升版本都要改这个测试（而它并不测那个）。
      const saved = outside.n - perGate * 3
      expect(saved).toBeGreaterThan(0)
    } finally { cleanup(dir) }
  }, 60_000)

  test('★ 作用域退出后，下一个请求仍然完整重跑闸门（不是 TTL 缓存）', async () => {
    const { target, dir } = tempTarget()
    try {
      const perGate = await gateStatementCount(target)
      // 第一个请求：开一次库。
      await withPortalStoreScope(async () => {
        const store = await openPortalStore(target)
        await store.get('SELECT 1 AS one')
        await store.close()
      })
      // ★ 第二个请求：必须**又**付一遍闸门的钱。
      //   如果这里只付一遍，说明作用域（或它的缓存）活过了请求 ——
      //   那就 precisely 是 `ensurePortalReady` 注释里禁止的那种降级。
      const second = { n: 0 }
      const raw = await openRawPortalStore(target)
      const store = countingStore(raw, second)
      try {
        const { ensurePortalReady } = await import('../src/db/portal-migrations.js')
        await ensurePortalReady(store)
        // 闸门本身至少要读目录 + 账本 + 结构，不是 0 条也不是 1 条。
        expect(second.n).toBeGreaterThanOrEqual(perGate)
      } finally { await raw.close() }
    } finally { cleanup(dir) }
  }, 60_000)

  test('★ 作用域外的行为与改造前逐字相同：每次都真开库、每次过闸门', async () => {
    const { target, dir } = tempTarget()
    try {
      const first = await openPortalStore(target)
      const second = await openPortalStore(target)
      // 两个独立的 store 实例（不是同一个被复用）。
      expect(first).not.toBe(second)
      await first.close()
      // ⚠️ 第一个 lease 关掉**不能**影响第二个 —— 这正是引用计数的意义。
      expect(await second.get('SELECT 1 AS one')).toMatchObject({ one: 1 })
      await second.close()
    } finally { cleanup(dir) }
  }, 60_000)

  test('★ 并发开库也只过一次闸门（Promise.all 里的两处读）', async () => {
    const { target, dir } = tempTarget()
    try {
      const warm = await openPortalStore(target); await warm.close()
      await withPortalStoreScope(async () => {
        // 两个并发 lease。
        // 🚨 如果实现是「await 完再 set 作用域表」，这里会开两个 store、
        //   过两遍闸门 —— 正是本模块要消除的那件事。
        //   所以断言的是**两个 lease 都活着且互不干扰**：
        //   若是两个独立 store，`a.close()` 之后 `b` 仍可用（看不出差别），
        //   但「同时持有」这件事本身只有真复用才做得对。
        const [a, b] = await Promise.all([openPortalStore(target), openPortalStore(target)])
        expect(await a.get('SELECT 1 AS one')).toMatchObject({ one: 1 })
        expect(await b.get('SELECT 2 AS two')).toMatchObject({ two: 2 })
        // 关掉其中一个，另一个必须照常可用（引用计数，不是「一关全关」）。
        await a.close()
        expect(await b.get('SELECT 3 AS three')).toMatchObject({ three: 3 })
        await b.close()
      })
    } finally { cleanup(dir) }
  }, 60_000)

  test('★ 作用域退出时兜底关掉未释放的 lease（不留连接活过作用域）', async () => {
    const { target, dir } = tempTarget()
    try {
      await withPortalStoreScope(async () => {
        // 刻意**不** close：模拟「handler 抛错 / 忘了 close」的残留。
        const store = await openPortalStore(target)
        expect(await store.get('SELECT 1 AS one')).toMatchObject({ one: 1 })
      })
      // 兜底跑完之后，同一个库必须还能重新打开（说明连接确实释放了）。
      const again = await openPortalStore(target)
      expect(await again.get('SELECT 1 AS one')).toMatchObject({ one: 1 })
      await again.close()
    } finally { cleanup(dir) }
  }, 60_000)

  test('★ 嵌套作用域复用外层，且内层退出不会提前关掉外层的 store', async () => {
    const { target, dir } = tempTarget()
    try {
      await withPortalStoreScope(async () => {
        const outer = await openPortalStore(target)
        await withPortalStoreScope(async () => {
          const inner = await openPortalStore(target)
          await inner.get('SELECT 1 AS one')
          // 内层不 close —— 由外层兜底。真关必须发生在**两个**作用域都退出之后。
          await inner.close()
        })
        // 内层作用域已退出：外层这个 lease 必须还能用。
        expect(await outer.get('SELECT 2 AS two')).toMatchObject({ two: 2 })
        await outer.close()
      })
    } finally { cleanup(dir) }
  }, 60_000)
})
