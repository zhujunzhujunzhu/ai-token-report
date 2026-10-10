<script setup lang="ts">
/** 全局助手对话面板：与看板筛选独立，每个用户只访问服务端绑定的私有会话。 */
import { computed, ref, onMounted, onBeforeUnmount, watch, nextTick, useId } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElAlert, ElButton, ElInput, ElMessageBox } from 'element-plus'
import { ArrowUp, ChatDotRound, Plus, ArrowRight, DataAnalysis, Position, Close, Paperclip, Document, Picture } from '@element-plus/icons-vue'
import { ASSISTANT_ATTACHMENT_LIMITS, type AssistantArtifact, type AssistantPendingAction, type AssistantStatus, type AssistantToolEvent } from '@ai-token-report/shared'
import AssistantSymbol from '../components/AssistantSymbol.vue'
import AssistantResultCard from '../components/AssistantResult.vue'
import AssistantActionCard from '../components/AssistantAction.vue'
import AssistantArtifactCard from '../components/AssistantArtifact.vue'
import AssistantAttachmentCard from '../components/AssistantAttachment.vue'
import AssistantSessionList from '../components/AssistantSessionList.vue'
import { createAssistantNavigator, navigateAssistantPage } from '../utils/assistantNavigation.js'
import { openAssistantForm } from '../utils/assistantForms.js'
import { notifyAssistantManagementChanged } from '../utils/assistantPageSearch.js'
import { renderAssistantMarkdown } from '../utils/assistantMarkdown.js'
import { assistantNavigationActivity } from '../utils/assistantActivity.js'
import { handleAssistantComposerKeydown } from '../utils/assistantComposer.js'
import { createAssistantConversations, type AssistantPendingFile } from '../utils/assistantConversations.js'
import { assistantAttachmentAccept, assistantAttachmentError, assistantAttachmentKind, assistantAttachmentSize, assistantCanSend } from '../utils/assistantAttachments.js'
import { assistantStatus, assistantSessions, assistantDetail, chatAssistant, deleteAssistantSession, steerAssistant } from '../api/assistant.js'
const props = defineProps<{ floating?: boolean }>()
const emit = defineEmits<{ 'sessions-toggle': [open: boolean]; 'form-opened': [] }>()
const route = useRoute(), router = useRouter()
const showSessions = ref(!props.floating)
const transcript = ref<HTMLElement>()
const composer = ref<InstanceType<typeof ElInput>>()
const fileInput = ref<HTMLInputElement>()
const composerShortcutsId = useId()
const status = ref<AssistantStatus | null>(null)
const conversations = createAssistantConversations({
  chat: chatAssistant, detail: assistantDetail, sessions: assistantSessions, steer: steerAssistant,
  navigate: async event => {
    const target = navigate(event)
    if (target) await navigateAssistantPage(router, target)
  },
  openForm: async (form, signal) => { await openAssistantForm(router, form, signal); if (!signal.aborted) emit('form-opened') },
  managementChanged: notifyAssistantManagementChanged,
})
const { current, sessions, active, loadingSessions, hasMoreSessions, sessionsError, totalSessions } = conversations
const messages = computed(() => current.value.messages)
const sources = computed(() => current.value.sources)
const runningTool = computed(() => [...sources.value].reverse().find(source => source.state === 'running'))
const prompt = computed({ get: () => current.value.prompt, set: value => { current.value.prompt = value } })
const loading = computed(() => current.value.loading)
const sending = computed(() => current.value.sending)
const error = computed({ get: () => current.value.error, set: value => { current.value.error = value } })
const pendingFiles = computed({ get: () => current.value.pendingFiles, set: value => { current.value.pendingFiles = value } })
const attachmentError = computed({ get: () => current.value.attachmentError, set: value => { current.value.attachmentError = value } })
const dragging = ref(false)
let attachmentSequence = 0
const composerDisabled = computed(() => !status.value?.enabled || loading.value)
const attachmentAccept = computed(() => assistantAttachmentAccept(status.value?.supports_images))
const attachmentLimitsHint = `最多 ${ASSISTANT_ATTACHMENT_LIMITS.max_files} 个 · 图片 ${assistantAttachmentSize(ASSISTANT_ATTACHMENT_LIMITS.max_image_bytes)} · Office/文本 ${assistantAttachmentSize(ASSISTANT_ATTACHMENT_LIMITS.max_file_bytes)} · 共 ${assistantAttachmentSize(ASSISTANT_ATTACHMENT_LIMITS.max_total_bytes)}`
const canSend = computed(() => !current.value.steering && assistantCanSend(prompt.value, pendingFiles.value.map(item => item.file), { enabled: status.value?.enabled, loading: loading.value, supportsImages: status.value?.supports_images }))
const canSteer = computed(() => canSend.value && status.value?.supports_steering !== false && sending.value && !!current.value.runId && !pendingFiles.value.length)
const anyRunning = computed(() => conversations.conversations.value.some(item => item.sending))
let navigate = createAssistantNavigator()
function updateAction(action: AssistantPendingAction) {
  for (const message of messages.value) {
    const index = message.actions?.findIndex(item => item.action_id === action.action_id) ?? -1
    if (index >= 0) message.actions![index] = action
  }
}
function updateArtifact(artifact: AssistantArtifact) {
  for (const message of messages.value) {
    const index = message.artifacts?.findIndex(item => item.artifact_id === artifact.artifact_id) ?? -1
    if (index >= 0) message.artifacts![index] = artifact
  }
}
const suggestions = [
  { title: '看看用量趋势', detail: '最近七天的用量有什么变化？', prompt: '最近七天的用量趋势如何？', icon: DataAnalysis },
  { title: '了解模型分布', detail: '哪些模型贡献了最多用量？', prompt: '最近七天哪些模型用量最多？', icon: ChatDotRound },
  { title: '导出用量报告', detail: '生成可下载的 Excel 文件', prompt: '把本月各模型的用量生成 Excel 文件供我下载', icon: DataAnalysis },
  { title: '打开调用明细', detail: '让助手带你到需要的页面', prompt: '打开调用明细页面', icon: Position },
]
function suggest(value: string) { prompt.value = value; composer.value?.focus() }
function addFiles(files: File[]) {
  if (composerDisabled.value || !files.length) return
  // 拖入或重复选择同一文件不占两份配额；整批校验失败时保留原草稿。
  const existing = pendingFiles.value.map(item => item.file)
  const added: File[] = []
  for (const file of files) if (![...existing, ...added].some(item => item.name === file.name && item.size === file.size && item.lastModified === file.lastModified)) added.push(file)
  attachmentError.value = assistantAttachmentError([...existing, ...added], status.value?.supports_images)
  if (attachmentError.value) return
  pendingFiles.value.push(...added.map(file => ({ id: ++attachmentSequence, file, ...(assistantAttachmentKind(file.name) === 'image' ? { preview: URL.createObjectURL(file) } : {}) })))
  void nextTick(() => composer.value?.focus())
}
function chooseFiles(event: Event) {
  const input = event.target as HTMLInputElement
  addFiles(Array.from(input.files ?? []))
  input.value = ''
}
function removeFile(item: AssistantPendingFile) {
  if (composerDisabled.value) return
  if (item.preview) URL.revokeObjectURL(item.preview)
  pendingFiles.value = pendingFiles.value.filter(file => file.id !== item.id)
  attachmentError.value = ''
}
function discardPreview(item: AssistantPendingFile) {
  if (item.preview) URL.revokeObjectURL(item.preview)
  item.preview = undefined
}
function dragOver(event: DragEvent) {
  if (!event.dataTransfer?.types.includes('Files')) return
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = composerDisabled.value ? 'none' : 'copy'
  dragging.value = !composerDisabled.value
}
function dragLeave(event: DragEvent) {
  if (!(event.currentTarget as HTMLElement).contains(event.relatedTarget as Node | null)) dragging.value = false
}
function dropFiles(event: DragEvent) {
  if (!event.dataTransfer?.types.includes('Files')) return
  event.preventDefault(); dragging.value = false
  addFiles(Array.from(event.dataTransfer.files))
}
function pasteImage(event: ClipboardEvent) {
  const files = Array.from(event.clipboardData?.items ?? []).filter(item => item.kind === 'file' && item.type.startsWith('image/')).map(item => item.getAsFile()).filter((file): file is File => !!file)
  if (!files.length || composerDisabled.value) return
  event.preventDefault()
  addFiles(files)
}
function composerKeydown(event: Event | KeyboardEvent) {
  if (!(event instanceof KeyboardEvent)) return
  handleAssistantComposerKeydown(event, {
    send: () => { void send() },
    newline: () => {
      const textarea = event.target as HTMLTextAreaElement
      const start = textarea.selectionStart, end = textarea.selectionEnd
      const value = prompt.value.slice(0, start) + '\n' + prompt.value.slice(end)
      if (value.length > 4096) return
      prompt.value = value
      void nextTick(() => textarea.setSelectionRange(start + 1, start + 1))
    },
  })
}
const toolNames: Record<string, string> = { query_usage: '查询与展示', stats_overview: '用量总览', stats_series: '用量趋势', stats_breakdown: '用量分布', stats_records: '调用明细', stats_diagnostics: '采集诊断', stats_pricing: '模型单价', stats_providers: '厂商目录', stats_sources: '来源目录', portal_navigate: '页面导航与搜索', render_table: '表格展示', render_echarts: 'ECharts 图表', render_cards: '指标卡片', list_datasets: '会话数据集', list_shared_html: '查询有效 HTML 分享', portal_manage_query: '查看管理配置', portal_manage_mutate: '编辑与操作确认', portal_manage_save: '直接保存管理配置', portal_open_form: '打开填写表单', web_search: '公开网络搜索', web_read: '读取公开网页', create_file: '生成导出文件', share_html: '创建 HTML 分享' }
function sourceDescription(source: AssistantToolEvent) {
  if (source.tool.startsWith('portal_manage_')) return '沿用当前身份的管理权限'
  if (source.tool.startsWith('web_')) return '公开网络信息与来源'
  if (source.tool === 'create_file') return '文件保存在当前私有对话'
  if (source.tool === 'share_html') return '按你的分享要求创建限时链接'
  if (source.tool === 'list_shared_html') return '当前账号所有对话中仍有效的 HTML 分享'
  if (source.tool === 'query_usage') return '按问题确认人员、时间范围和展示方式'
  if (source.tool.startsWith('render_') || source.tool === 'list_datasets') return '基于本会话已查询的数据'
  if (source.tool === 'portal_navigate' || source.tool === 'portal_open_form') return assistantNavigationActivity(source)!.description
  const query = new URLSearchParams(source.query)
  const periods: Record<string, string> = { today: '今天', yesterday: '昨天', week: '本周', lastweek: '上周', month: '本月', lastmonth: '上月', year: '今年', last7d: '最近 7 天', last30d: '最近 30 天', last90d: '最近 90 天' }
  const from = Number(query.get('from')), to = Number(query.get('to'))
  const absolute = query.has('from') && query.has('to') && Number.isSafeInteger(from) && Number.isSafeInteger(to) && !Number.isNaN(new Date(from).getTime()) && !Number.isNaN(new Date(to).getTime())
  const timeWindow = absolute ? `${new Date(from).toLocaleDateString('zh-CN')} — ${new Date(to).toLocaleDateString('zh-CN')}` : periods[query.get('period') ?? ''] ?? '自定义时间范围'
  return [timeWindow, query.get('provider'), query.get('model')].filter(Boolean).join(' · ')
}
async function open(id?: string) {
  if (props.floating && window.matchMedia('(max-width: 700px)').matches) showSessions.value = false
  navigate = createAssistantNavigator()
  await conversations.open(id)
  void nextTick(() => composer.value?.focus())
}
async function remove(id: string) {
  if (anyRunning.value) return
  try {
    await ElMessageBox.confirm('删除将同时移除对话记录和 DSH 会话，无法恢复。', '删除对话', { type: 'warning' })
    await deleteAssistantSession(id)
    conversations.forget(id)
    await conversations.refresh()
  } catch (err) { if (err instanceof Error) error.value = err.message }
}
async function send() {
  if (!canSend.value) return
  await conversations.submit(route.path)
}
async function steer() {
  if (!canSteer.value) return
  await conversations.steer(route.path)
}
function sessionActivity(id: string) {
  const state = conversations.sessionState(id)
  const label = state?.sending ? (state.queue.length ? `进行中 · ${state.queue.length} 条排队` : '进行中')
    : state?.queue.length ? `${state.queue.length} 条待发送`
    : state?.prompt || state?.pendingFiles.length ? '有草稿' : ''
  return { label, running: !!state?.sending }
}
onMounted(async () => {
  const result = await assistantStatus()
  if (result.ok) { status.value = result.data; if (status.value.enabled) await conversations.refresh() }
  else error.value = result.error
})
onBeforeUnmount(() => conversations.dispose())
watch(showSessions, value => emit('sessions-toggle', value), { immediate: true })
watch(() => current.value.key, () => { dragging.value = false; navigate = createAssistantNavigator(); if (fileInput.value) fileInput.value.value = '' })
watch(() => [messages.value.at(-1)?.text, messages.value.at(-1)?.results?.length, messages.value.at(-1)?.actions?.length, messages.value.at(-1)?.artifacts?.length], async () => { await nextTick(); if (transcript.value) transcript.value.scrollTop = messages.value.length ? transcript.value.scrollHeight : 0 })
</script>

