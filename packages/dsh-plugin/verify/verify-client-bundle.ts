/**
 * 浏览器半的**真实产物**冒烟：把 `lib/client.js` 当成 DSH 前端那样执行一遍。
 *
 * ```bash
 * bun run packages/dsh-plugin/verify/verify-client-bundle.ts
 * ```
 *
 * ## 为什么必须有这一层
 *
 * 单测跑的是 `src/client/**` 的**源码**，证明的是「代码逻辑对」。
 * 但装进 DSH 的是**打包产物**，中间隔着一次 `bun build` + 一层
 * `window.__ModuleLoader__` 信封。这一步会额外暴露三类只会在产物上出现的问题：
 *
 * 1. **信封没包对** —— 忘了包 `factory`，或 `id` 写成别的名字。
 *    DSH 的表现是 `bundle ... loaded without registering "<pkg>" via __ModuleLoader__.load`，
 *    而且是在浏览器里，宿主侧只看到「插件没起来」。
 * 2. **引用了模块表里没有的模块** —— 最典型的是 JSX 走了**开发版**转换
 *    （`react/jsx-dev-runtime`）。产物看着完全正常，运行时必炸。
 * 3. **`package.json` 声明与产物对不上** —— 声明了 `dsh.client` 却没有
 *    `exports["./client"]`（或文件不存在）会让 **DSH 启动直接失败**
 *    （`ClientPackageCompositionError`），不是「面板不出现」。
 *
 * 另外还断言了**宿主半与浏览器半对路由路径的看法一致** —— 两边各写一个字面量
 * 是这类双半插件最容易长出来的静默 bug（面板永远 404）。
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as React from 'react'
import * as ReactDOM from 'react-dom'
import * as JSXRuntime from 'react/jsx-runtime'

const pkgDir = process.env['ATR_PLUGIN_PACKAGE_DIR'] ?? join(import.meta.dir, '..')
const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as {
  name: string
  exports: Record<string, unknown>
  dsh?: { client?: { platform?: string; inject?: unknown } }
}

let failures = 0
let checks = 0

function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (ok) console.log(`  ✅ ${label}`)
  else {
    failures++
    console.log(`  ❌ ${label}${detail ? `\n     ${detail}` : ''}`)
  }
}

console.log('='.repeat(72))
console.log('浏览器半真实产物冒烟（lib/client.js → 假 __ModuleLoader__）')
console.log('='.repeat(72))

// ── ① package.json 的声明（DSH 靠它发现浏览器半）─────────────────────────
console.log('\n── package.json 声明 ──')

check('dsh.client.platform === "web"', pkg.dsh?.client?.platform === 'web', JSON.stringify(pkg.dsh?.client))

const clientExport = pkg.exports['./client']
const clientRel =
  typeof clientExport === 'string'
    ? clientExport
    : typeof clientExport === 'object' && clientExport !== null && typeof (clientExport as { default?: unknown }).default === 'string'
      ? ((clientExport as { default: string }).default)
      : undefined
check(
  'exports["./client"] 是字符串（或带字符串 default 的对象）',
  clientRel !== undefined,
  JSON.stringify(clientExport),
)

const clientPath = clientRel === undefined ? undefined : join(pkgDir, clientRel)
check(
  '★ exports["./client"] 指向的文件真的存在（不然 DSH 启动直接失败）',
  clientPath !== undefined && existsSync(clientPath),
  `path = ${String(clientPath)}`,
)

if (clientPath === undefined || !existsSync(clientPath)) {
  console.log('\n❌ 产物不存在，先跑：bun run --filter @ai-token-report/dsh-plugin build')
  process.exitCode = 1
  process.exit()
}

// ── ② 静态形状 ──────────────────────────────────────────────────────────
console.log('\n── 产物形状 ──')
const code = readFileSync(clientPath, 'utf8')

check('是 __ModuleLoader__.load 信封', /window\.__ModuleLoader__\.load\(\{/.test(code))
check('id 就是包名本身', code.includes(`id: ${JSON.stringify(pkg.name)}`))
check('factory 接收 require 参数', /factory:\s*\(require\)\s*=>/.test(code))
check('结尾 return module.exports', /return module\.exports;/.test(code))

/** DSH 前端预置的模块表（与 build-client.ts 同一份，改动前先核对前端产物）。 */
const PLATFORM_SEED = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]

const specifiers = [...new Set([...code.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]!))].sort()
const impure = specifiers.filter((s) => !PLATFORM_SEED.includes(s))
check(
  '★ 只 require 模块表里有的模块（越界会在浏览器里抛错）',
  impure.length === 0,
  impure.length > 0 ? `越界：${impure.join(', ')}` : '',
)
check(
  '没有走 JSX 开发版转换（react/jsx-dev-runtime）',
  !specifiers.includes('react/jsx-dev-runtime'),
  `实际：${specifiers.join(', ') || '(无)'}`,
)

