/**
 * 上报库的**请求作用域**：让「一次 HTTP 请求里的多次开库」只过一遍版本闸门。
 *
 * ## 为什么需要它
 *
 * 线上实测（2026-10-04，`docs/性能探索-线上-2026-10-04.md`）：一次看板渲染
 * 大约发 9 个请求，而**每个请求**都会经 `IdentityRepository.read()`（鉴权）与
 * `StatsRoute` 的业务查询各开一次库 —— 每次 `openPortalStore()` 都完整跑一遍
 * `ensurePortalReady()`。闸门本身已经很便宜了（合并后 MySQL 5 条语句），
 * 但「同一请求内重复过 2~4 遍」仍然是纯粹的浪费。
 *
 * ## 🚨 它**不是** TTL 缓存 —— 闸门最硬的那条语义原样保留
 *
 * `ensurePortalReady` 的注释明确禁止「降成版本指纹 + TTL 缓存」，因为
 * `portal-v5.test.ts` 有一条活体用例会 DROP 掉外键再 open，要求**立刻**抛
 * 「实际外键不一致」。本模块刻意绕开这个矛盾：
 *
 * | | 改结构后的行为 |
 * |---|---|
 * | TTL 缓存（N 秒内放行） | ❌ N 秒内仍然放行 —— 正是被禁止的那种 |
 * | **本模块** | ✅ **下一个请求**的第一次 open 就拒绝 |
 *
 * 差别在于**作用域的生命周期 = 一个请求**，而不是一个时间窗口：
 * 每个请求至少仍会完整跑一遍闸门（复用只发生在**同一个请求内部**），
 * 所以「运行中改结构立刻拒绝」在请求粒度上依然成立。
 *
 * ## 作用域必须**显式开启**
 *
 * 没有顶层 `withPortalStoreScope()` 时，`openPortalStore()` 的行为与
 * 引入本模块之前**逐字相同**（每次真开、每次过闸门）。CLI、单测、迁移器
 * 全都不开作用域 —— 它们一个请求只开一次库，复用对它们没有收益，
 * 却会让「闸门跑了几遍」在测试里变得不可观测。
 *
 * ## 连接的生命周期 = **作用域**，不是 lease
 *
 * 每次 `openPortalStore()` 返回一个**独立 lease**，`close()` 只递减引用计数，
 * **不真关连接** —— 真关只在作用域退出时发生一次。`refs` 仍然有用：它保证
 * 「作用域退出时还在别人手里」的 store 不会被提前关掉，以及并发开库只开一次。
 *
 * 🚨 **这一点是 2026-10-07 修掉的**：原实现一见 `refs` 归零就 `store.close()`
 *   并把 entry 从作用域表里摘掉，于是「关掉再开」会**重新开库、重新过闸门**。
 *   而线上一个带会话的看板请求正是**串行**开 4 次库
 *   （`isRegistered` → `resolveSession` → `authorize` → 统计会话），每处都在
 *   `finally` 里关掉才轮到下一处 ⇒ 闸门实测跑了 **4 遍**：
 *   带会话的 `/api/v1/stats/groups` = **55.3 条 SQL/请求**（≈ 4×闸门 + 鉴权 + 业务），
 *   而未鉴权的 401 只走一次 `isRegistered` = **11.3 条**（1×闸门 + 1）。
 *   ⇒ 本模块此前**对真实形状完全没生效**（附录 B 的 A/B「零差异」也是这个原因）。
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { describePortalTarget, openRawPortalStore, type PortalStore, type PortalTarget } from './portal-connection.js'
import { ensurePortalReady } from './portal-migrations.js'

interface ScopeEntry {
  /** 作用域表里的键（见 `scopeKey`）。清理时按它 `delete`，不能拿 label 反推。 */
  key: string
  store: PortalStore
  /** 已发放但尚未 `close()` 的 lease 数。 */
  refs: number
  /** 正在开库 / 过闸门的 promise：并发开库只能开一次、只过一次闸门。 */
  opening: Promise<PortalStore>
  /** 真关过一次：之后的 `close()` 变成空操作（幂等）。 */
  disposed: boolean
}

const storage = new AsyncLocalStorage<Map<string, ScopeEntry>>()

/** 当前是否处在一个请求作用域内。导出只为了测试断言与可观测性。 */
export function inPortalStoreScope(): boolean {
  return storage.getStore() !== undefined
}