<template>
  <div class="assistant-page" :class="{ floating }">
    <div class="assistant-heading">
      <div v-if="!floating"><h1>AI 助手</h1><p>查询用量、编辑配置、查阅公开资料与导出文件，权限沿用当前账号。</p></div>
      <button v-if="floating" class="assistant-toolbar-button" :class="{ active: showSessions }" :aria-expanded="showSessions" @click="showSessions = !showSessions"><ChatDotRound />我的对话<span v-if="totalSessions" class="assistant-count">{{ totalSessions }}</span></button>
      <button class="assistant-toolbar-button assistant-new" @click="open()"><Plus />新建对话</button>
    </div>
    <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon />
    <el-alert v-if="status && !status.enabled" title="管理员尚未启用 DSH 助手" type="info" :closable="false" show-icon />
    <div class="assistant-grid">
      <aside v-if="showSessions" class="assistant-sessions" aria-label="我的对话">
        <div class="assistant-sessions-heading"><div><h2>我的对话</h2><span>独立空间 · 仅你可见</span></div><button v-if="floating" aria-label="收起对话侧栏" @click="showSessions = false"><Close /></button></div>
        <AssistantSessionList :sessions="sessions" :active="active" :total="totalSessions" :loading="loadingSessions" :has-more="hasMoreSessions" :error="sessionsError" :disabled="anyRunning" :activity="sessionActivity" @open="open" @remove="remove" @load-more="conversations.loadMoreSessions()" />
      </aside>
      <section class="assistant-chat" aria-label="助手对话">
        <div ref="transcript" class="assistant-transcript" aria-live="polite" :aria-busy="sending || loading">
          <p v-if="loading" class="assistant-loading">正在读取对话…</p>
          <div v-else-if="!messages.length" class="assistant-welcome">
            <div class="assistant-welcome-mark"><AssistantSymbol /></div>
            <span class="assistant-eyebrow">你的用量分析伙伴</span>
            <h2>今天想了解什么？</h2>
            <p>一起看看用量背后的变化，<br />也可以编辑配置、生成文件和打开相关页面。</p>
            <div class="assistant-suggestions">
              <button v-for="item in suggestions" :key="item.title" :disabled="!status?.enabled || loading" @click="suggest(item.prompt)"><span class="assistant-suggestion-icon"><component :is="item.icon" /></span><span><strong>{{ item.title }}</strong><small>{{ item.detail }}</small></span><ArrowRight class="assistant-suggestion-arrow" /></button>
            </div>
          </div>
          <article v-for="(message, index) in messages" :key="index" class="assistant-message" :class="message.role">
            <div class="assistant-message-label"><span class="assistant-avatar" aria-hidden="true"><AssistantSymbol v-if="message.role === 'assistant'" /><span v-else>你</span></span><strong>{{ message.role === 'user' ? '你' : 'AI 助手' }}</strong><span v-if="message.delivery === 'steer'" class="assistant-steer-label">即时引导</span></div>
            <div class="assistant-message-bubble" :class="{ 'with-results': message.results?.length || message.actions?.length || message.artifacts?.length }">
              <div v-if="message.text && message.role === 'assistant'" class="assistant-markdown" v-html="renderAssistantMarkdown(message.text)" />
              <p v-else-if="message.text">{{ message.text }}</p>
              <div v-else-if="sending && index === messages.length - 1 && message.role === 'assistant'" class="assistant-thinking"><span class="assistant-thinking-dots" aria-hidden="true"><i /><i /><i /></span>{{ current.uploading ? '正在上传与解析附件' : runningTool ? `正在处理：${toolNames[runningTool.tool] ?? '数据查询'}` : sources.length ? '正在整理回答' : '正在理解问题' }}</div>
              <p v-else-if="!message.results?.length && !message.actions?.length && !message.artifacts?.length && !message.attachments?.length" class="assistant-no-answer">本轮没有回答</p>
              <div v-if="message.attachments?.length" class="assistant-message-attachments" aria-label="本轮附件"><AssistantAttachmentCard v-for="(attachment, attachmentIndex) in message.attachments" :key="attachment.attachment_id || attachmentIndex" :attachment="attachment" :session-id="current.sessionId" /></div>
              <AssistantResultCard v-for="result in message.results" :key="result.result_id" :result="result" />
              <AssistantActionCard v-for="action in message.actions" :key="action.action_id" :action="action" :disabled="anyRunning" @updated="updateAction" />
              <AssistantArtifactCard v-for="artifact in message.artifacts" :key="artifact.artifact_id" :artifact="artifact" :disabled="anyRunning" @updated="updateArtifact" />
            </div>
          </article>
          <details v-if="sources.length" class="assistant-sources">
            <summary><span class="assistant-source-indicator" />本轮操作与来源<span class="assistant-count">{{ sources.length }}</span></summary>
            <div v-for="(source, index) in sources" :key="source.call_id ?? index" class="assistant-source"><div><strong>{{ toolNames[source.tool] ?? '查询工具' }}</strong><small>{{ sourceDescription(source) }}</small></div><span :class="{ failed: source.state === 'failed' || source.status >= 400 }">{{ assistantNavigationActivity(source)?.label ?? (source.state === 'running' ? '进行中' : source.state === 'failed' || source.status >= 400 ? '未完成' : source.status === 202 ? '已请求' : '已完成') }}</span></div>
          </details>
        </div>
        <section v-if="current.queue.length" class="assistant-queue" aria-label="待发送消息">
          <div class="assistant-queue-heading"><strong>{{ current.queuePaused ? '队列已暂停' : '消息已排队' }} · {{ current.queue.length }}</strong><span v-if="!current.queuePaused">本轮结束后按顺序发送</span><button v-else type="button" :disabled="sending || loading" @click="conversations.resume()">继续发送</button></div>
          <div v-for="(item, index) in current.queue" :key="item.id" class="assistant-queued-message">
            <span class="assistant-queue-number">{{ index + 1 }}</span><div><p>{{ item.prompt || '请分析附件' }}</p><small v-if="item.files.length">{{ item.files.map(file => file.file.name).join('、') }}</small></div>
            <button v-if="sending && status?.supports_steering !== false && !item.files.length" type="button" :disabled="!current.runId || current.steering" title="在当前运行的下一步应用这条消息" @click="conversations.steerQueued(item.id)">立即引导</button>
            <button type="button" class="assistant-queue-remove" :disabled="current.steering" :aria-label="`移除排队消息 ${index + 1}`" @click="conversations.removeQueued(item.id)"><Close /></button>
          </div>
        </section>
        <form class="assistant-composer" :class="{ dragging }" @submit.prevent="send" @dragover="dragOver" @dragleave="dragLeave" @drop="dropFiles">
          <p v-if="sending" class="assistant-running-hint">继续输入会排队<span v-if="status?.supports_steering !== false">；立即引导将在下一步生效</span>。<span v-if="pendingFiles.length">附件请排队发送。</span></p>
          <input ref="fileInput" class="assistant-file-input" type="file" multiple :accept="attachmentAccept" :disabled="composerDisabled" aria-label="选择图片、Office 或文本附件" @change="chooseFiles" />
          <div v-if="pendingFiles.length" class="assistant-pending-files" aria-label="待发送附件">
            <div v-for="item in pendingFiles" :key="item.id" class="assistant-pending-file">
              <img v-if="item.preview" :src="item.preview" class="assistant-file-preview" :alt="`图片预览：${item.file.name}`" @error="discardPreview(item)" />
              <span v-else class="assistant-file-symbol" aria-hidden="true"><Picture v-if="assistantAttachmentKind(item.file.name) === 'image'" /><Document v-else /></span>
              <span class="assistant-file-description"><strong :title="item.file.name">{{ item.file.name }}</strong><small>{{ assistantAttachmentSize(item.file.size) }}</small></span>
              <button type="button" class="assistant-file-remove" :disabled="composerDisabled" :aria-label="`移除附件 ${item.file.name}`" @click="removeFile(item)"><Close /></button>
            </div>
          </div>
          <el-input ref="composer" v-model="prompt" type="textarea" :autosize="{ minRows: 3, maxRows: 8 }" resize="vertical" maxlength="4096" :placeholder="sending ? '继续输入，默认排队；也可以立即引导当前回答…' : '输入问题，或添加图片、Office 和文本文件…'" :disabled="composerDisabled" aria-label="问题" :aria-describedby="composerShortcutsId" @keydown="composerKeydown" @paste="pasteImage" />
          <p v-if="attachmentError" class="assistant-attachment-error" role="alert">{{ attachmentError }}</p>
          <div class="assistant-actions"><button class="assistant-attach" type="button" :disabled="composerDisabled" :title="`添加附件：${attachmentLimitsHint}；支持拖入与粘贴图片`" aria-label="添加附件" @click="fileInput?.click()"><Paperclip /><span>附件</span></button><div class="assistant-input-hints"><span :id="composerShortcutsId">{{ sending ? 'Enter 排队' : 'Enter 发送' }} · Alt + Enter 换行</span><span v-if="prompt.length">{{ prompt.length }} / 4096</span></div><div class="assistant-send-controls"><el-button v-if="sending" class="assistant-stop" @click="conversations.stop()"><span class="assistant-stop-icon" />停止</el-button><el-button v-if="sending" class="assistant-steer" :disabled="!canSteer" :loading="current.steering" :title="pendingFiles.length ? '附件请排队发送；即时引导支持文字' : '在当前运行的下一步应用，保留已输出内容'" @click="steer">立即引导</el-button><el-button class="assistant-send" type="primary" native-type="submit" :disabled="!canSend">{{ sending ? '排队发送' : '发送' }}<ArrowUp /></el-button></div></div>
          <div v-if="dragging" class="assistant-drop-hint" aria-hidden="true"><Paperclip />松开即可添加附件</div>
        </form>
        <p v-if="status?.enabled && status.supports_images === false" class="assistant-image-unavailable">当前助手未启用图片理解，可上传 Office 和文本文件。图片需管理员配置支持图片的模型。</p>
        <div v-if="status?.enabled" class="assistant-footer">
          <span :title="attachmentLimitsHint">图片 · Office · 文本</span>
          <span>删除与停用需确认 · 文件默认私有</span>
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
.assistant-sessions { display: flex; flex-direction: column; min-height: 0; padding: 12px; max-height: 70vh; overflow: hidden; border: 1px solid #e5edf8; border-radius: 12px; background: #f2f6fd; }
.assistant-sessions-heading { display: flex; flex-shrink: 0; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 16px; }
.assistant-sessions-heading h2 { font-size: 12px; color: #53637a; font-weight: 600; margin: 0; }
.assistant-sessions-heading span { display: block; font-size: 10px; color: #91a0b6; margin-top: 5px; }
.assistant-sessions-heading button { width: 24px; height: 24px; padding: 5px; border: 0; border-radius: 6px; color: #8b99ad; background: transparent; }
.assistant-sessions-heading button:hover { background: #e5edf9; color: #3275ed; }
.assistant-sessions-heading svg { width: 14px; height: 14px; }
.assistant-steer-label { color: #6489be; font-size: 10px; }
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
.assistant-sources summary::-webkit-details-marker { display: none; }
.assistant-sources summary::after { content: '⌄'; margin-left: auto; font-size: 14px; }
.assistant-sources[open] summary::after { transform: rotate(180deg); }
.assistant-source-indicator { width: 5px; height: 5px; background: #74b5a6; border-radius: 50%; }
.assistant-source { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 9px 12px; border-top: 1px solid #e8eef7; }
.assistant-source strong { display: block; font-size: 11px; font-weight: 500; }
.assistant-source small { display: block; color: #8c9bb0; font-size: 10px; margin-top: 4px; overflow-wrap: anywhere; }
.assistant-source > span { white-space: nowrap; color: #5c9d8e; font-size: 10px; }
.assistant-source > span.failed { color: #dc5961; }
.assistant-queue { flex-shrink: 0; max-height: 140px; overflow-y: auto; margin-bottom: 9px; padding: 9px 11px; border: 1px solid #e0e9f6; border-radius: 11px; background: #f3f7fd; }
.assistant-queue-heading { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 5px; font-size: 10px; color: #8294af; }
.assistant-queue-heading strong { color: #58739b; font-weight: 500; }
.assistant-queue-heading button, .assistant-queued-message > button { flex-shrink: 0; border: 0; border-radius: 5px; padding: 4px 5px; color: #557daf; background: transparent; font-size: 10px; cursor: pointer; }
.assistant-queue button:hover:not(:disabled) { background: #e6eefd; color: #3275ed; }
.assistant-queue button:disabled { opacity: .5; cursor: not-allowed; }
.assistant-queued-message { display: flex; align-items: center; gap: 7px; padding-top: 8px; font-size: 11px; color: #617796; }
.assistant-queue-number { flex-shrink: 0; color: #96a8c2; font-size: 10px; }
.assistant-queued-message > div { flex: 1; min-width: 0; }
.assistant-queued-message p { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 36px; overflow: auto; }
.assistant-queued-message small { display: block; color: #8e9fb7; margin-top: 3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.assistant-queued-message .assistant-queue-remove { display: grid; place-items: center; padding: 5px; }
.assistant-queue-remove svg { width: 12px; height: 12px; }
.assistant-composer { position: relative; flex-shrink: 0; max-height: min(400px, 55dvh); overflow-y: auto; border: 1px solid #dce6f6; border-radius: 15px; background: #fff; padding: 11px 12px 9px; box-shadow: 0 4px 14px #24334b04; transition: border-color .2s, box-shadow .2s; }
.assistant-composer:focus-within { border-color: #9fbef2; box-shadow: 0 0 0 3px #edf3ff; }
.assistant-running-hint { margin: 0 0 7px; color: #7891b3; font-size: 10px; line-height: 1.5; }
.assistant-file-input { display: none; }
.assistant-composer.dragging { border-color: #6ea5f5; background: #f6f9ff; }
.assistant-drop-hint { position: absolute; inset: 5px; display: flex; align-items: center; justify-content: center; gap: 8px; border: 1px dashed #8fb5ee; border-radius: 11px; background: #f0f6fff5; color: #3a7cdb; font-size: 13px; pointer-events: none; }
.assistant-drop-hint svg { width: 20px; height: 20px; }
.assistant-pending-files { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 170px), 1fr)); gap: 7px; max-height: 145px; overflow-y: auto; margin-bottom: 11px; }
.assistant-pending-file { display: flex; align-items: center; gap: 8px; min-width: 0; padding: 6px 7px; border: 1px solid #e0e9f6; border-radius: 9px; background: #f7faff; }
.assistant-file-preview, .assistant-file-symbol { width: 34px; height: 36px; flex-shrink: 0; border-radius: 6px; background: #e9f1fd; }
.assistant-file-preview { object-fit: cover; }
.assistant-file-symbol { display: grid; place-items: center; color: #7b9fcf; }
.assistant-file-symbol svg { width: 19px; height: 19px; }
.assistant-file-description { min-width: 0; flex: 1; }
.assistant-file-description strong { display: block; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; color: #536d90; font-size: 11px; font-weight: 500; }
.assistant-file-description small { display: block; font-size: 10px; color: #91a3bc; margin-top: 4px; }
.assistant-file-remove { display: grid; place-items: center; flex-shrink: 0; width: 21px; height: 24px; padding: 0; border: 0; border-radius: 5px; background: transparent; color: #98a9bf; cursor: pointer; }
.assistant-file-remove:hover:not(:disabled) { color: #cc6670; background: #fff1f2; }
.assistant-file-remove:disabled { opacity: .45; cursor: not-allowed; }
.assistant-file-remove svg { width: 12px; height: 12px; }
.assistant-attachment-error { margin: 7px 0 0; color: #bd4d58; font-size: 11px; line-height: 1.6; overflow-wrap: anywhere; }
.assistant-image-unavailable { margin: 7px 0 0; color: #8b7a5a; font-size: 10px; line-height: 1.6; flex-shrink: 0; }
.assistant-composer :deep(.el-textarea__inner) { border: 0; border-radius: 0; box-shadow: none; padding: 2px 0; font-size: 13px; line-height: 1.8; color: #465771; background: transparent; max-height: min(240px, 35dvh); }
.assistant-composer :deep(.el-textarea__inner::placeholder) { color: #9aa7ba; }
.assistant-composer :deep(.el-textarea.is-disabled .el-textarea__inner) { background: transparent; }
.assistant-actions { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 8px; margin-top: 9px; }
.assistant-send-controls { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px; margin-left: auto; }
.assistant-send-controls :deep(.el-button + .el-button) { margin-left: 0; }
.assistant-attach { display: inline-flex; align-items: center; gap: 4px; flex-shrink: 0; height: 28px; padding: 0 6px; margin-left: -4px; border: 0; border-radius: 7px; background: transparent; color: #7891b3; font-size: 11px; cursor: pointer; }
.assistant-attach svg { width: 16px; height: 16px; }
.assistant-attach:hover:not(:disabled) { color: #3275ed; background: #edf3ff; }
.assistant-attach:disabled { color: #b2bdcd; cursor: not-allowed; }
.assistant-actions .assistant-input-hints { flex: 1; }
.assistant-input-hints { display: flex; flex-wrap: wrap; gap: 4px 12px; color: #a0adc0; font-size: 10px; }
.assistant-send, .assistant-stop, .assistant-steer { height: 30px; padding: 0 9px; border-radius: 9px; font-size: 11px; }
.assistant-send svg { width: 13px; height: 13px; margin-left: 6px; }
.assistant-send:not(:disabled) { box-shadow: 0 3px 8px #3275ed26; }
.assistant-send:disabled { background: #eaf0fa; border-color: #eaf0fa; color: #a8bad7; }
.assistant-stop-icon { width: 7px; height: 7px; border-radius: 2px; background: #7c8aa0; margin-right: 6px; }
.assistant-footer { display: flex; align-items: flex-start; justify-content: space-between; flex-wrap: wrap; gap: 5px 12px; font-size: 10px; color: #8b99ad; margin-top: 11px; flex-shrink: 0; }
.assistant-footer > span { white-space: nowrap; padding-top: 1px; }
.floating { height: 100%; display: flex; flex-direction: column; min-height: 0; }
.floating .assistant-heading { margin: 0; flex-shrink: 0; }
.floating .assistant-grid { position: relative; display: flex; flex-direction: row; flex: 1; min-height: 0; gap: 16px; }
.floating .assistant-sessions { width: 220px; min-width: 220px; max-height: none; margin-bottom: 5px; flex-shrink: 0; padding: 14px 10px; }
.floating .assistant-chat { min-height: 0; flex: 1; }
.floating .assistant-transcript { max-height: none; min-height: 0; }
.floating :deep(.el-alert) { flex-shrink: 0; margin-bottom: 10px; font-size: 12px; }
@media (max-width: 800px) { .assistant-grid { grid-template-columns: 1fr; } .assistant-sessions { max-height: 180px; } }
@media (max-width: 700px) {
  .floating .assistant-sessions { position: absolute; inset: 0 auto 0 0; z-index: 2; width: min(250px, 90%); min-width: 0; background: #f2f6fd; box-shadow: 10px 0 28px #24334b1a; }
}
@container (max-width: 600px) {
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
