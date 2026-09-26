/** 统计专用线程的窄消息通道；不向线程发送身份 Key，只发送本地路径和查询参数。 */
import { Worker } from 'node:worker_threads'
import type { StatsContext, UsageQuery, UsageResult } from './stats.js'

interface Pending { resolve(value: UsageResult): void; reject(error: Error): void }
interface Entry { worker: Worker; next: number; pending: Map<number, Pending> }
const workers = new Map<string, Entry>()

export function queryInStatsWorker(ctx: StatsContext, query: UsageQuery): Promise<UsageResult> {
  let entry = workers.get(ctx.dbPath)
  if (!entry) {
    // 源码测试由 Bun 执行 TS；发布产物与独立 worker 文件在同一目录。
    const filename = import.meta.url.endsWith('.ts') ? './stats-worker.ts' : './stats-worker.js'
    const worker = new Worker(new URL(filename, import.meta.url))
    entry = { worker, next: 0, pending: new Map() }
    const own = entry
    const failed = (err: Error) => {
      if (workers.get(ctx.dbPath) === own) workers.delete(ctx.dbPath)
      for (const p of own.pending.values()) p.reject(err)
      own.pending.clear()
      void worker.terminate()
    }
    worker.on('error', failed)
    worker.on('exit', code => {
      if (own.pending.size) failed(new Error(`统计线程已退出（${code}）`))
      if (workers.get(ctx.dbPath) === own) workers.delete(ctx.dbPath)
    })
    worker.on('message', (message: { id: number; result?: UsageResult; error?: string }) => {
      const p = own.pending.get(message.id)
      if (!p) return
      own.pending.delete(message.id)
      if (message.result) p.resolve(message.result)
      else p.reject(new Error(message.error ?? '统计线程未返回结果'))
      if (own.pending.size === 0) worker.unref()
    })
    worker.unref()
    workers.set(ctx.dbPath, own)
  }
  const own = entry
  if (own.pending.size >= 32) return Promise.reject(new Error('统计请求过多，请稍后重试'))
  return new Promise((resolve, reject) => {
    const id = ++own.next
    own.pending.set(id, { resolve, reject })
    own.worker.ref()
    own.worker.postMessage({ id, query, ctx: { sessionsRoot: ctx.sessionsRoot, dbPath: ctx.dbPath, config: { localDb: ctx.config.localDb } } })
  })
}

/** 插件卸载时释放线程/文件观察器；空闲线程不阻止 DSH 正常退出。 */
export async function closeStatsWorker(dbPath: string): Promise<void> {
  const entry = workers.get(dbPath)
  if (!entry) return
  workers.delete(dbPath)
  for (const p of entry.pending.values()) p.reject(new Error('统计服务已停止'))
  entry.pending.clear()
  await entry.worker.terminate()
}
