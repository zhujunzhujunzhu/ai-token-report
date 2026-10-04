/**
 * 插件市场**收录预检**：提 PR 之前/之后各跑一次，回答三个问题。
 *
 * ```bash
 * bun run packages/dsh-plugin/verify/verify-market-entry.ts
 * ```
 *
 * ## 它回答什么
 *
 * 1. **站点的 npm 映射会不会成立** —— 复刻 awesome-dsh-plugin 的
 *    `scripts/probe-npm.mjs`：读**被收录子目录**里 `package.json` 的 `name`，
 *    去 registry 找那个包，并要求它的 `repository` 指回本仓。
 *    映射为空时，市场会把「一键安装」退化成源码安装
 *    （`github:owner/repo#path:/packages/dsh-plugin`）—— 而本仓源码包依赖
 *    `workspace:*`，那条路**装不上**。脚本会**分别对 `origin/main` 与当前 HEAD**
 *    各算一次：站点读的是 `raw.githubusercontent.com/<repo>/HEAD/…`，
 *    也就是**默认分支**，所以「只推特性分支」在站点眼里等于什么都没改。
 * 2. **提交物 YAML 合不合格** —— 键集（不许手写 `npm:`）、分类、双语描述、
 *    文件名约定、描述里没有营销词；这些正是 CI 与人工评审会看的形式项。
 * 3. **站点 CI 的第 2 项** —— 子目录 `package.json` 是否声明 `dsh.bundle`
 *    （只声明 `dsh.client` 是最常见的被拒原因）。
 *
 * ## ⚠️ 它是**预检**，不是权威
 *
 * 权威实现在 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
 * 的 `scripts/probe-npm.mjs` 与 CI 里。这里刻意只保留最小的等价逻辑（约 15 行），
 * 并在文件头写明来源；两边漂移的表现是「预检说成立、站点给不出映射」——
 * 那种情况以站点为准，回来更新这个脚本。
 *
 * 需要网络（registry.npmjs.org）；不写任何文件、不改任何状态。
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const repoRoot = resolve(import.meta.dir, '..', '..', '..')
/** 被收录的仓库与子目录 —— 与 `docs/插件市场收录.md` 里的条目保持一致。 */
const REPO = 'zhujunzhujunzhu/ai-token-report'
const SUBDIR = 'packages/dsh-plugin'
/** 精选列表仓库允许的键（`npm:` 是自动采集的，手写会被校验拒绝）。 */
const ALLOWED_KEYS = new Set(['url', 'name', 'category', 'description', 'tarball'])
/** contributing.md 里给出的分类取值表。 */
const CATEGORIES = [
  'agi', 'ui', 'usage', 'theme', 'model', 'identity', 'session', 'memory', 'tools', 'wsl',
  'browser', 'vision', 'voice', 'docs', 'skill', 'workflow', 'git', 'notify', 'dev',
  'security', 'remote', 'market', 'fun',
]
/** 提交物文件名（`<owner>__<repo>--<子目录路径>.yml`，路径分隔符换成 `-`）。 */
const ENTRY_FILE = 'zhujunzhujunzhu__ai-token-report--packages-dsh-plugin.yml'

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${detail ? ` —— ${detail}` : ''}`)
  if (!ok) failures += 1
}

/** 从某个 git 版本取出子目录清单（模拟站点读默认分支的 raw 文件）。 */
function manifestAt(rev: string): { name?: unknown; version?: unknown; dsh?: { bundle?: { patch?: unknown } } } {
  const text = execFileSync('git', ['show', `${rev}:${SUBDIR}/package.json`], { cwd: repoRoot, encoding: 'utf8' })
  return JSON.parse(text) as { name?: unknown; version?: unknown; dsh?: { bundle?: { patch?: unknown } } }
}

/** 与 `probe-npm.mjs` 同构：子目录包名 → registry → repository 必须指回本仓。 */
async function probe(manifest: { name?: unknown }): Promise<{ npm: string | null; version?: string; reason?: string }> {
  const name = typeof manifest.name === 'string' ? manifest.name : null
  if (name === null) return { npm: null, reason: '子目录 package.json 没有 name' }
  let meta: {
    'dist-tags'?: { latest?: unknown }
    versions?: Record<string, { repository?: unknown }>
    repository?: unknown
  }
  try {
    const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}`, {
      headers: { accept: 'application/json' },
    })
    if (!response.ok) return { npm: null, reason: `registry HTTP ${response.status}（这个包名没有发布过）` }
    meta = await response.json() as typeof meta
  } catch (error) {
    return { npm: null, reason: `registry 取不到：${String(error)}` }
  }
  // 与探针一致：先看 `latest` 那份清单里的 repository，再退回顶层（改名/改地址后仍要认得出）。
  const latest = typeof meta['dist-tags']?.latest === 'string' ? meta['dist-tags'].latest : null
  const repository = (latest === null ? null : meta.versions?.[latest]?.repository) ?? meta.repository
  const repoField = typeof repository === 'string' ? repository : (repository as { url?: string } | undefined)?.url ?? ''
  if (!repoField.toLowerCase().includes(REPO.toLowerCase())) {
    return { npm: null, reason: `repository 不指向本仓：${repoField || '(空)'}` }
  }
  return { npm: name, ...(latest === null ? {} : { version: latest }) }
}

