/**
 * 真实执行 Vue + Pinia + Router + Element Plus 组件树。
 * 验证登录门禁、角色路由、业务页面、空态与诊断文案；图表另由 verify-charts 验证。
 */
import { createServer } from 'vite'
import { createSSRApp, h, type Component, type Slot } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { createPinia, disposePinia } from 'pinia'
import { createMemoryHistory } from 'vue-router'
import { ID_INJECTION_KEY, ZINDEX_INJECTION_KEY } from 'element-plus'
import type { BreakdownRow, OverviewResponse } from '@ai-token-report/shared'
const server = await createServer({
  root: process.cwd(),
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
})
const failures: string[] = []
function check(label: string, condition: boolean): void {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}`)
  if (!condition) failures.push(label)
}
const pinia = createPinia()
try {
  const { useSessionStore } = await server.ssrLoadModule(
    '/src/stores/session.ts',
  )
  const { useDashboardStore } = await server.ssrLoadModule(
    '/src/stores/dashboard.ts',
  )
  const { useMembersStore } = await server.ssrLoadModule(
    '/src/stores/members.ts',
  )
  const { createPortalRouter, loginDestination } = await server.ssrLoadModule(
    '/src/router/index.ts',
  )
  // SSR 组件库必须注入独立 ID 与层级计数器，避免每个控件产生服务端渲染警告。
  const session = useSessionStore(pinia)
  session.initialized = true
  const router = createPortalRouter(pinia, createMemoryHistory())
  function createRenderApp(component: Component) {
    return createSSRApp(component)
      .use(pinia)
      .use(router)
      .provide(ID_INJECTION_KEY, { prefix: 100, current: 0 })
      .provide(ZINDEX_INJECTION_KEY, { current: 0 })
  }
  async function render(path: string): Promise<string> {
    const { default: component } = await server.ssrLoadModule(path)
    return renderToString(createRenderApp(component))
  }
  await router.push('/records')
  check('未登录访问明细回到登录页', router.currentRoute.value.name === 'login')
  check(
    '保留登录后的回跳页面',
    router.currentRoute.value.query.redirect === '/records',
  )
  check('拒绝外部回跳地址', loginDestination('//example.com') === '/overview')
  const { default: App } = await server.ssrLoadModule('/src/App.vue')
  const loginHtml = await renderToString(createRenderApp(App))
  check('登录页标题', loginHtml.includes('登录管理后台'))
  check('管理员开通提示', loginHtml.includes('管理员开通'))
  check('用户名字段', loginHtml.includes('autocomplete="username"'))
  check(
    '验证码输入和刷新按钮',
    loginHtml.includes('刷新验证码') && loginHtml.includes('name="captcha"'),
  )
  check('凭证使用密码框', loginHtml.includes('type="password"'))
  check('未登录无统计页面', !loginHtml.includes('人员排行'))
  check('未登录无人员数据', !loginHtml.includes('人员列表'))

  const managementPages = [
    { path: '/members', name: 'members', title: '人员管理' },
    { path: '/appkeys', name: 'appkeys', title: 'appKey 管理' },
    { path: '/roles', name: 'roles', title: '角色管理' },
    { path: '/groups', name: 'groups', title: '分组管理' },
    { path: '/providers', name: 'providers', title: '供应商归一化' },
    { path: '/pricing', name: 'pricing', title: '模型单价' },
  ]
  for (const page of managementPages) {
    await router.push(page.path)
    check(`未登录访问${page.title}保留登录回跳`,
      router.currentRoute.value.name === 'login' &&
      router.currentRoute.value.query.redirect === page.path)
    check(`${page.title}允许登录后回跳`, loginDestination(page.path) === page.path)
  }
  check('角色管理回跳保留本站查询参数', loginDestination('/roles?from=login') === '/roles?from=login')

  // 目录查询权限不等于管理入口权限，尤其普通成员自带的分组只读权限。
  const permissionCases = [
    { label: '缺省权限成员', permissions: [], allowed: [] },
    { label: '分组只读成员', permissions: ['groups:read'], allowed: [] },
    // appKey 管理页的主体是凭证列表（含凭证提示与权限范围），读权限按
    // `tokens:manage` 走；人员页与它互不附带，两页各自独立可进。
    { label: '人员查看者', permissions: ['members:read'], allowed: ['members'] },
    { label: '凭证管理者', permissions: ['tokens:manage'], allowed: ['appkeys'] },
    { label: '角色查看者', permissions: ['roles:read'], allowed: ['roles'] },
    { label: '分组管理者', permissions: ['groups:read', 'groups:manage'], allowed: ['groups'] },
    // ★ 归一化改的是「按供应商看用量」的口径，与分组管理**不共用**权限：
    //   能管分组的人不该顺带获得改全平台供应商口径的能力。
    { label: '供应商只读者', permissions: ['providers:read'], allowed: ['providers'] },
    // ★ 单价决定**每一笔费用怎么算**，是配置而不是「看一眼的数字」：
    //   读也要求 `pricing:manage`，所以「能看供应商口径」与「能看/改计价」互不附带。
    { label: '单价管理者', permissions: ['pricing:manage'], allowed: ['pricing'] },
  ]
  for (const entry of permissionCases) {
    session.identity = { name: '测试成员', username: 'member', role: 'member', permissions: entry.permissions }
    session.generation++
    for (const page of managementPages) {
      await router.push(page.path)
      const allowed = entry.allowed.includes(page.name)
      check(`${entry.label}${allowed ? '可进入' : '无法进入'}${page.title}`,
        router.currentRoute.value.name === (allowed ? page.name : 'overview'))
    }
    const layoutHtml = await render('/src/layouts/PortalLayout.vue')
    const navigationHtml = layoutHtml.match(/<aside\b[\s\S]*?<\/aside>/)?.[0] ?? ''
    check(`${entry.label}管理导航遵循各自权限`, !!navigationHtml && managementPages.every((page) =>
      navigationHtml.includes(page.title) === entry.allowed.includes(page.name)))
  }
  session.identity = { member_id: '00000000-0000-4000-8000-000000000001', name: '测试管理员', username: 'admin', role: 'admin', permissions: ['members:read', 'members:manage', 'groups:read', 'groups:manage', 'roles:read', 'roles:assign', 'tokens:manage', 'providers:read', 'providers:manage', 'cost:read', 'pricing:manage'] }
  session.generation++
  for (const page of managementPages) {
    await router.push(page.path)
    check(`管理员可进入${page.title}`, router.currentRoute.value.name === page.name)
    check(`${page.title}使用独立页面标题`, router.currentRoute.value.meta.title === page.title)
  }
  await router.push('/members')
  const layoutHtml = await render('/src/layouts/PortalLayout.vue')
  const navigationHtml = layoutHtml.match(/<aside\b[\s\S]*?<\/aside>/)?.[0] ?? ''
  check('管理导航依次为人员、appKey、角色、分组、供应商、单价六个独立入口',
    navigationHtml.indexOf('人员管理') >= 0 &&
    navigationHtml.indexOf('人员管理') < navigationHtml.indexOf('appKey 管理') &&
    navigationHtml.indexOf('appKey 管理') < navigationHtml.indexOf('角色管理') &&
    navigationHtml.indexOf('角色管理') < navigationHtml.indexOf('分组管理') &&
    navigationHtml.indexOf('分组管理') < navigationHtml.indexOf('供应商归一化') &&
    navigationHtml.indexOf('供应商归一化') < navigationHtml.indexOf('模型单价'))

  const dashboard = useDashboardStore(pinia)
  // ⚠️ 留一份**没有 `cost`** 的花生（fixture）：下面验金额时要临时挂上 `cost`
  //   再渲染一次，验完必须恢复 —— 否则后面那条「统计页不出现 ¥」的断言会被
  //   自己造的数据打成失败，而失败原因看起来像「页面泄漏了金额」。
  const overviewFixture: OverviewResponse = {
    range: { from: null, to: null, label: '最近 7 天（自然日）' },
    totalTokens: 1500,
    inputTokens: 15,
    outputTokens: 2,
    cacheReadTokens: 1483,
    cacheWriteTokens: 0,
    calls: 3,
    sessions: 1,
    cacheHitRate: 0.99,
    avgTokensPerCall: 500,
    unattributedRate: 0.333,
  }
  dashboard.overview = overviewFixture
  dashboard.series = { bucket: 'day', points: [] }
  dashboard.diagnostics = {
    totalEvents: 5,
    unattributedEvents: 1,
    unattributedRate: 0.2,
    identityViolations: 0,
    // 两个人员组、两个历史身份组，另有一条未归属；接口不提供实际成员人数。
    distinctUsers: 4,
    earliestTs: null,
    latestTs: null,
    lastIngestAt: null,
  }
  const dashboardHtml = await render('/src/views/DashboardView.vue')
  for (const label of [
    '计费总量',
    '缓存命中率',
    '调用次数',
    '会话数',
    '平均每次调用',
    '未署名占比',
    '用量趋势',
    '人员排行',
    '分组排行',
  ])
    check(`总览含 ${label}`, dashboardHtml.includes(label))
  check('总览直接展示接口总量', dashboardHtml.includes('1,500'))
  // ★ 趋势图上的两个开关必须真的渲染出来：没有它们，使用者只能看到一条合计线，
  //   而「按用户 / 按模型」这件事在页面上根本无从表达。
  for (const label of ['合计', '按用户', '按模型', 'Token 用量'])
    check(`总览趋势含开关：${label}`, dashboardHtml.includes(label))
  check('总览：没有 cost 字段（无 cost:read）时金额开关不出现',
    dashboardHtml.includes('费用（估算）') === false)
  // ★ 多对多的口径说明必须**真的渲染出来**：它是「各分组之和 > 总量」这一定义
  //   在页面上唯一的解释，少一句就会被当成 bug 去查。
  check('分组排行附多对多口径说明',
    dashboardHtml.includes('一名成员可属于多个分组') &&
    dashboardHtml.includes('同一笔用量会同时计入其所属的每个分组') &&
    dashboardHtml.includes('各分组之和可能大于总量') &&
    dashboardHtml.includes('未分组的成员不计入任何分组行'))
  const modelRow: BreakdownRow = {
    key: 'qa-model-plugin', totalTokens: 14690, inputTokens: 1300,
    outputTokens: 260, cacheReadTokens: 13000, cacheWriteTokens: 130,
    calls: 1, cacheHitRate: 0.91,
  }
  dashboard.breakdown = { by: 'model', rows: [modelRow] }
  const analysisHtml = await render('/src/views/AnalysisView.vue')
  for (const label of [
    '趋势分析',
    '调用次数',
    '用量分布',
    '厂商 / 模型',
    '项目',
  ])
    check(`分析页含 ${label}`, analysisHtml.includes(label))
  // ★ 金额指标同样按「服务端有没有下发 `cost`」出现/消失，三种状态分别钉住。
  check('分析页：趋势点没有金额（无 cost:read）时不出现费用指标',
    analysisHtml.includes('费用（估算）') === false)
  // 分层维度开关在分析页同样必须在（折线图的多条线由它决定）
  for (const label of ['合计', '按用户', '按模型'])
    check(`分析页趋势含分层开关：${label}`, analysisHtml.includes(label))
  const costPoints = [
    {
      bucket: '2026-09-20',
      totalTokens: 100,
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 85,
      calls: 1,
      cacheHitRate: 0.89,
      cost: {
        costs: [{ currency: 'CNY', amountMicro: 1_200 }],
        pricedTokens: 100,
        unpricedTokens: 0,
        totalTokens: 100,
        pricedRate: 1,
        unpricedRate: 0,
        pricing: { pricingSource: 'db' as const, pricingSyncedAt: null },
      },
    },
    {
      bucket: '2026-09-21',
      totalTokens: 200,
      inputTokens: 20,
      outputTokens: 10,
      cacheReadTokens: 170,
      calls: 2,
      cacheHitRate: 0.89,
      cost: {
        costs: [{ currency: 'CNY', amountMicro: 5_000 }],
        pricedTokens: 200,
        unpricedTokens: 0,
        totalTokens: 200,
        pricedRate: 1,
        unpricedRate: 0,
        pricing: { pricingSource: 'db' as const, pricingSyncedAt: null },
      },
    },
  ]
  dashboard.series = { bucket: 'day', points: costPoints }
  const costAnalysisHtml = await render('/src/views/AnalysisView.vue')
  check('分析页：趋势点带金额时出现「费用（估算）」指标（按币种画，不相加）',
    costAnalysisHtml.includes('费用（估算）'))
  // 多币种：指标出现但**禁用**，并明确说明为什么不叠加。
  dashboard.series = {
    bucket: 'day',
    points: [
      costPoints[0]!,
      {
        ...costPoints[1]!,
        cost: {
          ...costPoints[1]!.cost,
          costs: [{ currency: 'USD', amountMicro: 500 }],
        },
      },
    ],
  }
  const mixedAnalysisHtml = await render('/src/views/AnalysisView.vue')
  check('分析页：多币种时金额指标禁用并说明原因（绝不挑一个币种偷偷画）',
    mixedAnalysisHtml.includes('2 种币种') &&
    mixedAnalysisHtml.includes('CNY / USD') &&
    mixedAnalysisHtml.includes('绝不跨币种相加'))
  dashboard.series = { bucket: 'day', points: [] }
  // Element Plus 在 mounted 时注册表格列，普通 SSR 不输出数据单元格。
  // 先执行真实表格组件，再渲染收集到的真实列插槽，验证字段绑定与格式化。
  const { default: BreakdownTable } = await server.ssrLoadModule('/src/components/BreakdownTable.vue')
  const columns: Array<{ label: string; slot: Slot | undefined }> = []
  const tableApp = createRenderApp({ render: () => h(BreakdownTable, { rows: [modelRow] }) })
  tableApp.mixin({
    created() {
      if (this.$options.name === 'ElTableColumn')
        columns.push({ label: String(this.$props.label), slot: this.$slots.default })
    },
  })
  await renderToString(tableApp)
  const cells = new Map<string, string>()
  for (const column of columns) {
    const html = await renderToString(createSSRApp({
      render: () => h('td', column.slot?.({ row: modelRow })),
    }))
    cells.set(column.label, html)
  }
  check('分布表展示缓存写入及服务端非零值', cells.get('缓存写入') === '<td>130</td>')
  check('分布表原样展示总量与其余三项',
    cells.get('计费总量') === '<td><strong>14,690</strong></td>' &&
    cells.get('未缓存输入') === '<td>1,300</td>' &&
    cells.get('输出') === '<td>260</td>' &&
    cells.get('缓存读') === '<td>13,000</td>')
  // ── 金额（v7）─────────────────────────────────────────────────────────
  // ★ 三种「没有数」在页面上必须长得不一样，这一组用例逐个钉住：
  //   ① 没有 `cost:read`（字段整个缺席）→ 卡片与列都不出现（由下面的 `allHtml` 断言兜住）；
  //   ② 有权限、这段用量没配价 → **「未计价」**，不是 `¥0`；
  //   ③ 有权限、配了价 → 货币符号 + 金额，并附上单价来源。
  const costCell = async (row: BreakdownRow): Promise<string | undefined> => {
    const collected: Array<{ label: string; slot: Slot | undefined }> = []
    const app = createRenderApp({ render: () => h(BreakdownTable, { rows: [row] }) })
    app.mixin({
      created() {
        if (this.$options.name === 'ElTableColumn')
          collected.push({ label: String(this.$props.label), slot: this.$slots.default })
      },
    })
    await renderToString(app)
    const column = collected.find((entry) => entry.label === '费用（估算）')
    if (!column) return undefined
    return await renderToString(createSSRApp({
      render: () => h('td', column.slot?.({ row })),
    }))
  }
  const pricedRow: BreakdownRow = {
    ...modelRow,
    cost: {
      costs: [{ currency: 'CNY', amountMicro: 1_234_567, tokens: 14_690 }],
      pricedTokens: 14_690,
      unpricedTokens: 0,
      totalTokens: 14_690,
      pricedRate: 1,
      unpricedRate: 0,
      pricing: { pricingSource: 'db', pricingSyncedAt: null },
    },
  }
  const pricedCell = await costCell(pricedRow)
  check('分布表：服务端给出金额时才出现费用列，且直接展示服务端算好的金额',
    pricedCell?.includes('¥1.23') === true)
  // ② 没配价：金额是空的，但**必须**说「未计价」，而且带上比例。
  const unpricedCell = await costCell({
    ...modelRow,
    cost: {
      costs: [],
      pricedTokens: 0,
      unpricedTokens: 14_690,
      totalTokens: 14_690,
      pricedRate: 0,
      unpricedRate: 1,
      pricing: { pricingSource: 'db', pricingSyncedAt: null },
    },
  })
  check('分布表：未配价显示「未计价 100.0%」而不是 ¥0',
    unpricedCell?.includes('未计价') === true &&
    unpricedCell?.includes('100.0%') === true &&
    unpricedCell?.includes('¥') === false)
  // ① 字段缺席：整列不出现（不是显示一列空值或 0）。
  check('分布表：没有 cost 字段时费用列整列不出现',
    (await costCell(modelRow)) === undefined)
  // 概览卡片同款三态：金额 + 未计价提示 + 单价来源。
  dashboard.overview = {
    ...overviewFixture,
    cost: {
      ...pricedRow.cost!,
      unpricedTokens: 1_483,
      unpricedRate: 0.9886,
      pricedTokens: 17,
      unpricedTargets: ['dashscope/unpriced-model'],
    },
  }
  const costDashboardHtml = await render('/src/views/DashboardView.vue')
  check('总览：有金额时出现费用卡片，金额、未计价比例与单价来源同时可见',
    costDashboardHtml.includes('费用（估算）') &&
    costDashboardHtml.includes('¥1.23') &&
    costDashboardHtml.includes('未计价 98.9%') &&
    costDashboardHtml.includes('按服务端数据库中的单价现算') &&
    costDashboardHtml.includes('dashscope/unpriced-model'))
  dashboard.overview = overviewFixture
  check('总览：没有 cost 字段（无 cost:read）时费用卡片不出现',
    (await render('/src/views/DashboardView.vue')).includes('费用（估算）') === false)
  const recordsHtml = await render('/src/views/RecordsView.vue')
  check(
    '明细页及分页说明',
    recordsHtml.includes('用量明细') && recordsHtml.includes('20'),
  )
  const diagnosticsHtml = await render('/src/views/DiagnosticsView.vue')
  check('诊断将人员与历史身份合计展示为4组', diagnosticsHtml.includes('署名键组数') && /4\s*<small>组<\/small>/.test(diagnosticsHtml))
  // ⚠️ 卡片名**刻意不叫**「分组数」：「分组」在产品里只有一个含义（人员分组实体）。
  //   这里数的是署名键（人员 + 待确认历史身份）的组数，与分组个数无关 ——
  //   同名会让人拿它去对分组管理页，再把正确的数字当成数据 bug 排查。
  check('诊断说明署名键组数不等于实际人数且排除未归属',
    diagnosticsHtml.includes('不等同实际成员人数') &&
    diagnosticsHtml.includes('未归属记录不计入署名键组数') &&
    !diagnosticsHtml.includes('归属分组数') && !diagnosticsHtml.includes('不计入分组数') &&
    !diagnosticsHtml.includes('已署名人数'))
  for (const label of [
    '未署名事件',
    '数据时间边界',
    '结构性恒为 0',
    '并非一次扫描检查结果',
  ])
    check(`诊断页含 ${label}`, diagnosticsHtml.includes(label))
  // 页面上不再堆说明文字，结论收敛成一行状态：有未归属时必须是可核查的
  // 警告态，没有时才是常态 —— 两个分支都要钉住，否则「红变绿」静默失效。
  check('诊断有未归属时状态行转为警告',
    diagnosticsHtml.includes('存在 1 条未归属记录') &&
    diagnosticsHtml.includes('is-warning') && diagnosticsHtml.includes('需核查'))
  const unattributedDiagnostics = dashboard.diagnostics
  dashboard.diagnostics = { ...unattributedDiagnostics, unattributedEvents: 0, unattributedRate: 0 }
  const cleanDiagnosticsHtml = await render('/src/views/DiagnosticsView.vue')
  check('诊断无未归属时状态行恢复常态',
    cleanDiagnosticsHtml.includes('当前范围内未发现未归属记录') &&
    cleanDiagnosticsHtml.includes('is-ok') && !cleanDiagnosticsHtml.includes('is-warning'))
  dashboard.diagnostics = unattributedDiagnostics
  const filterHtml = await render('/src/components/FilterBar.vue')
  check(
    '筛选表单使用组件库',
    filterHtml.includes('el-form') && filterHtml.includes('el-select'),
  )
  check(
    '筛选包含人员、分组与时间',
    filterHtml.includes('人员筛选') &&
      filterHtml.includes('分组筛选') &&
      filterHtml.includes('时间范围'),
  )
  /**
   * ★ 厂商是**多选 + 可搜索 + 可新建**的下拉，而不是一个自由输入框。
   *
   * ⚠️ 判据里**不能**出现候选项文本（`dashscope` 之类）：Element Plus 的下拉
   *   内容是 `<teleport>` 出去的，SSR 产物里只有一个空的 teleport ——
   *   拿选项文本当判据会得到一条永远失败（或永远通过）的断言。
   *   「候选 = 库里的目录 ∪ 使用者自建的」由 `test/stores.test.ts` 的
   *   `providerChoices` 断言钉住（那里是纯数据，不经过 teleport）。
   *
   * 所以这里验的是**控件形状**与**说清自定义项存在哪里**：
   * 一个带 `role="combobox"` 的筛选控件（`el-select` 才有）+ 可新建的占位提示。
   */
  dashboard.providerOptions = ['dashscope', 'bailian-tpp']
  dashboard.customProviders = ['my-gateway']
  const providerHtml = await render('/src/components/FilterBar.vue')
  check(
    '★ 厂商是多选下拉（combobox）并提示可以新建',
    providerHtml.includes('data-testid="provider-filter"') &&
      providerHtml.includes('aria-label="厂商筛选"') &&
      providerHtml.includes('role="combobox"') &&
      providerHtml.includes('全部厂商（可输入后回车新建）'),
  )
  check(
    '★ 自定义项说明它存在本机并提供清除入口',
    providerHtml.includes('不写入数据库') && providerHtml.includes('清除'),
  )
  // 清回原状：下面的断言看的仍是同一份 store。
  dashboard.providerOptions = []
  dashboard.customProviders = []
  dashboard.filters = { ...dashboard.filters, period: 'custom' }
  const customHtml = await render('/src/components/FilterBar.vue')
  check(
    '自定义范围提供起止输入',
    customHtml.includes('开始时间') && customHtml.includes('结束时间'),
  )

  /**
   * 🚨 只看自己的身份**没有人员下拉**，也**不写任何数据范围提示**。
   *
   * 留一个筛不了任何东西的下拉，只会让人以为自己筛到了别人；而把
   * 「只看本人（不是管理员）」写在筛选栏里，等于占着一个筛不了控件的位置去讲
   * 一件与筛选无关的事 —— 使用者的身份不该由筛选栏来宣布。
   * 真正的收窄在服务端（`stats-route.ts` 的 `applyDataScope()`），页面这一层
   * 只是不再画一个假控件、也不解释它。其余筛选（分组 / 厂商 / 模型 / 时间）照旧。
   */
  const administrator = session.identity
  session.identity = {
    member_id: '00000000-0000-4000-8000-000000000002',
    name: '普通成员',
    username: 'member',
    role: 'member',
    permissions: ['stats:read', 'groups:read'],
  }
  session.generation++
  const scopedFilterHtml = await render('/src/components/FilterBar.vue')
  check(
    '★ 普通成员没有人员下拉，也不写数据范围提示',
    // ⚠️ 判据用 `aria-label` / `data-testid` / 那句原文：SSR 会把模板注释一起渲染
    //   出来，而注释里恰好也有「全部人员」「只看本人」这类字样（拿文本当判据会误判），
    //   所以这里同时钉住「那行提示真的没了」，而不是只看下拉在不在。
    !scopedFilterHtml.includes('人员筛选') &&
      !scopedFilterHtml.includes('data-testid="scope-note"') &&
      !scopedFilterHtml.includes('只看本人'),
  )
  check(
    '普通成员保留分组、厂商、模型与时间筛选',
    scopedFilterHtml.includes('分组筛选') &&
      scopedFilterHtml.includes('厂商筛选') &&
      scopedFilterHtml.includes('模型筛选') &&
      scopedFilterHtml.includes('时间范围'),
  )
  const scopedLayoutHtml = await render('/src/layouts/PortalLayout.vue')
  // ⚠️ 判据是身份块里那个 `<small>` 的**内容**，不是「整页有没有出现过这四个字」：
  //   SSR 会把模板注释一起渲染出来，而注释里也会提到「管理员」。
  check('身份标签跟着数据范围走', /<small>\s*普通成员\s*<\/small>/.test(scopedLayoutHtml))
  session.identity = administrator
  session.generation++
  const restoredLayoutHtml = await render('/src/layouts/PortalLayout.vue')
  check(
    '管理员仍有人员下拉与管理员标签',
    filterHtml.includes('人员筛选') && /<small>\s*管理员\s*<\/small>/.test(restoredLayoutHtml),
  )

  const members = useMembersStore(pinia)
  members.storage = { kind: 'mysql', schema_version: 4, available: true, initialized: true }
  const adminHtml = await render('/src/views/AdminView.vue')
  check(
    '管理页独立入口与名单',
    adminHtml.includes('添加成员') && adminHtml.includes('人员列表'),
  )
  check(
    '管理页提供搜索与角色筛选',
    adminHtml.includes('搜索成员') && adminHtml.includes('筛选角色'),
  )
  // 顶部说明文字与三张概览卡（团队成员 / 管理员角色 / 数据库种类）已按需求移除，
  // 所以这里断言的是「不再出现」，而不是原来的「出现 MySQL」。
  check('人员管理不再显示数据库种类概览卡',
    !adminHtml.includes('数据库') && !adminHtml.includes('SQLite') && !adminHtml.includes('MySQL'))
  check('人员管理不混排分组与角色目录',
    !adminHtml.includes('分组目录') && !adminHtml.includes('角色与权限目录') &&
    !adminHtml.includes('分组列表') && !adminHtml.includes('角色列表'))
  check('管理页不再显示凭证文件或可恢复明文', !adminHtml.includes('credentials.json') && !adminHtml.includes('显示 Token'))
  // 人员页与凭证彻底分离：既不签发 / 轮换，也不显示「有效凭证」计数列。
  check('人员管理不再承载凭证功能',
    !adminHtml.includes('上报凭证') && !adminHtml.includes('有效凭证') &&
    !adminHtml.includes('签发') && !adminHtml.includes('轮换'))
  const appKeyHtml = await render('/src/views/AppKeyView.vue')
  check('appKey 管理页只在标题里说明两项固定权限',
    appKeyHtml.includes('appKey 管理') && appKeyHtml.includes('权限固定为') &&
    appKeyHtml.includes('上报用量') && appKeyHtml.includes('获取统计信息'))
  // 页面上不再铺权限说明条，也不再逐行展示用途 / 权限列（scope 码只在接口层）。
  check('appKey 管理页不再铺开权限条与范围码',
    !appKeyHtml.includes('usage:write') && !appKeyHtml.includes('不能进入管理页面'))
  check('appKey 管理页主体是凭证列表并呈现归属',
    appKeyHtml.includes('已发放 appKey') && appKeyHtml.includes('标明它发给了谁') &&
    appKeyHtml.includes('搜索人员、分组或凭证提示'))
  // ★ 发放收进弹框：页面上只留一个入口按钮，表单本体在弹框里。
  //   而 Element Plus 的弹框正文在 SSR 下不渲染（`rendered` 由 `onMounted` 置位），
  //   所以那份表单直接渲染组件本体来断言 —— 与下面的交付信息同款。
  check('发放只在标题右侧留一个弹框入口',
    appKeyHtml.includes('发放 appKey') && !appKeyHtml.includes('选择在职成员'))
  const { default: IssueAppKeyForm } = await server.ssrLoadModule('/src/components/IssueAppKeyForm.vue')
  const issueHtml = await renderToString(createRenderApp({
    render: () => h(IssueAppKeyForm, { members: [], canPick: true, busy: false }),
  }))
  // ⚠️ 只断言真的进了 DOM 的东西：`el-select` 的 `el-option` 文案在 SSR 下
  //    不渲染（下拉未展开），能断言的是控件的 aria-label 与说明文字。
  check('发放表单提供选人与有效期入口',
    issueHtml.includes('选择在职成员') && issueHtml.includes('aria-label="有效期"') &&
    issueHtml.includes('有效期可以留空'))
  check('列表提供改有效期入口，并说明过期可以续期',
    appKeyHtml.includes('aria-label="设置有效期"') && appKeyHtml.includes('过期前可以延长有效期'))
  // ⚠️ 行内那五个动作（交付信息 / 有效期 / 轮换 / 吊销 / 删除）**断言不到**：
  //   `el-table` 的表头与单元格在 SSR 下都不渲染（只有空 `<tr>`，见下面角色页那段），
  //   所以这里只钉页面壳里那句「删除只对从未上报过的凭证开放」——
  //   它同时也是使用者唯一能在点按钮之前看到的口径说明。
  check('页面壳写明删除只对从未上报过的凭证开放',
    appKeyHtml.includes('误发且从未上报过的可以删除'))
  // ★ 完整明文不落在页面上：连「拿到过明文」这一次也不进 DOM。
  const demoSecret = 'atr-' + 'demo'.repeat(12)
  members.issuedSecret = demoSecret
  const issuedHtml = await render('/src/views/AppKeyView.vue')
  check('签发后页面不出现完整 appKey', !issuedHtml.includes(demoSecret))
  members.dismissSecret()
  // Element Plus 的弹框正文在 SSR 下不渲染（`rendered` 由 mounted 置位），
  // 所以交付信息直接渲染组件本体来断言那几行地址与遮罩。
  const { default: AppKeyDelivery } = await server.ssrLoadModule('/src/components/AppKeyDelivery.vue')
  const deliveryHtml = await renderToString(createRenderApp({
    render: () => h(AppKeyDelivery, { owner: '张三（研发组）', secret: demoSecret, prefix: '' }),
  }))
  const copySource = deliveryHtml.match(/<code id="delivery-text"[^>]*>[\s\S]*?<\/code>/)?.[0] ?? ''
  check('交付信息给出上报与统计的完整地址',
    deliveryHtml.includes('/api/v1/token-usage') && deliveryHtml.includes('/api/v1/stats/*'))
  check('交付信息只在页面上给遮罩形态',
    !!copySource && deliveryHtml.replace(copySource, '').includes('atr-demo…demo') &&
    !deliveryHtml.replace(copySource, '').includes(demoSecret))
  check('完整 appKey 只进剪贴板复制源',
    copySource.includes(`appKey：${demoSecret}`) && deliveryHtml.includes('复制 appKey') &&
    deliveryHtml.includes('复制交付信息'))
  // ★ 明文这一屏不再压警告条：说明就在下面 `appKey` 那一行的旁注里
  //   （「完整值不落在页面上」），弹框顶部再喊一遍只会把要照抄的地址挤下去。
  check('交付信息不再压一条警告条',
    !deliveryHtml.includes('完整 appKey 只显示这一次') && deliveryHtml.includes('完整值不落在页面上'))
  const listedHtml = await renderToString(createRenderApp({
    render: () => h(AppKeyDelivery, { owner: '李四', secret: null, prefix: 'd5788739d349' }),
  }))
  check('列表行的交付信息只有中间省略号的凭证提示',
    listedHtml.includes('d57887…39d349') && listedHtml.includes('只在签发或轮换成功时出现一次') &&
    !listedHtml.includes('复制 appKey'))
  // 角色页在 SSR 下只渲染列表壳（弹框正文要等 mounted 才渲染），
  // ★ 而且 `el-table` 的**表头与单元格也不渲染** —— Element Plus 在服务端只输出空 `<tr>`，
  //   列名与行内容都是客户端渲染的，断言「运营查看者」只会得到一次假失败。
  //   所以这里断言页面壳、两个入口与「数据确实进了表格」（计数文案）；
  //   行级判断（内置标记、状态标签、权限码中文名、停用角色仍留在目录、停用角色不进分配下拉）
  //   已抽到 `views/rolesModel.ts`，由 `test/roles.test.ts` 覆盖。
  members.roles = [
    { role_id: '00000000-0000-4000-8000-000000000001', code: 'admin', name: '管理员', permissions: ['members:manage', 'roles:assign'], is_builtin: true, status: 'active', version: 1 },
    { role_id: '00000000-0000-4000-8000-0000000000a1', code: 'ops-viewer', name: '运营查看者', permissions: ['stats:read'], is_builtin: false, status: 'disabled', version: 3 },
  ]
  members.permissions = [{ code: 'stats:read', description: 'stats:read' }]
  const rolesHtml = await render('/src/views/RolesView.vue')
  // 失败时把缺的标签一并报出来：只说「断言失败」会让人再跑一遍才知道少了什么。
  const roleLabels = ['角色管理', '角色列表', '搜索角色名称或标识', '筛选角色状态', '新建角色', '分配角色', '共 2 个角色']
  const roleMissing = roleLabels.filter((label) => !rolesHtml.includes(label))
  check(`角色管理独立展示列表、搜索、状态筛选与两个入口${roleMissing.length ? `（缺 ${roleMissing.join('、')}）` : ''}`, roleMissing.length === 0)
  check('角色页说明内置角色不可改写',
    rolesHtml.includes('内置角色由服务端维护，不能改名、改权限或停用'))
  check('角色管理不混排人员或分组列表', !rolesHtml.includes('人员列表') && !rolesHtml.includes('分组列表'))
  const groupsHtml = await render('/src/views/GroupsView.vue')
  check('分组管理独立展示列表、搜索、状态筛选与新增入口',
    ['分组管理', '分组列表', '搜索分组', '筛选分组状态', '添加分组'].every((label) => groupsHtml.includes(label)))
  check('分组管理不混排人员或角色列表', !groupsHtml.includes('人员列表') && !groupsHtml.includes('角色列表'))
  // ★ 多对多是这一页最容易误解的地方：副标题必须写清「一个人可属于多个分组」，
  //   否则管理员会以为归属是单选，看到分组排行求和不等时再去查一个不存在的 bug。
  check('分组管理写明成员与分组是多对多',
    groupsHtml.includes('一名成员可同时属于多个分组') &&
    groupsHtml.includes('用量会按其所属的每个分组统计'))
  const providersHtml = await render('/src/views/ProvidersView.vue')
  check('供应商归一化独立展示规则列表、搜索、作用范围与新增入口',
    ['供应商归一化', '规则列表', '搜索供应商或归一化名', '全部作用范围', '添加规则'].every((label) => providersHtml.includes(label)))
  // ★ 这一页最容易配错的两件事必须写在页面上，而不是只写在代码注释里：
  //   ① 原始名是大小写敏感的精确匹配（写错就静默不命中）；
  //   ② 没配规则的供应商保持原始名（归一化不是「统一改名」）。
  check('供应商归一化写明匹配规则与「未配置者保持原值」',
    providersHtml.includes('一字不差') &&
    providersHtml.includes('没有配规则的供应商保持自己的原始名') &&
    providersHtml.includes('明细里始终同时显示原值'))
  check('供应商归一化不混排人员或分组列表', !providersHtml.includes('人员列表') && !providersHtml.includes('分组列表'))
  const pricingHtml = await render('/src/views/PricingView.vue')
  check('模型单价独立展示计价目录、新增入口与种子初始化',
    ['模型单价', '计价目录', '新增单价', '用内置种子价初始化'].every((label) => pricingHtml.includes(label)))
  // ★ 这一页最容易误解的三件事必须写在页面上，而不是只写在代码注释里：
  //   ① 粒度是「供应商 → 模型」，同一供应商下不同模型可以各配各的价；
  //   ② 只存单价、不存金额，所以改价不改写历史用量；
  //   ③ 未配单价的用量是「未计价」，**不是 0 元**。
  check('模型单价写明按「供应商 + 模型」粒度定价',
    pricingHtml.includes('同一供应商下不同模型可以各不相同') &&
    pricingHtml.includes('区间不得重叠'))
  check('模型单价写明「只存单价不存金额」与「未计价不是 0 元」',
    pricingHtml.includes('而历史用量一个字节都不会被动') &&
    pricingHtml.includes('未计价') &&
    pricingHtml.includes('缓存读价通常比输入价便宜一个数量级') &&
    pricingHtml.includes('多币种各自累加，绝不换算也绝不相加') &&
    pricingHtml.includes('自建计价永远不会等于财务账单'))
  check('模型单价不混排人员或分组列表', !pricingHtml.includes('人员列表') && !pricingHtml.includes('分组列表'))
  const allHtml =
    loginHtml +
    dashboardHtml +
    analysisHtml +
    recordsHtml +
    diagnosticsHtml +
    adminHtml +
    appKeyHtml +
    issuedHtml +
    rolesHtml +
    groupsHtml +
    providersHtml
  // ★ 这条断言被**改写过**（原来是「全站不出现金额」）：v7 起单价有了来源，
  //   `/pricing` 这一页的主体就是单价（它当然要显示 `CNY` 与 `¥`），
  //   所以「不出现金额」现在指的是**统计页**——用量总览 / 分析 / 明细 / 诊断 / 管理页
  //   依然一个字都不显示金额。它们的数据来自 `/api/v1/stats/*`，而那些接口
  //   在 `cost:read` 之外**整个 `cost` 字段都不发**，页面也就无从显示。
  //   把 `pricingHtml` 拼进 `allHtml` 会让这条断言重新变成「全站不许有货币符号」，
  //   那与「页面要能让人核对单价」直接冲突 —— 于是它只会被删掉，而不是被满足。
  for (const term of ['消费金额', 'CNY', '¥', '充值余额', '80,642,909'])
    check(`统计页不包含金额或旧 mock：${term}`, !allHtml.includes(term))
  // 反过来：计价页必须把「单价的单位」说清楚，否则人填进去的数字没有意义。
  // ⚠️ 这里断言不到货币码（`CNY`）：币种只出现在**每条价的标签**与下拉候选里，
  //   而 SSR 时列表为空、`el-dialog` 的内容进的是 teleport 载荷而非返回的 HTML。
  //   想把「币种确实渲染出来了」也钉住，只能等有数据的那一层（真浏览器 / 组件测试）。
  const pricingLabels = ['货币单位 / 百万 token', '整数微元', '每百万 token 2 元']
  const pricingMissing = pricingLabels.filter((label) => !pricingHtml.includes(label))
  check(`计价页写明单价的单位与微元口径${pricingMissing.length ? `（缺 ${pricingMissing.join('、')}）` : ''}`, pricingMissing.length === 0)
  session.expire()
  await router.push('/analysis')
  check('退出后无法进入统计路由', router.currentRoute.value.name === 'login')
  if (failures.length) {
    console.error(failures.join('\n'))
    process.exitCode = 1
  } else console.log('全部渲染与路由断言通过。')
} finally {
  disposePinia(pinia)
  await server.close()
}
