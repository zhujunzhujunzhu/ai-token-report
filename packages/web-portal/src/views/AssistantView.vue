<script setup lang="ts">
/** 全局助手对话面板：与看板筛选独立，每个用户只访问服务端绑定的私有会话。 */
import { ref, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElAlert, ElButton, ElInput, ElMessageBox } from 'element-plus'
import { ArrowUp, ChatDotRound, Plus, Lock, ArrowRight, DataAnalysis, Position, Close } from '@element-plus/icons-vue'
import { ASSISTANT_PAGES, type AssistantMessage, type AssistantSession, type AssistantStatus } from '@ai-token-report/shared'
import AssistantSymbol from '../components/AssistantSymbol.vue'
import AssistantResultCard from '../components/AssistantResult.vue'
import { renderAssistantMarkdown } from '../utils/assistantMarkdown.js'
import { assistantStatus, assistantSessions, assistantDetail, chatAssistant, deleteAssistantSession } from '../api/assistant.js'
const props = defineProps<{ floating?: boolean }>()
const emit = defineEmits<{ 'sessions-toggle': [open: boolean] }>()
const route = useRoute(), router = useRouter()
const showSessions = ref(!props.floating)
const transcript = ref<HTMLElement>()
const composer = ref<InstanceType<typeof ElInput>>()
const status = ref<AssistantStatus | null>(null)
const sessions = ref<AssistantSession[]>([])
const active = ref<string>()
const messages = ref<AssistantMessage[]>([])
const sources = ref<Array<{ tool: string; query: string; status: number }>>([])
const prompt = ref('')
const loading = ref(false)
const sending = ref(false)
const error = ref('')
let controller: AbortController | undefined
let selection = 0
const suggestions = [
  { title: '看看用量趋势', detail: '最近七天的用量有什么变化？', prompt: '最近七天的用量趋势如何？', icon: DataAnalysis },
  { title: '了解模型分布', detail: '哪些模型贡献了最多用量？', prompt: '最近七天哪些模型用量最多？', icon: ChatDotRound },
  { title: '打开调用明细', detail: '让助手带你到需要的页面', prompt: '打开调用明细页面', icon: Position },
]
function suggest(value: string) { prompt.value = value; composer.value?.focus() }
const toolNames: Record<string, string> = { stats_overview: '用量总览', stats_series: '用量趋势', stats_breakdown: '用量分布', stats_records: '调用明细', stats_diagnostics: '采集诊断', stats_pricing: '模型单价', stats_providers: '厂商目录', stats_sources: '来源目录', portal_navigate: '页面导航' }
function sourceDescription(source: { tool: string; query: string }) {
  if (source.tool === 'portal_navigate') return ASSISTANT_PAGES.find(page => page.path === source.query)?.title ?? '站内页面'
  const query = new URLSearchParams(source.query)
  const periods: Record<string, string> = { today: '今天', yesterday: '昨天', last7d: '最近 7 天', last30d: '最近 30 天', month: '本月' }
  const timeWindow = periods[query.get('period') ?? ''] ?? '自定义时间范围'
  return [timeWindow, query.get('provider'), query.get('model')].filter(Boolean).join(' · ')
}
async function refresh() {
  const result = await assistantSessions()
  if (result.ok) sessions.value = result.data.sessions
  else error.value = result.error
}
async function open(id?: string) {
  if (sending.value) return
  if (props.floating && window.matchMedia('(max-width: 700px)').matches) showSessions.value = false
  const version = ++selection
  active.value = id
  messages.value = []; sources.value = []; error.value = ''
  loading.value = false
  if (!id) return
  loading.value = true
  try {
    const result = await assistantDetail(id)
    if (version !== selection) return
    if (result.ok) messages.value = result.data.messages
    else error.value = result.error
  } finally { if (version === selection) loading.value = false }
}
async function remove(id: string) {
  try {
    await ElMessageBox.confirm('删除将同时移除对话记录和 DSH 会话，无法恢复。', '删除对话', { type: 'warning' })
    await deleteAssistantSession(id)
    if (active.value === id) await open()
    await refresh()
  } catch (err) { if (err instanceof Error) error.value = err.message }
}
async function send() {
  if (!prompt.value.trim() || sending.value || loading.value || !status.value?.enabled) return
  const question = prompt.value.trim()
  prompt.value = ''; error.value = ''; sources.value = []
  messages.value.push({ role: 'user', text: question }, { role: 'assistant', text: '' })
  const reply = messages.value.length - 1
  sending.value = true
  controller = new AbortController()
  try {
    await chatAssistant(question, active.value, controller.signal, event => {
      if (event.type === 'session') active.value = event.session.session_id
      else if (event.type === 'text') messages.value[reply]!.text += event.text
      else if (event.type === 'result') (messages.value[reply]!.results ??= []).push(event.result)
      else if (event.type === 'tool') sources.value.push(event)
      else if (event.type === 'error') error.value = event.reason
      else if (event.type === 'navigate') void router.push(event.path).catch(() => { error.value = '页面跳转失败，请从导航栏打开目标页面' })
    }, route.path)
  } catch (err) { error.value = controller.signal.aborted ? '对话已停止' : err instanceof Error ? err.message : '助手请求失败' }
  finally { sending.value = false; await refresh() }
}
onMounted(async () => {
  const result = await assistantStatus()
  if (result.ok) { status.value = result.data; if (status.value.enabled) await refresh() }
  else error.value = result.error
})
onBeforeUnmount(() => { selection++; controller?.abort() })
watch(showSessions, value => emit('sessions-toggle', value), { immediate: true })
watch(() => [messages.value.at(-1)?.text, messages.value.at(-1)?.results?.length], async () => { await nextTick(); if (transcript.value) transcript.value.scrollTop = messages.value.length ? transcript.value.scrollHeight : 0 })
</script>

