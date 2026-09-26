<script setup lang="ts">
/** 上报凭证独立生命周期。只保留当前弹窗的秘密，不允许列表恢复原值。 */
import { computed, ref } from 'vue'
import { ElAlert, ElButton, ElDatePicker, ElForm, ElFormItem, ElInput, ElMessage, ElMessageBox, ElOption, ElSelect, ElTable, ElTableColumn, ElTag } from 'element-plus'
import type { PortalMember, PortalReportToken } from '@ai-token-report/shared'
import { useMembersStore } from '../stores/members.js'
import { useSessionStore } from '../stores/session.js'
import * as api from '../api/admin.js'
import { copyText } from '../utils/clipboard.js'
import { formatFullDateTime } from '../utils/format.js'
const props = defineProps<{ member: PortalMember }>()
const admin = useMembersStore(), session = useSessionStore()
const label = ref('日常上报')
const scopes = ref(['identity:read', 'usage:write'])
const expires = ref<number | null>(null)
const editing = ref<PortalReportToken | null>(null)
const editedScopes = ref<string[]>([])
const grantable = computed(() => [...new Set(props.member.roles.flatMap((r) => r.permissions))].filter((p) => session.can(p)))
const version = (token: PortalReportToken) => ({ member_id: props.member.member_id, token_id: token.token_id, expected_version: token.version })
async function issue(): Promise<void> {
  if (!label.value.trim() || !scopes.value.length) return
  await admin.tokenAction(() => api.issueToken({ member_id: props.member.member_id, label: label.value.trim(), scopes: scopes.value, expires_at_ms: expires.value }), props.member.member_id)
}
async function action(token: PortalReportToken, kind: 'rotate' | 'revoke'): Promise<void> {
  try {
    await ElMessageBox.confirm(kind === 'rotate' ? '旧 Token 将立即失效，新 Token 只显示一次。' : '此 Token 将立即失效，历史用量保留。', kind === 'rotate' ? '轮换 Token' : '吊销 Token', { confirmButtonText: '确认', cancelButtonText: '取消', type: 'warning' })
    await admin.tokenAction(() => kind === 'rotate' ? api.rotateToken(version(token)) : api.revokeToken(version(token)), props.member.member_id)
  } catch { /* 用户取消。 */ }
}
async function saveScopes(): Promise<void> {
  const token = editing.value
  if (!token) return
  if (await admin.tokenAction(() => api.updateTokenScopes({ ...version(token), scopes: editedScopes.value }), props.member.member_id)) editing.value = null
}
async function copy(): Promise<void> {
  if (!admin.issuedSecret) return
  const ok = await copyText(admin.issuedSecret, 'issued-token')
  ElMessage({ type: ok ? 'success' : 'info', message: ok ? 'Token 已复制' : '已选中 Token，请按 Ctrl+C 复制' })
}
</script>
<template>
  <div class="page-stack">
    <el-alert v-if="admin.error" :title="admin.error" type="error" :closable="false" />
    <div v-if="admin.issuedSecret" class="issued-card">
      <el-alert title="请现在保存：完整 Token 只显示这一次，关闭后无法找回。" type="warning" :closable="false" />
      <div class="issued-row"><code id="issued-token">{{ admin.issuedSecret }}</code><el-button type="primary" @click="copy">复制 Token</el-button><el-button @click="admin.dismissSecret">已保存，收起</el-button></div>
    </div>
    <el-form label-position="top" :disabled="!!admin.busyId || member.status !== 'active'" @submit.prevent="issue">
      <el-form-item label="凭证用途"><el-input v-model="label" maxlength="128" placeholder="例如：工作电脑的 DSH 插件" /></el-form-item>
      <el-form-item label="权限范围"><el-select v-model="scopes" multiple><el-option v-for="scope in grantable" :key="scope" :value="scope" :label="scope" /></el-select></el-form-item>
      <el-form-item label="到期时间（留空为长期有效）"><el-date-picker v-model="expires" type="datetime" value-format="x" placeholder="选择到期时间" @change="expires = expires === null ? null : Number(expires)" /></el-form-item>
      <el-button type="primary" native-type="submit" :loading="!!admin.busyId" :disabled="!label.trim() || !scopes.length">签发上报 Token</el-button>
    </el-form>
    <el-table :data="admin.tokens" row-key="token_id" empty-text="尚未签发凭证">
      <el-table-column prop="label" label="用途" min-width="110" />
      <el-table-column prop="token_prefix" label="凭证提示" min-width="120" />
      <el-table-column label="权限" min-width="160"><template #default="{ row }"><el-tag v-for="scope in row.scopes" :key="scope" size="small">{{ scope }}</el-tag></template></el-table-column>
      <el-table-column label="状态 / 到期" min-width="155"><template #default="{ row }">{{ row.status === 'revoked' ? '已吊销' : row.expires_at_ms && row.expires_at_ms <= Date.now() ? '已到期' : '有效' }}<br /><small>{{ row.expires_at_ms ? formatFullDateTime(row.expires_at_ms) : '长期有效' }}</small></template></el-table-column>
      <el-table-column label="操作" min-width="160"><template #default="{ row }"><el-button link :disabled="!!admin.busyId || row.status !== 'active' || member.status !== 'active'" @click="action(row, 'rotate')">轮换</el-button><el-button link :disabled="!!admin.busyId || row.status !== 'active'" @click="editing = row; editedScopes = [...row.scopes]">权限</el-button><el-button link type="danger" :disabled="!!admin.busyId || row.status !== 'active'" @click="action(row, 'revoke')">吊销</el-button></template></el-table-column>
    </el-table>
    <el-form v-if="editing" label-position="top" @submit.prevent="saveScopes"><el-form-item :label="'调整权限 · ' + editing.label"><el-select v-model="editedScopes" multiple :disabled="!!admin.busyId"><el-option v-for="scope in grantable" :key="scope" :label="scope" :value="scope" /></el-select></el-form-item><el-button @click="editing = null">取消</el-button><el-button type="primary" native-type="submit" :loading="!!admin.busyId">保存权限</el-button></el-form>
  </div>
</template>