console.log('='.repeat(72))
console.log('插件市场收录预检（npm 映射 / 提交物 / dsh.bundle）')
console.log('='.repeat(72))

console.log('\n── 1. npm 映射（站点读默认分支，所以两个版本各算一次）──')
for (const [label, rev] of [['origin/main（站点今天读到的）', 'origin/main'], ['当前 HEAD', 'HEAD']] as const) {
  let manifest: ReturnType<typeof manifestAt>
  try {
    manifest = manifestAt(rev)
  } catch {
    check(`${label} 能读到 ${SUBDIR}/package.json`, false, 'git show 失败（分支或路径不存在？）')
    continue
  }
  const result = await probe(manifest)
  console.log(`\n  [${label}] 子目录包名 ${String(manifest.name)}@${String(manifest.version)}`)
  check(
    '站点能拿到 npm 映射（否则市场会退化成装不上的源码安装）',
    result.npm !== null,
    result.npm !== null
      ? `install: dsh plugin --profile web add ${result.npm}`
      : `${result.reason}；修法：把改名/发布先落到默认分支`,
  )
  // ★ 站点读的是 `raw.githubusercontent.com/<repo>/HEAD/…`，也就是**默认分支**：
  //   只推特性分支时，站点眼里什么都没变 —— 而这一条在并进 main 之前**必然是红的**，
  //   属预期，不是脚本坏了。明确说出来，免得下一个人把它当噪音删掉。
  if (rev === 'origin/main' && result.npm === null) {
    console.log('     ℹ️ 预期：本分支并进 main 之前这一条一直是红的（站点只看默认分支）。并完再跑一次应转绿。')
  }
  if (result.npm !== null && result.version !== undefined) {
    // ★ 市场卡片与一键安装用的一直是 npm 上那个 **latest**：没发新版就等于让用户装旧版。
    console.log(`     市场会装到的版本：${result.version}（发新版后这里才会变）`)
  }
}

console.log('\n── 2. 提交物 YAML（形式项，与 CI / 评审会看的一致）──')
const docPath = join(repoRoot, 'docs', '插件市场收录.md')
const doc = readFileSync(docPath, 'utf8')
const yamlBlock = doc.split('```yaml')[1]?.split('```')[0]?.trim() ?? ''
const entry = Bun.YAML.parse(yamlBlock) as {
  url?: unknown
  name?: unknown
  category?: unknown
  description?: { en?: unknown; zh?: unknown }
  [key: string]: unknown
}
check('手册里能取到 YAML 代码块', yamlBlock.length > 0)
check(`文件名符合 <owner>__<repo>--<子目录路径>.yml`, /^[A-Za-z0-9._-]+__[A-Za-z0-9._-]+--[A-Za-z0-9._-]+\.yml$/.test(ENTRY_FILE), ENTRY_FILE)
check('YAML 可解析（描述里的 ": " 必须加引号）', entry !== null && typeof entry === 'object')
check('键集只在允许范围内（不许手写 npm:）', Object.keys(entry).every((key) => ALLOWED_KEYS.has(key)), Object.keys(entry).join(', '))
check('url 精确指向被收录的子目录', entry.url === `https://github.com/${REPO}/tree/main/${SUBDIR}`, String(entry.url))
check('name 形如 owner/repo#subname', entry.name === 'zhujunzhujunzhu/ai-token-report#dsh-plugin', String(entry.name))
check('category 在取值表内', typeof entry.category === 'string' && CATEGORIES.includes(entry.category), String(entry.category))
check('description.en 以句号结尾', typeof entry.description?.en === 'string' && entry.description.en.trimEnd().endsWith('.'))
check('description.zh 以句号结尾', typeof entry.description?.zh === 'string' && entry.description.zh.trimEnd().endsWith('。'))
check(
  '描述是单行且不带营销词',
  typeof entry.description?.en === 'string' && !entry.description.en.includes('\n') &&
    !/best|ultimate|powerful|amazing|revolutionary/i.test(entry.description.en),
)

console.log('\n── 3. 站点 CI 的第 2 项：子目录声明 dsh.bundle ──')
for (const rev of ['origin/main', 'HEAD']) {
  try {
    const manifest = manifestAt(rev)
    const patch = manifest.dsh?.bundle?.patch
    check(`${rev}: dsh.bundle.patch 已声明`, typeof patch === 'string', typeof patch === 'string' ? patch : '(缺 —— 只声明 dsh.client 会被拒)')
  } catch {
    check(`${rev}: 能读到子目录清单`, false)
  }
}

console.log('\n' + '='.repeat(72))
if (failures === 0) console.log('✅ 预检全部通过')
else console.log(`❌ ${failures} 项未通过`)
console.log('='.repeat(72))
if (failures > 0) process.exitCode = 1
