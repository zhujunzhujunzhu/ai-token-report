/**
 * 上报接收路由 —— 插件与 CLI 的 token 用量入口。
 *
 * ## 端点
 *
 * ```http
 * POST /api/v1/token-usage
 * Authorization: Bearer <appKey>
 * Content-Type: application/json
 *
 * { "schemaVersion": 1,
 *   "client": { "name": "dsh-token-report", "userId": "张三", "userName": "张三" },
 *   "generatedAt": "2026-09-25T10:00:00Z",
 *   "records": [ { "event_id": "s:17", "session_id": "s", "seq": 17, "ts": 1790245427069,
 *                  "provider": "dashscope", "model": "m", "input_tokens": 1, "output_tokens": 1,
 *                  "cache_read_tokens": 0, "cache_write_tokens": 0,
 *                  "reasoning_tokens": 0, "total_tokens": 2,
 *                  "cwd": "D:\\proj", "turn": 1, "step": 1 } ] }
 *
 * → 200 { "accepted": 1, "duplicates": 0, "rejected": 0 }
 * ```
 *
 * 契约由 `shared/src/protocol.ts` 定义，**响应里的三个计数必须如实返回**：
 * CLI 的 `deliver.ts` 与插件都按它们更新统计，缺字段时会回退成「全部接受」
 * ——不会报错，但统计会失真。
 *
 * ## ★ 鉴权失败必须是非 2xx（与 `/api/v1/identity/verify` 相反）
 *
 * `identity/verify` 用 `200 + ok:false` 表达业务失败（免得前端把「token 填错了」
 * 和「网络坏了」混为一谈）。**这里不能照搬**：
 *
 * | 客户端拿到 | CLI 的行为 |
 * |---|---|
 * | 2xx | 认为已投递 → **清掉 pending** |
 * | 非 2xx | 保留 pending，下一轮重试（`report.ts`） |
 *
 * 所以 2xx 就等于「数据已收下」。若鉴权失败也回 200，那批用量会被
 * 客户端**当成投递成功而永久丢掉** —— 静默丢数据，是本仓最不能接受的一类故障。
 * 于是这里：token 无效 / 缺失 → `401`；服务端还没配置凭证 → `503`
 * （前者用户重试没用，后者等管理员发凭证后重试有用，两者分开才好排障）。
 *
 * ## ★ 归属：只信服务端
 *
 * 请求体里的 `client.userName` / `client.userId` **一律忽略**，只用于排查。
 * 归属取 `Authorization` 头里的 token 查凭证表的结果
 * （`verify-route.ts` 的 `resolveIngestIdentity`）。改一下本地配置就能冒用他人
 * 身份上报的话，部门看板的数据立刻失去意义。
 *
 * ## 幂等：`event_id` 主键
 *
 * 同一批重发、插件与 CLI 同时上报同一条记录，都靠 `usage_event.event_id`
 * 主键 + **幂等插入**去重（SQLite `INSERT OR IGNORE` / MySQL `INSERT IGNORE`，
 * 由 `core/db/dialect.ts` 决定）—— 重复的计入 `duplicates` 而不是错误。
 * 这是「上报只需 at-least-once」的落点：上报方可以有很多个，不必互相协调。
 *
 * ## 两种后端
 *
 * 上报库可以是 SQLite（默认）或 MySQL（配了 `mysqlUrl`）。本路由**看不到**
 * 这个差别：配置在构造时归一成 `PortalTarget`，落库一律走
 * `openPortalStore()`（见 `core/db/portal-db.ts`）。
 */

import {
  insertAttributedRecords,
  insertAttributedRecordsInTransaction,
  openPortalStore,
  recordIngestMoment,
  resolvePortalTarget,
  type EventOwner,
  type IngestRecord,
  type PortalTarget,
} from '@ai-token-report/core/db'
import type { IngestResponse } from '@ai-token-report/shared'
import { ingestRecordSchema, parseIngestEnvelope } from '@ai-token-report/shared/schemas'

import type { CredentialStore } from './credentials.js'
import { authorize, authorizeDatabase, databaseFailure } from './http/auth.js'
import type { IdentityRepository } from './identity/index.js'
import { INGEST_AUTH_MESSAGES } from './verify-route.js'

/** 路由结果：状态码 + 响应体。`index.ts` 的 `fromRoute()` 直接吃这个形状。 */
export interface IngestResult {
  status: number
  body: unknown
}

