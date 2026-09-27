<script setup lang="ts">
/** 人员页面只处理人员资料、登录账号与上报凭证；目录维护由独立管理页承接。 */
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import { Plus, Refresh, Search } from '@element-plus/icons-vue'
import { ElAlert, ElButton, ElCard, ElCollapse, ElCollapseItem, ElDialog, ElForm, ElFormItem, ElInput, ElMessage, ElMessageBox, ElOption, ElSelect, ElSkeleton, ElTable, ElTableColumn } from 'element-plus'
import { validateName, type PortalMember, type PortalCreateMemberRequest, type PortalLoginAccountRequest } from '@ai-token-report/shared'
import { useSessionStore } from '../stores/session.js'
import { useMembersStore } from '../stores/members.js'
import * as api from '../api/admin.js'
import IssueMemberForm from '../components/IssueMemberForm.vue'
import MemberTable from '../components/MemberTable.vue'
import LoginAccountForm from '../components/LoginAccountForm.vue'
import TokenManager from '../components/TokenManager.vue'
import LegacyAttributions from '../components/LegacyAttributions.vue'
import { formatFullDateTime } from '../utils/format.js'

const session = useSessionStore(), admin = useMembersStore()
const search = ref(''), role = ref(''), showIssue = ref(false)
const selected = ref<PortalMember | null>(null)
const dialog = ref<'edit' | 'login' | 'tokens' | null>(null)
const draft = reactive({ name: '', department_id: '' })
const busy = computed(() => !!admin.busyId || admin.loading)
const members = computed(() => admin.members.filter((m) =>
  (!role.value || m.roles.some((r) => r.role_id === role.value)) &&
  (!search.value.trim() || [m.name, m.department_name, m.account?.username, m.member_id].join(' ').toLowerCase().includes(search.value.trim().toLowerCase())),
))
const currentSelected = computed(() => admin.members.find((m) => m.member_id === selected.value?.member_id) ?? selected.value)
const adminCount = computed(() => admin.members.filter((m) => m.roles.some((r) => r.code === 'admin')).length)
function open(member: PortalMember, mode: NonNullable<typeof dialog.value>): void {
  selected.value = member; dialog.value = mode; admin.error = null
  draft.name = member.name; draft.department_id = member.department_id ?? ''
  if (mode === 'tokens') void admin.loadTokens(member.member_id)
}
function close(): void { dialog.value = null; selected.value = null; admin.closeTokens() }
async function create(input: PortalCreateMemberRequest): Promise<void> {
  if (await admin.mutate(() => api.issueMember(input), 'new-member')) { showIssue.value = false; ElMessage.success('成员已保存') }
}
async function saveEdit(): Promise<void> {
  const member = selected.value
  if (!member) return
  const validation = validateName(draft.name)
  if (!validation.ok) { admin.error = validation.reason ?? '姓名不合法'; return }
  if (await admin.mutate(() => api.updateMember({ member_id: member.member_id, expected_version: member.version, name: draft.name.trim(), department_id: draft.department_id || null }), member.member_id)) close()
}
async function saveLogin(input: PortalLoginAccountRequest): Promise<void> {
  const self = input.member_id === session.identity?.member_id
  if (await admin.mutate(() => api.setLoginAccount(input), input.member_id)) {
    close(); ElMessage.success('登录账号已保存，旧会话已失效')
    if (self) session.expire('账号已更新，请重新登录')
  }
}
async function changeStatus(member: PortalMember, account = false): Promise<void> {
  const enabling = account ? !member.account?.enabled : member.status !== 'active'
  try {
    await ElMessageBox.confirm(account
      ? enabling ? '恢复此账号的登录。' : '停用此登录账号并使其现有会话失效。'
      : enabling ? '恢复人员后，需要重新开通登录或签发 Token；旧凭证不会恢复。' : '停用人员将使其登录会话和全部上报 Token 失效，历史用量保留。', (enabling ? '恢复' : '停用') + ' · ' + member.name,
    { confirmButtonText: '确认', cancelButtonText: '取消', type: 'warning' })
    const request = { member_id: member.member_id, expected_version: member.version }
    const result = await admin.mutate(() => account ? api.setLoginStatus({ ...request, enabled: enabling }) : api.updateMemberStatus({ ...request, status: enabling ? 'active' : 'disabled' }), member.member_id)
    if (result && !enabling && member.member_id === session.identity?.member_id) session.expire('当前身份已停用')
  } catch { /* 用户取消。 */ }
}
onMounted(() => { void admin.load('members') })
onUnmounted(() => { admin.clear() })
</script>
<template>
  <div class="page-stack">
    <div class="page-heading"><div><div class="eyebrow">TEAM MANAGEMENT</div><h1>人员管理</h1><p>维护团队成员资料、登录账号和上报凭证。</p></div><el-button v-if="session.can('members:manage') && session.can('roles:assign')" type="primary" :icon="Plus" :disabled="busy" @click="admin.error = null; showIssue = true">添加成员</el-button></div>
    <el-alert v-if="admin.error" :title="admin.error" type="error" :closable="false" show-icon role="alert" />
    <div class="member-summary"><el-card shadow="never"><span>团队成员</span><strong>{{ admin.members.length }}<small>人</small></strong></el-card><el-card shadow="never"><span>管理员角色</span><strong>{{ adminCount }}<small>人</small></strong></el-card><el-card shadow="never"><span>数据库</span><strong class="storage-status">{{ admin.storage?.kind === 'mysql' ? 'MySQL' : admin.storage?.kind === 'sqlite' ? 'SQLite' : '连接中' }}</strong></el-card></div>
    <el-card shadow="never"><template #header><div class="panel-heading"><div><h2>人员列表</h2><p>同名人员分别记录，修改资料不会改变人员归属。</p></div><el-button :icon="Refresh" :loading="admin.loading" :disabled="!!admin.busyId" @click="admin.error = null; admin.load()">刷新</el-button></div></template>
      <div class="member-filters"><el-input v-model="search" :prefix-icon="Search" clearable placeholder="搜索姓名、部门、账号或 ID" aria-label="搜索成员" /><el-select v-model="role" clearable placeholder="全部角色" aria-label="筛选角色"><el-option v-for="item in admin.roles" :key="item.role_id" :value="item.role_id" :label="item.name" /></el-select><span class="muted">共 {{ members.length }} 人</span></div>
      <el-skeleton v-if="admin.loading && !admin.members.length" :rows="5" animated />
      <MemberTable v-else :members="members" :current-id="session.identity?.member_id ?? null" :busy="busy" :permissions="session.identity?.permissions ?? []" @edit="open($event, 'edit')" @login="open($event, 'login')" @tokens="open($event, 'tokens')" @status="changeStatus($event)" @login-status="changeStatus($event, true)" />
    </el-card>
    <el-collapse><el-collapse-item title="历史归属确认" name="legacy"><LegacyAttributions /></el-collapse-item><el-collapse-item v-if="session.can('audit:read')" title="最近管理操作" name="audit"><el-button :disabled="busy" @click="admin.loadAudit">加载操作记录</el-button><el-table :data="admin.audits"><el-table-column label="时间" min-width="160"><template #default="{ row }">{{ formatFullDateTime(row.created_at_ms) }}</template></el-table-column><el-table-column prop="action" label="操作" /><el-table-column prop="target_type" label="对象类型" /><el-table-column prop="target_id" label="对象 ID" min-width="280" /></el-table></el-collapse-item></el-collapse>
    <el-dialog v-model="showIssue" title="添加团队成员" width="min(500px, 94vw)" destroy-on-close :close-on-click-modal="false" :show-close="!busy" :close-on-press-escape="!busy"><el-alert v-if="admin.error" :title="admin.error" type="error" :closable="false" /><IssueMemberForm :busy="busy" :roles="admin.roles" :departments="admin.departments" @issue="create" @cancel="showIssue = false" /></el-dialog>
    <el-dialog :model-value="dialog !== null" :title="({ edit: '编辑资料', login: '设置登录', tokens: '上报凭证' }[dialog ?? 'edit']) + ' · ' + (selected?.name ?? '')" :width="dialog === 'tokens' ? 'min(980px, 96vw)' : 'min(500px, 94vw)'" destroy-on-close :close-on-click-modal="false" :show-close="!busy" :close-on-press-escape="!busy" @close="close">
      <template v-if="selected">
        <el-alert v-if="admin.error && dialog !== 'tokens'" :title="admin.error" type="error" :closable="false" />
        <LoginAccountForm v-if="dialog === 'login'" :key="selected.member_id" :member="selected" :busy="busy" @save="saveLogin" @cancel="close" />
        <TokenManager v-else-if="dialog === 'tokens' && currentSelected" :key="selected.member_id" :member="currentSelected" />
        <el-form v-else-if="dialog === 'edit'" label-position="top" :disabled="busy" @submit.prevent="saveEdit"><el-form-item label="姓名"><el-input v-model="draft.name" maxlength="32" /></el-form-item><el-form-item label="部门"><el-select v-model="draft.department_id" clearable><el-option v-for="dept in admin.departments.filter(d => d.status === 'active' || d.department_id === draft.department_id)" :key="dept.department_id" :label="dept.name" :value="dept.department_id" /></el-select></el-form-item><div class="dialog-actions"><el-button @click="close">取消</el-button><el-button type="primary" native-type="submit" :loading="busy">保存资料</el-button></div></el-form>
      </template>
    </el-dialog>
  </div>
</template>
