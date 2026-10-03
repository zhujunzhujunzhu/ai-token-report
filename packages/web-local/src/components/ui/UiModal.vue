<script setup lang="ts">
/**
 * 通用弹框 —— 遮罩 + 居中面板。
 *
 * ## 为什么不用 `Teleport`
 *
 * `verify/verify-render.ts` 走 SSR 真实渲染组件树，读的是渲染出来的 HTML 串。
 * `Teleport` 会把内容搬到另一个容器里，那些断言就**看不见**弹框里的文案了
 * （而「弹框里到底有哪几栏」正是这一版最需要被钉住的东西）。
 * 遮罩本身是 `position: fixed`，不需要 Teleport 也能盖住整页。
 *
 * ## 关闭的三种方式都在
 *
 * 右上角 ×、`Esc`、点遮罩空白处。⚠️ `Esc` 的监听只在挂载后加
 * （SSR 下没有 `window`），且卸载时摘掉 —— 否则每次开关弹框都会多一个监听器。
 */
import { onBeforeUnmount, onMounted } from 'vue'

const props = withDefaults(
  defineProps<{
    /** 标题。同时作为 `aria-label`（弹框必须有个能被读屏念出来的名字）。 */
    title: string
    /** 标题下的一句说明。 */
    subtitle?: string
  }>(),
  { subtitle: '' },
)

const emit = defineEmits<{ (e: 'close'): void }>()

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') emit('close')
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <div class="modal" role="presentation" @click.self="emit('close')">
    <section class="modal__panel" role="dialog" aria-modal="true" :aria-label="props.title">
      <header class="modal__head">
        <h2 class="modal__title">{{ props.title }}</h2>
        <button type="button" class="modal__close" aria-label="关闭" @click="emit('close')">×</button>
      </header>

      <p v-if="props.subtitle" class="modal__sub">{{ props.subtitle }}</p>

      <slot />
    </section>
  </div>
</template>

<style scoped>
.modal {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 32px 16px;
  overflow-y: auto;
  background-color: rgba(0, 0, 0, 0.32);
}

.modal__panel {
  width: 100%;
  max-width: 460px;
  margin: auto;
  padding: 28px;
  background-color: #fff;
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg);
}

.modal__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.modal__title {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
  color: var(--c-text-primary);
}

.modal__close {
  flex: none;
  width: 28px;
  height: 28px;
  padding: 0;
  font-size: 18px;
  line-height: 1;
  color: var(--c-text-tertiary);
  background: none;
  border: none;
  border-radius: var(--radius-sm);
}

.modal__close:hover {
  color: var(--c-text-primary);
  background-color: var(--c-bg-hover);
}

.modal__sub {
  margin: 8px 0 0;
  font-size: 13px;
  line-height: 1.6;
  color: var(--c-text-secondary);
}
</style>
