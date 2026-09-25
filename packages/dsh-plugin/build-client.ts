/**
 * 构建插件的浏览器半 → `lib/client.js`。
 *
 * ```bash
 * bun run --filter '@ai-token-report/dsh-plugin' build:client
 * ```
 *
 * ## 为什么要一个脚本，而不是一行 `bun build`
 *
 * 因为浏览器半的产物**不是**一个普通 JS 文件，而是一个
 * `window.__ModuleLoader__.load({ id, factory })` 信封：
 *
 * ```js
 * window.__ModuleLoader__.load({
 *   id: "@ai-token-report/dsh-plugin",
 *   factory: (require) => {   // ← 整个 CJS 产物必须在这个函数**里面**
 *     var module = { exports: {} }; var exports = module.exports;
 *     ...bun build 产出的 CJS...
 *     return module.exports;
 *   }
 * });
 * ```
 *
 * 用 `bun build` 的 `--banner` / `--footer` 也能拼，但那段 banner 里有引号、
 * 花括号、箭头函数与换行 —— 塞进 `package.json` 的脚本里再经一层 shell
 * 转义，在 Windows 上非常容易坏，而且坏了是「产物语法错」这种难查的症状。
 * 走 `Bun.build` 的 JS API 最直白，顺便还能在构建期做下面那道校验。
 *
 * ## 🚨 平台模块纯度校验（本脚本存在的主要理由）
 *
 * DSH 前端只预置**固定 9 个**模块（`PLATFORM_SEED`，取自
 * `dsh-web-frontend/dist/assets/index-*.js` 里的静态模块表）。浏览器半的
 * `require()` 只能命中这张表 —— 命中不了会在**物化阶段**抛错，
 * 而报错发生在浏览器里、DSH 侧只表现为「插件没起来」。
 *
 * 最阴的一种失败是 JSX：bun 在**没有 `jsx` 配置**时默认走
 * `react/jsx-dev-runtime`（开发版转换），而那张表里**只有**
 * `react/jsx-runtime`。产物看着完全正常，运行时必炸。
 * 所以这里不只看「有没有 require」，而是逐个断言都在表内。
 */

import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 插件在 DSH 客户端模块图里的 id。用**包名本身**。 */
const CLIENT_ID = '@ai-token-report/dsh-plugin'

/**
 * DSH 前端预置的模块表（`PLATFORM_MODULES`）。
 *
 * ⚠️ 这是**宿主版本相关的常量**，不是本仓能决定的。DSH 升级后如果这张表变了，
 *   本脚本会在这里直接失败 —— 那正是我们想要的：宁可在构建期炸，
 *   也不要在用户浏览器里表现为「面板不见了」。
 *   核对方式见 `verify/verify-client-bundle.ts` 里的说明。
 */
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
] as const

const OUT_DIR = join(import.meta.dir, 'lib')
const OUT_FILE = join(OUT_DIR, 'client.js')

/**
 * 找出产物里所有 `require("...")` 的说明符。
 *
 * 故意用正则而不是解析 AST：产物是我们自己一个入口的 CJS，形状可控，
 * 而这道校验的意图就是**粗粒度地兜住意外**，不需要精确到语义。
 */
function requiredSpecifiers(code: string): string[] {
  const found = new Set<string>()
  for (const match of code.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g)) {
    const spec = match[1]
    if (spec !== undefined) found.add(spec)
  }
  return [...found].sort()
}

const result = await Bun.build({
  entrypoints: [join(import.meta.dir, 'src', 'client', 'index.ts')],
  target: 'browser',
  format: 'cjs',
  // 预置模块一律 external：它们由 DSH 的模块表提供，不能打进产物
  // （打进去 = 两份 React，hooks 会因实例不同而直接抛错）
  external: [...PLATFORM_SEED],
  // 图表与日历内联进单文件；生产压缩减少每次宿主物化插件的传输与解析成本。
  minify: true,
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  sourcemap: 'none',
  naming: 'client.js',
})

if (!result.success) {
  for (const log of result.logs) console.error(log)
  throw new Error('浏览器半构建失败')
}

const output = result.outputs[0]
if (output === undefined) throw new Error('浏览器半构建没有产出文件')
const body = await output.text()

// ── 纯度校验 ────────────────────────────────────────────────────────────
const specifiers = requiredSpecifiers(body)
const impure = specifiers.filter((spec) => !(PLATFORM_SEED as readonly string[]).includes(spec))
if (impure.length > 0) {
  throw new Error(
    [
      '浏览器半引用了 DSH 模块表里没有的模块，加载时会直接抛错：',
      ...impure.map((spec) => `  - ${spec}`),
      `模块表内容：${PLATFORM_SEED.join(', ')}`,
      '要引入别的第一方客户端包，请改走 package.json 的 dsh.client.inject/external（模块图依赖）。',
    ].join('\n'),
  )
}
if (specifiers.includes('react/jsx-dev-runtime')) {
  throw new Error(
    '产物用了 JSX 开发版转换（react/jsx-dev-runtime）。' +
      '请确认 tsconfig.json 里有 "jsx": "react-jsx"（bun build 读的是它）。',
  )
}

// ── 包成 __ModuleLoader__ 信封 ──────────────────────────────────────────
const banner = `window.__ModuleLoader__.load({
\tid: ${JSON.stringify(CLIENT_ID)},
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
`
const footer = `
\t\treturn module.exports;
\t}
});
`

const bundle = banner + body + footer

mkdirSync(dirname(OUT_FILE), { recursive: true })
await Bun.write(OUT_FILE, bundle)

console.log(`✅ lib/client.js  ${(bundle.length / 1024).toFixed(1)} KB`)
console.log(`   外部依赖 ${specifiers.length > 0 ? specifiers.join(', ') : '(无)'}`)
