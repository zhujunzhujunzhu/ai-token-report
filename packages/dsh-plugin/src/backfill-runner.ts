/**
 * 历史补报执行器：以磁盘日志为耐久源，逐文件扫描并等待服务端确认。
 *
 * ★ 实时 telemetry 只回放存活会话，不能覆盖从未打开的历史会话。
 * 此处复用本地统计扫描器与 Reporter，只有整份文件的新增记录全部确认后
 * 才保存字节光标。中途退出会重发该文件，由服务端 event_id 幂等吸收。
 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  listSessionFiles, resolveDshHome, scanIncremental, SESSION_SCAN_REVISION,
  type IncrementalFileResult, type UsageRecord,
} from '@ai-token-report/core'
import type { EffectiveConfig } from './config.js'
import type { BillingRecord, FoldIdentity } from './fold.js'
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
  sessionsRoot: string
  /** 传入上一轮快照时累计确认数；不传时返回本次执行的计数。 */
  stats?: BackfillStats
  onProgress?: (stats: BackfillStats) => void
  fetchImpl?: typeof fetch
}

interface Checkpoint { version: 1; file: IncrementalFileResult }
const digest = (text: string) => createHash('sha256').update(text).digest('hex')

/** 目标服务器或凭证改变时重新核对全部历史；明文凭证绝不进入文件。 */
export function resolveBackfillDir(config: EffectiveConfig, sessionsRoot: string): string {
  const scope = digest(JSON.stringify([SESSION_SCAN_REVISION, config.endpoint, config.appKey, resolve(sessionsRoot)]))
  return join(resolveDshHome(config.dshHome), 'token-report', 'backfill', scope)
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

/** 只转换内存字段，不在补报路径另算任何指标。 */
function toBilling(record: UsageRecord, identity: FoldIdentity): BillingRecord {
  return {
    eventId: record.eventId, sessionId: record.sessionId, seq: record.seq, time: record.time,
    provider: record.provider, model: record.model, cwd: record.cwd, turn: record.turn, step: record.step,
    inputTokens: record.usage.input, outputTokens: record.usage.output,
    cacheReadTokens: record.usage.cacheRead, cacheWriteTokens: record.usage.cacheWrite,
    reasoningTokens: record.usage.reasoning, totalTokens: record.usage.total,
    identityViolation: false, identity,
  }
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
    if (!(await stat(options.sessionsRoot)).isDirectory()) throw new Error('会话日志根路径不是目录')
    await readdir(options.sessionsRoot)
    const files = await listSessionFiles(options.sessionsRoot, { strictErrors: true })
    progress.filesTotal = files.length
    const checkpointDir = resolveBackfillDir(options.config, options.sessionsRoot)
    await mkdir(checkpointDir, { recursive: true })
    const maxRecords = Math.max(1, Math.min(200, Math.floor(options.config.batch.maxRecords)))
    const cwdBySession = new Map<string, string | null>()
    publish()

    for (const meta of files) {
      const checkpointPath = join(checkpointDir, `${digest(meta.filePath)}.json`)
      const previous = await loadCheckpoint(checkpointPath, meta.filePath)
      let deliveryFailed = false
      try {
        const scan = await scanIncremental(options.sessionsRoot, {
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

        // 历史日志本身就是重试副本，不能把全量历史塞进容量受限的实时 outbox。
        // 每批确认后继续，文件完成才保存光标；没有 durable ack 时绝不前移。
        const reporter = new Reporter({
          config: { ...options.config, batch: { ...options.config.batch, maxRecords },
            outbox: { ...options.config.outbox, enabled: false } },
          identity: options.identity, fetchImpl: options.fetchImpl,
        })
        let acknowledged = 0
        let accepted = 0
        let duplicates = 0
        for (let offset = 0; offset < scan.records.length; offset += maxRecords) {
          const batch = scan.records.slice(offset, offset + maxRecords)
          for (const record of batch) reporter.enqueue(toBilling(record, options.identity))
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
            deliveryFailed = result.rejected === 0 && !['400', '413', '422'].includes(status ?? '') &&
              !result.lastError?.startsWith('单条上报记录超过')
            throw new Error(`历史补报未获得完整确认${status ? `（HTTP ${status}）` : ''}，记录保留在日志中等待重试`)
          }
          acknowledged = confirmed
          accepted = result.delivered
          duplicates = result.duplicates
          publish()
        }
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