export interface IngestRouteOptions {
  credentials?: CredentialStore
  identityStore?: IdentityRepository
  /** 服务端上报库路径（与本地库 `usage.sqlite` 是**两个文件**）。 */
  dbPath: string
  /**
   * 可选：配了就用 MySQL 上报库（部门集中部署）。
   *
   * ★ `dbPath` 仍然必填：没配 MySQL 时它就是真值，配了则是「退路配置」。
   *   两者同时存在不是配置错误 —— `resolvePortalTarget()` 只做形状归一，
   *   而 `openPortalStore()` 的语义是「有 mysqlUrl 就用它」。
   */
  mysqlUrl?: string
}

/**
 * 上报接收路由。
 *
 * ⚠️ 每个请求**独立开关**一次库连接。批量上报是低频动作（插件按批次、
 *   CLI 每 10 分钟），开一个 SQLite 连接是亚毫秒级，而长持连接要额外处理
 *   WAL 回收与生命周期 —— 不值得。这与 `local-api.ts` 的取舍一致。
 *   MySQL 下 `close()` 是空操作（连接来自进程内共享池），调用形状不变。
 */
export class IngestRoute {
  readonly #credentials: CredentialStore | undefined
  readonly #identityStore: IdentityRepository | undefined
  readonly #target: PortalTarget

  constructor(options: IngestRouteOptions) {
    this.#credentials = options.credentials
    this.#identityStore = options.identityStore
    // ★ 配置只在这里归一成 `PortalTarget`：路由内部不再散落 if (mysql)，
    //   换后端不影响任何业务分支。
    this.#target = resolvePortalTarget({
      sqlitePath: options.dbPath,
      mysqlUrl: options.mysqlUrl,
    })
  }

  /**
   * 处理一次上报。
   *
   * 顺序是「先认人、再看载荷、最后落库」：鉴权必须排在解析之前 ——
   * 未通过鉴权的请求体没有任何理由被解析或写进库。
   */
  async submit(payload: unknown, authorization: string | null): Promise<IngestResult> {
    if (this.#identityStore) return this.#submitDatabase(payload, authorization)
    // ── 1. 身份（★ 归属的唯一来源）──────────────────────────────
    // 401/503 的判定在 `http/auth.ts` 的 `authorize()` 里 —— 全仓唯一一处。
    // 这里只用它的结果，不再自己算状态码（重构前这段映射在三个路由里各写了一遍）。
    const auth = authorize(this.#credentials!, authorization, INGEST_AUTH_MESSAGES)
    if (!auth.ok) {
      return { status: auth.status, body: { ok: false, reason: auth.reason } }
    }

    // ── 2. 载荷校验 ────────────────────────────────────────────
    const parsed = parseIngestPayload(payload)
    if (!parsed.ok) {
      return { status: 400, body: { ok: false, reason: parsed.reason } }
    }

    // ── 3. 落库（幂等）─────────────────────────────────────────
    // 归属取服务端认定的姓名；`dept` 只在凭证登记了部门时才有值。
    const owner: EventOwner = {
      userId: auth.viewer.name,
      userName: auth.viewer.name,
      dept: auth.viewer.dept ?? null,
    }

    let stored: { inserted: number; duplicates: number }
    try {
      stored = await this.#store(parsed.records, owner)
    } catch (err) {
      // 库打不开（含 schema 版本不符：上报库**不会**自动重建，见 `openPortalStore`）
      // → 500。客户端会保留 pending 重试，管理员在响应里能看到具体原因。
      // 🚨 响应文案一个字都不许变（`e2e-ingest.ts` / `http-contract.test.ts` 逐字断言）。
      return { status: 500, body: { ok: false, reason: `落库失败: ${msg(err)}` } }
    }

    const body: IngestResponse = {
      accepted: stored.inserted,
      duplicates: stored.duplicates,
      rejected: parsed.rejected,
    }
    return { status: 200, body }
  }

  /** 重新鉴权与写入持有同一身份锁，使撤权提交和上报提交具有明确先后顺序。 */
  async #submitDatabase(payload: unknown, authorization: string | null): Promise<IngestResult> {
    const repository = this.#identityStore!
    const auth = await authorizeDatabase(repository, authorization, 'usage:write', INGEST_AUTH_MESSAGES)
    if (!auth.ok) return { status: auth.status, body: { ok: false, reason: auth.reason } }
    const parsed = parseIngestPayload(payload)
    if (!parsed.ok) return { status: 400, body: { ok: false, reason: parsed.reason } }
    try {
      const stored = await repository.withWrite(auth.viewer, 'usage:write', async (tx, fresh) => {
        const result = await insertAttributedRecordsInTransaction(tx, parsed.records, {
          userId: fresh.name, userName: fresh.name, dept: fresh.dept ?? null,
          memberId: fresh.memberId, departmentId: fresh.departmentId,
          tokenId: fresh.auth.kind === 'token' ? fresh.auth.tokenId : null,
          receivedAtMs: Date.now(),
        })
        await recordIngestMoment(tx)
        return result
      })
      return { status: 200, body: { accepted: stored.inserted, duplicates: stored.duplicates, rejected: parsed.rejected } satisfies IngestResponse }
    } catch (err) {
      const failure = databaseFailure(err)
      return { status: failure.status, body: { ok: false, reason: failure.reason } }
    }
  }

  /**
   * 打开库 → 写入 → 关闭。空批次直接短路，省掉一次建连接。
   *
   * ★ 收 `PortalTarget` 而不是路径：`openPortalStore()` 按它决定连 SQLite 还是 MySQL，
   *   本方法里**看不到**用的是哪种库。
   * 🚨 `finally` 里的 `close()` 对 SQLite 是真的关连接（不关会残留 WAL 与句柄），
   *   对 MySQL 是空操作 —— 两边的调用形状刻意一致。
   */
  async #store(
    records: IngestRecord[],
    owner: EventOwner,
  ): Promise<{ inserted: number; duplicates: number }> {
    if (records.length === 0) return { inserted: 0, duplicates: 0 }

    const store = await openPortalStore(this.#target)
    try {
      const stored = await insertAttributedRecords(store, records, owner)
      // ★ 记录「最近一次落库时刻」，部门看板据此显示数据是什么时候到的。
      //   重发（全部 duplicates）也算 —— 客户端刚刚投递过，这个事实本身就是
      //   「该机器还活着」的信号，正是看板要看的。
      //   复用 ingest_run 表而**不新增列**：上报库 schema 不能动（见 core/db/ingest.ts）。
      await recordIngestMoment(store)
      return stored
    } finally {
      await store.close()
    }
  }
}

