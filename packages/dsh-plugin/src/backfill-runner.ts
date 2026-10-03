/**
 * 历史补报执行器：以磁盘日志为耐久源，逐文件扫描并等待服务端确认。
 *
 * ★ 实时 telemetry 只回放存活会话，不能覆盖从未打开的历史会话。
 * 此处复用本地统计扫描器与 Reporter，只有整份文件的新增记录全部确认后
 * 才保存字节光标。中途退出会重发该文件，由服务端 event_id 幂等吸收。
 *
 * ## 两类日志、两套增量语义（与 CLI `report` 同源）
 *
 * | 来源族 | 扫描入口 | 水位线 |
 * |---|---|---|
 * | DSH（分帧 zstd） | `scanIncremental()` | 每文件**帧数 + 字节光标**（本文件一份 JSON） |
 * | Codex / Claude Code / Trae / WorkBuddy（纯文本） | `scanPlainSources()` | 每文件**字节数**（`plain-watermarks.json` 一份表） |
 *
 * 🚨 **不能只补报 DSH**：这些来源的用量若不上报，部门看板上永远是 0，
 *    而它与「这台机器没跑过 Codex」长得一模一样（见 `extra-sources.ts` 文件头）。
 *    所以缺省就把本机全部已注册来源都补上。
 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  listSessionFiles, scanIncremental, scanPlainSources, SESSION_SCAN_REVISION,
  type IncrementalFileResult, type SourceRoot, type UsageRecord,
} from '@ai-token-report/core'
import type { EffectiveConfig } from './config.js'
import type { BillingRecord, FoldIdentity } from './fold.js'
import { reportBackfillDir } from './paths.js'
import { Reporter } from './reporter.js'

export interface BackfillStats {
  status: 'idle' | 'running' | 'complete' | 'retrying' | 'stopped'
  filesTotal: number
  filesProcessed: number
  confirmed: number
  accepted: number
  duplicates: number
  failures: number
  lastError: string | null
  lastCompletedAt: number
}

export function emptyBackfillStats(): BackfillStats {
  return { status: 'idle', filesTotal: 0, filesProcessed: 0, confirmed: 0,
    accepted: 0, duplicates: 0, failures: 0, lastError: null, lastCompletedAt: 0 }
}

export interface BackfillPassOptions {
  config: EffectiveConfig
  identity: FoldIdentity
  /**
   * ★ 一组 DSH 会话日志根（多套 DSH 并存）。
   *
   * ⚠️ 这里刻意**不过滤存在性**（与统计路径不同）：补报的承诺是「全部历史都已核对」，
   *   一个配了却不存在的根必须**报错**，见下面 `runBackfillPass` 的逐根检查。
   */
  sessionsRoots: string[]
  /** ★ DSH 之外的来源根（Codex / Claude Code / Trae / WorkBuddy）。 */
  plainRoots: readonly SourceRoot[]
  /** 传入上一轮快照时累计确认数；不传时返回本次执行的计数。 */
  stats?: BackfillStats
  onProgress?: (stats: BackfillStats) => void
  fetchImpl?: typeof fetch
}

interface Checkpoint { version: 1; file: IncrementalFileResult }
/** 纯文本来源的字节数水位线：一份表，键是文件绝对路径。 */
interface PlainWatermarks { version: 1; files: Record<string, number> }
const digest = (text: string) => createHash('sha256').update(text).digest('hex')

/**
 * 目标服务器、凭证或**日志根集合**任一改变时都要重新核对全部历史。
 *
 * ★ 根集合必须进作用域：否则「新加了一个 home」或「新并进一个来源」会复用旧作用域的
 *   水位目录，那部分历史会被当成「已经确认过」而**永远不补报**，
 *   且不会报任何错 —— 只会让部门看板少掉一台机器 / 一个客户端的用量。
 */
export function resolveBackfillDir(
  config: EffectiveConfig,
  sessionsRoots: readonly string[],
  plainRoots: readonly SourceRoot[] = [],
): string {
  const scope = digest(JSON.stringify([
    SESSION_SCAN_REVISION,
    config.endpoint,
    config.appKey,
    sessionsRoots.map((root) => resolve(root)),
    // 带来源前缀：同一个目录被两个来源解析出来时不能算同一个根。
    plainRoots.map((root) => `${root.source}:${resolve(root.path)}`),
  ]))
  return reportBackfillDir(config, scope)
}

