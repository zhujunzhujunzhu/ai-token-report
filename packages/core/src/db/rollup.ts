/**
 * 看板汇总表（v8）的**构建与增量补齐**。
 *
 * ## 这三张表是什么、为什么不是「又一份事实」
 *
 * 看板取数一律是整窗口聚合：30 天要扫几十万行，`day`/`hour` 分桶还要把原始行搬回
 * Node。实测 300 万行下单个接口 330~490ms。汇总表把这些聚合**提前算好**，
 * 于是同样的接口变成查几千行小表（实测 191~485×）。
 *
 * ★ **它们是纯粹的派生数据**：任何时候都能从 `usage_event` 完整重建，
 *   所以「表坏了 / 水位乱了 / 时区变了」的处理一律是**重建**，不是迁移或修复。
 *   这也意味着查询层必须能在汇总表不可用时**退原始表而不报错**。
 *
 * ## 三张表的分工（时点粒度是被需求逼出来的）
 *
 * | 表 | 粒度 | 服务 |
 * |---|---|---|
 * | `usage_rollup_day` | (本地日, 人, 供应商, 模型) | 长窗口趋势 / 排行 / 分布 |
 * | `usage_rollup_hour` | (本地日, 本地小时, 人, 供应商, 模型)，仅最近 N 天 | 单日日内曲线 + 近期时段分布 |
 * | `usage_rollup_hod` | (本地时点, 工作日?) | 全历史「一天中的第几小时」分布 |
 *
 * ## 🚨 四条不许破的约束
 *
 * 1. **只存原始列的和** + `lo`/`hi`。派生指标（命中率、均价、金额）一律查询期现算。
 * 2. **`sessions` 不在这里**：去重会话数**不可加**（跨天会话会被算两次），
 *    永远走原始表。少一列是刻意的。
 * 3. **归属只存 `member_id`**：分组在查询期 JOIN `member_group_assignments` 展开。
 * 4. **时间键用 `aggregate.ts` 的实现**（`toDayKey` / `toHourOfDay` / `dayKindOf`），
 *    **绝不用 SQL 的 `DATE(FROM_UNIXTIME())`** —— 那正是 `query.ts` 避开的时区分叉。
 *
 * ## 🚨 水位用 `received_at_ms`，不是 `ts`
 *
 * 上报允许乱序（历史补报会把很旧的 `ts` 送进来）。若按 `ts` 走水位，
 * 一条「昨天发生、今天才上报」的事件会被水位跳过、**永久不进汇总**，
 * 而原始表里明明有它 —— 表现是「汇总比原始少一点」，没有任何报错。
 * `received_at_ms` 是「这条数据什么时候到的」，不会倒退。
 *
 * ⚠️ `received_at_ms IS NULL` 的历史行（v4 之前导入的）永远进不了汇总：
 *   它们没有接收时刻可比。这些行由查询层的**覆盖率守卫**兜住（见 `rollupCoverage()`）。
 */
import { dayKindOf, toDayKey, toHourOfDay } from '../aggregate.js'
import type { PortalStore } from './portal-connection.js'
import { ROLLUP_HOUR_RETAIN_DAYS, rollupTimezoneKey } from './portal-schema-v8.js'
import { PORTAL_SCHEMA_VERSION } from './portal-schema-v5.js'

/** 一行原始事件里汇总结算需要的字段。 */
export interface RollupSourceRow {
  ts: unknown
  member_id: unknown
  provider: unknown
  model: unknown
  input_tokens: unknown
  output_tokens: unknown
  cache_read_tokens: unknown
  cache_write_tokens: unknown
  reasoning_tokens: unknown
}

/** 一个汇总格的计数（全是原始列的和）。 */
export interface RollupCell {
  memberId: string
  provider: string
  model: string
  calls: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  reasoning: number
  lo: number
  hi: number
}

function num(value: unknown): number {
  if (value === null || value === undefined) return 0
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}
/** 未归属用 `''` 哨兵：主键列不能为 NULL。 */
function memberKey(value: unknown): string {
  return typeof value === 'string' && value.length > 0 ? value : ''
}