// ── ③ 宿主半与浏览器半的路由路径必须一致 ────────────────────────────────
console.log('\n── 双半一致性 ──')
const hostExport = pkg.exports['.'] as { default: string }
const host = (await import(join(pkgDir, hostExport.default))) as {
  UI_STATS_PATH?: string
  UI_CONFIG_PATH?: string
  UI_DEFAULT_POSITION?: string
}
check('宿主半导出了 UI_STATS_PATH', typeof host.UI_STATS_PATH === 'string', String(host.UI_STATS_PATH))
check(
  '★ 浏览器半里的取数字面量与宿主半一致（不一致 = 面板永远 404）',
  typeof host.UI_STATS_PATH === 'string' && code.includes(JSON.stringify(host.UI_STATS_PATH)),
  `宿主 = ${String(host.UI_STATS_PATH)}`,
)
// ★ 位置通道同理：两边各写一个字面量，面板会静默地停在默认位置上
check('宿主半导出了 UI_CONFIG_PATH', typeof host.UI_CONFIG_PATH === 'string', String(host.UI_CONFIG_PATH))
check(
  '★ 浏览器半里的配置路由字面量与宿主半一致（不一致 = 位置配置永远不生效）',
  typeof host.UI_CONFIG_PATH === 'string' && code.includes(JSON.stringify(host.UI_CONFIG_PATH)),
  `宿主 = ${String(host.UI_CONFIG_PATH)}`,
)

// ── ④ 真的执行一遍 ──────────────────────────────────────────────────────
console.log('\n── 执行产物（假 loader + 严格 require）──')

interface LoaderEntry {
  id: string
  factory: (require: (spec: string) => unknown) => unknown
}

let entry: LoaderEntry | undefined
const g = globalThis as unknown as Record<string, unknown>
g['window'] = g
g['__ModuleLoader__'] = {
  load(registered: LoaderEntry) {
    entry = registered
  },
}

// 极简假 document：只够 installStyles 用，用来验证「样式真的被插进去了」
const styles: { dataset: Record<string, string>; textContent: string; removed: boolean }[] = []
const fakeDocument = {
  querySelector: (selector: string) => {
    const id = /data-plugin-css="([^"]+)"/.exec(selector)?.[1]
    return styles.find((s) => s.dataset['pluginCss'] === id) ?? null
  },
  createElement: () => {
    const tag = { dataset: {} as Record<string, string>, textContent: '', removed: false, remove() { this.removed = true } }
    return tag
  },
  head: { appendChild: (tag: (typeof styles)[number]) => styles.push(tag) },
}
g['document'] = fakeDocument

try {
  new Function(code)()
} catch (err) {
  check('产物能被浏览器语义执行', false, err instanceof Error ? err.stack : String(err))
}

check('注册到了 __ModuleLoader__', entry !== undefined)
check('注册 id 与包名一致', entry?.id === pkg.name, String(entry?.id))

const required: string[] = []
const requiredButMissing: string[] = []
const mod = entry?.factory((spec: string) => {
  required.push(spec)
  if (!PLATFORM_SEED.includes(spec)) {
    requiredButMissing.push(spec)
    throw new Error(`模块表里没有 ${spec}`)
  }
  // 日历在模块初始化时创建 context；使用真 React 才能验证组件库的装载兼容性。
  if (spec === 'react') return React
  if (spec === 'react-dom') return ReactDOM
  if (spec === 'react/jsx-runtime') return JSXRuntime
  return {}
}) as {
  apply?: unknown
  inject?: unknown
  DOCK_SLOT?: string
  HEADER_SLOT?: string
} | undefined

check('factory 返回了模块对象', mod !== undefined)
check('导出 apply()', typeof mod?.apply === 'function')
check('导出 inject（服务名列表）', Array.isArray(mod?.inject))
check(
  'inject 里是服务名 slots，不是包名',
  Array.isArray(mod?.inject) && (mod.inject as string[]).includes('slots'),
  JSON.stringify(mod?.inject),
)
check('require 只用了模块表内的模块', requiredButMissing.length === 0, requiredButMissing.join(', '))

// slot 名字写错是**静默失效**（`slots.inject()` 永不回调），所以产物本身也要钉住这两个字面量
check(
  '★ 产物导出的两个 slot 名与 DSH 的 SlotMap 声明逐字相符',
  mod?.DOCK_SLOT === 'conversation.input.dock' &&
    mod?.HEADER_SLOT === 'conversation.session.header.utilities',
  `${String(mod?.DOCK_SLOT)} / ${String(mod?.HEADER_SLOT)}`,
)

// ── ⑤ 装配（假客户端 ctx）──────────────────────────────────────────────
console.log('\n── apply()（假客户端 ctx）──')

interface Recorded {
  slot: string
  order?: number
  id?: string
  face: () => Record<string, unknown>
}

