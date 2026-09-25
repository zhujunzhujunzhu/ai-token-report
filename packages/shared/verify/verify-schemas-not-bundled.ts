/**
 * 产物侧不变量：**zod 只属于服务端的形状校验，绝不能进前端产物**。
 *
 * ## 这条不变量为什么需要脚本兜住
 *
 * `zod` 是 `@ai-token-report/shared` 的依赖（形状校验住在 `src/schemas.ts`），
 * 而 `web-local` / `web-portal` / 插件的浏览器半都 import `shared` 的**根入口**。
 * 一旦有人图方便在 `src/index.ts` 里写一行 `export * from './schemas.js'`：
 *
 * - 三个前端产物各自多出几十 KB 的校验库（实测压缩后仍有 ~81 KB）；
 * - 页面行为**完全不变**（校验在服务端跑，前端一次也用不到）；
 * - 没有任何测试会红 —— 这是一次纯粹静默的退化。
 *
 * 所以这里从**产物**侧断言：dist 里搜不到 zod 的指纹串。
 *
 * ## 为什么这些指纹串是可靠的
 *
 * `_zod`（zod v4 的内部品牌字段）、`ZodError`（错误类名）、
 * `Invalid input: expected`（v4 默认文案前缀）在被打包 **且 --minify 之后
 * 依然存在** —— 用 `bun build <入口> --minify --target=browser` 把一个
 * 只做 `z.object({a: z.string()})` 的探针打成 81 KB 产物后实测：
 * `_zod` 命中 5 次、`ZodError` 2 次、`Invalid input: expected` 1 次。
 *
 * 反向也验过：把那份探针临时丢进 `packages/web-local/dist/`，本脚本立刻
 * 报 ❌ 并指出文件 —— 所以这里**不会给假绿**（假绿 = 检查看起来在跑、
 * 其实什么都搜不到，那比没有检查更糟）。
 *
 * ## ⚠️ 两条检查的分工（实测结论，别只留一条）
 *
 * 实测 Vite 会把根入口里**没人用**的 `export * from './schemas.js'` 直接摇掉：
 * 临时加上它之后 web-local 产物**字节不变**（hash 与体积都一样），
 * 产物扫描因此抓不到这次错误 —— 抓到它的是 ① 那条根因侧检查。
 * ② 产物扫描兜的是另一半：前端真的 import 了某个 schema（或换了不做
 * tree-shaking 的打包方式）时 zod 确实会进产物，而那时只有产物侧看得见。
 * 两条都要在。
 *
 * ## 用法（从仓库根、从包内两种调用都要能跑）
 *
 * ```bash
 * bun run build:local                                          # 前置：先出产物
 * bun run --filter '@ai-token-report/shared' verify:bundles
 * bun run packages/shared/verify/verify-schemas-not-bundled.ts # 从根直接跑
 * ```
 *
 * ⚠️ 路径一律用 `import.meta.dir` 反推仓库根，**不看 cwd** ——
 *    否则从包内跑会去找 `packages/shared/packages/web-local/dist`。
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { extname, join } from 'node:path'

/** `verify/` → `shared/` → `packages/` → 仓库根 */
const REPO_ROOT = join(import.meta.dir, '..', '..', '..')

/**
 * zod 的指纹串（理由见文件头：都在 --minify 之后存活）。
 *
 * ⚠️ 刻意不搜裸的 `zod`：包名会出现在注释、sourcemap 的自定义字段等
 *    与「库被打进去」无关的地方，只会制造假红。
 */
const ZOD_MARKERS = ['_zod', 'ZodError', 'Invalid input: expected'] as const

/** 只扫文本产物；图片 / 字体里的二进制字节没有语义。 */
const TEXT_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.css', '.html', '.json', '.txt', '.map', '.svg'])

