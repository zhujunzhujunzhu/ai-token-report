<script setup lang="ts">
/** 公共布局中的浮动助手；页面跳转和收起窗口都不会销毁正在运行的对话。 */
import { defineAsyncComponent, ref, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { useSessionStore } from '../stores/session.js'
import { assistantStatus } from '../api/assistant.js'
import { Minus } from '@element-plus/icons-vue'
import AssistantSymbol from './AssistantSymbol.vue'
const AssistantView = defineAsyncComponent(() => import('../views/AssistantView.vue'))
const session = useSessionStore()
const enabled = ref(false), expanded = ref(false), mounted = ref(false)
const sidebarOpen = ref(false)
const left = ref(0), top = ref(0)
const panel = ref<HTMLElement>()
let drag: { pointer: number; x: number; y: number; left: number; top: number } | undefined
function clamp() {
  if (!panel.value) return
  left.value = Math.max(8, Math.min(left.value, window.innerWidth - panel.value.offsetWidth - 8))
  // ★ 给悬浮入口留出底部空间，缩小视口后不能压住发送按钮。
  top.value = Math.max(8, Math.min(top.value, window.innerHeight - panel.value.offsetHeight - 92))
}
function toggle() {
  if (!mounted.value) { left.value = Math.max(12, window.innerWidth - 504); top.value = Math.max(12, window.innerHeight - 772) }
  mounted.value = true
  expanded.value = !expanded.value
  if (expanded.value) void nextTick(clamp)
}
function startDrag(event: PointerEvent) {
  if (event.button !== 0 || (event.target as HTMLElement).closest('button')) return
  drag = { pointer: event.pointerId, x: event.clientX, y: event.clientY, left: left.value, top: top.value }
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
}
function moveDrag(event: PointerEvent) {
  if (!drag || event.pointerId !== drag.pointer) return
  left.value = drag.left + event.clientX - drag.x
  top.value = drag.top + event.clientY - drag.y
  clamp()
}
function endDrag() { drag = undefined }
async function setSidebar(open: boolean) {
  const previousWidth = panel.value?.offsetWidth ?? 0
  sidebarOpen.value = open
  await nextTick()
  if (panel.value && previousWidth) left.value += previousWidth - panel.value.offsetWidth
  clamp()
}
watch(() => session.generation, async () => {
  const generation = session.generation
  enabled.value = false; expanded.value = false; mounted.value = false; sidebarOpen.value = false
  if (!session.can('stats:read')) return
  const result = await assistantStatus()
  if (generation === session.generation) enabled.value = result.ok && result.data.enabled
}, { immediate: true })
onMounted(() => window.addEventListener('resize', clamp))
onBeforeUnmount(() => window.removeEventListener('resize', clamp))
</script>

<template>
  <template v-if="enabled">
    <button class="assistant-orb" :class="{ expanded }" :aria-expanded="expanded" aria-controls="global-assistant" :aria-label="expanded ? '收起 AI 助手' : '打开 AI 助手'" @click="toggle">
      <AssistantSymbol /><span class="assistant-orb-label">AI</span><span class="assistant-orb-tip">{{ expanded ? '收起助手' : 'AI 助手' }}</span>
    </button>
    <section v-if="mounted" v-show="expanded" id="global-assistant" ref="panel" class="assistant-floating" :class="{ 'with-sidebar': sidebarOpen }" :style="{ left: `${left}px`, top: `${top}px` }" role="region" aria-label="AI 助手浮动窗口">
      <header class="assistant-floating-header" @pointerdown="startDrag" @pointermove="moveDrag" @pointerup="endDrag" @pointercancel="endDrag">
        <div class="assistant-brand"><span class="assistant-brand-icon"><AssistantSymbol /></span><div><strong>AI 助手<span class="assistant-brand-badge">用量分析</span></strong><small>随时提问，也可以继续操作页面</small></div></div>
        <div class="assistant-window-controls"><span class="assistant-drag-handle" aria-hidden="true" title="拖动标题栏移动"><i /><i /><i /><i /><i /><i /></span><button aria-label="收起助手窗口" title="收起助手" @click="expanded = false"><Minus /></button></div>
      </header>
      <div class="assistant-floating-body"><AssistantView :key="session.generation" floating @sessions-toggle="setSidebar" /></div>
    </section>
  </template>
</template>

<style scoped>
.assistant-orb {
  position: fixed; right: 24px; bottom: 24px; width: 60px; height: 60px;
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 1px;
  border: 1px solid #ffffff80; border-radius: 50%; color: #fff;
  background: radial-gradient(circle at 30% 15%, #8fb9ff 0, #4b86f5 35%, #3466db 80%);
  box-shadow: 0 0 0 5px #ffffffb3, 0 9px 26px #3275ed40, inset 0 1px 2px #ffffff66;
  z-index: 1500; cursor: pointer; transition: transform .2s, box-shadow .2s;
}
.assistant-orb > svg { width: 27px; height: 27px; }
.assistant-orb-label { font-size: 9px; font-weight: 750; letter-spacing: 1.5px; line-height: 1; }
.assistant-orb:hover { transform: translateY(-3px); box-shadow: 0 0 0 7px #edf3ffa6, 0 12px 30px #3275ed50; }
.assistant-orb.expanded { background: linear-gradient(145deg, #4b86f5, #3264d6); }
.assistant-orb:focus-visible { outline: 3px solid #93b7f7; outline-offset: 7px; }
.assistant-orb-tip { position: absolute; right: 76px; padding: 7px 12px; border-radius: 9px; color: #53637a; background: #fff; box-shadow: 0 4px 20px #24334b14; font-size: 12px; white-space: nowrap; opacity: 0; pointer-events: none; transform: translateX(5px); transition: opacity .2s, transform .2s; }
.assistant-orb:hover .assistant-orb-tip, .assistant-orb:focus-visible .assistant-orb-tip { opacity: 1; transform: translateX(0); }
.assistant-floating {
  position: fixed; width: min(480px, calc(100vw - 24px)); height: min(680px, calc(100dvh - 104px));
  display: flex; flex-direction: column; z-index: 1499; border: 1px solid #e2e9f4; border-radius: 22px;
  background: #fbfcff; box-shadow: 0 24px 70px #24334b24, 0 4px 16px #24334b0a; overflow: hidden;
}
.assistant-floating-header { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 19px 20px; background: linear-gradient(110deg, #edf3ff, #fff 75%); border-bottom: 1px solid #e8eef7; cursor: move; touch-action: none; user-select: none; flex-shrink: 0; }
.assistant-floating.with-sidebar { width: min(720px, calc(100vw - 24px)); }
.assistant-brand { display: flex; gap: 12px; align-items: center; min-width: 0; }
.assistant-brand-icon { display: grid; place-items: center; width: 42px; height: 42px; flex-shrink: 0; border-radius: 14px; color: #3275ed; background: #fff; border: 1px solid #dce8fc; box-shadow: 0 3px 8px #3275ed0a; }
.assistant-brand-icon svg { width: 26px; height: 26px; }
.assistant-brand strong { display: flex; align-items: center; gap: 9px; font-size: 16px; font-weight: 700; color: #24334b; }
.assistant-brand-badge { padding: 3px 6px; font-size: 9px; font-weight: 500; border-radius: 5px; background: #e7effd; color: #5d7bad; }
.assistant-brand small { display: block; color: #7c8aa0; font-size: 11px; margin-top: 6px; }
.assistant-window-controls { display: flex; align-items: center; gap: 12px; }
.assistant-drag-handle { display: grid; grid-template-columns: repeat(2, 3px); gap: 3px; padding: 5px; }
.assistant-drag-handle i { width: 3px; height: 3px; border-radius: 50%; background: #bcc9db; }
.assistant-window-controls button { display: grid; place-items: center; width: 30px; height: 30px; border: 0; background: transparent; border-radius: 9px; cursor: pointer; color: #7c8aa0; transition: background .15s; }
.assistant-window-controls button svg { width: 18px; height: 18px; }
.assistant-window-controls button:hover { background: #eaf0fa; color: #3275ed; }
.assistant-floating-body { padding: 0 20px 14px; flex: 1; min-height: 0; overflow: hidden; }
@media (max-width: 600px) {
  .assistant-orb { right: 18px; bottom: 18px; width: 54px; height: 54px; }
  .assistant-floating { border-radius: 18px; }
  .assistant-floating-body { padding: 0 14px 12px; }
  .assistant-floating-header { padding: 14px; }
  .assistant-brand { gap: 9px; }
  .assistant-brand small { font-size: 10px; }
  .assistant-window-controls { gap: 3px; }
  .assistant-drag-handle { display: none; }
}
@media (max-width: 700px) { .assistant-floating.with-sidebar { width: min(480px, calc(100vw - 24px)); } }
@media (prefers-reduced-motion: reduce) { .assistant-orb, .assistant-orb-tip { transition: none; } }
</style>
