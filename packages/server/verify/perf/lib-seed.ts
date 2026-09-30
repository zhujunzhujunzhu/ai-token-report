/**
 * 性能摸底专用造数器：往**本次随机命名的隔离库**里灌入仿真事件。
 *
 * ## 为什么要它
 *
 * `verify-*` 系列造的是「几十条能对账」的数据，而性能问题只在大表上出现
 * （索引选择、全窗口扫、buffer pool 命中率）。本文件按**固定随机种子**生成
 * 与真实流量同形的数据，使「加索引前 / 加索引后」两次测量面对**逐字节相同**的表。
 *
 * ## 数据形状的依据
 *
 * | 维度 | 分布 | 依据 |
 * |---|---|---|
 * | 事件数 | 调用方给（1e5 / 1e6 / 3e6） | 用户口径：一个月 10 万调用 → 一年 120 万 → 目标 300 万 |
 * | 时间跨度 | 365 天均匀铺开 | 年度上报库的真实形态 |
 * | 人员 | 默认 200 人 | 部门规模；决定 `member_id` 的基数 |
 * | 供应商 / 模型 | 4 家 × 每家 3 个模型 | 决定 provider-model 分组行数 |
 * | session | 每人每天 1~3 个会话 | 决定 `COUNT(DISTINCT session_id)` 的代价 |
 * | token 量级 | cacheRead 占 94%+ | AGENTS.md 铁律 2 的实测口径 |
 *
 * ⚠️ 数据一律用**本仓自己的**写入路径（`insertAttributedRecordsInTransaction`）
 *   灌进去：手工拼 INSERT 会绕过 CHECK / 外键 / 列映射，造出一张
 *   「性能测出来很好看、真实写入却写不进去」的表。
 */
import { randomUUID } from 'node:crypto'
import type { PortalStore } from '@ai-token-report/core/db'
import { insertAttributedRecordsInTransaction, type IngestRecord } from '@ai-token-report/core/db'

/** 确定性 PRNG（mulberry32）——同一 seed 必然造出同一张表。 */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const PROVIDERS = [
  { provider: 'deepseek-official', models: ['deepseek-chat', 'deepseek-reasoner', 'deepseek-coder'] },
  { provider: 'dashscope', models: ['qwen-max', 'qwen-plus', 'qwen-turbo'] },
  { provider: 'volcengine', models: ['doubao-pro', 'doubao-lite', 'doubao-1.5'] },
  { provider: 'openai', models: ['gpt-4o', 'gpt-4o-mini', 'o3-mini'] },
]

export interface SeedOptions {
  /** 事件总数。 */
  events: number
  /** 人员数（决定 member_id 基数）。 */
  members?: number
  /** 时间跨度（天）。事件在其中均匀铺开。 */
  days?: number
  /** 每批写入条数（走真实 HTTP 路径时是 200）。 */
  batch?: number
  /** 会话日志归属用的姓名快照。 */
  prefix?: string
  /** 固定种子。 */
  seed?: number
  /**
   * 事件的 `ts` 与**插入顺序**的关系。
   *
   * - `random`（默认）：`ts` 在窗口内随机 —— 事件**不按时间到达**。
   * - `ordered`：`ts` 随插入单调递增 —— **生产形态**（插件/CLI 在会话进行中
   *   实时上报，`received_at_ms` 与 `ts` 基本同步）。
   *
   * 🚨 这一条直接影响 `ts` 索引与主键的相关性，进而决定「按时间窗扫描」是
   *   顺序读还是随机读。两种形态必须分别测：只测其中一种会把结论搞反。
   */
  order?: 'random' | 'ordered'
}

/** 造数结果：需要的人员 / 凭证 id 列表，供后续建分组与签发 appKey。 */
export interface SeedResult {
  memberIds: string[]
  /** 每个人员的一条 token id（用于 `usage_event.report_token_id`）。 */
  tokenIds: string[]
  /** 实际写入的事件数（重放时会小于请求数）。 */
  inserted: number
}

/**
 * 建人员名册与凭证行。
 *
 * ⚠️ 这一步**不走管理 HTTP 接口**（那要建几百个账号太慢），而是直接写
 *   身份表 —— 造数脚本可以这么做，业务代码不行。行结构与
 *   `identity/repository.ts` 的插入保持一致（UUID / 时间戳 / 摘要）。
 */