async function loadCheckpoint(path: string, filePath: string): Promise<IncrementalFileResult | undefined> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as Partial<Checkpoint>
    const file = value.file
    if (value.version !== 1 || !file || file.filePath !== filePath || !file.cursor ||
      !Number.isSafeInteger(file.size) || file.size < 0 ||
      !Number.isSafeInteger(file.frameCount) || file.frameCount < 0 ||
      file.cursor.byteOffset !== file.size || file.cursor.observedSize !== file.size) return undefined
    return file
  } catch {
    // 状态损坏只会导致安全重发；不能让一个派生光标永久阻止历史恢复。
    return undefined
  }
}

async function saveCheckpoint(path: string, file: IncrementalFileResult): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, JSON.stringify({ version: 1, file } satisfies Checkpoint), 'utf8')
    await rename(temporary, path)
  } finally {
    try { await unlink(temporary) } catch { /* rename 成功后临时文件已不存在 */ }
  }
}

/** 读纯文本来源的水位线；损坏 / 缺失一律退回空表（只会导致安全重发）。 */
async function loadPlainWatermarks(path: string): Promise<PlainWatermarks> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as Partial<PlainWatermarks>
    if (value.version !== 1 || value.files === null || typeof value.files !== 'object') return { version: 1, files: {} }
    const files: Record<string, number> = {}
    for (const [key, size] of Object.entries(value.files)) {
      if (typeof size === 'number' && Number.isSafeInteger(size) && size >= 0) files[key] = size
    }
    return { version: 1, files }
  } catch {
    return { version: 1, files: {} }
  }
}

async function savePlainWatermarks(path: string, value: PlainWatermarks): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, JSON.stringify(value), 'utf8')
    await rename(temporary, path)
  } finally {
    try { await unlink(temporary) } catch { /* rename 成功后临时文件已不存在 */ }
  }
}

/** 只转换内存字段，不在补报路径另算任何指标。 */
function toBilling(record: UsageRecord, identity: FoldIdentity): BillingRecord {
  return {
    eventId: record.eventId, sessionId: record.sessionId, seq: record.seq, time: record.time,
    provider: record.provider, model: record.model, cwd: record.cwd, turn: record.turn, step: record.step,
    inputTokens: record.usage.input, outputTokens: record.usage.output,
    cacheReadTokens: record.usage.cacheRead, cacheWriteTokens: record.usage.cacheWrite,
    reasoningTokens: record.usage.reasoning, totalTokens: record.usage.total,
    // ★ 来源必须跟着记录走：缺了它服务端按 `dsh` 落库，Codex 的用量会记在 DSH 名下。
    source: record.source,
    identityViolation: false, identity,
  }
}

/** 一次投递尝试的结论。`fatal` = 共享故障（网络 / 鉴权 / 限流），继续跑别的文件没有意义。 */
type DeliveryOutcome = { ok: true } | { ok: false; fatal: boolean; error: Error }

/**
 * 把一批计费记录**分批投递并逐批验证完整确认**。
 *
 * ★ DSH 与纯文本来源共用这一份：两处各写一遍「什么叫确认了」，
 *   迟早会出现「一个来源按确认前移光标、另一个按请求成功前移」这种偏一半的 bug，
 *   而它只会表现为看板上少几条数。
 *
 * ⚠️ outbox **刻意关掉**：历史日志本身就是重试副本，把它塞进容量受限的实时
 *   outbox 会把真正的新用量挤掉。
 */
