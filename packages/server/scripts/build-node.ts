/** Node 部署与离线迁移共用源码；MySQL 驱动由服务端安装依赖提供。 */
import { resolve } from 'node:path'
const root = resolve(import.meta.dir, '..')
const result = await Bun.build({
  entrypoints: ['src/main.ts', 'scripts/migrate-db.ts', 'scripts/import-credentials.ts'].map((path) => resolve(root, path)),
  target: 'node', format: 'esm', outdir: resolve(root, 'dist'), naming: '[name].mjs',
  external: ['mysql2/promise'],
})
if (!result.success) throw new AggregateError(result.logs, 'Node 服务端构建失败')
console.log('Node 服务端、数据库检查/迁移与凭证导入入口已构建到 packages/server/dist')
