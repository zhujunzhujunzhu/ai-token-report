/** 等待路由守卫恢复会话后展示首屏，避免闪现未授权页面。 */
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { createPortalRouter } from './router/index.js'

import App from '@/App.vue'
// 组件库样式先加载，部门后台主题随后覆盖；本地页保持独立构建。
import 'element-plus/dist/index.css'
import '@/styles/base.css'

const pinia = createPinia()
const router = createPortalRouter(pinia)
const app = createApp(App).use(pinia).use(router)
void router.isReady().then(() => app.mount('#app'))
