<script setup lang="ts">
/**
 * 人员页面只处理人员资料、角色与登录账号。
 *
 * ⚠️ 上报凭证（appKey）不在这里：签发、轮换、吊销与「发给谁」的呈现
 *   统一在 appKey 管理页（`/appkeys`）。两页共用同一批凭证，但回答的
 *   问题不同 —— 这里「这个人是谁」，那里「这把 key 发给了谁」。
 *
 * ★ 「编辑资料」弹框把姓名 / 分组 / **角色**收在一处：三样都是「这个人是谁、
 *   他能做什么」，分散在两个页面只会让人以为「改角色必须去角色管理页」。
 *   ⚠️ 收拢的只是**入口**：资料与角色仍是两个端点、两道权限
 *   （`members:manage` / `roles:assign`），提交顺序见 `views/memberEditModel.ts`。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useAssistantPageSearch } from '../utils/assistantPageSearch.js'
import { useAssistantForm, assistantFormEntry, assistantMemberPrefill } from '../utils/assistantForms.js'
import { Plus, Refresh, Search } from '@element-plus/icons-vue'
import { ElAlert, ElButton, ElCard, ElDialog, ElInput, ElMessage, ElMessageBox, ElOption, ElSelect, ElSkeleton } from 'element-plus'
import type { PortalMember, PortalCreateMemberRequest, PortalLoginAccountRequest } from '@ai-token-report/shared'
import { useSessionStore } from '../stores/session.js'
import { useMembersStore } from '../stores/members.js'
import * as api from '../api/admin.js'
import EditMemberForm from '../components/EditMemberForm.vue'
import IssueMemberForm from '../components/IssueMemberForm.vue'
import MemberTable from '../components/MemberTable.vue'
import LoginAccountForm from '../components/LoginAccountForm.vue'
import { groupNamesLabel } from '../types/portal.js'
import { rolePickerOptions } from './rolesModel.js'
import { submitMemberEdit, type MemberEditDraft } from './memberEditModel.js'

const session = useSessionStore(), admin = useMembersStore()
const search = useAssistantPageSearch(() => { void admin.load('members') }, () => admin.loading), role = ref(''), showIssue = ref(false)
const selected = ref<PortalMember | null>(null)
const formInitialValues = ref<{ name?: string; group_ids?: string[] }>()
const dialog = ref<'edit' | 'login' | null>(null)
/**
 * 本地「提交中」标记。
 *
 * ⚠️ 不能只看 `admin.busyId`：一次保存可能要连发两条请求（先资料、再角色），
 *   而 store 在两条之间会把 `busyId` 清掉（它随后还要刷新目录）——
 *   那一瞬间「保存资料」是可点的，第二次点击拿的是同一个旧版本号，必然 409，
 *   使用者看到「资料已被其他操作更新」而其实只点了一下。
 */
const saving = ref(false)
const busy = computed(() => !!admin.busyId || admin.loading || saving.value)
/**
 * 角色那一栏的两道门：`roles:assign`（能改）与 `roles:read`（有目录可选）。
 * 只给 assign 不给 read 时下拉是空的 —— 让人对着空下拉保存，等于让他用一次
 * 「全量替换」把角色清空（本地会拦下空集合，但那只是一句报错）。
 */
