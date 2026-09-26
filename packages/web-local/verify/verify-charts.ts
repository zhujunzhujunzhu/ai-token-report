/**
 * 图表几何校验：从真实 SSR 渲染结果中提取 SVG 的 rect / path，
 * 断言柱子数量、颜色分层、面积路径确实生成了，而不只是「有个 svg 标签」。
 */
import { renderChartFixture } from './chart-fixture.js'

const failures: string[] = []
function check(label: string, condition: boolean): void {
  if (!condition) failures.push(label)
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}`)
}

{
  const html = await renderChartFixture(true)

  const rects = [...html.matchAll(/<rect[^>]*>/g)].map((m) => m[0])
  const paths = [...html.matchAll(/<path[^>]*d="([^"]*)"/g)].map((m) => m[1]!)

  console.log(`rect 数量: ${rects.length}`)
  console.log(`path 数量: ${paths.length}`)
  console.log(`非空 path: ${paths.filter((d) => d.length > 0).length}`)

  check('堆叠柱生成了 rect', rects.length > 5)
  check('面积图生成了非空 path', paths.some((d) => d.length > 20))
  check('柱形使用了 3 种模型配色', ['--c-series-chat', '--c-series-reasoner', '--c-series-coder'].every((c) => html.includes(c)))
  check('面积图填充色已应用', html.includes('--c-chart-area-fill'))
  check('Tokens 柱使用浅蓝配色', html.includes('--c-chart-bar-light'))

  // 面积路径应包含贝塞尔曲线，说明用了平滑处理
  const smooth = paths.find((d) => d.includes('C') && d.length > 50)
  check('面积路径使用三次贝塞尔平滑', Boolean(smooth))

  console.log('')
  if (failures.length > 0) {
    console.error(`共 ${failures.length} 项失败: ${failures.join(', ')}`)
    process.exitCode = 1
  } else {
    console.log('图表几何断言全部通过。')
  }
}
