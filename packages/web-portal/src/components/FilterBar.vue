<script setup lang="ts">
/** 筛选草稿与已应用条件分开，填写期间不会触发无效查询。 */
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
import { reactive, watch } from 'vue'
import { Search, RefreshLeft } from '@element-plus/icons-vue'
import { useDashboardStore } from '../stores/dashboard.js'
import { TIME_RANGES, CUSTOM_PERIOD, identityLabel } from '../types/portal.js'
const dashboard = useDashboardStore()
const draft = reactive({
  ...dashboard.filters,
  users: [...dashboard.filters.users],
})
watch(
  () => dashboard.filters,
  (value) => Object.assign(draft, { ...value, users: [...value.users] }),
)
async function apply(): Promise<void> {
  await dashboard.applyFilters(draft)
}
async function reset(): Promise<void> {
  Object.assign(draft, {
    ...dashboard.filters,
    provider: '',
    model: '',
    users: [],
  })
  await apply()
}
</script>
<template>
  <el-card shadow="never" class="filter-card">
    <el-form label-position="top" class="filter-form" @submit.prevent="apply">
      <el-form-item label="时间范围"
        ><el-select v-model="draft.period" aria-label="时间范围"
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
          ><el-option
            v-for="row in dashboard.userOptions"
            :key="row.key"
            :value="row.key"
            :label="identityLabel(row)" /></el-select
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
