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
import { createSSRApp, h } from 'vue'
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

  // —— ★ 引导外壳里绝不能出现金额 ——
  // v7 起统计页**会**显示「费用（估算）」，但有两个前提：服务可达 + 拿到了 cost 字段。
  // 这里渲染的是「正在检查署名状态」的 loading 壳，两者都不满足，
  // 所以「一位金额都不显示」仍然是对的断言 ——
  // 而且它守的正是「没有数据来源时不许拿 ¥0.00 顶上去」这件事。
  // （有金额时的显示断言见 `verify-data.ts` 的金额三态。）
  check('不含「消费金额」（mock 时代的假金额）', !html.includes('消费金额'))
  check('不含 CNY', !html.includes('CNY'))
  check('不含 ¥', !html.includes('¥'))
  check('含「费用（估算）」也需要数据，loading 壳里不许出现', !html.includes('费用（估算）'))
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
  check('有费用口径说明且点明「估算」与「未计价」不是 0', 
    typeof METRIC_HINTS.cost === 'string' &&
      METRIC_HINTS.cost.includes('估算') &&
      METRIC_HINTS.cost.includes('未计价'))

  // —— ★ 明细表的费用列（模板层：`verify-data.ts` 只验到视图模型，验不到模板） ——
  //   模板里的列集合是**动态**的（`columns` computed），这类改动最容易出现
  //   「逻辑对了但模板还引用旧的列数组」——只跑视图模型断言看不出来。
  const { default: UsageDetailTable } = await server.ssrLoadModule(
    '/src/components/usage/UsageDetailTable.vue',
  )
  const costTotals = {
    costs: [{ currency: 'CNY', amountMicro: 12_345_678, tokens: 100 }],
    pricedTokens: 100,
    unpricedTokens: 0,
    totalTokens: 100,
    pricedRate: 1,
    unpricedRate: 0,
    pricing: { pricingSource: 'snapshot', pricingSyncedAt: 1 },
  }
  const baseRow = {
    totalTokens: 100,
    inputTokens: 1,
    outputTokens: 1,
    cacheReadTokens: 98,
    cacheWriteTokens: 0,
    calls: 1,
    cacheHitRate: 0.5,
  }
  /** 渲染一次明细表（`rows` 决定费用列出不出现）。 */
  async function renderTable(rows: unknown[]): Promise<string> {
    return renderToString(
      createSSRApp({
        render: () =>
          h(UsageDetailTable, { rows, groupBy: 'model', totalTokens: 110 }),
      }),
    )
  }

  const costHtml = await renderTable([
    { ...baseRow, key: 'a', cost: costTotals },
    // 未计价的行：必须有「未计价」，**不能**是 ¥0.00
    { ...baseRow, key: 'b', cost: { ...costTotals, costs: [], unpricedTokens: 100, unpricedRate: 1 } },
  ])
  check('明细表有费用列表头', costHtml.includes('费用（估算）'))
  check('有金额的行显示货币金额', costHtml.includes('¥12.35'))
  check('未计价的行写「未计价」而不是 ¥0', costHtml.includes('未计价'))

  const noCostHtml = await renderTable([{ ...baseRow, key: 'a' }])
  check('服务端没下发 cost 时费用列整列不出现', !noCostHtml.includes('费用（估算）'))

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