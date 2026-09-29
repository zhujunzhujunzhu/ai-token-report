<script setup lang="ts">
/**
 * 筛选草稿与已应用条件分开，填写期间不会触发无效查询。
 * 三个下拉（时间范围 / 人员 / 分组）是离散选择，选中即应用到列表，不必再点「查询」；
 * 厂商 / 模型是子串输入，逐字符查询没有意义，仍由按钮或回车提交。
 */
import {
  ElAlert,
  ElButton,
  ElCard,
  ElDatePicker,
  ElForm,
  ElFormItem,
  ElInput,
  ElOption,
  ElSelect,
} from 'element-plus'
import { onUnmounted, reactive, watch } from 'vue'
import { Search, RefreshLeft } from '@element-plus/icons-vue'
import { useDashboardStore } from '../stores/dashboard.js'
import {
  TIME_RANGES,
  CUSTOM_PERIOD,
  identityLabel,
  periodReadyForQuery,
} from '../types/portal.js'
const dashboard = useDashboardStore()
const draft = reactive({
  ...dashboard.filters,
  users: [...dashboard.filters.users],
  groups: [...dashboard.filters.groups],
})
watch(
  () => dashboard.filters,
  (value) =>
    Object.assign(draft, {
      ...value,
      users: [...value.users],
      groups: [...value.groups],
    }),
)
let selectTimer: ReturnType<typeof setTimeout> | undefined
/** 此刻的时间范围是否可以直接查询（自定义区间要等起止时间填齐）。 */
function periodReady(): boolean {
  return periodReadyForQuery(draft.period, draft.customFrom, draft.customTo)
}
async function apply(): Promise<void> {
  // 立即应用时取消排队中的防抖查询，避免同一份草稿查两遍。
  clearTimeout(selectTimer)
  await dashboard.applyFilters(draft)
}
function applyPeriod(): void {
  // 自定义区间在起止时间填齐前不查，否则切过去就弹一次「请选择开始与结束时间」。
  if (!periodReady()) return
  void apply()
}
function applySelectsSoon(): void {
  // 多选每勾一项都会触发 change，短暂防抖合并成一次查询。
  clearTimeout(selectTimer)
  selectTimer = setTimeout(() => void apply(), 250)
}
async function reset(): Promise<void> {
  // ★ 分组与人员是两个独立维度，重置必须**都**清空 ——
  //   漏掉一个就会留下「看不见的筛选」，数字对不上却找不到原因。
  Object.assign(draft, {
    ...dashboard.filters,
    provider: '',
    model: '',
    users: [],
    groups: [],
  })
  await apply()
}
watch(
  () => [draft.customFrom, draft.customTo],
  () => {
    // 起止时间补齐后自动生效；具名周期下改这两个输入框不发查询。
    if (draft.period === CUSTOM_PERIOD && periodReady()) void apply()
  },
)
onUnmounted(() => clearTimeout(selectTimer))
</script>
<template>
  <el-card shadow="never" class="filter-card">
    <el-form label-position="top" class="filter-form" @submit.prevent="apply">
      <el-form-item label="时间范围"
        ><el-select
          v-model="draft.period"
          aria-label="时间范围"
          @change="applyPeriod"
          ><el-option
            v-for="option in TIME_RANGES"
            :key="option.value"
            :value="option.value"
            :label="option.label" /></el-select
      ></el-form-item>
      <el-form-item label="人员"
        ><el-select
          v-model="draft.users"
          multiple
          filterable
          clearable
          collapse-tags
          collapse-tags-tooltip
          placeholder="全部人员"
          aria-label="人员筛选"
          @change="applySelectsSoon"
          ><el-option
            v-for="row in dashboard.userOptions"
            :key="row.key"
            :value="row.key"
            :label="identityLabel(row)" /></el-select
      ></el-form-item>
      <!--
        分组筛选的候选项来自看板接口 `/api/v1/stats/groups`（`stats:read`），
        不是管理接口 `/api/v1/admin/groups`（那是 `groups:read`）。
        ⚠️ 多选是 OR / 展开（多对多）：命中任一所选分组即计入。
        ⚠️ 已停用的分组**照样列出**并标注：停用只影响「以后还能不能选它」，
          历史用量仍在，排行里也仍有它那一行 —— 藏起来会让人以为用量丢了。
      -->
      <el-form-item label="分组"
        ><el-select
          v-model="draft.groups"
          multiple
          filterable
          clearable
          collapse-tags
          collapse-tags-tooltip
          placeholder="全部分组"
          aria-label="分组筛选"
          @change="applySelectsSoon"
          ><el-option
            v-for="group in dashboard.groupOptions"
            :key="group.group_id"
            :value="group.group_id"
            :label="
              group.status === 'active' ? group.name : `${group.name}（已停用）`
            " /></el-select
      ></el-form-item>
      <el-form-item label="厂商"
        ><el-input
          v-model="draft.provider"
          clearable
          placeholder="搜索厂商"
          aria-label="厂商筛选"
      /></el-form-item>
      <el-form-item label="模型"
        ><el-input
          v-model="draft.model"
          clearable
          placeholder="搜索模型"
          aria-label="模型筛选"
      /></el-form-item>
      <div class="filter-actions">
        <el-button
          type="primary"
          native-type="submit"
          :icon="Search"
          :loading="dashboard.loading"
          >查询</el-button
        ><el-button :icon="RefreshLeft" @click="reset">重置</el-button>
      </div>
      <div v-if="draft.period === CUSTOM_PERIOD" class="custom-range">
        <el-form-item label="开始时间"
          ><el-date-picker
            v-model="draft.customFrom"
            type="datetime"
            value-format="YYYY-MM-DDTHH:mm"
            format="YYYY-MM-DD HH:mm"
            placeholder="选择开始时间"
            aria-label="开始时间"
        /></el-form-item>
        <span>至</span>
        <el-form-item label="结束时间"
          ><el-date-picker
            v-model="draft.customTo"
            type="datetime"
            value-format="YYYY-MM-DDTHH:mm"
            format="YYYY-MM-DD HH:mm"
            placeholder="选择结束时间"
            aria-label="结束时间"
        /></el-form-item>
      </div>
    </el-form>
    <el-alert
      v-if="dashboard.rangeError"
      :title="dashboard.rangeError"
      type="warning"
      :closable="false"
      show-icon
    />
  </el-card>
</template>