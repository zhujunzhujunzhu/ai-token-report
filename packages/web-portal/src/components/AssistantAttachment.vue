<script setup lang="ts">
/** 上传附件的历史卡只通过鉴权入口下载，不把受保护的 URL 当公开图片加载。 */
import { ref } from 'vue'
import { Document, Picture, Download } from '@element-plus/icons-vue'
import type { AssistantAttachment } from '@ai-token-report/shared'
import { downloadAssistantAttachment } from '../api/assistant.js'
import { assistantAttachmentSize } from '../utils/assistantAttachments.js'
const props = defineProps<{ attachment: AssistantAttachment; sessionId?: string; disabled?: boolean }>()
const busy = ref(false), error = ref('')
async function download() {
  if (busy.value || props.disabled || !props.sessionId || !props.attachment.attachment_id) return
  busy.value = true; error.value = ''
  try { await downloadAssistantAttachment(props.sessionId, props.attachment) }
  catch (err) { error.value = err instanceof Error ? err.message : '附件下载失败' }
  finally { busy.value = false }
}
</script>
<template>
  <div class="attachment-card">
    <button class="attachment-download" :disabled="disabled || busy || !sessionId || !attachment.attachment_id" :aria-label="`下载附件 ${attachment.file_name}`" @click="download">
      <span class="attachment-icon" aria-hidden="true"><Picture v-if="attachment.kind === 'image'" /><Document v-else /></span>
      <span class="attachment-details"><strong>{{ attachment.file_name }}</strong><small>{{ assistantAttachmentSize(attachment.size_bytes) }}<template v-if="attachment.extracted_chars !== undefined"> · 已解析 {{ attachment.extracted_chars.toLocaleString() }} 字</template><template v-else-if="attachment.kind === 'image'"> · 图片</template></small></span>
      <span class="attachment-download-icon" aria-hidden="true"><Download /></span>
    </button>
    <p v-if="attachment.note" class="attachment-note">{{ attachment.note }}</p>
    <p v-if="error" class="attachment-error" role="alert">{{ error }}</p>
  </div>
</template>
<style scoped>
.attachment-card { min-width: 0; margin-top: 8px; border: 1px solid #d7e3f5; border-radius: 10px; background: #ffffff9c; overflow: hidden; }
.attachment-download { display: flex; align-items: center; gap: 10px; width: 100%; border: 0; padding: 10px 12px; color: #496588; text-align: left; background: transparent; cursor: pointer; }
.attachment-download:hover:not(:disabled) { background: #f5f9ff; }
.attachment-download:focus-visible { outline: 2px solid #7caaed; outline-offset: -2px; }
.attachment-download:disabled { cursor: default; }
.attachment-icon { display: grid; place-items: center; width: 34px; height: 36px; flex-shrink: 0; border-radius: 8px; background: #eaf1fc; color: #6c92c7; }
.attachment-icon svg { width: 19px; height: 19px; }
.attachment-details { min-width: 0; flex: 1; }
.attachment-details strong { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; font-weight: 500; }
.attachment-details small { display: block; color: #8798b0; font-size: 10px; margin-top: 4px; }
.attachment-download-icon svg { width: 15px; height: 15px; color: #8da4c3; }
.attachment-download:disabled .attachment-download-icon { opacity: .4; }
.attachment-note, .attachment-error { margin: 0; padding: 0 12px 9px; font-size: 11px; line-height: 1.6; overflow-wrap: anywhere; color: #7889a1; }
.attachment-error { color: #b42318; }
</style>
