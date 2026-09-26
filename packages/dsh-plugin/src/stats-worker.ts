/** 重查询只在线程内运行；日志变更合并，短时间内多个周期共用一轮已完成的采集。 */
import { parentPort } from 'node:worker_threads'
import { watch, type FSWatcher } from 'node:fs'
import { resolve } from 'node:path'
import { executeQuery, type StatsContext, type UsageQuery } from './stats.js'

interface Request { id: number; ctx: StatsContext; query: UsageQuery }
let root = ''
let watcher: FSWatcher | undefined
let fullScanNeeded = true
const changedFiles = new Set<string>()
let lastFullScanAt = 0
let scannedAt = 0
let chain = Promise.resolve()

function observe(sessionsRoot: string): void {
  if (root === sessionsRoot && watcher) return
  watcher?.close()
  root = sessionsRoot
  fullScanNeeded = true
  try {
    watcher = watch(root, { recursive: true }, (_event, filename) => {
      if (filename && /(?:^|[\\/])session[^\\/]*\.jsonl\.zstd$/.test(filename)) changedFiles.add(resolve(root, filename))
      else fullScanNeeded = true
    })
    watcher.on('error', () => { watcher?.close(); watcher = undefined; fullScanNeeded = true })
    watcher.unref()
  } catch { watcher = undefined }
}

parentPort?.on('message', (request: Request) => {
  chain = chain.catch(() => {}).then(async () => {
    observe(request.ctx.sessionsRoot)
    // 观察器只是加速提示；定期扫描仍发现丢通知、其它进程与启动后新建的根目录。
    const full = !request.ctx.config.localDb || request.query.refresh || fullScanNeeded || Date.now() - lastFullScanAt >= 30_000
    const changed = [...changedFiles]
    const scan = full || changed.length > 0
    if (scan) { fullScanNeeded = false; changedFiles.clear() }
    try {
      const result = await executeQuery(request.ctx, request.query, { readOnly: !scan, ...(scan && !full ? { changedFiles: changed } : {}) })
      if (scan && result.source === 'local-db') {
        scannedAt = Date.now()
        if (full) lastFullScanAt = scannedAt
      } else if (result.source !== 'local-db') fullScanNeeded = true
      if (result.source === 'local-db') result.scannedAt = scannedAt
      parentPort!.postMessage({ id: request.id, result })
    } catch (error) {
      fullScanNeeded = true
      parentPort!.postMessage({ id: request.id, error: error instanceof Error ? error.message : String(error) })
    }
  })
})
