/** 重查询只在线程内运行；日志变更合并，短时间内多个周期共用一轮已完成的采集。 */
import { parentPort } from 'node:worker_threads'
import { watch, realpathSync, type FSWatcher } from 'node:fs'
import { resolve } from 'node:path'
import { executeQuery, type StatsContext, type UsageQuery } from './stats.js'

interface Request { id: number; ctx: StatsContext; query: UsageQuery }
/** 当前监听的那一组根（用于判断「要不要重装监听」）。 */
let rootsKey = ''
const watchers = new Map<string, FSWatcher>()
let fullScanNeeded = true
const changedFiles = new Set<string>()
let lastFullScanAt = 0
let scannedAt = 0
let chain = Promise.resolve()

/**
 * 为**每一个**会话日志根装一个递归监听。
 *
 * ★ 多套 DSH 并存时这是最容易漏的一处：只监听第一个根的话，
 *   其余 home 的新会话不会触发变更提示 —— 不会报错，只会让面板「慢半拍」，
 *   而这恰恰是最难被发现的一类失效。定期全量扫描（30 秒）是兜底，不是借口。
 *
 * 变更路径必须用**它所属的那个根**去 `resolve()`：回调闭包里绑的是本根的 `root`，
 * 两个根的 `filename` 拼错会得到一个不存在的路径，表现为「变更被静默忽略」。
 */
function observe(sessionsRoots: readonly string[]): void {
  const key = sessionsRoots.join('\u0000')
  if (rootsKey === key && watchers.size > 0) return

  for (const existing of watchers.values()) existing.close()
  watchers.clear()
  rootsKey = key
  fullScanNeeded = true

  for (const root of sessionsRoots) {
    try {
      // Windows 的 8.3 短路径/目录联接可能让 libuv 的递归监听触发原生断言，
      // 直接终止宿主，try/catch 无法恢复。监听前还原真实路径；变更路径仍用调用方根目录。
      const watcher = watch(realpathSync.native(root), { recursive: true }, (_event, filename) => {
        if (filename && /(?:^|[\\/])session[^\\/]*\.jsonl\.zstd$/.test(filename)) changedFiles.add(resolve(root, filename))
        else fullScanNeeded = true
      })
      watcher.on('error', () => { watcher.close(); watchers.delete(root); fullScanNeeded = true })
      watcher.unref()
      watchers.set(root, watcher)
    } catch {
      // 单个根装不上监听不能拖垮其它根（缺失的 home / 无权限的目录很常见）：
      // 由 30 秒周期全量扫描兜住，这里不抛错。
    }
  }
}

parentPort?.on('message', (request: Request) => {
  chain = chain.catch(() => {}).then(async () => {
    observe(request.ctx.sessionsRoots)
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