/**
 * 作用域的键：同一个库才算复用。
 *
 * ⚠️ 必须用 `describePortalTarget` 的输出（MySQL 是 `库名 @ 主机:端口`，
 *   SQLite 是绝对路径）而不是 `sqlitePath` 原串 —— 否则同一文件用
 *   `./a/portal.sqlite` 与 `/abs/a/portal.sqlite` 两种写法打开时
 *   会开出两个 store，而闸门白跑两遍（这正是 `SqlitePortalStore.key`
 *   已经在处理的同一件事：`process.platform === 'win32'` 要小写化）。
 */
function scopeKey(target: PortalTarget): string {
  const label = describePortalTarget(target)
  return process.platform === 'win32' ? label.toLowerCase() : label
}

/**
 * 给一个真实 store 套上「计数式 close」的 lease。
 *
 * ★ 只有 `close()` 的语义变了：`all` / `get` / `run` / `exec` /
 *   `transaction` / `withConnection` 全部原样转发，`this` 语义也保留
 *   （`SqlitePortalStore.key` 等字段仍可读）。
 *   `transaction` / `withConnection` 交出去的是**真实**的子 store，
 *   不套 lease —— 它们由父 store 的队列/连接池管，调用方也不会去 `close()` 它们。
 */
function lease(entry: ScopeEntry): PortalStore {
  entry.refs += 1
  const inner = entry.store
  return {
    kind: inner.kind,
    label: inner.label,
    // ⚠️ 泛型必须原样透传，不能写成 `all: (sql, params) => inner.all(sql, params)`：
    //   那样 `store.get<{ one: number }>(...)` 的 `Row` 会在包装层丢失，
    //   调用方拿到 `unknown`，`toEqual` 随之报「不是 null | undefined」。
    //   `params as never` 只作用在**参数**上（底层 `MysqlPortalStore` 声明成 `never`，
    //   因为驱动要能收数组），与返回值的泛型无关。
    all: <Row>(sql: string, params?: Record<string, unknown>) => inner.all<Row>(sql, params as never),
    get: <Row>(sql: string, params?: Record<string, unknown>) => inner.get<Row>(sql, params as never),
    run: (sql: string, params?: Record<string, unknown> | unknown[]) => inner.run(sql, params as never),
    exec: (sql: string) => inner.exec(sql),
    transaction: <T>(fn: (tx: PortalStore) => Promise<T>) => inner.transaction((tx) => fn(tx)),
    withConnection: <T>(fn: (connection: PortalStore) => Promise<T>) => inner.withConnection((connection) => fn(connection)),
    close: async () => {
      entry.refs -= 1
      // 🚨 **lease 关掉不等于真关连接**：连接的生命周期归**作用域**，不归 lease。
      //
      //   为什么必须这样：线上一个带会话的看板请求会**串行**开 4 次库
      //   （`isRegistered` → `resolveSession` → `authorize` → 统计会话），
      //   每处都在 `finally` 里 `close()` 完才轮到下一处。原来的实现一见 refs 归零
      //   就 `store.close()` 并把 entry 从表里摘掉 ⇒ 后一次 open **又开一遍库、又过一遍闸门**。
      //   实测（2026-10-07，线上 `Questions` 差值 / 10 次请求）：
      //   带会话的 `groups` = **55.3 条 SQL/请求** ≈ 4×闸门(9) + 鉴权(~18) + 业务(1)，
      //   而「未鉴权 401」只走一次 `isRegistered` ⇒ **11.3 条**，正好是 1×闸门 + 1。
      //   ⇒ 这条优化此前**对真实形状完全没生效**（附录 B 的 A/B「零差异」也是这个原因）。
      if (entry.refs > 0 || entry.disposed) return
      // 留在作用域表里：同一请求后续再 open 会拿到**同一个**已过闸门的 store。
      // ⚠️ 这里刻意**不**碰 `scope`，也不关连接 —— 真正的关闭只在作用域退出时发生
      //   （见 `withPortalStoreScope` 的 `finally`）。`disposed` 仍只表示「真关过一次」，
      //   所以作用域退出后再来的 `close()` 依旧是空操作（幂等）。
    },
  }
}

