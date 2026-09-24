/**
 * 一次性验证脚本：走 Vite 的 SSR 管线真实执行整棵组件树，
 * 断言关键文案，避免只靠「模块能编译」这种弱验证。
 *
 * 运行： bun run verify/verify-render.ts
 *
 * ⚠️ SSR 环境没有本地服务，`fetch('/api/local/*')` 必然失败，
 *   因此这里断言的是**外壳与筛选栏**，而不是卡片数值
 *   （数值断言见 `verify-data.ts`，那里直接喂样本数据给视图模型）。
 *   服务未达时页面本就应该显示错误提示而不是白屏 —— 这也在断言之列。
 */
import { createServer } from 'vite'
import { createSSRApp } from 'vue'
import { renderToString } from 'vue/server-renderer'

const server = await createServer({
  root: process.cwd(),
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'error',
  // 关闭依赖预构建，避免与 dev server 争抢临时目录句柄
  optimizeDeps: { noDiscovery: true },
})

try {
  const { default: App } = await server.ssrLoadModule('/src/App.vue')
  const html: string = await renderToString(createSSRApp(App))

  /** 断言 helper：全部通过则静默，失败计入清单 */
  const failures: string[] = []

  function check(label: string, condition: boolean): void {
    if (!condition) {
      failures.push(label)
    }
    console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}`)
  }

  // —— 引导外壳 ——
  // SSR 下 useIdentity 的 onMounted 不执行，因此停在 loading 态。
  // 这本身是对的：没有服务可达之前不该展示引导页或统计页。
  check('服务未确认前显示「正在检查署名状态…」', html.includes('正在检查署名状态'))

  // —— ★ 绝不能出现金额 ——
  check('不含「消费金额」', !html.includes('消费金额'))
  check('不含 CNY', !html.includes('CNY'))
  check('不含 ¥', !html.includes('¥'))
  check('不含「充值余额」', !html.includes('充值余额'))
  check('不含「累计消费金额」', !html.includes('累计消费金额'))
  check('不含「去充值」', !html.includes('去充值'))

  // —— ★ 旧的 mock 概念必须消失 ——
  check('不含「API Key」筛选项', !html.includes('API Key'))
  check('不含 mock 模型名 deepseek-chat', !html.includes('deepseek-chat'))
  check('不含 mock 模型名 deepseek-reasoner', !html.includes('deepseek-reasoner'))
  check('不含 mock 模型名 deepseek-coder', !html.includes('deepseek-coder'))
  check('不含 mock 分组标题 deepseek-flash', !html.includes('deepseek-flash'))
  check('不含 mock 数值 80,642,909', !html.includes('80,642,909'))
  check('不含 mock 数值 4.56', !html.includes('4.56'))

  // —— 口径说明文案必须存在 ——
  // 由视图模型集中定义，页面渲染统计页时才会出现（SSR 停在 loading 态）。
  const { METRIC_HINTS, CHART_HINTS } = await server.ssrLoadModule(
    '/src/composables/usage-view-model.ts',
  )
  check('有「计费总量」口径说明', typeof METRIC_HINTS.total === 'string' && METRIC_HINTS.total.length > 0)
  check(
    '缓存命中率说明点明分母不是 input',
    typeof METRIC_HINTS.cacheHitRate === 'string' &&
      METRIC_HINTS.cacheHitRate.includes('未缓存输入'),
  )
  check('有图表口径说明', typeof CHART_HINTS.tokens === 'string' && CHART_HINTS.tokens.length > 0)

  console.log('')
  if (failures.length > 0) {
    console.error(`共 ${failures.length} 项断言失败：`)
    for (const failure of failures) {
      console.error(`  - ${failure}`)
    }
    process.exitCode = 1
  } else {
    console.log('全部断言通过。')
  }
} finally {
  await server.close()
}