export async function seedIdentity(
  store: PortalStore,
  members: number,
  prefix: string,
): Promise<{ memberIds: string[]; tokenIds: string[] }> {
  const now = Date.now()
  const memberIds: string[] = []
  const tokenIds: string[] = []
  const memberRows: unknown[] = []
  const tokenRows: unknown[] = []
  const roleRows: unknown[] = []
  const scopeRows: unknown[] = []
  const memberRoleId = '00000000-0000-4000-8000-000000000002'
  const scopeIds = [
    '00000000-0000-4000-8000-000000000101', // usage:write
    '00000000-0000-4000-8000-000000000100', // identity:read
  ]
  for (let index = 0; index < members; index++) {
    const memberId = randomUUID()
    const tokenId = randomUUID()
    memberIds.push(memberId)
    tokenIds.push(tokenId)
    memberRows.push(memberId, `${prefix}${index}`, now, now)
    tokenRows.push(tokenId, memberId, `${String(index).padStart(4, '0')}${'a'.repeat(60)}`, `atr-${index}`, `${prefix}${index}`, now)
    roleRows.push(memberId, memberRoleId, now)
    for (const scopeId of scopeIds) scopeRows.push(tokenId, scopeId)
  }
  await store.exec('SET FOREIGN_KEY_CHECKS = 0')
  try {
    for (let index = 0; index < members; index++) {
      await store.run(
        'INSERT INTO members (member_id,display_name,status,version,created_at_ms,updated_at_ms) VALUES ($id,$name,\'active\',1,$now,$now)',
        { $id: memberRows[index * 4] as string, $name: memberRows[index * 4 + 1] as string, $now: now },
      )
      await store.run(
        'INSERT INTO report_tokens (token_id,member_id,token_hash,token_prefix,label,status,version,created_at_ms) VALUES ($id,$mid,$hash,$prefix,$label,\'active\',1,$now)',
        {
          $id: tokenRows[index * 6] as string, $mid: tokenRows[index * 6 + 1] as string,
          $hash: tokenRows[index * 6 + 2] as string, $prefix: tokenRows[index * 6 + 3] as string,
          $label: tokenRows[index * 6 + 4] as string, $now: now,
        },
      )
      await store.run('INSERT INTO member_roles (member_id,role_id,granted_at_ms) VALUES ($m,$r,$now)', { $m: memberIds[index]!, $r: memberRoleId, $now: now })
      for (const scopeId of scopeIds) {
        await store.run('INSERT INTO report_token_scopes (token_id,permission_id) VALUES ($t,$p)', { $t: tokenId, $p: scopeId })
      }
    }
  } finally {
    await store.exec('SET FOREIGN_KEY_CHECKS = 1')
  }
  return { memberIds, tokenIds }
}

/**
 * 灌入 `events` 条事件。
 *
 * ★ 走 `insertAttributedRecordsInTransaction`：与真实上报**同一条写路径**
 *   （含 sql_mode 检查、SAVEPOINT、多行 INSERT、`changes` 校验）。
 *   直接拼 INSERT 会让「入库性能」这个指标失去意义。
 */
export async function seedEvents(
  store: PortalStore,
  options: SeedOptions & { memberIds: string[]; tokenIds: string[] },
): Promise<{ inserted: number }> {
  const {
    events, members = options.memberIds.length, days = 365, batch = 1000, prefix = 'perf-member-',
    seed = 20260101, memberIds, tokenIds, order = 'random',
  } = options
  const rand = rng(seed)
  const now = Date.now()
  const dayMs = 86_400_000
  // 时间窗：以「今天」为右端往前铺 days 天（与真实库「最近一年」同形）。
  const endMs = now
  const startMs = endMs - days * dayMs

  let inserted = 0
  let buffer: IngestRecord[] = []
  let bufferMember = 0
  let perMemberCount = 0
  const perMemberTarget = Math.ceil(events / members)

  const flush = async (): Promise<void> => {
    if (buffer.length === 0) return
    const owner = {
      userId: `${prefix}${bufferMember}`,
      userName: `${prefix}${bufferMember}`,
      groupName: '性能造数',
      memberId: memberIds[bufferMember]!,
      tokenId: tokenIds[bufferMember]!,
      receivedAtMs: now,
    }
    // ⚠️ 必须自己开事务：写路径内部用 `SAVEPOINT`（MySQL 下 autocommit 时
    //   `SAVEPOINT` 直接报 1305 does not exist），真实上报由
    //   `IdentityRepository.withWrite()` 提供这个事务。
    const result = await store.transaction((tx) => insertAttributedRecordsInTransaction(tx, buffer, owner))
    inserted += result.inserted
    buffer = []
  }

  for (let index = 0; index < events; index++) {
    if (perMemberCount >= perMemberTarget) {
      await flush()
      bufferMember = (bufferMember + 1) % members
      perMemberCount = 0
    }
    const pick = PROVIDERS[Math.floor(rand() * PROVIDERS.length)]!
    const model = pick.models[Math.floor(rand() * pick.models.length)]!
    // `ordered`：`ts` 严格随插入递增（生产形态：实时上报）；
    // `random`：窗口内随机（病态形态：历史补报 / 乱序到达）。
    const ts = order === 'ordered'
      ? Math.floor(startMs + (index / Math.max(events - 1, 1)) * (endMs - startMs))
      : Math.floor(startMs + rand() * (endMs - startMs))
    // 一天内的会话数 1~3：session_id 里带「天 + 序号」，使去重计数有真实代价。
    // ⚠️ 末尾带 `seed`：增量续灌时 event_id 必须全局唯一，否则续灌的条数
    //   会被主键幂等吃掉（表现为「灌了 10 万却只有 9.98 万」）。
    const dayIndex = Math.floor((ts - startMs) / dayMs)
    const sessionIndex = Math.floor(rand() * 3)
    const sessionId = `${prefix}s-${seed}-${bufferMember}-${dayIndex}-${sessionIndex}`
    const seq = perMemberCount
    const cacheRead = 20_000 + Math.floor(rand() * 700_000)
    const input = 2_000 + Math.floor(rand() * 30_000)
    const output = 200 + Math.floor(rand() * 4_000)
    const cacheWrite = Math.floor(rand() * 2_000)
    buffer.push({
      event_id: `${sessionId}:${seq}`,
      session_id: sessionId,
      seq,
      ts,
      provider: pick.provider,
      model,
      cwd: `D:\\perf\\${pick.provider}`,
      input_tokens: input,
      output_tokens: output,
      cache_read_tokens: cacheRead,
      cache_write_tokens: cacheWrite,
      reasoning_tokens: Math.floor(output / 4),
      turn: Math.floor(rand() * 20),
      step: seq,
    })
    perMemberCount++
    if (buffer.length >= batch) await flush()
  }
  await flush()
  return { inserted }
}
