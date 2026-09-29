<script setup lang="ts">
/**
 * 人员页面只处理人员资料、角色与登录账号。
 *
 * ⚠️ 上报凭证（appKey）不在这里：签发、轮换、吊销与「发给谁」的呈现
 *   统一在 appKey 管理页（`/appkeys`）。两页共用同一批凭证，但回答的
 *   问题不同 —— 这里「这个人是谁」，那里「这把 key 发给了谁」。
 */
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import { Plus, Refresh, Search } from '@element-plus/icons-vue'
import { ElAlert, ElButton, ElCard, ElDialog, ElForm, ElFormItem, ElInput, ElMessage, ElMessageBox, ElOption, ElSelect, ElSkeleton } from 'element-plus'
import { validateName, type PortalMember, type PortalCreateMemberRequest, type PortalLoginAccountRequest } from '@ai-token-report/shared'
import { useSessionStore } from '../stores/session.js'
import { useMembersStore } from '../stores/members.js'
import * as api from '../api/admin.js'
import IssueMemberForm from '../components/IssueMemberForm.vue'
import MemberTable from '../components/MemberTable.vue'
import LoginAccountForm from '../components/LoginAccountForm.vue'
import { groupNamesLabel } from '../types/portal.js'

const session = useSessionStore(), admin = useMembersStore()
const search = ref(''), role = ref(''), showIssue = ref(false)
const selected = ref<PortalMember | null>(null)
const dialog = ref<'edit' | 'login' | null>(null)
/** 编辑资料草稿。★ `group_ids` 是一份**完整集合**（全量替换），不是增量。 */
const draft = reactive({ name: '', group_ids: [] as string[] })
const busy = computed(() => !!admin.busyId || admin.loading)
const members = computed(() => admin.members.filter((m) =>
  (!role.value || m.roles.some((r) => r.role_id === role.value)) &&
  (!search.value.trim() || [m.name, groupNamesLabel(m.groups.map((g) => g.name)), m.account?.username, m.member_id].join(' ').toLowerCase().includes(search.value.trim().toLowerCase())),
))
function open(member: PortalMember, mode: NonNullable<typeof dialog.value>): void {
  selected.value = member; dialog.value = mode; admin.error = null
  // 打开时把「当前归属」抄进草稿：保存时这份草稿就是**全量替换**后的集合，
  // 取消即不提交，所以不存在「只发变化量」这种需要服务端求差的语义。
  draft.name = member.name; draft.group_ids = member.groups.map((group) => group.group_id)
}
function close(): void { dialog.value = null; selected.value = null }
async function create(input: PortalCreateMemberRequest): Promise<void> {
  if (await admin.mutate(() => api.issueMember(input), 'new-member')) { showIssue.value = false; ElMessage.success('成员已保存') }
}
async function saveEdit(): Promise<void> {
  const member = selected.value
  if (!member) return
  const validation = validateName(draft.name)
  if (!validation.ok) { admin.error = validation.reason ?? '姓名不合法'; return }
  // ★ 提交的是完整分组集合（`group_ids` 全量替换）：服务端把该人员的归属设成这个列表，
  //   清空即「未分组」。不做增量 diff —— 「移除最后一个分组」与「没传该字段」必须能区分开。
  if (await admin.mutate(() => api.updateMember({ member_id: member.member_id, expected_version: member.version, name: draft.name.trim(), group_ids: [...draft.group_ids] }), member.member_id)) close()
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
      : enabling ? '恢复人员后，需要重新开通登录或签发 appKey；旧凭证不会恢复。' : '停用人员将使其登录会话和全部上报凭证（appKey）失效，历史用量保留。', (enabling ? '恢复' : '停用') + ' · ' + member.name,
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
    <div class="page-heading"><div><div class="eyebrow">TEAM MANAGEMENT</div><h1>人员管理</h1></div><el-button v-if="session.can('members:manage') && session.can('roles:assign')" type="primary" :icon="Plus" :disabled="busy" @click="admin.error = null; showIssue = true">添加成员</el-button></div>
    <el-alert v-if="admin.error" :title="admin.error" type="error" :closable="false" show-icon role="alert" />
    <el-card shadow="never"><template #header><div class="panel-heading"><div><h2>人员列表</h2><p>同名人员分别记录；分组归属是多对多关联，改名不会改变它。</p></div><el-button :icon="Refresh" :loading="admin.loading" :disabled="!!admin.busyId" @click="admin.error = null; admin.load()">刷新</el-button></div></template>
      <div class="member-filters"><el-input v-model="search" :prefix-icon="Search" clearable placeholder="搜索姓名、分组、账号或 ID" aria-label="搜索成员" /><el-select v-model="role" clearable placeholder="全部角色" aria-label="筛选角色"><el-option v-for="item in admin.roles" :key="item.role_id" :value="item.role_id" :label="item.name" /></el-select><span class="muted">共 {{ members.length }} 人</span></div>
      <el-skeleton v-if="admin.loading && !admin.members.length" :rows="5" animated />
      <MemberTable v-else :members="members" :current-id="session.identity?.member_id ?? null" :busy="busy" :permissions="session.identity?.permissions ?? []" @edit="open($event, 'edit')" @login="open($event, 'login')" @status="changeStatus($event)" @login-status="changeStatus($event, true)" />
    </el-card>
    <el-dialog v-model="showIssue" title="添加团队成员" width="min(500px, 94vw)" destroy-on-close :close-on-click-modal="false" :show-close="!busy" :close-on-press-escape="!busy"><el-alert v-if="admin.error" :title="admin.error" type="error" :closable="false" /><IssueMemberForm :busy="busy" :roles="admin.roles" :groups="admin.groups" @issue="create" @cancel="showIssue = false" /></el-dialog>
    <el-dialog :model-value="dialog !== null" :title="({ edit: '编辑资料', login: '设置登录' }[dialog ?? 'edit']) + ' · ' + (selected?.name ?? '')" width="min(500px, 94vw)" destroy-on-close :close-on-click-modal="false" :show-close="!busy" :close-on-press-escape="!busy" @close="close">
      <template v-if="selected">
        <el-alert v-if="admin.error" :title="admin.error" type="error" :closable="false" />
        <LoginAccountForm v-if="dialog === 'login'" :key="selected.member_id" :member="selected" :busy="busy" @save="saveLogin" @cancel="close" />
        <el-form v-else label-position="top" :disabled="busy" @submit.prevent="saveEdit"><el-form-item label="姓名"><el-input v-model="draft.name" maxlength="32" /></el-form-item><el-form-item label="分组"><el-select v-model="draft.group_ids" multiple filterable clearable collapse-tags collapse-tags-tooltip placeholder="未分组（可多选）" aria-label="选择分组"><el-option v-for="group in admin.groups.filter((g) => g.status === 'active' || draft.group_ids.includes(g.group_id))" :key="group.group_id" :label="group.name" :value="group.group_id" /></el-select></el-form-item><p class="muted">保存后以所选分组为准（全量替换）；一名成员可同时属于多个分组，用量会按其所属的每个分组统计。</p><div class="dialog-actions"><el-button @click="close">取消</el-button><el-button type="primary" native-type="submit" :loading="busy">保存资料</el-button></div></el-form>
      </template>
    </el-dialog>
  </div>
</template>