/**
 * 在一个请求作用域内执行 `fn`：作用域内的多次 `openPortalStore()`
 * 复用同一个已过闸门的 store。
 *
 * ★ **嵌套调用直接透传**（不建新作用域）：内层 `withPortalStoreScope`
 *   复用外层的表，退出内层时也**不会**提前关掉外层还在用的 store。
 *   这是「引用计数」而不是「作用域退出就关」的直接后果。
 */
export async function withPortalStoreScope<T>(fn: () => Promise<T>): Promise<T> {
  if (storage.getStore()) return await fn()
  const scope = new Map<string, ScopeEntry>()
  try {
    return await storage.run(scope, fn)
  } finally {
    // ★ **连接的生命周期 = 作用域**：退出时把这一请求开过的库统统关掉。
    //   lease 的 `close()` 只递减引用计数（它必须在同一个请求里被反复开关，
    //   见 `lease()` 的注释），真关只在这里发生一次。
    //   ⚠️ 因此这里**不能**按 `refs > 0` 跳过：handler 忘了 close 的 lease
    //     同样必须被关掉（SQLite 下那就是一个活过请求的文件句柄）。
    for (const entry of scope.values()) {
      if (entry.disposed) continue
      entry.disposed = true
      await entry.store.close()
    }
    scope.clear()
  }
}

/**
 * 作用域感知的开库。**没有作用域时行为与改造前逐字相同**。
 *
 * 放在这里而不是让每个调用方自己判，是因为调用点有 8 处
 * （`IdentityRepository.read` / `StatsRoute` 6 处 / `IngestRoute` /
 *  `openPortalStats`），逐处判断迟早会漏一处，而漏掉的那处
 * 表现为「优化在测试里看不出来、在线上时灵时不灵」。
 */
export async function openScopedPortalStore(target: PortalTarget): Promise<PortalStore> {
  const scope = storage.getStore()
  if (!scope) return await openPortalStoreUnscoped(target)
  const key = scopeKey(target)
  const existing = scope.get(key)
  // ⚠️ 命中已有 entry 时**同样要 await**：并发分支里 entry 已经在表里，
  //   但它的 store 可能还没开出来（`opening` 未 settle）。
  //   少了这个 await，`lease()` 就会包到 `store === undefined` 上 ——
  //   症状是「Promise.all 里两处读，偶发 500」，串行写法永远测不到。
  if (existing) { await existing.opening; return lease(existing) }
  // 🚨 必须在 `scope.set` **之前**就把 promise 存进去：并发开库
  //   （`Promise.all` 里的两处读）如果各自 `await` 完再 set，
  //   会开两个 store、过两次闸门 —— 正是本模块要消除的那件事。
  const entry: ScopeEntry = {
    key,
    store: undefined as unknown as PortalStore,
    refs: 0,
    opening: undefined as unknown as Promise<PortalStore>,
    disposed: false,
  }
  entry.opening = openPortalStoreUnscoped(target)
    .then((store) => {
      entry.store = store
      return store
    })
    .catch((error) => {
      // 开库失败不能把半成品留在表里，否则同一个请求后续的
      // 每次 open 都会重试同一个已 reject 的 promise。
      if (scope.get(key) === entry) scope.delete(key)
      throw error
    })
  scope.set(key, entry)
  // ⚠️ 这里**必须 `await`**，不能直接 `lease(entry)`：
  //   并发的第二个调用会命中上面 `scope.get(key)` 拿到同一条 entry，
  //   若那时 `entry.store` 还是 `undefined`（`.then` 还没跑），
  //   它的 `all/get/run` 全会炸在「读 undefined 的属性」上 ——
  //   表现为**生产里偶发**的 500（只在真并发时出现，串行写法测不出来）。
  await entry.opening
  // 作用域在 `await` 期间就退出了（不该发生，但要防一手）：
  // 此时没人会再来 `close()` 这个 lease，直接真关。
  if (!storage.getStore()) {
    entry.disposed = true
    await entry.store.close()
    throw new Error('上报库作用域在开库过程中就结束了')
  }
  return lease(entry)
}

/** 真正开库并过闸门。作用域内外共用这一条路径，保证语义完全一致。 */
async function openPortalStoreUnscoped(target: PortalTarget): Promise<PortalStore> {
  const store = await openRawPortalStore(target)
  try { await ensurePortalReady(store); return store }
  catch (error) { await store.close(); throw error }
}