<template>
  <div class="assistant-page" :class="{ floating }">
    <div class="assistant-heading">
      <div v-if="!floating"><h1>AI 助手</h1><p>查询用量、分析趋势，回答基于你有权访问的数据。</p></div>
      <button v-if="floating" class="assistant-toolbar-button" :class="{ active: showSessions }" :aria-expanded="showSessions" @click="showSessions = !showSessions"><ChatDotRound />我的对话<span v-if="sessions.length" class="assistant-count">{{ sessions.length }}</span></button>
      <button class="assistant-toolbar-button assistant-new" :disabled="sending" @click="open()"><Plus />新建对话</button>
    </div>
    <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon />
    <el-alert v-if="status && !status.enabled" title="管理员尚未启用 DSH 助手" type="info" :closable="false" show-icon />
    <div class="assistant-grid">
      <aside v-if="showSessions" class="assistant-sessions" aria-label="我的对话">
        <div class="assistant-sessions-heading"><div><h2>我的对话</h2><span>独立空间 · 仅你可见</span></div><button v-if="floating" aria-label="收起对话侧栏" @click="showSessions = false"><Close /></button></div>
        <p v-if="!sessions.length" class="assistant-list-empty">你的对话会出现在这里。</p>
        <div v-for="item in sessions" :key="item.session_id" class="assistant-session" :class="{ selected: item.session_id === active }">
          <button class="assistant-session-open" :disabled="sending" :aria-current="item.session_id === active ? 'true' : undefined" @click="open(item.session_id)"><strong>{{ item.title }}</strong><small>{{ item.turn_count }} 轮 · {{ new Date(item.updated_at_ms).toLocaleDateString() }}</small></button>
          <el-button text size="small" class="assistant-session-delete" :disabled="sending" @click="remove(item.session_id)">删除</el-button>
        </div>
      </aside>
      <section class="assistant-chat" aria-label="助手对话">
        <div ref="transcript" class="assistant-transcript" aria-live="polite" :aria-busy="sending || loading">
          <p v-if="loading" class="assistant-loading">正在读取对话…</p>
          <div v-else-if="!messages.length" class="assistant-welcome">
            <div class="assistant-welcome-mark"><AssistantSymbol /></div>
            <span class="assistant-eyebrow">你的用量分析伙伴</span>
            <h2>今天想了解什么？</h2>
            <p>一起看看用量背后的变化，<br />也可以让我带你打开需要的页面。</p>
            <div class="assistant-suggestions">
              <button v-for="item in suggestions" :key="item.title" :disabled="!status?.enabled || loading" @click="suggest(item.prompt)"><span class="assistant-suggestion-icon"><component :is="item.icon" /></span><span><strong>{{ item.title }}</strong><small>{{ item.detail }}</small></span><ArrowRight class="assistant-suggestion-arrow" /></button>
            </div>
          </div>
          <article v-for="(message, index) in messages" :key="index" class="assistant-message" :class="message.role">
            <div class="assistant-message-label"><span class="assistant-avatar" aria-hidden="true"><AssistantSymbol v-if="message.role === 'assistant'" /><span v-else>你</span></span><strong>{{ message.role === 'user' ? '你' : 'AI 助手' }}</strong></div>
            <div class="assistant-message-bubble" :class="{ 'with-results': message.results?.length }"><div v-if="message.text && message.role === 'assistant'" class="assistant-markdown" v-html="renderAssistantMarkdown(message.text)" /><p v-else-if="message.text">{{ message.text }}</p><div v-else-if="sending" class="assistant-thinking"><span class="assistant-thinking-dots" aria-hidden="true"><i /><i /><i /></span>正在查询与思考</div><p v-else-if="!message.results?.length" class="assistant-no-answer">本轮没有回答</p><AssistantResultCard v-for="result in message.results" :key="result.result_id" :result="result" /></div>
          </article>
          <details v-if="sources.length" class="assistant-sources">
            <summary><span class="assistant-source-indicator" />本轮查询来源<span class="assistant-count">{{ sources.length }}</span></summary>
            <div v-for="(source, index) in sources" :key="index" class="assistant-source"><div><strong>{{ toolNames[source.tool] ?? '查询工具' }}</strong><small>{{ sourceDescription(source) }}</small></div><span :class="{ failed: source.status >= 400 }">{{ source.status === 202 ? '已请求' : source.status < 400 ? '已完成' : '未完成' }}</span></div>
          </details>
        </div>
        <form class="assistant-composer" @submit.prevent="send">
          <el-input ref="composer" v-model="prompt" type="textarea" :autosize="{ minRows: 2, maxRows: 5 }" maxlength="4096" placeholder="问问用量、模型，或让助手打开页面…" :disabled="!status?.enabled || sending || loading" aria-label="问题" @keydown.ctrl.enter.prevent="send" @keydown.meta.enter.prevent="send" />
          <div class="assistant-actions"><span>{{ prompt.length ? `${prompt.length} / 4096` : 'Ctrl / ⌘ + Enter 发送' }}</span><el-button v-if="sending" class="assistant-stop" @click="controller?.abort()"><span class="assistant-stop-icon" />停止</el-button><el-button v-else class="assistant-send" type="primary" native-type="submit" :disabled="!prompt.trim() || !status?.enabled || loading">发送<ArrowUp /></el-button></div>
        </form>
        <div v-if="status?.enabled" class="assistant-footer">
          <details class="assistant-privacy"><summary><Lock />独立空间 · 保留 {{ status.retention_days }} 天</summary><p>提问和查询结果会发送给配置的模型服务。记录仅你可见，删除对话会同时移除全部记录。</p></details>
          <span>回答请结合来源核对</span>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.assistant-page { color: #24334b; }
.assistant-heading { display: flex; align-items: center; gap: 8px; padding: 14px 0; margin-bottom: 12px; }
.assistant-heading h1 { font-size: 25px; }
.assistant-heading p { color: #7c8aa0; font-size: 13px; }
.assistant-toolbar-button { display: inline-flex; align-items: center; gap: 7px; min-height: 32px; padding: 6px 9px; background: transparent; border: 0; border-radius: 8px; color: #68778b; font-size: 12px; transition: background .15s, color .15s; }
.assistant-toolbar-button svg { width: 15px; height: 15px; }
.assistant-toolbar-button:hover, .assistant-toolbar-button.active { color: #3275ed; background: #edf3ff; }
.assistant-toolbar-button:disabled { color: #a5afbe; cursor: not-allowed; }
.assistant-new { margin-left: auto; }
.assistant-count { display: inline-flex; align-items: center; justify-content: center; min-width: 18px; height: 17px; padding: 0 5px; border-radius: 5px; background: #eaf0f8; color: #7b8aa0; font-size: 10px; }
.assistant-grid { display: grid; grid-template-columns: 240px minmax(0, 1fr); gap: 18px; }
.assistant-sessions { padding: 12px; max-height: 70vh; overflow: auto; border: 1px solid #e5edf8; border-radius: 12px; background: #f2f6fd; }
.assistant-sessions-heading { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 16px; }
.assistant-sessions-heading h2 { font-size: 12px; color: #53637a; font-weight: 600; margin: 0; }
.assistant-sessions-heading span { display: block; font-size: 10px; color: #91a0b6; margin-top: 5px; }
.assistant-sessions-heading button { width: 24px; height: 24px; padding: 5px; border: 0; border-radius: 6px; color: #8b99ad; background: transparent; }
.assistant-sessions-heading button:hover { background: #e5edf9; color: #3275ed; }
.assistant-sessions-heading svg { width: 14px; height: 14px; }
.assistant-list-empty { font-size: 12px; color: #7c8aa0; margin: 12px 0 5px; }
.assistant-session { display: flex; align-items: center; gap: 5px; border-radius: 8px; margin-bottom: 3px; }
.assistant-session:hover { background: #eaf0fc; }
.assistant-session.selected { background: #fff; box-shadow: 0 2px 6px #24334b05; }
.assistant-session-open { flex: 1; min-width: 0; text-align: left; border: 0; background: transparent; padding: 8px; color: inherit; }
.assistant-session strong, .assistant-session small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.assistant-session strong { font-size: 12px; font-weight: 500; }
.assistant-session small { color: #8b99ad; margin-top: 5px; font-size: 10px; }
.assistant-session-delete { color: #8b99ad; font-size: 10px; }
.assistant-chat { display: flex; flex-direction: column; min-height: 65vh; min-width: 0; }
.assistant-transcript { flex: 1; max-height: 60vh; overflow: auto; padding: 8px 2px 20px; scrollbar-width: thin; scrollbar-color: #d8e2f2 transparent; overscroll-behavior: contain; }
.assistant-loading { padding: 40px 0; color: #7c8aa0; text-align: center; font-size: 13px; }
.assistant-welcome { padding: 6px 0 12px; text-align: center; }
.assistant-welcome-mark { display: grid; place-items: center; width: 48px; height: 48px; margin: 0 auto 10px; border: 1px solid #e0e9fa; border-radius: 17px; color: #3275ed; background: linear-gradient(145deg, #fff, #eaf1ff); box-shadow: 0 6px 18px #3275ed0a; }
.assistant-welcome-mark svg { width: 29px; height: 29px; }
.assistant-eyebrow { font-size: 10px; color: #8c9bb0; letter-spacing: 1px; }
.assistant-welcome h2 { margin: 6px 0 8px; font-size: 22px; font-weight: 650; letter-spacing: -.5px; }
.assistant-welcome > p { font-size: 12px; line-height: 1.7; color: #7c8aa0; margin-bottom: 14px; }
.assistant-suggestions { display: grid; gap: 8px; text-align: left; }
.assistant-suggestions button { display: flex; align-items: center; gap: 12px; padding: 10px 12px; border: 1px solid #e6edf7; border-radius: 12px; background: #fff; color: #53637a; text-align: left; transition: border-color .15s, background .15s, transform .15s; }
.assistant-suggestions button:hover:not(:disabled) { border-color: #bfd3f7; background: #f5f8ff; transform: translateX(2px); }
.assistant-suggestions button:disabled { opacity: .55; cursor: not-allowed; }
.assistant-suggestion-icon { width: 32px; height: 32px; display: grid; place-items: center; flex-shrink: 0; background: #edf3ff; color: #6590da; border-radius: 9px; }
.assistant-suggestion-icon svg { width: 17px; height: 17px; }
.assistant-suggestions strong { display: block; font-weight: 500; font-size: 12px; }
.assistant-suggestions small { display: block; color: #93a0b3; font-size: 10px; margin-top: 4px; }
.assistant-suggestion-arrow { margin-left: auto; width: 14px; height: 14px; flex-shrink: 0; color: #a6b6ce; }
.assistant-message { margin-bottom: 22px; }
.assistant-message-label { display: flex; align-items: center; gap: 7px; margin-bottom: 8px; }
.assistant-message-label strong { font-size: 11px; font-weight: 500; color: #8593a9; }
.assistant-avatar { display: grid; place-items: center; width: 24px; height: 24px; border-radius: 8px; background: #eaf1ff; color: #3275ed; font-size: 10px; }
.assistant-avatar svg { width: 17px; height: 17px; }
.assistant-message-bubble { border-radius: 3px 13px 13px; padding: 13px 15px; background: #fff; border: 1px solid #e8edf6; color: #465771; }
.assistant-message-bubble p { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 13px; line-height: 1.9; margin: 0; }
.assistant-message-bubble.with-results { padding: 0; background: transparent; border: 0; }
.assistant-message-bubble.with-results > .assistant-markdown { padding: 13px 15px; border: 1px solid #e8edf6; border-radius: 3px 13px 13px; background: #fff; }
.assistant-markdown { font-size: 13px; line-height: 1.9; overflow-wrap: anywhere; }
.assistant-markdown :deep(p) { margin: 0 0 10px; white-space: normal; }
.assistant-markdown :deep(p:last-child) { margin-bottom: 0; }
.assistant-markdown :deep(h1), .assistant-markdown :deep(h2), .assistant-markdown :deep(h3) { margin: 16px 0 9px; font-size: 15px; line-height: 1.5; color: #355681; }
.assistant-markdown :deep(:first-child) { margin-top: 0; }
.assistant-markdown :deep(ul), .assistant-markdown :deep(ol) { padding-left: 20px; margin: 8px 0; }
.assistant-markdown :deep(li) { margin: 4px 0; }
.assistant-markdown :deep(blockquote) { margin: 10px 0; padding: 8px 12px; border-left: 3px solid #bfd3f7; background: #f5f8fd; color: #7c8aa0; }
.assistant-markdown :deep(code) { padding: 2px 5px; background: #f0f4fb; border-radius: 4px; font-size: 11px; }
.assistant-markdown :deep(pre) { padding: 12px; overflow: auto; background: #f3f6fc; border-radius: 9px; font-size: 11px; }
.assistant-markdown :deep(pre code) { padding: 0; white-space: pre; }
.assistant-markdown :deep(.assistant-markdown-table) { max-width: 100%; overflow: auto; margin: 12px 0; }
.assistant-markdown :deep(table) { border-collapse: collapse; min-width: 100%; font-size: 11px; }
.assistant-markdown :deep(th), .assistant-markdown :deep(td) { border: 1px solid #e5edf8; padding: 7px 10px; white-space: nowrap; }
.assistant-markdown :deep(th) { background: #f3f7fd; font-weight: 500; }
.assistant-message.user { margin-left: 35px; }
.assistant-message.user .assistant-message-label { flex-direction: row-reverse; }
.assistant-message.user .assistant-avatar { background: #eef1f7; color: #7c8aa0; }
.assistant-message.user .assistant-message-bubble { border: 0; border-radius: 13px 3px 13px 13px; background: #eaf1ff; color: #355681; }
.assistant-thinking { display: flex; align-items: center; gap: 9px; font-size: 12px; color: #8c9bb0; min-height: 24px; }
.assistant-thinking-dots { display: inline-flex; gap: 3px; }
.assistant-thinking-dots i { width: 4px; height: 4px; background: #8fafe6; border-radius: 50%; animation: assistant-dot 1.2s infinite; }
.assistant-thinking-dots i:nth-child(2) { animation-delay: .15s; }
.assistant-thinking-dots i:nth-child(3) { animation-delay: .3s; }
@keyframes assistant-dot { 0%, 70%, 100% { opacity: .35; transform: translateY(0); } 35% { opacity: 1; transform: translateY(-3px); } }
.assistant-sources { margin-top: -8px; margin-bottom: 14px; border: 1px solid #e6edf6; border-radius: 10px; background: #f6f9fd; }
.assistant-sources summary { display: flex; gap: 7px; align-items: center; padding: 10px 12px; cursor: pointer; list-style: none; font-size: 11px; color: #7c8aa0; }
.assistant-sources summary::-webkit-details-marker, .assistant-privacy summary::-webkit-details-marker { display: none; }
.assistant-sources summary::after { content: '⌄'; margin-left: auto; font-size: 14px; }
.assistant-sources[open] summary::after { transform: rotate(180deg); }
.assistant-source-indicator { width: 5px; height: 5px; background: #74b5a6; border-radius: 50%; }
.assistant-source { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 9px 12px; border-top: 1px solid #e8eef7; }
.assistant-source strong { display: block; font-size: 11px; font-weight: 500; }
.assistant-source small { display: block; color: #8c9bb0; font-size: 10px; margin-top: 4px; overflow-wrap: anywhere; }
.assistant-source > span { white-space: nowrap; color: #5c9d8e; font-size: 10px; }
.assistant-source > span.failed { color: #dc5961; }
.assistant-composer { flex-shrink: 0; border: 1px solid #dce6f6; border-radius: 15px; background: #fff; padding: 11px 12px 9px; box-shadow: 0 4px 14px #24334b04; transition: border-color .2s, box-shadow .2s; }
.assistant-composer:focus-within { border-color: #9fbef2; box-shadow: 0 0 0 3px #edf3ff; }
.assistant-composer :deep(.el-textarea__inner) { border: 0; border-radius: 0; box-shadow: none; padding: 2px 0; font-size: 12px; line-height: 1.8; color: #465771; background: transparent; resize: none; }
.assistant-composer :deep(.el-textarea__inner::placeholder) { color: #9aa7ba; }
.assistant-composer :deep(.el-textarea.is-disabled .el-textarea__inner) { background: transparent; }
.assistant-actions { display: flex; justify-content: space-between; align-items: center; gap: 10px; margin-top: 9px; }
.assistant-actions > span { color: #a0adc0; font-size: 10px; }
.assistant-send, .assistant-stop { height: 30px; padding: 0 11px; border-radius: 9px; font-size: 11px; }
.assistant-send svg { width: 13px; height: 13px; margin-left: 6px; }
.assistant-send:not(:disabled) { box-shadow: 0 3px 8px #3275ed26; }
.assistant-send:disabled { background: #eaf0fa; border-color: #eaf0fa; color: #a8bad7; }
.assistant-stop-icon { width: 7px; height: 7px; border-radius: 2px; background: #7c8aa0; margin-right: 6px; }
.assistant-footer { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; font-size: 10px; color: #8b99ad; margin-top: 11px; flex-shrink: 0; }
.assistant-footer > span { white-space: nowrap; padding-top: 1px; }
.assistant-privacy { min-width: 0; }
.assistant-privacy summary { display: flex; align-items: center; gap: 4px; cursor: pointer; list-style: none; line-height: 1.5; }
.assistant-privacy summary svg { width: 11px; height: 11px; flex-shrink: 0; }
.assistant-privacy summary:hover { color: #3275ed; }
.assistant-privacy p { font-size: 10px; line-height: 1.8; margin: 8px 0 0; color: #7c8aa0; }
.floating { height: 100%; display: flex; flex-direction: column; min-height: 0; }
.floating .assistant-heading { margin: 0; flex-shrink: 0; }
.floating .assistant-grid { position: relative; display: flex; flex-direction: row; flex: 1; min-height: 0; gap: 16px; }
.floating .assistant-sessions { width: 220px; min-width: 220px; max-height: none; margin-bottom: 5px; flex-shrink: 0; padding: 14px 10px; }
.floating .assistant-session { align-items: flex-start; }
.floating .assistant-session-delete { margin-top: 8px; }
.floating .assistant-chat { min-height: 0; flex: 1; }
.floating .assistant-transcript { max-height: none; min-height: 0; }
.floating :deep(.el-alert) { flex-shrink: 0; margin-bottom: 10px; font-size: 12px; }
@media (max-width: 800px) { .assistant-grid { grid-template-columns: 1fr; } .assistant-sessions { max-height: 180px; } }
@media (max-width: 700px) {
  .floating .assistant-sessions { position: absolute; inset: 0 auto 0 0; z-index: 2; width: min(250px, 90%); min-width: 0; background: #f2f6fd; box-shadow: 10px 0 28px #24334b1a; }
}
@media (max-width: 600px) {
  .assistant-welcome { padding-top: 2px; }
  .assistant-welcome-mark { width: 44px; height: 44px; margin-bottom: 10px; border-radius: 15px; }
  .assistant-welcome-mark svg { width: 27px; height: 27px; }
  .assistant-welcome h2 { font-size: 21px; }
  .assistant-welcome > p { margin-bottom: 14px; font-size: 11px; }
  .assistant-suggestions button { padding: 9px 10px; gap: 9px; }
  .assistant-suggestions small { display: none; }
  .assistant-suggestion-icon { width: 27px; height: 27px; }
  .assistant-footer { gap: 8px; }
  .assistant-message-bubble { padding: 11px 12px; }
}
@media (max-height: 700px) {
  .floating .assistant-welcome-mark, .floating .assistant-eyebrow { display: none; }
  .floating .assistant-welcome h2 { font-size: 18px; margin: 0 0 12px; }
  .floating .assistant-welcome > p { display: none; }
  .floating .assistant-suggestions button { padding-top: 8px; padding-bottom: 8px; }
  .floating .assistant-suggestions small { display: none; }
}
@media (prefers-reduced-motion: reduce) { .assistant-thinking-dots i { animation: none; } .assistant-suggestions button, .assistant-composer, .assistant-toolbar-button { transition: none; } }
</style>
