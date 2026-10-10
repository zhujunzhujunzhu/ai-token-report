<script setup lang="ts">
/** 私有对话列表的虚拟视口；分页状态归会话控制器，视口只负责触底与交互。 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ElButton } from 'element-plus'
import type { AssistantConversationSession } from '../utils/assistantConversations.js'
import { ASSISTANT_SESSION_ROW_HEIGHT, assistantSessionWindow, assistantSessionsNearEnd } from '../utils/assistantSessionWindow.js'

const props = defineProps<{
  sessions: AssistantConversationSession[]
  active: string
  total: number
  loading: boolean
  hasMore: boolean
  error: string
  disabled: boolean
  activity: (id: string) => { label: string; running: boolean }
}>()
const emit = defineEmits<{ open: [id: string]; remove: [id: string]; 'load-more': [] }>()
const viewport = ref<HTMLElement>()
const scrollTop = ref(0), viewportHeight = ref(400)
const window = computed(() => assistantSessionWindow(props.sessions.length, scrollTop.value, viewportHeight.value))
const visible = computed(() => props.sessions.slice(window.value.start, window.value.end).map((item, offset) => ({ item, index: window.value.start + offset, activity: props.activity(item.session_id) })))
let observer: ResizeObserver | undefined
let disposed = false

function measure() {
  const element = viewport.value
  if (!element || disposed) return
  scrollTop.value = element.scrollTop
  viewportHeight.value = element.clientHeight
  if (!props.loading && !props.error && props.hasMore && assistantSessionsNearEnd(props.sessions.length, element.scrollTop, element.clientHeight)) emit('load-more')
}
async function moveFocus(event: KeyboardEvent) {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || !props.sessions.length) return
  event.preventDefault()
  const element = viewport.value!
  const row = (event.target as HTMLElement).closest<HTMLElement>('[data-session-index]')
  const current = row ? Number(row.dataset.sessionIndex) : Math.max(0, props.sessions.findIndex(item => item.session_id === props.active))
  const index = event.key === 'Home' ? 0 : event.key === 'End' ? props.sessions.length - 1 : Math.max(0, Math.min(props.sessions.length - 1, current + (event.key === 'ArrowDown' ? 1 : -1)))
  const top = index * ASSISTANT_SESSION_ROW_HEIGHT
  if (top < element.scrollTop) element.scrollTop = top
  else if (top + ASSISTANT_SESSION_ROW_HEIGHT > element.scrollTop + element.clientHeight) element.scrollTop = top + ASSISTANT_SESSION_ROW_HEIGHT - element.clientHeight
  measure()
  await nextTick()
  element.querySelector<HTMLButtonElement>(`[data-session-index="${index}"] .assistant-session-open`)?.focus({ preventScroll: true })
}
onMounted(() => {
  observer = new ResizeObserver(measure)
  observer.observe(viewport.value!)
  measure()
})
watch(() => [props.sessions.length, props.loading, props.hasMore, props.error], async () => { await nextTick(); measure() })
onBeforeUnmount(() => { disposed = true; observer?.disconnect() })
</script>

<template>
  <div ref="viewport" class="assistant-session-list" role="list" aria-label="对话列表" :aria-busy="loading" tabindex="0" @scroll.passive="measure" @keydown="moveFocus">
    <p v-if="!sessions.length && !loading && !error" class="assistant-list-empty">你的对话会出现在这里。</p>
    <div class="assistant-session-spacer" :style="{ height: `${window.height}px` }">
      <div class="assistant-session-window" :style="{ transform: `translateY(${window.offset}px)` }">
        <div v-for="{ item, index, activity: state } in visible" :key="item.session_id" class="assistant-session-row" :data-session-index="index" role="listitem" :aria-posinset="index + 1" :aria-setsize="total">
          <div class="assistant-session" :class="{ selected: item.session_id === active }">
            <button class="assistant-session-open" :title="item.title" :aria-current="item.session_id === active ? 'true' : undefined" @click="emit('open', item.session_id)"><strong>{{ item.title }}</strong><small>{{ item.local ? '新对话 · 尚未保存' : `${item.turn_count} 轮 · ${new Date(item.updated_at_ms).toLocaleDateString()}` }}</small><span v-if="state.label" class="assistant-session-progress" :class="{ running: state.running }">{{ state.label }}</span></button>
            <el-button v-if="!item.local" text size="small" class="assistant-session-delete" :disabled="disabled" :aria-label="`删除对话：${item.title}`" @click="emit('remove', item.session_id)">删除</el-button>
          </div>
        </div>
      </div>
    </div>
    <div class="assistant-session-status" role="status" aria-live="polite">
      <span v-if="loading">正在加载对话…</span>
      <template v-else-if="error"><span>{{ error }}</span><button type="button" @click="emit('load-more')">重试</button></template>
      <span v-else-if="hasMore">向下滚动加载更多</span>
      <span v-else-if="sessions.length">已加载全部对话</span>
    </div>
  </div>
</template>

<style scoped>
.assistant-session-list { flex: 1; min-height: 0; overflow: auto; scrollbar-width: thin; scrollbar-color: #cbd6e8 transparent; overscroll-behavior: contain; overflow-anchor: none; }
.assistant-session-list:focus-visible { outline: 2px solid #3275ed; outline-offset: -2px; }
.assistant-session-spacer { position: relative; }
.assistant-session-window { position: absolute; inset: 0 0 auto; }
.assistant-session-row { height: 64px; box-sizing: border-box; padding-bottom: 3px; }
.assistant-session { display: flex; align-items: flex-start; gap: 5px; height: 100%; border-radius: 8px; }
.assistant-session:hover { background: #eaf0fc; }
.assistant-session.selected { background: #fff; box-shadow: 0 2px 6px #24334b05; }
.assistant-session-open { flex: 1; min-width: 0; height: 100%; text-align: left; border: 0; border-radius: 8px; background: transparent; padding: 6px 8px; color: inherit; cursor: pointer; }
.assistant-session-open:focus-visible { outline: 2px solid #3275ed; outline-offset: -2px; }
.assistant-session strong, .assistant-session small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.assistant-session strong { font-size: 12px; font-weight: 500; line-height: 16px; }
.assistant-session small { color: #8b99ad; margin-top: 4px; font-size: 10px; line-height: 14px; }
.assistant-session-delete { color: #8b99ad; font-size: 10px; margin-top: 6px; }
.assistant-session-progress { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #7891b3; font-size: 10px; line-height: 12px; margin-top: 2px; }
.assistant-session-progress.running { color: #3275ed; }
.assistant-session-progress.running::before { content: ''; display: inline-block; width: 5px; height: 5px; border-radius: 50%; background: currentColor; margin-right: 5px; }
.assistant-list-empty { font-size: 12px; color: #7c8aa0; margin: 12px 0 5px; }
.assistant-session-status { min-height: 32px; padding: 8px 2px; box-sizing: border-box; text-align: center; font-size: 11px; line-height: 16px; color: #8b99ad; }
.assistant-session-status button { margin-left: 8px; padding: 0; border: 0; background: transparent; color: #3275ed; cursor: pointer; font: inherit; }
</style>
