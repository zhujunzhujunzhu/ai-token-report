<script setup lang="ts">
/** 指纹图标的问号提示，hover 通过原生 title 展示说明文案。 */
defineProps<{ text: string }>()
</script>

<template>
  <span class="ui-hint" :title="text" role="img" aria-label="说明">
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="6.6" fill="none" stroke="currentColor" stroke-width="1.2" />
      <path
        d="M6.35 6.1a1.7 1.7 0 1 1 2.2 1.62c-.42.15-.55.42-.55.84v.34"
        fill="none"
        stroke="currentColor"
        stroke-width="1.2"
        stroke-linecap="round"
      />
      <circle cx="8" cy="11.35" r="0.85" fill="currentColor" />
    </svg>
  </span>
</template>

<style scoped>
.ui-hint {
  display: inline-flex;
  align-items: center;
  color: var(--c-text-placeholder);
  cursor: help;
}

.ui-hint svg {
  width: 14px;
  height: 14px;
}
</style>