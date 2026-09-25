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
            meta: { title: '人员管理', adminOnly: true },
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
    if (to.meta.adminOnly && !session.isAdmin) return { name: 'overview' }
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
    /^\/(overview|analysis|records|diagnostics|members)(\?.*)?$/.test(value)
    ? value
    : '/overview'
}
