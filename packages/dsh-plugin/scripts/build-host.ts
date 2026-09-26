/** 宿主入口和统计线程必须一起构建，发布时缺少线程文件会导致首次查询失败。 */
import { resolve } from 'node:path'
const root = resolve(import.meta.dir, '..')
const build = await Bun.build({
  entrypoints: [resolve(root, 'src/index.ts'), resolve(root, 'src/stats-worker.ts')],
  target: 'node', format: 'esm', outdir: resolve(root, 'lib'), naming: '[name].js',
  external: ['@deepseek-ai/*'],
})
if (!build.success) {
  for (const log of build.logs) console.error(log)
  process.exit(1)
}
