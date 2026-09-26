<script setup lang="ts">
/** 历史姓名只能由管理员明确确认归属，不能按同名自动接管历史记录。 */
import { onUnmounted, ref } from 'vue'
import { ElAlert, ElButton, ElForm, ElFormItem, ElInput, ElMessage, ElMessageBox, ElOption, ElSelect, ElTable, ElTableColumn } from 'element-plus'
import type { PortalLegacyAttribution } from '@ai-token-report/shared'
import { useMembersStore } from '../stores/members.js'
import { useSessionStore } from '../stores/session.js'
import { fetchLegacyAttributions, confirmLegacyAttribution } from '../api/admin.js'
const admin = useMembersStore(), session = useSessionStore()
const mappings = ref<PortalLegacyAttribution[]>([]), selected = ref<PortalLegacyAttribution | null>(null)
const memberId = ref(''), reason = ref(''), error = ref<string | null>(null), loading = ref(false)
let alive = true
async function load(): Promise<void> {
  loading.value = true; error.value = null
  const result = await fetchLegacyAttributions()
  if (!alive) return
  loading.value = false
  if (result.ok) mappings.value = result.data.mappings
  else { error.value = result.error; if (result.status === 401) session.expire('登录已失效') }
}
function select(mapping: PortalLegacyAttribution): void { selected.value = mapping; memberId.value = ''; reason.value = '' }
async function confirm(): Promise<void> {
  const mapping = selected.value, member = admin.members.find((m) => m.member_id === memberId.value)
  if (!mapping || !member || !reason.value.trim()) return
  try {
    await ElMessageBox.confirm(`将历史归属「${mapping.legacy_user_id}」确认给「${member.name} · ${member.member_id.slice(0, 8)}」。只影响这批历史，原始用量与署名快照保留。`, '确认历史归属', { confirmButtonText: '确认归属', cancelButtonText: '取消', type: 'warning' })
    const result = await admin.mutate(() => confirmLegacyAttribution({ mapping_id: mapping.mapping_id, member_id: member.member_id, expected_status: 'pending', source_import_ref: mapping.source_import_ref, reason: reason.value.trim() }), mapping.mapping_id)
    if (!alive) return
    if (result) { selected.value = null; await load(); ElMessage.success(`已确认 ${result.updated_events ?? 0} 条历史记录`) }
    else error.value = admin.error
  } catch { /* 用户取消。 */ }
}
onUnmounted(() => { alive = false; selected.value = null; reason.value = '' })
</script>
<template>
  <div class="page-stack">
    <el-alert title="旧记录保留为待确认历史；确认前请核对原人员与目标人员，不能仅凭同名判断。" type="info" :closable="false" />
    <el-alert v-if="error" :title="error" type="error" :closable="false" />
    <div><el-button :loading="loading" :disabled="!!admin.busyId" @click="load">加载历史归属</el-button></div>
    <el-table :data="mappings" row-key="mapping_id"><el-table-column prop="legacy_user_id" label="旧归属" /><el-table-column label="状态"><template #default="{ row }">{{ row.status === 'pending' ? '待确认' : row.status === 'mapped' ? '已确认' : '已忽略' }}</template></el-table-column><el-table-column label="目标人员"><template #default="{ row }">{{ admin.members.find(m => m.member_id === row.member_id)?.name ?? '—' }}</template></el-table-column><el-table-column prop="decision_reason" label="确认依据" /><el-table-column v-if="session.can('members:manage')" label="操作"><template #default="{ row }"><el-button link :disabled="row.status !== 'pending' || !!admin.busyId" @click="select(row)">核对并确认</el-button></template></el-table-column></el-table>
    <el-form v-if="selected" label-position="top" :disabled="!!admin.busyId" @submit.prevent="confirm"><el-form-item :label="'历史归属：' + selected.legacy_user_id"><el-select v-model="memberId" filterable placeholder="明确选择目标人员"><el-option v-for="member in admin.members" :key="member.member_id" :value="member.member_id" :label="member.name + ' · ' + (member.department_name ?? '未分配部门') + ' · ' + member.member_id.slice(0, 8)" /></el-select></el-form-item><el-form-item label="确认依据"><el-input v-model="reason" maxlength="512" placeholder="说明核对方式或原始记录依据" /></el-form-item><el-button @click="selected = null">取消</el-button><el-button type="primary" native-type="submit" :disabled="!memberId || !reason.trim()" :loading="!!admin.busyId">提交归属确认</el-button></el-form>
  </div>
</template>
