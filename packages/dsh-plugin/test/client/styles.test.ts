/**
 * 明细表的**列轨道**一致性（样式层）。
 *
 * ## 为什么这条值得一个测试
 *
 * 「带金额时明细表多一列」这件事，在 CSS 里**只由书写顺序决定**：
 * `.atr-row` 与 `.atr-row-cost` 的特异性完全相同（都只有一个类选择器），
 * 所以后出现的那条 `grid-template-columns` 赢。而 `styles.ts` 里
 * `.atr-row{grid-template-columns:…}` 出现了**三次**（紧凑层 / 对话层 / 窄屏层），
 * 每一次都必须紧跟一条列数 +1 的 `.atr-row-cost`。
 *
 * 实测漏掉对话层那次配对（4 条轨道盖掉了上一层的 5 条）的表现是：
 * 表头的「费用（估算）」与每行金额被挤到**第二行**、缩在「明细」那一列下面 ——
 * 看着像整张表错位，而不是「少了一列」。它**不会报错**，只是静默画错，
 * 而且单测（渲染出 HTML 的那些）完全看不见它，因为 HTML 里的类名是对的。
 *
 * 所以这里不比对字符串是否相等，而是**按 CSS 的层叠规则重演一遍**：
 * 每一处 `.atr-row` 都必须在同一作用域里有一条更晚的、列数正好 +1 的
 * `.atr-row-cost`。
 */

import { readFileSync } from 'node:fs'

import { describe, expect, test } from 'bun:test'

/**
 * 直接读源码文本而不是 `import { CSS }`：
 * `styles.ts` 顶部有一句 `import … from 'react-day-picker/style.css' with { type: 'text' }`，
 * 那条 text 导入只有 `bun build` 会用到；这里只关心轨道配对，
 * 没必要把整条依赖链（react-day-picker 的 CSS 产物）拉进单测。
 * 日历那一份 CSS 的类名是 `.atr-rdp-*`，与 `.atr-row` 无关。
 */
const STYLES_SOURCE = readFileSync(new URL('../../src/client/styles.ts', import.meta.url), 'utf8')

const ROW = '.atr-row'
const ROW_COST = '.atr-row-cost'

interface Rule {
  /** 选择器原文（未拆分选择器列表） */
  selector: string
  /** `grid-template-columns` 的值；没写这条声明就是 `null` */
  columns: string | null
  /** 所在作用域：`''` = 顶层，否则是 `@media …` 的条件原文 */
  scope: string
}

/**
 * 极简 CSS 扫描：只认「选择器 { 声明 }」与一层 `@media` / `@keyframes` 包裹。
 * 够本文件的形态，**不打算当通用解析器**（真要解析 CSS 就该引依赖，
 * 而本仓不为一个小工具引依赖）。
 */
function scanRules(source: string): Rule[] {
  const text = source.replace(/\/\*[\s\S]*?\*\//g, '')
  const rules: Rule[] = []
  const stack: string[] = []
  let buffer = ''
  let index = 0

  while (index < text.length) {
    const char = text[index]!
    if (char === '{') {
      const head = buffer.trim()
      buffer = ''
      if (head.startsWith('@')) {
        stack.push(head)
        index += 1
        continue
      }
      const end = text.indexOf('}', index)
      const body = text.slice(index + 1, end === -1 ? text.length : end)
      rules.push({ selector: head, columns: columnsOf(body), scope: stack.join(' | ') })
      index = (end === -1 ? text.length : end) + 1
      continue
    }
    if (char === '}') {
      stack.pop()
      buffer = ''
      index += 1
      continue
    }
    buffer += char
    index += 1
  }

  return rules
}

function columnsOf(body: string): string | null {
  const match = /(?:^|;)\s*grid-template-columns\s*:\s*([^;]+)/.exec(body)
  return match === null ? null : match[1]!.trim()
}

/** 轨道条数：先把 `minmax(…)` / `repeat(…)` 折成一个记号，再按空白切开。 */
function trackCount(columns: string): number {
  return columns.replace(/\([^()]*\)/g, 'X').trim().split(/\s+/).length
}

describe('明细表列轨道', () => {
  test('每一处 .atr-row 的轨道都被更晚的 .atr-row-cost 补上一列', () => {
    const rules = scanRules(STYLES_SOURCE)
    const scopes = [...new Set(rules.map((rule) => rule.scope))]
    const problems: string[] = []

    for (const scope of scopes) {
      const list = rules.filter((rule) => rule.scope === scope)
      for (const [index, rule] of list.entries()) {
        if (rule.selector !== ROW) continue
        const columns = rule.columns
        if (columns === null) continue
        const where = `${scope === '' ? '顶层' : scope} 的第 ${index + 1} 条规则`
        const pair = list
          .slice(index + 1)
          .find((candidate) => candidate.selector === ROW_COST && candidate.columns !== null)
        if (pair === undefined) {
          problems.push(`${where}（${columns}）之后没有配对的 ${ROW_COST}`)
          continue
        }
        const expected = trackCount(columns) + 1
        const actual = trackCount(pair.columns!)
        if (actual !== expected) {
          problems.push(
            `${where}：${ROW} 有 ${trackCount(columns)} 条轨道，`
            + `配对的 ${ROW_COST} 却是 ${actual} 条（应为 ${expected} 条）`,
          )
        }
      }
    }

    // 报出人看得懂的原因，而不是一句「expect 5 to be 4」
    expect(problems).toEqual([])
  })

  test('对话层（详情弹框）最终生效的是 5 条轨道，且金额列排在最后', () => {
    const top = scanRules(STYLES_SOURCE).filter((rule) => rule.scope === '')
    const row = [...top].reverse().find((rule) => rule.selector === ROW && rule.columns !== null)
    const cost = [...top].reverse().find((rule) => rule.selector === ROW_COST && rule.columns !== null)

    expect(row).toBeDefined()
    expect(cost).toBeDefined()
    // 5 列 = 明细 / Token 总量 / 命中率 / 调用数 / 费用（估算），与 UsageDetail 的 5 个 span 对齐
    expect(trackCount(row!.columns!)).toBe(4)
    expect(trackCount(cost!.columns!)).toBe(5)
    // ★ 这条就是本测试的全部意义：带金额那条必须**晚于**不带金额那条，否则会被它盖掉
    expect(top.indexOf(cost!)).toBeGreaterThan(top.indexOf(row!))
  })

  test('窄屏（≤700px）那层也配了 5 条轨道', () => {
    const rules = scanRules(STYLES_SOURCE)
    const narrow = rules.find((rule) => rule.scope.startsWith('@media(max-width:700px)') && rule.selector === ROW_COST)
    expect(narrow).toBeDefined()
    expect(trackCount(narrow!.columns!)).toBe(5)
  })
})
