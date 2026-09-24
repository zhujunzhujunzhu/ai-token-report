<script setup lang="ts">
/** 胶囊按钮，支持 primary（黑底）/ ghost（灰底）两种外观。 */
withDefaults(defineProps<{ variant?: 'primary' | 'ghost' }>(), { variant: 'ghost' })
</script>

<template>
  <button type="button" class="ui-button" :class="`ui-button--${variant}`">
    <slot />
  </button>
</template>

<style scoped>
.ui-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: var(--control-height);
  padding: 0 18px;
  font-size: 13px;
  font-weight: 500;
  line-height: 1;
  border: 1px solid transparent;
  border-radius: var(--radius-pill);
  transition: background-color 0.15s var(--ease), color 0.15s var(--ease);
}

.ui-button--primary {
  color: #fff;
  background-color: var(--c-bg-inverse);
}

.ui-button--primary:hover {
  background-color: #000;
}

.ui-button--ghost {
  color: var(--c-text-primary);
  background-color: var(--c-bg-subtle);
}

.ui-button--ghost:hover {
  background-color: var(--c-bg-hover);
}
</style>