async function deliverRecords(
  records: readonly BillingRecord[],
  options: Pick<BackfillPassOptions, 'config' | 'identity' | 'fetchImpl'>,
  progress: BackfillStats,
  publish: () => void,
): Promise<DeliveryOutcome> {
  const maxRecords = Math.max(1, Math.min(200, Math.floor(options.config.batch.maxRecords)))
  const reporter = new Reporter({
    config: { ...options.config, batch: { ...options.config.batch, maxRecords },
      outbox: { ...options.config.outbox, enabled: false } },
    identity: options.identity,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  })
  let acknowledged = 0
  let accepted = 0
  let duplicates = 0
  for (let offset = 0; offset < records.length; offset += maxRecords) {
    const batch = records.slice(offset, offset + maxRecords)
    for (const record of batch) reporter.enqueue(record)
    await reporter.flush()
    const result = reporter.stats()
    const confirmed = result.delivered + result.duplicates
    const batchConfirmed = confirmed - acknowledged
    progress.accepted += result.delivered - accepted
    progress.duplicates += result.duplicates - duplicates
    progress.confirmed += batchConfirmed
    // Reporter 已验证每条回执；这里再验证队列清空，避免把失败残留当成完成。
    if (result.queueLength !== 0 || batchConfirmed !== batch.length) {
      // 响应体可能回显请求信息；补报诊断只带 HTTP 状态，不转发服务端原文。
      const status = result.lastError?.match(/^HTTP ([1-5]\d\d)/)?.[1]
      // 单条坏记录不能永久挡住其它文件；网络、鉴权、限流等共享故障才停止整轮。
      const fatal = result.rejected === 0 && !['400', '413', '422'].includes(status ?? '') &&
        !result.lastError?.startsWith('单条上报记录超过')
      return { ok: false, fatal, error: new Error(
        `历史补报未获得完整确认${status ? `（HTTP ${status}）` : ''}，记录保留在日志中等待重试`,
      ) }
    }
    acknowledged = confirmed
    accepted = result.delivered
    duplicates = result.duplicates
    publish()
  }
  return { ok: true }
}

