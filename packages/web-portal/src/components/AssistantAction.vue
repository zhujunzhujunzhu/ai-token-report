<script setup lang="ts">
/** 独立确认卡展示真实影响，确认请求只携带服务端保存的动作身份。 */
import { computed, ref, onMounted, onBeforeUnmount } from 'vue'
import { ElButton } from 'element-plus'
import type { AssistantPendingAction } from '@ai-token-report/shared'
import { assistantDetail, confirmAssistantAction } from '../api/assistant.js'
import { assistantActionStatus, canConfirmAssistantAction } from '../utils/assistantCapabilities.js'
import { notifyAssistantManagementChanged } from '../utils/assistantPageSearch.js'
const props = defineProps<{ action: AssistantPendingAction; disabled?: boolean }>()
const emit = defineEmits<{ updated: [action: AssistantPendingAction] }>()
const busy = ref(false), error = ref(''), now = ref(Date.now())
const pending = computed(() => canConfirmAssistantAction(props.action, now.value))
const label = computed(() => assistantActionStatus(props.action, now.value))
let timer: ReturnType<typeof setInterval> | undefined
onMounted(() => { timer = setInterval(() => { now.value = Date.now() }, 1_000) })
onBeforeUnmount(() => clearInterval(timer))
async function decide(decision: 'confirm' | 'cancel') {
  if (busy.value || props.disabled || !canConfirmAssistantAction(props.action)) return
  busy.value = true; error.value = ''
  try {
    const result = await confirmAssistantAction(props.action.action_id, props.action.session_id, decision)
    if (result.ok) {
      emit('updated', result.data.action)
      if (result.data.action.status === 'confirmed') notifyAssistantManagementChanged()
    }
    else {
      error.value = result.error
      // 失败也可能已消费动作；读取服务端终态，不能让历史卡无限重放。
      const history = await assistantDetail(props.action.session_id)
      if (history.ok) {
        const action = history.data.messages.flatMap(message => message.actions ?? []).find(item => item.action_id === props.action.action_id)
        if (action) emit('updated', action)
      }
    }
  } finally { now.value = Date.now(); busy.value = false }
}
</script>
<template>
  <section class="action-card" aria-label="操作确认">
    <div class="action-heading"><strong>{{ action.title }}</strong><span>{{ label }}</span></div>
    <p class="action-target">对象：{{ action.target_label }}</p>
    <p>{{ action.description }}</p>
    <p v-if="pending" class="action-warning">请核对对象和影响。只有点击下面的确认按钮才会执行；在对话中回复同意不会执行。</p>
    <small v-if="pending">确认有效至 {{ new Date(action.expires_at_ms).toLocaleString('zh-CN') }}</small>
    <p v-if="pending && disabled" class="action-warning">对话结束后即可确认或取消。</p>
    <p v-if="error" class="action-error" role="alert">{{ error }}</p>
    <div v-if="pending" class="action-buttons"><el-button type="danger" :loading="busy" :disabled="busy || disabled" @click="decide('confirm')">{{ action.operation.includes('delete') ? '确认删除' : '确认停用' }}</el-button><el-button :disabled="busy || disabled" @click="decide('cancel')">取消操作</el-button></div>
  </section>
</template>
<style scoped>
.action-card { margin-top: 12px; padding: 16px; border: 1px solid #f2d8bf; border-radius: 12px; background: #fffaf4; font-size: 13px; line-height: 1.65; }
.action-heading { display: flex; justify-content: space-between; gap: 12px; }
.action-heading span, small { color: #8a6a49; font-size: 12px; }
.action-target { font-weight: 600; }
.action-card p { margin: 9px 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.action-warning { color: #8a5b28; }
.action-error { color: #b42318; }
.action-buttons { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
</style>