const canAssignRoles = computed(() => session.can('roles:assign') && session.can('roles:read'))
/** 候选项 = 启用角色 ∪ 这个人当前持有的（含已停用，标注出来）。见 `rolePickerOptions`。 */
const roleOptions = computed(() => rolePickerOptions(admin.roles, selected.value?.roles.map((item) => item.role_id) ?? []))
const members = computed(() => admin.members.filter((m) =>
  (!role.value || m.roles.some((r) => r.role_id === role.value)) &&
  (!search.value.trim() || [m.name, groupNamesLabel(m.groups.map((g) => g.name)), m.account?.username, m.member_id].join(' ').toLowerCase().includes(search.value.trim().toLowerCase())),
))
function open(member: PortalMember, mode: NonNullable<typeof dialog.value>): void {
  formInitialValues.value = undefined; selected.value = member; dialog.value = mode; admin.error = null
  // 草稿由表单组件从 `member` 初始化（它挂了 `:key="member.member_id"`），
  // 所以这里不抄一份：两份草稿就是两个「打开时抄了什么」的实现。
}
function close(): void { dialog.value = null; selected.value = null; formInitialValues.value = undefined }
function openIssue(): void { formInitialValues.value = undefined; admin.error = null; showIssue.value = true }
async function create(input: PortalCreateMemberRequest): Promise<void> {
  if (await admin.mutate(() => api.issueMember(input), 'new-member')) { showIssue.value = false; ElMessage.success('成员已保存') }
}
async function saveEdit(input: MemberEditDraft): Promise<void> {
  const member = selected.value
  if (!member || saving.value) return
  saving.value = true
  try {
    const outcome = await submitMemberEdit({
      // 不直接传 `admin.mutate`：包一层让这里始终读到 store 代理，也与其余调用点同一个写法。
      mutate: (action, id) => admin.mutate(action, id),
      updateProfile: api.updateMember,
      updateRoles: api.updateRoles,
    }, member, input, canAssignRoles.value)
    if (!outcome.ok) {
      // `reason: null` = 请求失败，原因已由 store 写在 `error` 上（版本冲突另有专门文案），
      // 这里**不要覆盖**它 —— 覆盖等于把「这一行过期了」换成一句更没用的话。
      if (outcome.reason !== null) admin.error = outcome.reason
      return
    }
    close()
    // 一个字段都没改就不报「已保存」：那会让人以为自己的修改生效了。
    if (outcome.changed) ElMessage.success('人员资料已保存')
  } finally { saving.value = false }
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
useAssistantForm('members', {
  canOpen: () => session.can('members:manage'),
  isLoading: () => admin.loading, isBusy: () => !!admin.busyId || saving.value,
  isOpen: () => showIssue.value || dialog.value !== null, error: () => admin.error,
  open: request => {
    const member = assistantFormEntry(request, admin.members, row => row.member_id)
    if (member) { open(member, 'edit'); formInitialValues.value = assistantMemberPrefill(request.values) }
    else {
      if (!session.can('roles:assign')) throw new Error('添加成员需要分配普通成员角色的权限')
      openIssue(); formInitialValues.value = assistantMemberPrefill(request.values)
    }
  },
})
onMounted(() => { void admin.load('members') })
onUnmounted(() => { admin.clear() })
</script>
<template>
  <div class="page-stack">
    <div class="page-heading"><div><div class="eyebrow">TEAM MANAGEMENT</div><h1>人员管理</h1></div><el-button v-if="session.can('members:manage') && session.can('roles:assign')" type="primary" :icon="Plus" :disabled="busy" @click="openIssue">添加成员</el-button></div>
    <el-alert v-if="admin.error" :title="admin.error" type="error" :closable="false" show-icon role="alert" />
    <el-card shadow="never"><template #header><div class="panel-heading"><div><h2>人员列表</h2><p>同名人员分别记录；分组与角色都是关联表，改名不会改变它们。</p></div><el-button :icon="Refresh" :loading="admin.loading" :disabled="!!admin.busyId" @click="admin.error = null; admin.load()">刷新</el-button></div></template>
      <div class="member-filters"><el-input v-model="search" :prefix-icon="Search" clearable placeholder="搜索姓名、分组、账号或 ID" aria-label="搜索成员" /><el-select v-model="role" clearable placeholder="全部角色" aria-label="筛选角色"><el-option v-for="item in admin.roles" :key="item.role_id" :value="item.role_id" :label="item.name" /></el-select><span class="muted">共 {{ members.length }} 人</span></div>
      <el-skeleton v-if="admin.loading && !admin.members.length" :rows="5" animated />
      <MemberTable v-else :members="members" :current-id="session.identity?.member_id ?? null" :busy="busy" :permissions="session.identity?.permissions ?? []" @edit="open($event, 'edit')" @login="open($event, 'login')" @status="changeStatus($event)" @login-status="changeStatus($event, true)" />
    </el-card>
    <el-dialog v-model="showIssue" title="添加团队成员" width="min(500px, 94vw)" destroy-on-close :close-on-click-modal="false" :show-close="!busy" :close-on-press-escape="!busy"><el-alert v-if="admin.error" :title="admin.error" type="error" :closable="false" /><IssueMemberForm :busy="busy" :roles="admin.roles" :groups="admin.groups" :initial-values="formInitialValues" @issue="create" @cancel="showIssue = false" /></el-dialog>
    <el-dialog :model-value="dialog !== null" :title="({ edit: '编辑资料', login: '设置登录' }[dialog ?? 'edit']) + ' · ' + (selected?.name ?? '')" width="min(500px, 94vw)" destroy-on-close :close-on-click-modal="false" :show-close="!busy" :close-on-press-escape="!busy" @close="close">
      <template v-if="selected">
        <el-alert v-if="admin.error" :title="admin.error" type="error" :closable="false" />
        <LoginAccountForm v-if="dialog === 'login'" :key="selected.member_id" :member="selected" :busy="busy" @save="saveLogin" @cancel="close" />
        <EditMemberForm v-else :key="selected.member_id" :member="selected" :groups="admin.groups" :role-options="roleOptions" :can-assign-roles="canAssignRoles" :busy="busy" :initial-values="formInitialValues" @save="saveEdit" @cancel="close" />
      </template>
    </el-dialog>
  </div>
</template>
