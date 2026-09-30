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
import type { BreakdownRow } from '@ai-token-report/shared'
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
  session.identity = { member_id: '00000000-0000-4000-8000-000000000001', name: '测试管理员', username: 'admin', role: 'admin', permissions: ['members:read', 'members:manage', 'groups:read', 'groups:manage', 'roles:read', 'roles:assign', 'tokens:manage', 'providers:read', 'providers:manage'] }
  session.generation++
  for (const page of managementPages) {
    await router.push(page.path)
    check(`管理员可进入${page.title}`, router.currentRoute.value.name === page.name)
    check(`${page.title}使用独立页面标题`, router.currentRoute.value.meta.title === page.title)
  }
  await router.push('/members')
  const layoutHtml = await render('/src/layouts/PortalLayout.vue')
  const navigationHtml = layoutHtml.match(/<aside\b[\s\S]*?<\/aside>/)?.[0] ?? ''
  check('管理导航依次为人员、appKey、角色、分组、供应商五个独立入口',
    navigationHtml.indexOf('人员管理') >= 0 &&
    navigationHtml.indexOf('人员管理') < navigationHtml.indexOf('appKey 管理') &&
    navigationHtml.indexOf('appKey 管理') < navigationHtml.indexOf('角色管理') &&
    navigationHtml.indexOf('角色管理') < navigationHtml.indexOf('分组管理') &&
    navigationHtml.indexOf('分组管理') < navigationHtml.indexOf('供应商归一化'))

  const dashboard = useDashboardStore(pinia)
  dashboard.overview = {
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
  dashboard.filters = { ...dashboard.filters, period: 'custom' }
  const customHtml = await render('/src/components/FilterBar.vue')
  check(
    '自定义范围提供起止输入',
    customHtml.includes('开始时间') && customHtml.includes('结束时间'),
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
  for (const term of ['消费金额', 'CNY', '¥', '充值余额', '80,642,909'])
    check(`不包含金额或旧 mock：${term}`, !allHtml.includes(term))
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