/**
 * 把一段原始行折成「日 / 小时 / 时点」三种键的汇总格。
 *
 * ★ **本函数是纯函数**（不碰库），所以口径可以单独单测 ——
 *   而它与查询层的分桶共用同一份 `aggregate.ts` 实现，两边必然一致。
 */
export function foldRollupRows(rows: readonly RollupSourceRow[], options: { key: 'day' | 'hour' | 'hod' | 'hodWorkday' }): Map<string, RollupCell> {
  const cells = new Map<string, RollupCell>()
  for (const row of rows) {
    const ts = num(row.ts)
    const memberId = memberKey(row.member_id)
    const provider = typeof row.provider === 'string' ? row.provider : ''
    const model = typeof row.model === 'string' ? row.model : ''
    // 🔑 分桶键：一律走 aggregate.ts，绝不用 SQL 的日期函数。
    const scope = options.key === 'day'
      ? toDayKey(ts)
      : options.key === 'hour'
        ? `${toDayKey(ts)}|${toHourOfDay(ts)}`
        : `${toHourOfDay(ts)}|${dayKindOf(ts)}`
    const key = `${scope}\u0000${memberId}\u0000${provider}\u0000${model}`
    const existing = cells.get(key)
    const input = num(row.input_tokens)
    const output = num(row.output_tokens)
    const cacheRead = num(row.cache_read_tokens)
    const cacheWrite = num(row.cache_write_tokens)
    const reasoning = num(row.reasoning_tokens)
    if (existing) {
      existing.calls += 1
      existing.input += input
      existing.output += output
      existing.cacheRead += cacheRead
      existing.cacheWrite += cacheWrite
      existing.reasoning += reasoning
      if (ts < existing.lo) existing.lo = ts
      if (ts > existing.hi) existing.hi = ts
    } else {
      cells.set(key, { memberId, provider, model, calls: 1, input, output, cacheRead, cacheWrite, reasoning, lo: ts, hi: ts })
    }
  }
  return cells
}

/** 汇总元数据（单行）。 */
export interface RollupMeta {
  timezoneKey: string
  /** 已汇总到的**接收时刻**（复合游标的第一段）。 */
  builtThroughMs: number
  /**
   * 已汇总到的**事件 ID**（复合游标的第二段）。
   *
   * 🚨 少了它，水位在「同一接收时刻有超过一批行」时会**停住不动** ——
   *   一次批量上报的接收时刻完全相同，`received_at_ms > 水位` 永远筛不到新行。
   *   见 `syncRollups()` 的模块注释。
   */
  builtThroughEventId: string
  hourCutoffMs: number
}

/** 读元数据；表为空或没建都返回 null（调用方据此走全量重建）。 */
export async function readRollupMeta(store: PortalStore): Promise<RollupMeta | null> {
  try {
    const row = await store.get<{ timezone_key: unknown; built_through_ms: unknown; built_through_event_id: unknown; hour_cutoff_ms: unknown }>(
      'SELECT timezone_key, built_through_ms, built_through_event_id, hour_cutoff_ms FROM usage_rollup_meta WHERE id = 1',
    )
    if (!row) return null
    return {
      timezoneKey: String(row.timezone_key ?? ''),
      builtThroughMs: num(row.built_through_ms),
      builtThroughEventId: String(row.built_through_event_id ?? ''),
      hourCutoffMs: num(row.hour_cutoff_ms),
    }
  } catch {
    // 表不存在（迁移没跑完 / 手工删了）→ 当成「没有汇总」，查询层会退原始表。
    return null
  }
}

/**
 * 汇总表能不能被信任。
 *
 * 三种情况必须**重建**：
 * 1. 没有元数据行（从未同步过）；
 * 2. `timezone_key` 与当前进程不符 —— 改了 `TZ` 之后旧的 `day_key` 是按旧时区算的，
 *    继续用会让趋势点整体偏移而**没有任何报错**（`local-rollup.ts` 的同款先例）；
 * 3. 水位缺失。
 */
export function rollupNeedsRebuild(meta: RollupMeta | null): boolean {
  if (!meta) return true
  if (meta.timezoneKey !== rollupTimezoneKey(PORTAL_SCHEMA_VERSION)) return true
  return meta.builtThroughMs <= 0
}

