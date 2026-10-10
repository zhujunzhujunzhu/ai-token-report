<script setup lang="ts">
/** 私有文件直接下载，HTML 仅经用户点击分享才创建公开链接。 */
import { computed, ref, onMounted, onBeforeUnmount, useId } from 'vue'
import { ElButton } from 'element-plus'
import type { AssistantArtifact } from '@ai-token-report/shared'
import { downloadAssistantArtifact, shareAssistantArtifact, revokeAssistantArtifact } from '../api/assistant.js'
import { withBase } from '../api/request.js'
import { ASSISTANT_SHARE_HOURS, assistantShareActive, assistantShareUrl } from '../utils/assistantCapabilities.js'
import { copyText } from '../utils/clipboard.js'
const props = defineProps<{ artifact: AssistantArtifact; disabled?: boolean }>()
const emit = defineEmits<{ updated: [artifact: AssistantArtifact] }>()
const busy = ref(false), error = ref(''), notice = ref(''), hours = ref(24), now = ref(Date.now()), linkId = useId()
const activeShare = computed(() => assistantShareActive(props.artifact, now.value))
const shareUrl = computed(() => {
  const value = assistantShareUrl(props.artifact.share?.url ?? '')
  if (!value || !value.startsWith('/')) return value
  const path = withBase(value)
  return typeof window === 'undefined' ? path : new URL(path, window.location.origin).href
})
const size = computed(() => props.artifact.size_bytes < 1024 ? `${props.artifact.size_bytes} B` : `${(props.artifact.size_bytes / 1024).toFixed(1)} KB`)
let timer: ReturnType<typeof setInterval> | undefined
onMounted(() => { timer = setInterval(() => { now.value = Date.now() }, 1_000) })
onBeforeUnmount(() => clearInterval(timer))
async function download() {
  if (busy.value) return
  busy.value = true; error.value = ''; notice.value = ''
  try { await downloadAssistantArtifact(props.artifact) }
  catch (err) { error.value = err instanceof Error ? err.message : '文件下载失败' }
  finally { busy.value = false }
}
async function share(revoke = false) {
  if (busy.value || props.disabled) return
  busy.value = true; error.value = ''; notice.value = ''
  try {
    const result = revoke ? await revokeAssistantArtifact(props.artifact.artifact_id) : await shareAssistantArtifact(props.artifact.artifact_id, hours.value)
    if (result.ok) { emit('updated', result.data.artifact); notice.value = revoke ? '分享链接已撤销' : '分享链接已创建' }
    else error.value = result.error
  } finally { now.value = Date.now(); busy.value = false }
}
async function copy() {
  if (!activeShare.value || !shareUrl.value) return
  notice.value = await copyText(shareUrl.value, linkId) ? '链接已复制' : '链接已选中，请按 Ctrl+C 复制'
}
</script>
<template>
  <section class="artifact-card" aria-label="生成文件">
    <div class="artifact-heading"><strong>{{ artifact.title }}</strong><span>{{ artifact.format.toUpperCase() }}</span></div>
    <p class="artifact-file">{{ artifact.file_name }} · {{ size }}</p>
    <p v-if="artifact.note" class="artifact-note">{{ artifact.note }}</p>
    <el-button :loading="busy" :disabled="busy" @click="download">下载文件</el-button>
    <div v-if="artifact.format === 'html'" class="artifact-share">
      <p class="artifact-warning">分享后，任何持有链接的人都可以查看文件，包含文件中的数据。链接到期或撤销后停止访问。</p>
      <small v-if="disabled">对话结束后即可创建或撤销分享。</small>
      <template v-if="activeShare && shareUrl">
        <a :id="linkId" :href="shareUrl" target="_blank" rel="noopener noreferrer" class="artifact-link">{{ shareUrl }}</a>
        <small>到期时间：{{ new Date(artifact.share!.expires_at_ms).toLocaleString('zh-CN') }}</small>
        <div class="artifact-buttons"><el-button :disabled="busy" @click="copy">复制链接</el-button><el-button type="danger" plain :disabled="busy || disabled" @click="share(true)">撤销分享</el-button></div>
      </template>
      <template v-else>
        <small v-if="artifact.share">原分享链接已过期</small>
        <div class="artifact-buttons"><label>有效期 <select v-model="hours" :disabled="busy || disabled" aria-label="分享链接有效期"><option v-for="option in ASSISTANT_SHARE_HOURS" :key="option.hours" :value="option.hours">{{ option.label }}</option></select></label><el-button :disabled="busy || disabled" @click="share()">创建分享链接</el-button></div>
      </template>
    </div>
    <p v-if="error" class="artifact-error" role="alert">{{ error }}</p>
    <p v-if="notice" class="artifact-notice" role="status">{{ notice }}</p>
  </section>
</template>
<style scoped>
.artifact-card { margin-top: 12px; padding: 16px; border: 1px solid #dce6f4; border-radius: 12px; background: #f8fbff; font-size: 13px; line-height: 1.65; }
.artifact-heading { display: flex; justify-content: space-between; gap: 12px; }
.artifact-heading span { color: #537296; font-size: 12px; }
.artifact-file, small { color: #64748b; }
.artifact-note { color: #64748b; white-space: pre-wrap; }
.artifact-card p { margin: 8px 0; overflow-wrap: anywhere; }
.artifact-share { margin-top: 14px; border-top: 1px solid #e2e8f0; padding-top: 8px; }
.artifact-warning { color: #745c34; }
.artifact-link { display: block; word-break: break-all; color: #2563eb; margin: 8px 0; }
.artifact-buttons { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
.artifact-buttons select { border: 1px solid #d6dfec; border-radius: 6px; padding: 6px; background: #fff; color: #334155; }
.artifact-error { color: #b42318; }
.artifact-notice { color: #25664a; }
</style>
