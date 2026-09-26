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

  session.identity = { name: '测试成员', username: 'member', role: 'member' }
  session.generation++
  await router.push('/members')
  check(
    '普通成员直接访问管理页回总览',
    router.currentRoute.value.name === 'overview',
  )
  session.identity = { member_id: '00000000-0000-4000-8000-000000000001', name: '测试管理员', username: 'admin', role: 'admin', permissions: ['members:read', 'members:manage', 'departments:read', 'departments:manage', 'roles:read'] }
  await router.push('/members')
  check('管理员可进入人员管理', router.currentRoute.value.name === 'members')

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
  async function render(path: string): Promise<string> {
    const { default: component } = await server.ssrLoadModule(path)
    return renderToString(createRenderApp(component))
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
  ])
    check(`总览含 ${label}`, dashboardHtml.includes(label))
  check('总览直接展示接口总量', dashboardHtml.includes('1,500'))
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
  check('诊断将人员与历史身份合计展示为4组', diagnosticsHtml.includes('归属分组数') && /4\s*<small>组<\/small>/.test(diagnosticsHtml))
  check('诊断明确分组不等于实际人数且排除未归属', diagnosticsHtml.includes('不等同实际成员人数') && diagnosticsHtml.includes('未归属记录不计入分组数') && !diagnosticsHtml.includes('已署名人数'))
  for (const label of [
    '未署名事件',
    '数据时间边界',
    '结构性恒为 0',
    '并非一次扫描检查结果',
  ])
    check(`诊断页含 ${label}`, diagnosticsHtml.includes(label))
  const filterHtml = await render('/src/components/FilterBar.vue')
  check(
    '筛选表单使用组件库',
    filterHtml.includes('el-form') && filterHtml.includes('el-select'),
  )
  check(
    '筛选包含人员与时间',
    filterHtml.includes('人员筛选') && filterHtml.includes('时间范围'),
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
  check('管理页连接数据库身份模型', adminHtml.includes('MySQL') && adminHtml.includes('部门目录'))
  check('管理页不再显示凭证文件或可恢复明文', !adminHtml.includes('credentials.json') && !adminHtml.includes('显示 Token'))
  const allHtml =
    loginHtml +
    dashboardHtml +
    analysisHtml +
    recordsHtml +
    diagnosticsHtml +
    adminHtml
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