/** 一次同步的结果（供日志与测试断言）。 */
export interface RollupSyncResult {
  mode: 'rebuild' | 'incremental' | 'skipped'
  dayCells: number
  hourCells: number
  hodCells: number
  fromMs: number
  throughMs: number
  /** 因 `received_at_ms IS NULL` 而永远进不了汇总的行数（覆盖率缺口，必须能被看见）。 */
  unattributedWindow: number
}

/**
 * 把汇总同步到「现在」。
 *
 * 流程：读现状 → 判断全量重建还是增量 → 拉一批原始行 → 折格 → upsert → 推进水位。
 *
 * ⚠️ **单次同步有上界**（`maxRows`），所以「积压很多」时会分多次推进：
 *   每次只处理一个窗口并把水位前移，下一次接着走。这样内存有界、
 *   且任何一次中断都只丢「还没推进的那一段」，不会破坏已写入的格
 *   （upsert 是累加语义，重放同一段会翻倍 —— 所以**水位与 upsert 必须在同一事务里提交**）。
 *
 * ## 🚨 水位是**复合游标** `(received_at_ms, event_id)`，不是单个时刻
 *
 * 只按 `received_at_ms > 水位` 推进会**卡死**：一批上报的接收时刻往往**完全相同**
 * （一次 HTTP 批量写入就带一个 `Date.now()`），于是「本批最后一行的时刻」与
 * 「下一批的第一行」相等，`>` 永远筛不到新行 —— 水位停在那里，**剩下的数据永远进不了汇总**。
 *
 * 实测踩到过：300 万行造数一次写入，200k 上限下只同步了 20 万行就再也不动了
 * （`SUM(汇总.calls)=200000` 而原始 300 万），而**没有任何报错** ——
 * 看板只是静默少算。
 *
 * ⇒ 用 `(received_at_ms, event_id)` 元组比较 + 同序 `ORDER BY`，
 *   保证「批边界重复」也能继续前进。`event_id` 是主键，所以游标严格单调。
 */
