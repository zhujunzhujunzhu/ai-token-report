/** Hash 路由兼容现有静态托管；服务端仍负责每个接口的真实鉴权。 */
import {
  createRouter,
  createWebHashHistory,
  type RouterHistory,
} from 'vue-router'
import type { Pinia } from 'pinia'
import { useSessionStore } from '../stores/session.js'

export function createPortalRouter(
  pinia: Pinia,
  history: RouterHistory = createWebHashHistory(),
) {
  const router = createRouter({
    history,
    scrollBehavior: () => ({ top: 0 }),
    routes: [
      {
        path: '/login',
        name: 'login',
        component: () => import('../views/LoginView.vue'),
        meta: { title: '登录' },
      },
      {
        path: '/',
        component: () => import('../layouts/PortalLayout.vue'),
        meta: { requiresAuth: true },
        children: [
          {
            path: '',
            component: () => import('../layouts/StatsLayout.vue'),
            children: [
              { path: '', redirect: '/overview' },
              {
                path: 'overview',
                name: 'overview',
                component: () => import('../views/DashboardView.vue'),
                meta: { title: '用量总览', section: 'overview' },
              },
              {
                path: 'analysis',
                name: 'analysis',
                component: () => import('../views/AnalysisView.vue'),
                meta: { title: '用量分析', section: 'analysis' },
              },
              {
                path: 'records',
                name: 'records',
                component: () => import('../views/RecordsView.vue'),
                meta: { title: '调用明细', section: 'records' },
              },
              {
                path: 'diagnostics',
                name: 'diagnostics',
                component: () => import('../views/DiagnosticsView.vue'),
                meta: { title: '采集诊断', section: 'diagnostics' },
              },
            ],
          },
          {
            path: 'members',
            name: 'members',
            component: () => import('../views/AdminView.vue'),
            meta: { title: '人员管理', requiredPermission: 'members:read' },
          },
          {
            path: 'appkeys',
            name: 'appkeys',
            component: () => import('../views/AppKeyView.vue'),
            // 页面主体是凭证列表（读）与签发/轮换/吊销（写），两者都要 tokens:manage。
            meta: { title: 'appKey 管理', requiredPermission: 'tokens:manage' },
          },
          {
            path: 'roles',
            name: 'roles',
            component: () => import('../views/RolesView.vue'),
            meta: { title: '角色管理', requiredPermission: 'roles:read' },
          },
          {
            path: 'groups',
            name: 'groups',
            component: () => import('../views/GroupsView.vue'),
            meta: { title: '分组管理', requiredPermission: 'groups:manage' },
          },
          {
            path: 'providers',
            name: 'providers',
            component: () => import('../views/ProvidersView.vue'),
            // ★ 与分组管理**不共用**权限：归一化改的是「按供应商看用量」的口径，
            //   对全平台的统计口径都有影响，所以读要 providers:read、写要 providers:manage。
            meta: { title: '供应商归一化', requiredPermission: 'providers:read' },
          },
          {
            path: 'pricing',
            name: 'pricing',
            component: () => import('../views/PricingView.vue'),
            // ★ 读也归 `pricing:manage`：单价是**配置**，不是「看一眼的数字」。
            //   能看金额的人（`cost:read`）不必能看/改计价表 —— 那两件事的
            //   误操作代价不同：「看错一个数」与「把全平台的计价改掉」。
            meta: { title: '模型单价', requiredPermission: 'pricing:manage' },
          },
        ],
      },
      { path: '/:pathMatch(.*)*', redirect: '/overview' },
    ],
  })
  router.beforeEach(async (to) => {
    const session = useSessionStore(pinia)
    await session.restore()
    if (to.meta.requiresAuth && !session.signedIn)
      return { name: 'login', query: { redirect: to.fullPath } }
    if (typeof to.meta.requiredPermission === 'string' && !session.can(to.meta.requiredPermission))
      return { name: 'overview' }
    if (to.name === 'login' && session.signedIn) return { name: 'overview' }
  })
  router.afterEach((to) => {
    if (typeof document !== 'undefined')
      document.title = `${String(to.meta.title ?? '管理后台')} · DSH Token`
  })
  return router
}

/** 回跳只接受本站已知页面，避免把登录参数当作外部跳转地址。 */
export function loginDestination(value: unknown): string {
  return typeof value === 'string' &&
    /^\/(overview|analysis|records|diagnostics|members|appkeys|roles|groups|providers|pricing)(\?.*)?$/.test(value)
    ? value
    : '/overview'
}