/** 无定时器的一轮完整对账；只能在线程内或独立脚本执行，不能放进 emit 热路径。 */
export async function runBackfillPass(options: BackfillPassOptions): Promise<BackfillStats> {
  const progress = { ...(options.stats ?? emptyBackfillStats()), status: 'running' as BackfillStats['status'],
    filesTotal: 0, filesProcessed: 0, lastError: null as string | null }
  const publish = () => options.onProgress?.({ ...progress })
  const fail = (error: unknown) => {
    progress.failures++
    progress.status = 'retrying'
    const message = error instanceof Error ? error.message : String(error)
    progress.lastError = (options.config.appKey ? message.split(options.config.appKey).join('[已隐藏]') : message).slice(0, 500)
    publish()
  }
  publish()
  try {
    if (!options.config.features.reporting || !options.config.appKey || !options.identity.claimedUserId.trim()) {
      throw new Error('历史补报未启用：需要有效署名和上报凭证')
    }
    // listSessionFiles 为交互统计容忍不存在的目录；补报必须将它报告为失败，
    // 否则根目录配错或失去访问权限会被伪装成“所有历史已完成”。
    // ★ 多根：**逐根**检查并指名道姓 —— 一个笼统的「扫描失败」在配了两个根时
    //   没法告诉使用者是哪个 home 出了问题。这里刻意不学统计路径的「跳过缺失根」：
    //   补报的承诺是「全部历史都已核对」，静默少一个根就是在谎报完成。
    for (const root of options.sessionsRoots) {
      if (!existsSync(root)) throw new Error(`会话日志根不存在：${root}`)
      if (!(await stat(root)).isDirectory()) throw new Error(`会话日志根路径不是目录：${root}`)
      await readdir(root)
    }
    const files = await listSessionFiles(options.sessionsRoots, { strictErrors: true })
    progress.filesTotal = files.length
    const checkpointDir = resolveBackfillDir(options.config, options.sessionsRoots, options.plainRoots)
    await mkdir(checkpointDir, { recursive: true })
    const cwdBySession = new Map<string, string | null>()
    publish()

    // ── ① DSH：分帧 zstd，按帧数 + 字节光标增量 ─────────────────────────────
    for (const meta of files) {
      const checkpointPath = join(checkpointDir, `${digest(meta.filePath)}.json`)
      const previous = await loadCheckpoint(checkpointPath, meta.filePath)
      let deliveryFailed = false
      try {
        const scan = await scanIncremental(options.sessionsRoots, {
          sessionFiles: [meta],
          watermarks: {
            sizeOf: () => previous?.size,
            frameCountOf: () => previous?.frameCount,
            cursorOf: () => previous?.cursor,
            cwdOf: () => previous?.cursor?.cwd ?? cwdBySession.get(meta.sessionId),
            // ★ 文件分段、升级或恢复顺序不保证 seq 单调；跨文件最大 seq 会漏低序号历史。
            // 字节光标只属于本文件，重读产生的重复全部交给服务端幂等处理。
            lastSeqOf: () => undefined,
          },
        })
        const file = scan.files[0]
        if (!file || scan.diagnostics.filesFailed > 0) throw new Error(`历史日志读取失败：${meta.filePath}`)
        if (file.cursor?.cwd != null) cwdBySession.set(meta.sessionId, file.cursor.cwd)

        const outcome = await deliverRecords(
          scan.records.map((record) => toBilling(record, options.identity)), options, progress, publish)
        if (!outcome.ok) { deliveryFailed = outcome.fatal; throw outcome.error }
        if (scan.diagnostics.framesFailed > 0 || file.cursor?.byteOffset !== file.size) {
          // 半帧可能只是正在写入，损坏帧也可能随后恢复；二者都不允许保存越过它的光标。
          // 不足四字节的 magic 和完全损坏的文件没有可识别帧，也必须靠消费字节数拦住。
          throw new Error(`历史日志存在未完整解析的压缩帧或尾部数据，保留光标等待重试：${meta.filePath}`)
        }
        if (file.changed) await saveCheckpoint(checkpointPath, file)
        progress.filesProcessed++
        publish()
      } catch (error) {
        fail(error)
        // 同一个目标不可达时，不再让每个历史文件各等一次网络超时。
        if (deliveryFailed) break
      }
    }

    // ── ② Codex / Claude Code / Trae / WorkBuddy：纯文本，按字节数增量 ──────
    //    🚨 走 `scanPlainSources()` —— 与 CLI `report` 是**同一个**函数：两处各写一遍
    //      「什么时候该重解析」，就会出现「同一批日志，CLI 与插件报出不同条数」而**不报错**。
    if (progress.status !== 'retrying' && options.plainRoots.length > 0) {
      const watermarkPath = join(checkpointDir, 'plain-watermarks.json')
      const watermarks = await loadPlainWatermarks(watermarkPath)
      // 逐根扫：一个根 = 一个客户端的日志目录（Codex 的主根与 archived 副本是两个根），
      // 于是内存里一次只有一个根的记录，而不是全部来源的并集。
      for (const root of options.plainRoots) {
        let deliveryFailed = false
        try {
          const scan = await scanPlainSources([root], {
            sizeOf: (filePath) => watermarks.files[filePath],
            cwdOf: (sessionId) => cwdBySession.get(sessionId),
          })
          progress.filesTotal += scan.files.length
          publish()
          // 根在配置里是「解析出来就存在」的；这一刻不见了只能是目录被删 / 权限变了。
          // 与 DSH 那条路同一个口径：**不许**静默少一个来源。
          if (scan.missingRoots.length > 0) {
            throw new Error(`来源日志根不存在：${scan.missingRoots.join(' / ')}`)
          }
          if (scan.records.length > 0) {
            const outcome = await deliverRecords(
              scan.records.map((record) => toBilling(record, options.identity)), options, progress, publish)
            if (!outcome.ok) { deliveryFailed = outcome.fatal; throw outcome.error }
          }
          if (scan.diagnostics.filesFailed > 0) {
            throw new Error(`历史日志读取失败：${root.source} 有 ${scan.diagnostics.filesFailed} 个文件读不出来`)
          }
          // ★ 只在**整根全部确认之后**才前移字节数水位线（与 DSH 的「确认后才存光标」同一条规矩）。
          //   ⚠️ 「已核对」按**全部**文件计（含字节数没变、零解析的那些）—— 与 DSH 那条路一致；
          //      只记 changed 会让「这一轮其实没事可做」被判成没跑完，状态永远停在 running。
          for (const file of scan.files) {
            if (file.changed) watermarks.files[file.meta.filePath] = file.size
            progress.filesProcessed++
          }
          await savePlainWatermarks(watermarkPath, watermarks)
          publish()
        } catch (error) {
          fail(error)
          if (deliveryFailed) break
        }
      }
    }

    if (progress.filesProcessed === progress.filesTotal && progress.status !== 'retrying') {
      progress.status = 'complete'
      progress.lastCompletedAt = Date.now()
    }
  } catch (error) {
    fail(error)
  }
  publish()
  return { ...progress }
}
