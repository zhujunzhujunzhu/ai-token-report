/** 历史扫描与补报放在独立线程；插件启动只安排任务，不在宿主读取日志。 */
import { Worker } from 'node:worker_threads'
import type { EffectiveConfig } from './config.js'
import type { FoldIdentity } from './fold.js'
import { emptyBackfillStats, type BackfillStats } from './backfill-runner.js'

export type { BackfillStats } from './backfill-runner.js'

export interface HistoryBackfillOptions {
  config: EffectiveConfig
  identity: FoldIdentity
  sessionsRoot: string
  onLog?: (level: 'info' | 'warn', message: string) => void
}

export interface HistoryBackfill {
  start(): void
  stop(): Promise<void>
  stats(): BackfillStats
}

export function createHistoryBackfill(options: HistoryBackfillOptions): HistoryBackfill {
  let snapshot = emptyBackfillStats()
  let worker: Worker | undefined
  let restart: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  let lastLoggedConfirmed: number | undefined
  const launch = () => {
    if (stopped || worker) return
    snapshot = { ...snapshot, status: 'running', lastError: null }
    const failed = (error: Error) => {
      snapshot = { ...snapshot, status: 'retrying', failures: snapshot.failures + 1,
        lastError: error.message.split(options.config.appKey || '\u0000').join('[已隐藏]').slice(0, 500) }
      options.onLog?.('warn', `token-report: 历史补报线程失败，将自动重试：${snapshot.lastError}`)
      const current = worker
      worker = undefined
      if (current) void current.terminate()
      if (!stopped && !restart) {
        restart = setTimeout(() => { restart = undefined; launch() }, 30_000)
        restart.unref?.()
      }
    }
    try {
      const filename = import.meta.url.endsWith('.ts') ? './backfill-worker.ts' : './backfill-worker.js'
      const current = new Worker(new URL(filename, import.meta.url), {
        workerData: { config: options.config, identity: options.identity, sessionsRoot: options.sessionsRoot, stats: snapshot },
      })
      worker = current
      current.on('message', (message: BackfillStats) => {
        if (worker !== current || stopped) return
        const previous = snapshot
        snapshot = message
        if (message.status === 'complete' && lastLoggedConfirmed !== message.confirmed) {
          lastLoggedConfirmed = message.confirmed
          options.onLog?.('info', `token-report: 历史补报完成，本轮核对 ${message.filesProcessed}/${message.filesTotal} 个文件；累计确认 ${message.confirmed} 条（重复 ${message.duplicates} 条）`)
        } else if (message.status === 'retrying' && message.lastError !== previous.lastError) {
          options.onLog?.('warn', `token-report: 历史补报未完成，将自动重试：${message.lastError}`)
        }
      })
      current.on('error', error => { if (worker === current && !stopped) failed(error) })
      current.on('exit', code => {
        if (worker === current && !stopped) failed(new Error(`历史补报线程提前退出（${code}）`))
      })
      current.unref()
    } catch (error) {
      failed(error instanceof Error ? error : new Error(String(error)))
    }
  }
  return {
    start() { if (!stopped) launch() },
    async stop() {
      stopped = true
      if (restart) clearTimeout(restart)
      restart = undefined
      const current = worker
      worker = undefined
      if (current) await current.terminate()
      snapshot = { ...snapshot, status: 'stopped' }
    },
    stats() { return { ...snapshot } },
  }
}
