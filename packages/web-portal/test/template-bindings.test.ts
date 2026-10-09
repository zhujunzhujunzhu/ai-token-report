/**
 * 模板里引用的标识符（函数 / 常量 / 工具）**必须真的绑定在 `<script setup>` 里**。
 *
 * ## 为什么需要这条断言（真实事故）
 *
 * 2026-10-08：`components/DiagnosticsPanel.vue` 的模板里用了 `formatCount(...)`
 * 共三处（采集来源表的「事件数」「会话数」、署名覆盖表的「事件数」），
 * 而顶部那行 `import` 里只有 `formatCompact / formatFullDateTime / formatTimeGap`
 * —— 漏了 `formatCount`。
 *
 * 漏 import 的后果**不是编译失败，而是少一格 `<td>`**：模板里没绑定的标识符会被
 * 编译成 `_ctx.formatCount`，运行时是 `undefined`，于是这一格的渲染函数抛
 * `TypeError`。Element Plus 的每个单元格都是一个独立的 `td-wrapper` 子组件，
 * 错误被**那一格**的渲染吞掉（生产构建里 Vue 不重抛），结果：
 * 那个 `<td>` 根本没进 DOM，**同一行剩下的单元格整体左移一格** ——
 * 「计费总量」的数字跑到「事件数」表头下、时间戳跑到「计费总量」表头下、
 * 新鲜度标签跑到中间，而每行下方的分隔线也在第四列就断了。
 * 页面看着「只是样式有点怪」，实际是两列数据被丢掉了。
 *
 * ## 为什么 typecheck 与 verify-render 都拦不住
 *
 * - `vue-tsc` 默认 `strictTemplates: false`（本仓没开），模板里**没定义的标识符
 *   不报错**；`bun run typecheck` 因此是绿的。
 * - `verify/verify-render.ts` 收集的是「组件没解析出来」（`Failed to resolve
 *   component`），与函数名漏 import 是两回事；而且它走 SSR，**渲染不到 el-table 的
 *   tbody**（列在 `onMounted` 才注册），那条路径连 `<td>` 都不存在，
 *   自然也不会抛异常。
 *
 * ## 判据为什么用编译器而不是正则扫模板
 *
 * 正则扫 `{{ ... }}` 分不清「模板里的局部变量」（`v-for` / 插槽解构）与「外部绑定」，
 * 必然误报。这里直接按**生产构建的同一模式**（`inlineTemplate`）编译 SFC：
 * 解析不了的标识符一律落成 `_ctx.xxx`，而 `<script setup>` 里的绑定不会 ——
 * 于是「渲染函数里出现 `_ctx.名字`」就是「模板用了没有的东西」的准确判据。
 *
 * ⚠️ 两个边界都写在断言里，别当成漏检：
 *   1. 只查有 `<script setup>` 的 SFC —— 普通 `<script>` 组件的模板本来就走
 *      `_ctx`（那是它自己的 options），查了必然误报。
 *   2. 只报 `$` 开头的名字**之外**的标识符：Vue 的公开实例属性（`$slots` 等）
 *      合法地落在 `_ctx` 上，而漏 import 的永远是普通标识符。
 */
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { compileScript, parse } from 'vue/compiler-sfc'

const SRC_DIR = join(import.meta.dir, '..', 'src')

function vueFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) vueFiles(path, out)
    else if (name.endsWith('.vue')) out.push(path)
  }
  return out
}

/** 模板里解析不到、落到 `_ctx` 上的普通标识符（`$` 开头的公开实例属性不算）。 */
function unboundNamesOf(file: string): string[] {
  const { descriptor, errors } = parse(readFileSync(file, 'utf8'), { filename: file })
  if (errors.length > 0) return [`SFC 解析失败：${errors[0]?.message ?? '未知原因'}`]
  if (!descriptor.scriptSetup) return []
  const { content } = compileScript(descriptor, { id: file, inlineTemplate: true })
  const names = new Set<string>()
  for (const match of content.matchAll(/_ctx\.([A-Za-z_$][\w$]*)/g)) {
    const name = match[1]!
    if (!name.startsWith('$')) names.add(name)
  }
  return [...names]
}

const files = vueFiles(SRC_DIR)

describe('模板绑定', () => {
  test('确实扫到了本包的 SFC（否则这组断言会空过）', () => {
    expect(files.length).toBeGreaterThan(20)
  })
  for (const file of files) {
    test(`${relative(SRC_DIR, file)} 的模板标识符都有绑定`, () => {
      expect(unboundNamesOf(file)).toEqual([])
    })
  }
})