export async function syncRollups(store: PortalStore, options: {
  now?: number
  maxRows?: number
  /** 已经知道要全量重建时传 true，省掉一次元数据读。 */
  forceRebuild?: boolean
} = {}): Promise<RollupSyncResult> {
  const now = options.now ?? Date.now()
  const maxRows = options.maxRows ?? 200_000
  const meta = options.forceRebuild ? null : await readRollupMeta(store)
  const rebuild = options.forceRebuild === true || rollupNeedsRebuild(meta)
  const fromMs = rebuild ? 0 : (meta?.builtThroughMs ?? 0)
  const fromId = rebuild ? '' : (meta?.builtThroughEventId ?? '')
  const hourCutoffMs = now - ROLLUP_HOUR_RETAIN_DAYS * 86_400_000

  const rows = await store.all<RollupSourceRow & { received_at_ms: unknown; event_id: unknown }>(
    `SELECT event_id, ts, member_id, provider, model, input_tokens, output_tokens,
            cache_read_tokens, cache_write_tokens, reasoning_tokens, received_at_ms
       FROM usage_event
      WHERE received_at_ms IS NOT NULL
        AND (received_at_ms, event_id) > ($fromMs, $fromId)
      ORDER BY received_at_ms, event_id
      LIMIT ${maxRows}`,
    { $fromMs: fromMs, $fromId: fromId },
  )
  if (rows.length === 0 && !rebuild) {
    // 没有新数据：不写库，直接返回（避免每次启动都做一次无谓的写事务）。
    return { mode: 'skipped', dayCells: 0, hourCells: 0, hodCells: 0, fromMs, throughMs: fromMs, unattributedWindow: 0 }
  }
  // 水位推进到「本批最后一行的 (接收时刻, event_id)」；没有行时（全量重建空库）用 0/''。
  const last = rows[rows.length - 1]
  const throughMs = last ? num(last.received_at_ms) : now
  const throughId = last ? String(last.event_id ?? '') : ''

  const dayCells = foldRollupRows(rows, { key: 'day' })
  const hourCells = foldRollupRows(rows.filter(row => num(row.ts) >= hourCutoffMs), { key: 'hour' })
  const hodCells = foldRollupRows(rows, { key: 'hodWorkday' })

  // ⚠️ 覆盖率缺口：没有接收时刻的历史行永远进不了汇总。
  //   它不是「正在补齐」，所以要如实报出来（查询层据此决定要不要退原始表）。
  const unattributed = await store.get<{ c: unknown }>(
    'SELECT COUNT(*) AS c FROM usage_event WHERE received_at_ms IS NULL',
  )

  await store.transaction(async tx => {
    if (rebuild) {
      await tx.exec('DELETE FROM usage_rollup_day')
      await tx.exec('DELETE FROM usage_rollup_hour')
      await tx.exec('DELETE FROM usage_rollup_hod')
      // ⚠️ 元数据行也必须先删：重建走的是 INSERT（不是 upsert），
      //   而 `usage_rollup_meta.id` 上有 UNIQUE —— 不删就撞主键
      //   （实测报 `UNIQUE constraint failed: usage_rollup_meta.id`）。
      await tx.exec('DELETE FROM usage_rollup_meta')
    }
    await upsertCells(tx, 'usage_rollup_day', dayCells, 'day')
    await upsertCells(tx, 'usage_rollup_hour', hourCells, 'hour')
    await upsertCells(tx, 'usage_rollup_hod', hodCells, 'hod')
    if (rebuild) {
      await tx.run(
        `INSERT INTO usage_rollup_meta (id, timezone_key, built_through_ms, built_through_event_id, hour_cutoff_ms, updated_at_ms)
         VALUES (1, $tz, $through, $throughId, $cutoff, $now)`,
        { $tz: rollupTimezoneKey(PORTAL_SCHEMA_VERSION), $through: throughMs, $throughId: throughId, $cutoff: hourCutoffMs, $now: now },
      )
    } else {
      await tx.run(
        'UPDATE usage_rollup_meta SET built_through_ms = $through, built_through_event_id = $throughId, hour_cutoff_ms = $cutoff, updated_at_ms = $now WHERE id = 1',
        { $through: throughMs, $throughId: throughId, $cutoff: hourCutoffMs, $now: now },
      )
    }
    // T2 的保留窗口：过期日整体删掉（它服务的是「最近 N 天」，旧数据留在 T1 里）。
    const cutoffDay = toDayKey(hourCutoffMs)
    await tx.run('DELETE FROM usage_rollup_hour WHERE day_key < $cutoff', { $cutoff: cutoffDay })
  })

  return {
    mode: rebuild ? 'rebuild' : 'incremental',
    dayCells: dayCells.size, hourCells: hourCells.size, hodCells: hodCells.size,
    fromMs, throughMs, unattributedWindow: num(unattributed?.c),
  }
}

/**
 * **一次追平**：反复调 `syncRollups` 直到没有新数据（或达到轮数上限）。
 *
 * ## 为什么需要它
 *
 * `syncRollups()` 单次只处理一批（`maxRows` = 20 万，内存有界）。实测 1M 行要 **5 批**、
 * 每批 10~12 秒。若只在启动时调一次，剩下的要等**定时器**（默认 5 分钟一轮）——
 * 也就是说一个刚迁到 v8 的库要 **~25 分钟**才追平，这段时间看板一直在走原始表
 * （数字正确，但没有收益）。那是个没必要的长尾。
 *
 * ⚠️ 它是**后台**跑的（见 `server/src/index.ts` 的 🚨：首次补齐不能 await，
 *   否则服务端 20 秒后才监听端口）。这里只是在后台把它跑完。
 *
 * ⚠️ `maxRounds` 是硬上界：万一水位因为某种原因推不动（例如查询与写入的边界条件
 *   再次出错），这个循环必须**能停下来**，不能变成一只烧 CPU 的死循环。
 *   达到上界就返回，剩下的交给定时器 —— 与「只跑一批」相比只是更快，不是必须。
 */
