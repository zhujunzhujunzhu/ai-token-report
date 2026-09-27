/** 补报线程周期性核对所有日志；失败只延后重试，不推进未确认文件的光标。 */
import { parentPort, workerData } from 'node:worker_threads'
import { setTimeout as delay } from 'node:timers/promises'
import { runBackfillPass, type BackfillPassOptions } from './backfill-runner.js'

const options = workerData as BackfillPassOptions
let stats = options.stats
let failedPasses = 0
for (;;) {
  stats = await runBackfillPass({ ...options, stats, onProgress: progress => parentPort?.postMessage(progress) })
  failedPasses = stats.status === 'complete' ? 0 : failedPasses + 1
  // 成功后仍补齐其它 DSH 进程新增的日志；断网时最多每五分钟重试一轮。
  await delay(Math.min(300_000, 30_000 * 2 ** Math.min(failedPasses, 4)))
}
