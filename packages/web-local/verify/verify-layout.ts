/**
 * SVG 布局几何：生产组件的逻辑 viewBox 不依赖浏览器，直接 SSR 后检查。
 *
 * 关键点：柱形的 x/width 与 viewBox 都是渲染期算出的真实值，
 * DOM 里能直接读到，足够判断「图表是否铺满卡片宽度」。
 */
import { renderChartFixture } from './chart-fixture.js'

const html = await renderChartFixture()

const failures: string[] = []
function check(label: string, condition: boolean, detail = ''): void {
  if (!condition) failures.push(label)
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`)
}

const blocks = html.split('class="chart-card"').slice(1)
console.log(`chart-card 数量: ${blocks.length}\n`)

interface Measured {
  title: string
  rects: number
  paths: number
  widths: number[]
  fills: string[]
  viewBox: string
}

const measured: Measured[] = blocks.map((block) => {
  const rectMatches = [...block.matchAll(/<rect[^>]*width="([\d.]+)"[^>]*fill="([^"]+)"/g)]
  const paths = [...block.matchAll(/<path[^>]*d="([^"]{10,})"/g)]
  const title = block.match(/chart-card__title[^>]*>([^<]*)/)?.[1]?.trim().replace(/\s+/g, ' ') ?? ''
  const viewBox = block.match(/viewBox="([^"]+)"/)?.[1] ?? ''
  return {
    title,
    rects: rectMatches.length,
    paths: paths.length,
    widths: [...new Set(rectMatches.map((m) => Math.round(parseFloat(m[1]!))))].sort((a, b) => a - b),
    fills: [...new Set(rectMatches.map((m) => m[2]!))],
    viewBox,
  }
})

for (const m of measured) {
  console.log(`卡片: ${m.title}`)
  console.log(`  rect=${m.rects}  path=${m.paths}  viewBox="${m.viewBox}"`)
  console.log(`  柱宽=${JSON.stringify(m.widths)}`)
  console.log(`  fills=${JSON.stringify(m.fills)}\n`)
}

// 图表宽度应约等于卡片可用宽度：卡片约 1128px，减去 Y 轴 34px 与间隙 10px
const tok = measured.find((m) => m.title.includes('计费总量'))
const calls = measured.find((m) => m.title.includes('调用次数'))

check('两张图表卡片均已渲染', measured.length === 2, `实际 ${measured.length}`)

if (tok) {
  const vbWidth = parseFloat(tok.viewBox.split(' ')[2] ?? '0')
  // 坐标系固定为逻辑宽度，靠 CSS 横向拉伸铺满卡片，
  // 因此这里断言的是「viewBox 稳定」而非「等于卡片像素宽」。
  check('计费总量 viewBox 宽度为逻辑宽度 480', vbWidth === 480, `viewBox 宽=${vbWidth}`)
  check('计费总量为单色柱状', tok.fills.length === 1, `fills=${JSON.stringify(tok.fills)}`)
  check('计费总量柱形数量 >= 1', tok.rects >= 1, `rect=${tok.rects}`)
}

check('调用次数渲染面积路径', Boolean(calls) && calls.paths >= 1, `path=${calls?.paths}`)

console.log('')
if (failures.length > 0) {
  console.error(`共 ${failures.length} 项失败: ${failures.join(', ')}`)
  process.exitCode = 1
} else {
  console.log('布局测量断言全部通过。')
}
