/** 管理页共用助手搜索参数，监听同页导航并保持页面原有搜索入口。 */
import { ref, watch, onMounted, onBeforeUnmount } from 'vue'
import { useRoute } from 'vue-router'
import { assistantSearch } from './assistantNavigation.js'

/** 读取进行中收到修改事件时合并排队，结束后再读一次，避免旧响应盖住新状态。 */
export function createAssistantRefreshQueue(refresh: () => void, isLoading: () => boolean) {
  let pending = false
  function flush() {
    if (!pending || isLoading()) return
    pending = false
    refresh()
  }
  return { request() { pending = true; flush() }, flush }
}

export function useAssistantPageSearch(refresh?: () => void, isLoading: () => boolean = () => false) {
  const route = useRoute()
  const search = ref(assistantSearch(route.query.search))
  watch(() => route.query.search, value => { search.value = assistantSearch(value) })
  // 助手可以在页面仍挂载时完成编辑或确认，页面需重取配置而不是一直展示旧行。
  const queue = createAssistantRefreshQueue(() => refresh?.(), isLoading)
  const changed = () => queue.request()
  watch(isLoading, loading => { if (!loading) queue.flush() })
  onMounted(() => window.addEventListener('assistant-management-changed', changed))
  onBeforeUnmount(() => window.removeEventListener('assistant-management-changed', changed))
  return search
}
export function notifyAssistantManagementChanged(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('assistant-management-changed'))
}
