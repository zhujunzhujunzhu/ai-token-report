<script setup lang="ts">
/** 统计页共享筛选与刷新生命周期，离开统计模块即停止轮询。 */
import { ElAlert, ElButton, ElEmpty, ElIcon, ElSkeleton } from 'element-plus'
import { computed, onMounted, onUnmounted, watch } from 'vue'
import { useRoute } from 'vue-router'
import { Refresh, Clock } from '@element-plus/icons-vue'
import FilterBar from '../components/FilterBar.vue'
import UserDetailPanel from '../components/UserDetailPanel.vue'
import { buildFilter, useDashboardStore, type StatsSection } from '../stores/dashboard.js'
import { formatFullDateTime } from '../utils/format.js'
import { refreshIntervalMs, refreshIntervalLabel } from '../utils/refresh.js'
const dashboard = useDashboardStore()
const route = useRoute()
// 页面副标题只在真正需要补充说明时给（`section` 未登记即不渲染）：
// 「采集诊断」这类标题已经自明的页面，多一行灰字只是噪音。
const descriptions: Record<string, string> = {
  overview: '从团队全貌到个人用量，掌握每一次 AI 调用。',
  analysis: '观察用量变化，了解团队的模型与项目使用分布。',
  records: '查看每一条调用记录，追溯用量来源。',
}
const description = computed(
  () => descriptions[String(route.meta.section)] ?? '',
)
let timer: ReturnType<typeof setInterval> | undefined
const refreshInterval = computed(() =>
  refreshIntervalMs(dashboard.filters.period, buildFilter(dashboard.filters).span),
)
function refreshWhenVisible(): void {
  if (!document.hidden && (!dashboard.fetchedAt || Date.now() - dashboard.fetchedAt >= refreshInterval.value))
    void dashboard.load(true)
}
watch(
  () => route.meta.section,
  (value) => {
    if (value) void dashboard.activate(value as StatsSection)
  },
  { immediate: true },
)
onMounted(() => {
  watch(refreshInterval, (interval) => {
    clearInterval(timer)
    timer = setInterval(() => { void dashboard.load(true) }, interval)
  }, { immediate: true })
  // 隐藏时跳过轮询；返回时只补过期数据，避免频繁切标签触发全年扫描。
  document.addEventListener('visibilitychange', refreshWhenVisible)
})
onUnmounted(() => {
  clearInterval(timer)
  document.removeEventListener('visibilitychange', refreshWhenVisible)
  dashboard.deactivate()
})
</script>
<template>
  <div class="page-stack">
    <div class="page-heading">
      <div>
        <div class="eyebrow">TEAM WORKSPACE</div>
        <h1>{{ route.meta.title }}</h1>
        <p v-if="description">{{ description }}</p>
      </div>
      <el-button
        :icon="Refresh"
        :loading="dashboard.loading"
        @click="dashboard.load(false, true)"
        >刷新数据</el-button
      >
    </div>
    <FilterBar />
    <div class="data-context">
      <span>{{ dashboard.overview?.range.label || '当前筛选范围' }}</span
      ><span
        ><el-icon><Clock /></el-icon
        >{{
          dashboard.fetchedAt
            ? `更新于 ${formatFullDateTime(dashboard.fetchedAt)} · ${refreshIntervalLabel(refreshInterval)}`
            : '等待获取数据'
        }}</span
      >
    </div>
    <el-alert
      v-if="dashboard.error"
      :title="dashboard.error"
      :description="
        dashboard.fetchedAt
          ? '当前展示上一次成功获取的数据，请刷新重试。'
          : '数据尚未加载成功，请检查服务连接后重试。'
      "
      type="error"
      show-icon
      :closable="false"
    />
    <el-skeleton
      v-if="dashboard.loading && !dashboard.overview"
      :rows="10"
      animated
      class="panel loading-panel"
    />
    <router-view v-else-if="dashboard.overview" />
    <el-empty v-else-if="!dashboard.loading" description="暂无可展示的数据" />
    <UserDetailPanel />
  </div>
</template>