export async function backfillRollups(store: PortalStore, options: {
  now?: number
  maxRows?: number
  /** 最多推几批。默认 50（= 1000 万行）。 */
  maxRounds?: number
  /** 已知要全量重建时传 true（第一轮就重建，后续轮次自然变成增量）。 */
  forceRebuild?: boolean
} = {}): Promise<{ rounds: number; dayCells: number; hourCells: number; hodCells: number; caughtUp: boolean }> {
  const maxRounds = options.maxRounds ?? 50
  let rounds = 0
  let dayCells = 0
  let hourCells = 0
  let hodCells = 0
  while (rounds < maxRounds) {
    const result = await syncRollups(store, {
      ...(options.now !== undefined ? { now: options.now } : {}),
      ...(options.maxRows !== undefined ? { maxRows: options.maxRows } : {}),
      // ⚠️ `forceRebuild` 只在第一轮有意义：重建已经把水位清零，
      //   后面几轮自然是增量。传 true 给每一轮会让每轮都先删光再重灌。
      ...(rounds === 0 && options.forceRebuild === true ? { forceRebuild: true } : {}),
    })
    rounds++
    if (result.mode === 'skipped') return { rounds, dayCells, hourCells, hodCells, caughtUp: true }
    dayCells += result.dayCells
    hourCells += result.hourCells
    hodCells += result.hodCells
  }
  // 达到上界仍未追平：如实返回 false，调用方（与日志）能看出「还有积压」。
  return { rounds, dayCells, hourCells, hodCells, caughtUp: false }
}

/**
 * 把一批汇总格写进某张表。
 *
 * ## 为什么必须是 upsert（累加）而不是 INSERT
 *
 * 水位按**接收时刻**推进，而一条事件可能在两次同步之间到达：
 * 同一天会被覆盖多次，所以 `calls = calls + new.calls`。
 * 这让「重放同一批」的结果是**翻倍**而不是幂等 —— 所以
 * **水位推进与这批写入必须在同一个事务里**（见 `syncRollups` 的 `store.transaction`）。
 *
 * ## 为什么两个后端各写一份 SQL
 *
 * 三处方言差异同时出现在这一条语句里，用模板拼会变成「拼错也不报错」：
 * 1. 冲突子句：SQLite `ON CONFLICT(<键列>) DO UPDATE SET` vs MySQL `ON DUPLICATE KEY UPDATE`；
 * 2. 引用别名：SQLite `excluded.x` vs MySQL `new.x`；
 * 3. 标量最值：SQLite `MIN(a,b)` / `MAX(a,b)` vs MySQL `LEAST(a,b)` / `GREATEST(a,b)`
 *    （走 `dialect.scalarMax()`，与 `local-rollup.ts` 同源）。
 *
 * ⚠️ SQLite 的**多行 upsert 引用 `excluded` 时不能带表名前缀**，
 *   而 `lo`/`hi` 的累加必须用「旧值 vs 新值」的标量最值 ——
 *   写成 `MIN(lo, excluded.lo)` 在这里是合法的（两列都在同一行作用域内）。
 */
