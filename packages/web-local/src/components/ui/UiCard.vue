<script setup lang="ts">
/** 灰底圆角卡片容器，页面中所有信息块的基础外壳。 */
withDefaults(defineProps<{ padding?: string }>(), { padding: '20px' })
</script>

<template>
  <section class="ui-card" :style="{ padding }">
    <slot />
  </section>
</template>

<style scoped>
.ui-card {
  background-color: var(--c-bg-subtle);
  border-radius: var(--radius-lg);
  transition: background-color 0.15s var(--ease);
}

.ui-card:hover {
  background-color: var(--c-bg-muted);
}
</style>