/** 要检查的产物目录。`web-local` 是硬要求（本任务的验收对象）。 */
const TARGETS = [
  {
    label: 'web-local（本地页面）',
    dir: join(REPO_ROOT, 'packages', 'web-local', 'dist'),
    required: true,
  },
  {
    label: 'web-portal（部门看板）',
    dir: join(REPO_ROOT, 'packages', 'web-portal', 'dist'),
    required: false,
  },
  {
    label: 'dsh-plugin（插件产物，含浏览器半）',
    dir: join(REPO_ROOT, 'packages', 'dsh-plugin', 'dist'),
    required: false,
  },
] as const

/** 计数与打印风格与 `packages/dsh-plugin/verify/verify-client-bundle.ts` 一致。 */
let checks = 0
let failures = 0

function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (ok) console.log(`  ✅ ${label}${detail ? ` — ${detail}` : ''}`)
  else {
    failures++
    console.log(`  ❌ ${label}${detail ? `\n     ${detail}` : ''}`)
  }
}

/** 递归列出目录下所有文件（自己走，不依赖运行时对 `recursive` 的支持差异）。 */
async function walk(dir: string, out: string[] = []): Promise<string[]> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) await walk(full, out)
    else if (entry.isFile()) out.push(full)
  }
  return out
}

/** 某个文件命中的指纹串。 */
function hitsIn(text: string): string[] {
  return ZOD_MARKERS.filter((marker) => text.includes(marker))
}

async function scanTarget(label: string, dir: string, required: boolean): Promise<void> {
  if (!(await exists(dir))) {
    if (required) {
      check(`${label} 产物存在`, false, `找不到 ${dir} —— 先跑 bun run build:local`)
    } else {
      console.log(`ℹ️ 跳过 ${label}：产物目录不存在（没有可检查的产物）`)
    }
    return
  }

  const files = await walk(dir)
  let bytes = 0
  let scanned = 0
  const offenders: string[] = []

  for (const file of files) {
    const info = await stat(file)
    bytes += info.size
    if (!TEXT_EXTENSIONS.has(extname(file).toLowerCase())) continue
    scanned++
    const hits = hitsIn(await readFile(file, 'utf8'))
    if (hits.length > 0) offenders.push(`${relPath(file)} → ${hits.join(' / ')}`)
  }

  const summary = `${scanned}/${files.length} 个文本产物、${Math.round(bytes / 1024)} KB、命中 ${offenders.length}`
  check(
    `${label} 不含 zod 指纹串`,
    offenders.length === 0,
    offenders.length ? `搜索的指纹串：${ZOD_MARKERS.join(' / ')}\n     ${offenders.join('\n     ')}` : summary,
  )
}

function relPath(file: string): string {
  return file.startsWith(REPO_ROOT) ? file.slice(REPO_ROOT.length + 1).replaceAll('\\', '/') : file
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

// ── 检查 ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('='.repeat(72))
  console.log('产物侧不变量：zod 不得进入前端产物（根因是 shared 根入口的 re-export）')
  console.log('='.repeat(72))
  console.log()

  // ① 根因侧：便宜、快，能在 30 秒的构建之前就拦住
  const indexSource = await readFile(join(REPO_ROOT, 'packages', 'shared', 'src', 'index.ts'), 'utf8')
  const reExportsSchemas = /['"]\.\/schemas(\.js)?['"]/.test(indexSource)
  check(
    'shared 根入口不 re-export schemas（🚨 一挂上就会进三份前端产物）',
    !reExportsSchemas,
    reExportsSchemas ? 'shared/src/index.ts 里出现了 ./schemas —— 请改成从 @ai-token-report/shared/schemas 显式 import' : '',
  )

  // ② 产物侧：真正的验收对象
  for (const target of TARGETS) {
    await scanTarget(target.label, target.dir, target.required)
  }

  console.log('\n' + '='.repeat(72))
  if (failures === 0) console.log(`✅ 全部通过：${checks} 项检查`)
  else console.log(`❌ ${failures} / ${checks} 项检查失败`)
  console.log('='.repeat(72))
  // 🚨 必须显式给退出码：这是验收命令，静默 0 等于没检查
  process.exit(failures > 0 ? 1 : 0)
}

await main()