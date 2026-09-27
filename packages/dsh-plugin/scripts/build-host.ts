/** 宿主入口、统计与历史补报线程必须一起构建，避免装载成功却缺少后台能力。 */
import { resolve } from 'node:path'
const root = resolve(import.meta.dir, '..')
const build = await Bun.build({
  entrypoints: [resolve(root, 'src/index.ts'), resolve(root, 'src/stats-worker.ts'), resolve(root, 'src/backfill-worker.ts')],
  target: 'node', format: 'esm', outdir: resolve(root, 'lib'), naming: '[name].js',
  external: ['@deepseek-ai/*'],
})
if (!build.success) {
  for (const log of build.logs) console.error(log)
  process.exit(1)
}
