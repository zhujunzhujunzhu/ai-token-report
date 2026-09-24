<script setup lang="ts">
/**
 * 基础下拉选择器。
 * 点击外部自动收起，支持 v-model 双向绑定。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

import type { SelectOption } from '@/types/usage'

const props = withDefaults(
  defineProps<{
    modelValue: string
    options: SelectOption[]
    /** 是否在触发器内展示当前选中项文案 */
    showValue?: boolean
  }>(),
  { showValue: true },
)

const emit = defineEmits<{ 'update:modelValue': [value: string] }>()

const rootRef = ref<HTMLElement | null>(null)
const open = ref(false)

const currentLabel = computed(
  () => props.options.find((option) => option.value === props.modelValue)?.label ?? '',
)

function toggle(): void {
  open.value = !open.value
}

function select(value: string): void {
  emit('update:modelValue', value)
  open.value = false
}

function handleClickOutside(event: MouseEvent): void {
  if (rootRef.value && !rootRef.value.contains(event.target as Node)) {
    open.value = false
  }
}

onMounted(() => document.addEventListener('click', handleClickOutside))
onBeforeUnmount(() => document.removeEventListener('click', handleClickOutside))
</script>

<template>
  <div ref="rootRef" class="ui-select">
    <button
      type="button"
      class="ui-select__trigger"
      :class="{ 'is-open': open }"
      @click="toggle"
    >
      <span class="ui-select__prefix"><slot name="prefix" /></span>
      <span v-if="showValue" class="ui-select__value">{{ currentLabel }}</span>
      <svg class="ui-select__caret" viewBox="0 0 12 12" aria-hidden="true">
        <path
          d="M2.5 4.5 6 8l3.5-3.5"
          fill="none"
          stroke="currentColor"
          stroke-width="1.4"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
    </button>

    <ul v-if="open" class="ui-select__menu" role="listbox">
      <li
        v-for="option in options"
        :key="option.value"
        class="ui-select__option"
        :class="{ 'is-active': option.value === modelValue }"
        role="option"
        :aria-selected="option.value === modelValue"
        @click="select(option.value)"
      >
        {{ option.label }}
      </li>
    </ul>
  </div>
</template>

<style scoped>
.ui-select {
  position: relative;
}

.ui-select__trigger {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: var(--control-height);
  padding: 0 12px;
  font-size: 13px;
  color: var(--c-text-primary);
  background-color: var(--c-bg-subtle);
  border: 1px solid transparent;
  border-radius: var(--radius-pill);
  transition: background-color 0.15s var(--ease), border-color 0.15s var(--ease);
}

.ui-select__trigger:hover,
.ui-select__trigger.is-open {
  background-color: var(--c-bg-hover);
}

.ui-select__prefix {
  color: var(--c-text-tertiary);
}

.ui-select__value {
  color: var(--c-text-primary);
}

.ui-select__caret {
  width: 12px;
  height: 12px;
  color: var(--c-text-secondary);
  transition: transform 0.15s var(--ease);
}

.ui-select__trigger.is-open .ui-select__caret {
  transform: rotate(180deg);
}

.ui-select__menu {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  z-index: 20;
  min-width: 140px;
  margin: 0;
  padding: 4px;
  list-style: none;
  background-color: #fff;
  border: 1px solid var(--c-border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-md);
}

.ui-select__option {
  padding: 6px 10px;
  font-size: 13px;
  color: var(--c-text-primary);
  border-radius: var(--radius-sm);
  cursor: pointer;
  white-space: nowrap;
}

.ui-select__option:hover {
  background-color: var(--c-bg-hover);
}

.ui-select__option.is-active {
  font-weight: 500;
  background-color: var(--c-bg-muted);
}
</style>