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
import { readFile } from 'node:fs/promises'

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

  // —— ★ 模板层：「缺失的会话日志根」那一行**刻意不渲染** ——
  //   为什么读源码而不是渲染：SSR 停在 loading 壳，渲染不到统计页（见文件头）。
  //   这条守的是「别把它当成漏渲染补回去」：来源缺省是全部已注册来源，
  //   没装 Trae CN / Codex 这类「本来就没有」的根每次都会命中，页面上只剩噪音。
  //   ⚠️ 只扫 `<template>` 段 —— 组件脚本里那段「为什么刻意不渲染」的注释
  //   必然写着这些字，扫全文会把它自己判成失败。
  const viewSource = await readFile(new URL('../src/views/UsageStatsView.vue', import.meta.url), 'utf8')
  const viewTemplate = viewSource.slice(
    viewSource.indexOf('<template>'),
    viewSource.indexOf('</template>'),
  )
  check(
    '统计页模板里没有「会话日志根不存在」告警（刻意去掉的，不是漏渲染）',
    viewTemplate.length > 0 && !viewTemplate.includes('不存在') && !viewTemplate.includes('missingRoots'),
  )

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
  /** 渲染一次明细表（`rows` 决定费用列出不出现，`extra` 补 loading / busy 这类状态）。 */
  async function renderTable(rows: unknown[], extra: Record<string, unknown> = {}): Promise<string> {
    return renderToString(
      createSSRApp({
        render: () =>
          h(UsageDetailTable, { rows, groupBy: 'model', totalTokens: 110, ...extra }),
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

  // —— ★ 换一批行时不许塌陷（模板层；编排那一半见 `verify-loading.ts`） ——
  //   点分组维度页签 / 换时间窗时旧行仍然有效：表格必须**留在原地**（淡化 + 表头「更新中…」），
  //   而不是清空成一行「正在扫描本机日志…」—— 那会让表格从 N 行塌成 1 行，
  //   整页高度跟着一收一放，正是使用者看到的「点一下闪一下」。
  const busyHtml = await renderTable([{ ...baseRow, key: 'a' }], { loading: false, busy: true })
  check('★ 有行时即便在取数也不塌成占位行', !busyHtml.includes('正在扫描本机日志') && busyHtml.includes('a</td>'))
  check('换行期间表头写明「更新中…」', busyHtml.includes('更新中'))
  check('换行期间表格走淡化而不是清空', busyHtml.includes('is-refreshing'))

  const firstPaintHtml = await renderTable([], { loading: true })
  check('首屏（一行数据都没有）才用占位行', firstPaintHtml.includes('正在扫描本机日志'))

  const emptyBusyHtml = await renderTable([], { loading: false, busy: true })
  check(
    '上一次结果为空、正在换维度时说「正在扫描」而不是「暂无数据」',
    emptyBusyHtml.includes('正在扫描本机日志') && !emptyBusyHtml.includes('暂无用量数据'),
  )

  const emptyHtml = await renderTable([], { loading: false, busy: false })
  check('查完了确实没有用量才说「暂无用量数据」', emptyHtml.includes('暂无用量数据'))

  // —— ★ 「配置」弹框：只有服务端地址与 appKey 两栏 ——
  //   为什么单独渲染它：SSR 停在 loading 壳，整棵 App 树渲染不到弹框（见上）。
  //   而这一版最容易悄悄退回旧形态（姓名 / Key / 分组三栏、整页替换）——
  //   所以逐项断言「该有的在、不该有的不在」。
  const { default: IdentityGate } = await server.ssrLoadModule(
    '/src/components/identity/IdentityGate.vue',
  )
  const gateHtml: string = await renderToString(
    createSSRApp({
      render: () =>
        h(IdentityGate, {
          settings: true,
          initialBaseUrl: 'http://127.0.0.1:8787',
          signedName: '朱俊',
          signedGroup: '数学建模中心开发',
        }),
    }),
  )
  check('配置弹框是 dialog（不是整页替换）', gateHtml.includes('role="dialog"') && gateHtml.includes('aria-modal="true"'))
  check('配置弹框有「服务端地址」栏', gateHtml.includes('服务端地址'))
  check('配置弹框有「appKey」栏', gateHtml.includes('appKey'))
  check('地址栏回填生效地址', gateHtml.includes('http://127.0.0.1:8787'))
  check('★ 不再有「姓名」输入栏（服务端按 appKey 解析）', !gateHtml.includes('姓名<') && !gateHtml.includes('placeholder="例如：张三"'))
  check('★ 不再有「分组」输入栏（同上）', !gateHtml.includes('分组<') && !gateHtml.includes('placeholder="例如：研发一部"'))
  check(
    '★ 已署名时把服务端认定的姓名与分组显示成**只读**文案',
    gateHtml.includes('当前署名') && gateHtml.includes('朱俊 · 数学建模中心开发'),
  )
  check('保留「数据与隐私」三条承诺', gateHtml.includes('数据与隐私') && gateHtml.includes('不采集对话内容'))
  check('appKey 输入框是密码型（不回显）', gateHtml.includes('type="password"'))

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