function fakeSlots(recorded: Recorded[]): unknown {
  return {
    inject(_name: string, callback: () => unknown) {
      callback()
      return () => {}
    },
    register(
      options: { name: string; order?: number; id?: string; inject?: () => Record<string, unknown> },
      _component: unknown,
    ) {
      recorded.push({
        slot: options.name,
        ...(options.order !== undefined ? { order: options.order } : {}),
        ...(options.id !== undefined ? { id: options.id } : {}),
        face: options.inject ?? (() => ({})),
      })
      return () => {}
    },
  }
}

/**
 * 假配置通道：位置来自宿主半的 `GET /api/tokenReport.config`。
 *
 * ★ 这一步必须**注入** fetch：产物里的 `apply()` 拿不到插件 config
 *   （DSH 的客户端条目只带 name），位置只能问这条路由。
 *   不注入就会去请求一个相对 URL，验的就成了「网络失败时的回退」。
 */
function configFetch(position: string | 'fail', urls: string[] = []) {
  return async (input: string): Promise<{ ok: boolean; status: number; json(): Promise<unknown> }> => {
    urls.push(input)
    if (position === 'fail') throw new Error('Failed to fetch')
    return { ok: true, status: 200, json: async () => ({ position }) }
  }
}

/** 用给定位置装配一次，返回注册结果、告警与 config 被请求到的地址。 */
async function mount(position: string | 'fail'): Promise<{
  recorded: Recorded[]
  warnings: string[]
  urls: string[]
}> {
  const recorded: Recorded[] = []
  const warnings: string[] = []
  const urls: string[] = []
  try {
    await (mod?.apply as (ctx: unknown, deps: unknown) => Promise<void>)(
      { slots: fakeSlots(recorded), logger: { info: () => {}, warn: (m: string) => warnings.push(m) } },
      { fetch: configFetch(position, urls) },
    )
  } catch (err) {
    check('apply() 不抛错', false, err instanceof Error ? err.stack : String(err))
  }
  return { recorded, warnings, urls }
}

const slotsOf = (recorded: Recorded[]): string => recorded.map((r) => r.slot).join(', ')

// ① 默认位置：宿主说 dock 就只挂用量条
const dock = await mount('dock')
check(
  '★ 位置 = dock：只注册 conversation.input.dock（0.3.0 起的默认）',
  dock.recorded.length === 1 && dock.recorded[0]?.slot === 'conversation.input.dock',
  slotsOf(dock.recorded),
)
check(
  '取位置的地址就是宿主半声明的那条路由',
  dock.urls.length === 1 && dock.urls[0] === host.UI_CONFIG_PATH,
  dock.urls.join(', '),
)
check('两个挂载点都带格子 id', dock.recorded.every((r) => r.id === 'token-report'))

// ② 右上角：只挂标题栏胶囊
const header = await mount('header')
check(
  '位置 = header：只注册 conversation.session.header.utilities（右上角）',
  header.recorded.length === 1 && header.recorded[0]?.slot === 'conversation.session.header.utilities',
  slotsOf(header.recorded),
)

// ③ 兼容外观：两个都挂，且共用同一个 store
const both = await mount('both')
check(
  '位置 = both：两个挂载点都注册（等价于 0.2.0 的外观）',
  both.recorded.length === 2 &&
    both.recorded[0]?.slot === 'conversation.input.dock' &&
    both.recorded[1]?.slot === 'conversation.session.header.utilities',
  slotsOf(both.recorded),
)
const stores = both.recorded.map((r) => r.face()['usage'])
check(
  '★ 两个面板共用同一个 store（取数只做一次）',
  stores.length === 2 && stores[0] === stores[1] && stores[0] !== undefined,
)

// ④ 取不到位置也要照常挂载 —— 这是最难排查的一类故障
const failed = await mount('fail')
check(
  '★ 取位置失败（旧宿主 / 网络）→ 回退默认位置，但面板照常挂载',
  failed.recorded.length === 1 && failed.recorded[0]?.slot === 'conversation.input.dock',
  slotsOf(failed.recorded),
)
check(
  '回退时打一条能指着动作的 warn',
  failed.warnings.some((w) => w.includes('读取面板位置失败')),
  failed.warnings.join(' | '),
)

// ⑤ 样式注入 + 幂等（HMR 会重新执行工厂函数）
check('插入了 <style> 标签', styles.length === 1, `实际 ${styles.length} 个`)
check(
  '样式里用的是 DSH 主题变量（不是写死的颜色）',
  styles[0]?.textContent.includes('--dsw-alias-') === true,
)
await mount('dock')
check('重复装配不重复插样式（HMR 会重新执行工厂）', styles.length === 1, `实际 ${styles.length} 个`)

console.log('\n' + '='.repeat(72))
if (failures === 0) console.log(`✅ 全部通过：${checks} 项断言`)
else console.log(`❌ ${failures} / ${checks} 项断言失败`)
console.log('='.repeat(72))
if (failures > 0) process.exitCode = 1