// ── 载荷校验 ────────────────────────────────────────────────────────────────

/** 校验结果：合法记录 + 被拒条数，或一条能直接展示给排障者的原因。 */
export type ParseIngestPayloadResult =
  | { ok: true; records: IngestRecord[]; rejected: number }
  | { ok: false; reason: string }

/**
 * 校验并归一化一整批上报载荷。
 *
 * 分两层，因为它们对应两种完全不同的故障：
 *
 * | 层次 | 例子 | 返回 |
 * |---|---|---|
 * | **整批**（结构性） | body 不是对象、`records` 不是数组、协议版本高于本服务端 | `400`，整批拒收 |
 * | **单行**（数据性） | 某行缺 `event_id`、token 不是自然数 | 计入 `rejected`，**其余行照常入库** |
 *
 * ★ 整批失败必须是非 2xx：只有这样才能让 CLI 保留 pending（2xx 会被当成已投递）。
 *
 * ★ 形状本身（含每个字段的拒收标准与**逐字文案**）已收编成 zod schema，
 *   住在 `@ai-token-report/shared/schemas`（`ingestEnvelopeSchema`）——
 *   本函数只负责「把失败翻译成哪一层」，不再自己判类型。
 *   改字段规则、改版本上限、改提示语都请改那边。
 */
export function parseIngestPayload(value: unknown): ParseIngestPayloadResult {
  // 外层（整批）：对象 / `schemaVersion` 整数且不高于本服务端 / `records` 是数组。
  // 文案在 shared 那边逐字保留（`schemaVersion` 过高时原因里带具体版本号）。
  const envelope = parseIngestEnvelope(value)
  if (!envelope.ok) return { ok: false, reason: envelope.reason }

  const records: IngestRecord[] = []
  let rejected = 0
  for (const item of envelope.value.records) {
    const rec = parseIngestRecord(item)
    if (rec) records.push(rec)
    else rejected++
  }

  return { ok: true, records, rejected }
}

/**
 * 校验并归一化一条上报记录；**结构上无法落库**时返回 null（调用方计入 `rejected`）。
 *
 * ★ 判定标准（哪个字段必填、哪些缺失即 0、为什么拒收标准刻意偏保守）
 *   全在 `shared/src/schemas.ts` 的 `ingestRecordSchema` 上，本函数只做
 *   「成功 → 记录 / 失败 → null」这一步翻译 —— 两边各写一份判定表迟早会漂移。
 */
export function parseIngestRecord(value: unknown): IngestRecord | null {
  const parsed = ingestRecordSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