async function upsertCells(
  store: PortalStore,
  table: 'usage_rollup_day' | 'usage_rollup_hour' | 'usage_rollup_hod',
  cells: Map<string, RollupCell>,
  key: 'day' | 'hour' | 'hod',
): Promise<void> {
  if (cells.size === 0) return
  const scalarMin = store.kind === 'mysql' ? 'LEAST' : 'MIN'
  const scalarMax = store.kind === 'mysql' ? 'GREATEST' : 'MAX'
  const withSpan = key !== 'hod'
  const columns = key === 'day'
    ? ['day_key', 'member_id', 'provider', 'model', 'calls', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'reasoning_tokens', 'lo', 'hi']
    : key === 'hour'
      ? ['day_key', 'hour_of_day', 'member_id', 'provider', 'model', 'calls', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'reasoning_tokens', 'lo', 'hi']
      : ['hour_of_day', 'day_kind', 'member_id', 'provider', 'model', 'calls', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'reasoning_tokens']
  const keyColumns = key === 'day'
    ? ['day_key', 'member_id', 'provider', 'model']
    : key === 'hour'
      ? ['day_key', 'hour_of_day', 'member_id', 'provider', 'model']
      : ['hour_of_day', 'day_kind', 'member_id', 'provider', 'model']

  // 每行一条 VALUES 元组；分批提交，避免超过 SQLite 的参数上限（旧版 999）。
  const rows: (string | number)[][] = []
  for (const [composite, cell] of cells) {
    const [scope, memberId, provider, model] = composite.split('\u0000')
    const head: (string | number)[] = key === 'day'
      ? [scope!, memberId!, provider!, model!]
      : key === 'hour'
        ? (() => { const [day, hour] = (scope ?? '').split('|'); return [day!, Number(hour), memberId!, provider!, model!] })()
        : (() => { const [hour, dayKind] = (scope ?? '').split('|'); return [Number(hour), Number(dayKind), memberId!, provider!, model!] })()
    rows.push([...head, cell.calls, cell.input, cell.output, cell.cacheRead, cell.cacheWrite, cell.reasoning, ...(withSpan ? [cell.lo, cell.hi] : [])])
  }

  const perRow = columns.length
  const batchRows = Math.max(1, Math.min(500, Math.floor(800 / perRow)))
  const rowTuple = `(${columns.map(() => '?').join(',')})`
  for (let start = 0; start < rows.length; start += batchRows) {
    const slice = rows.slice(start, start + batchRows)
    const values = slice.map(() => rowTuple).join(', ')
    const params = slice.flat()
    if (store.kind === 'mysql') {
      /**
       * 🚨 **每一条赋值都必须把「当前行」用表名限定写出来**（`calls = usage_rollup_day.calls + new.calls`）。
       *
       * 实测（MySQL 8.0.40）：写成不带限定的 `calls = calls + new.calls` 会直接
       * 报 **errno 1052 `Column 'calls' in field list is ambiguous`** ——
       * 因为 `AS new` 引入了行别名之后，`calls` 同时存在于「目标表」与「new」两个
       * 作用域里。这与 `ingest.ts` 的 `recordIngestMoment()`（只更新一列、且用
       * `new.last_ingest_ms` 做右值）是**不同形状**，照抄那段会踩这个坑。
       *
       * ⚠️ SQLite 侧**不能**这么写：那边 `ON CONFLICT … DO UPDATE SET` 的
       * 「当前行」只能用 `表名.列名` 或裸列名，而 `excluded` 是伪表 ——
       * 两边的 SQL 必须各写一份（见下面的 else 分支）。
       */
      const qualified = table
      const assignments = [
        `calls = ${qualified}.calls + new.calls`,
        `input_tokens = ${qualified}.input_tokens + new.input_tokens`,
        `output_tokens = ${qualified}.output_tokens + new.output_tokens`,
        `cache_read_tokens = ${qualified}.cache_read_tokens + new.cache_read_tokens`,
        `cache_write_tokens = ${qualified}.cache_write_tokens + new.cache_write_tokens`,
        `reasoning_tokens = ${qualified}.reasoning_tokens + new.reasoning_tokens`,
        ...(withSpan ? [`lo = ${scalarMin}(${qualified}.lo, new.lo)`, `hi = ${scalarMax}(${qualified}.hi, new.hi)`] : []),
      ]
      // ⚠️ MySQL 8.0.20+ 里 `VALUES(col)` 已废弃，用 `AS new` 行别名（与 dialect.ts 同款）。
      await store.run(
        `INSERT INTO ${table} (${columns.join(',')}) VALUES ${values} AS new ON DUPLICATE KEY UPDATE ${assignments.join(', ')}`,
        params,
      )
    } else {
      const assignments = [
        'calls = calls + excluded.calls',
        'input_tokens = input_tokens + excluded.input_tokens',
        'output_tokens = output_tokens + excluded.output_tokens',
        'cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens',
        'cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens',
        'reasoning_tokens = reasoning_tokens + excluded.reasoning_tokens',
        ...(withSpan ? [`lo = ${scalarMin}(lo, excluded.lo)`, `hi = ${scalarMax}(hi, excluded.hi)`] : []),
      ]
      await store.run(
        `INSERT INTO ${table} (${columns.join(',')}) VALUES ${values} ON CONFLICT(${keyColumns.join(',')}) DO UPDATE SET ${assignments.join(', ')}`,
        params,
      )
    }
  }
}
