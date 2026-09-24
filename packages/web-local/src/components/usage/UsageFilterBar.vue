<script setup lang="ts">
/**
 * 筛选工具栏：时间维度、刷新、清除筛选条件、导出。
 *
 * 「API Key」下拉已移除 —— 本机日志里没有这个概念（真实维度是 provider / model），
 * 那个下拉在 mock 时代是虚构的筛选项，接上真实数据后无从实现。
 */
import UiButton from '@/components/ui/UiButton.vue'
import UiSelect from '@/components/ui/UiSelect.vue'
import type { TimeRangeOption } from '@/types/usage'

const props = defineProps<{
  timeRanges: TimeRangeOption[]
  timeRange: string
  /** 是否存在生效中的筛选（决定「清除筛选条件」是否可用） */
  dirty: boolean
  loading?: boolean
}>()

const emit = defineEmits<{
  'update:timeRange': [value: string]
  clear: []
  export: []
  refresh: []
}>()

function clear(): void {
  if (props.dirty) {
    emit('clear')
  }
}
</script>

<template>
  <div class="filter-bar">
    <div class="filter-bar__left">
      <UiSelect
        :model-value="timeRange"
        :options="timeRanges"
        @update:model-value="emit('update:timeRange', $event)"
      >
        <template #prefix>时间维度</template>
      </UiSelect>

      <button
        type="button"
        class="filter-bar__clear"
        :disabled="!dirty"
        @click="clear"
      >
        清除筛选条件
      </button>
    </div>

    <div class="filter-bar__right">
      <button
        type="button"
        class="filter-bar__refresh"
        :disabled="loading"
        title="强制服务端重扫日志（日常无需使用，服务端会按日志变化自动重扫）"
        @click="emit('refresh')"
      >
        {{ loading ? '刷新中…' : '刷新' }}
      </button>
      <UiButton variant="primary" :disabled="loading" @click="emit('export')">
        导出 CSV
      </UiButton>
    </div>
  </div>
</template>

<style scoped>
.filter-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
  padding: 18px 0;
}

.filter-bar__left,
.filter-bar__right {
  display: flex;
  align-items: center;
  gap: 10px;
}

.filter-bar__clear,
.filter-bar__refresh {
  padding: 0 4px;
  font-size: 13px;
  color: var(--c-text-primary);
  background: none;
  border: none;
  border-radius: var(--radius-sm);
  transition: color 0.15s var(--ease);
}

.filter-bar__refresh {
  padding: 0 12px;
  height: var(--control-height);
  color: var(--c-text-secondary);
}

.filter-bar__clear:hover:not(:disabled),
.filter-bar__refresh:hover:not(:disabled) {
  color: var(--c-link);
}

.filter-bar__clear:disabled,
.filter-bar__refresh:disabled {
  color: var(--c-text-placeholder);
  cursor: not-allowed;
}
</style>