/** DSH 的运行期包版本读取在单文件产物里丢失相对位置；构建时内联该包自身版本。 */
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { BunPlugin } from 'bun'

export const dshBundlePlugin: BunPlugin = {
  name: 'dsh-package-version',
  setup(build) {
    build.onLoad({ filter: /[\\/]@deepseek-ai[\\/]dsh-llm[\\/]lib[\\/]index\.js$/ }, async ({ path }) => {
      const source = await readFile(path, 'utf8')
      const manifest = JSON.parse(await readFile(join(dirname(path), '..', 'package.json'), 'utf8')) as { version: string }
      const statement = 'const { version } = createRequire(import.meta.url)("../package.json");'
      if (source.split(statement).length !== 2 || typeof manifest.version !== 'string') throw new Error('DSH 版本读取实现已变化，请复核单文件打包适配')
      return { contents: source.replace(statement, `const version = ${JSON.stringify(manifest.version)};`), loader: 'js' }
    })
  },
}
