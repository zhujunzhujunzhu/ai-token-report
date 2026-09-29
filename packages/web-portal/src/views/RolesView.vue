<script setup lang="ts">
/**
 * 角色管理：定义角色（一组权限）并把它分配给团队成员。
 *
 * ★ 这一页管两件**改不同表**的事，刻意放在同一个入口下：
 *   1. 角色定义（新建 / 改名 / 改权限 / 启停）→ `roles` + `role_permissions`
 *   2. 分配角色 → `member_roles`，**一个人可同时持多个角色，权限取并集**
 *
 * ⚠️ 内置角色（`admin` / `member`）只读：服务端 `assertEditableRole` 会拒绝改写，
 *   所以页面**不给出入口**，而不是让人点完再看一次 409。
 * ⚠️ 停用角色的真正判断在服务端（仍被在职成员持有时回 409「请先为他们调整角色」）：
 *   页面这里的名单随时可能过期，前置提示只是提醒，不是门禁。
 * ⚠️ 权限勾选清单来自服务端 `permissions` 表（随角色目录一起下发），页面不硬编码 ——
 *   硬编码一份会漏掉数据库里真实存在的权限，而页面看起来「权限就这些」。
 */
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import { Plus, Refresh, Search } from '@element-plus/icons-vue'
import {
  ElAlert, ElButton, ElCard, ElCheckbox, ElCheckboxGroup, ElDialog, ElForm, ElFormItem,
  ElInput, ElMessage, ElMessageBox, ElOption, ElSelect, ElSkeleton, ElTable, ElTableColumn, ElTag,
} from 'element-plus'
import type { FormInstance, FormRules } from 'element-plus'
import type { PortalMember, PortalMemberGroupRef, PortalRole } from '@ai-token-report/shared'
import { useMembersStore } from '../stores/members.js'
import { useSessionStore } from '../stores/session.js'
import { assignableRoles, filterRoles, permissionLabel, permissionOptions } from './rolesModel.js'
import * as api from '../api/admin.js'

const admin = useMembersStore(), session = useSessionStore()
const search = ref(''), status = ref('')
const showRoleForm = ref(false), showAssign = ref(false)
const editing = ref<PortalRole | null>(null)
const form = ref<FormInstance>()
const draft = reactive({ code: '', name: '', permissions: [] as string[] })
const selected = ref<PortalMember | null>(null)
const memberId = ref(''), roleIds = ref<string[]>([]), initialRoleId = ref<string | null>(null)
const busy = computed(() => admin.loading || !!admin.busyId)
/** 定义角色与分配角色共用 `roles:assign`；能给人改角色还需要能读人员名单。 */
const canManage = computed(() => session.can('roles:assign'))
const canAssign = computed(() => canManage.value && session.can('members:read'))
/** 过滤与「哪些角色能被分配」都在 `rolesModel.ts` 里，那里能被 `bun test` 直接断言。 */
const roles = computed(() => filterRoles(admin.roles, { search: search.value, status: status.value }))
const assignable = computed(() => assignableRoles(admin.roles))
const permissionChoices = computed(() => permissionOptions(admin.permissions))
/** 分组可能整体缺失（人员列表早于分组数据），所以按可选处理而不是直接 `.map`。 */
function groupLabel(groups: PortalMemberGroupRef[] | undefined): string {
  return (groups ?? []).map((group) => group.name).join('、')
}
function memberCount(roleId: string): number {
  return admin.members.filter((member) => member.roles.some((role) => role.role_id === roleId)).length
}
function memberLabel(member: PortalMember): string {
  return `${member.name} · ${groupLabel(member.groups) || '未分组'} · ${member.member_id.slice(0, 8)}`
}
const rules: FormRules = {
  code: [{
    required: true,
    validator: (_rule, value, done) => {
      const code = String(value).trim()
      done(/^[a-z][a-z0-9_.:-]*$/.test(code)
        ? undefined
        : new Error('角色标识需要以字母开头，只能使用小写字母、数字与 _ . : -'))
    },
    trigger: 'blur',
  }],
  name: [{
    required: true,
    validator: (_rule, value, done) => {
      const name = String(value)
      done(name.trim() && name.trim().length <= 128 && !/[\r\n\t]/.test(name)
        ? undefined
        : new Error('角色名称须为 1～128 个字符，不能包含换行或制表符'))
    },
    trigger: 'blur',
  }],
}
/**
 * 表格插槽给的 `row` 是 Element Plus 自己的 `DefaultRow`（`Record<PropertyKey, any>`），
 * 不是本页的契约类型，而模板里做不了类型断言 —— 所以入口收 `unknown`、
 * 在这里收窄一次。行的真实形状由 `GET /api/v1/admin/roles` 决定。
 */
const rowRole = (row: unknown): PortalRole => row as PortalRole
function openRole(role: PortalRole | null = null): void {
  editing.value = role
  draft.code = role?.code ?? ''
  draft.name = role?.name ?? ''
  draft.permissions = [...(role?.permissions ?? [])]
  admin.error = null
  showRoleForm.value = true
}
async function saveRole(): Promise<void> {
  if (busy.value || !(await form.value?.validate().catch(() => false))) return
  const role = editing.value
  const name = draft.name.trim()
  const result = await admin.mutate(() => role
    ? api.updateRole({
      role_id: role.role_id, expected_version: role.version, name, permission_codes: [...draft.permissions],
    })
    : api.createRole({ code: draft.code.trim(), name, permission_codes: [...draft.permissions] }),
  role?.role_id ?? 'new-role')
  if (result) {
    showRoleForm.value = false
    ElMessage.success(role ? '角色已更新' : '角色已创建')
  }
}
async function changeRoleStatus(role: PortalRole): Promise<void> {
  if (busy.value) return
  const enabling = role.status !== 'active'
  try {
    await ElMessageBox.confirm(enabling
      ? '启用后，可以为团队成员选择此角色。'
      : '停用后不能再把此角色分配给新成员；若仍有在职成员持有它，服务端会拒绝停用并提示先为他们调整角色。',
    `${enabling ? '启用' : '停用'}角色 · ${role.name}`,
    { type: 'warning', confirmButtonText: enabling ? '启用角色' : '停用角色', cancelButtonText: '取消' })
    if (await admin.mutate(() => api.updateRoleStatus({
      role_id: role.role_id, expected_version: role.version, status: enabling ? 'active' : 'disabled',
    }), role.role_id)) ElMessage.success(enabling ? '角色已启用' : '角色已停用')
  } catch { /* 用户取消。 */ }
}
function openAssign(roleId: string | null = null): void {
  initialRoleId.value = roleId
  memberId.value = ''; selected.value = null; roleIds.value = []
  admin.error = null; showAssign.value = true
}
function selectMember(id: string): void {
  // 保留选中时的版本：冲突后须重新确认，不能把旧表单悄悄套到新版本上。
  selected.value = admin.members.find((member) => member.member_id === id) ?? null
  const existing = selected.value?.roles.map((role) => role.role_id) ?? []
  roleIds.value = [...new Set(initialRoleId.value ? [...existing, initialRoleId.value] : existing)]
}
async function saveAssign(): Promise<void> {
  const member = selected.value
  if (busy.value || !member || !roleIds.value.length) return
  if (await admin.mutate(() => api.updateRoles({
    member_id: member.member_id, expected_version: member.version, role_ids: roleIds.value,
  }), member.member_id)) {
    showAssign.value = false
    ElMessage.success('人员角色已更新')
  }
}
onMounted(() => { void admin.load('roles') })
onUnmounted(() => { admin.clear() })
</script>

<template>
  <div class="page-stack">
    <div class="page-heading">
      <div>
        <div class="eyebrow">ROLE MANAGEMENT</div>
        <h1>角色管理</h1>
        <p>定义每个角色能做哪些事，再把角色分配给团队成员；一个人可以同时持有多个角色。</p>
      </div>
      <div class="heading-actions">
        <el-button v-if="canAssign" :icon="Plus" :disabled="busy" @click="openAssign()">分配角色</el-button>
        <el-button v-if="canManage" type="primary" :icon="Plus" :disabled="busy" @click="openRole()">新建角色</el-button>
      </div>
    </div>
    <el-alert v-if="admin.error" :title="admin.error" type="error" :closable="false" show-icon role="alert" />
    <el-card shadow="never">
      <template #header>
        <div class="panel-heading">
          <div><h2>角色列表</h2><p>内置角色由服务端维护，不能改名、改权限或停用；自定义角色可随时调整，保存后立即生效。</p></div>
          <el-button :icon="Refresh" :loading="admin.loading" :disabled="!!admin.busyId" @click="admin.error = null; admin.load()">刷新</el-button>
        </div>
      </template>
      <div class="member-filters">
        <el-input v-model="search" :prefix-icon="Search" clearable placeholder="搜索角色名称或标识" aria-label="搜索角色" />
        <el-select v-model="status" clearable placeholder="全部状态" aria-label="筛选角色状态">
          <el-option label="启用" value="active" /><el-option label="停用" value="disabled" />
        </el-select>
        <span class="muted">共 {{ roles.length }} 个角色</span>
      </div>
      <el-skeleton v-if="admin.loading && !admin.roles.length" :rows="5" animated />
      <el-table v-else :data="roles" row-key="role_id" empty-text="暂无符合条件的角色">
        <el-table-column label="角色名称" min-width="160">
          <template #default="{ row }">
            <span class="role-name">{{ row.name }}</span>
            <el-tag v-if="row.is_builtin" size="small" type="warning" effect="plain" class="role-badge">内置</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="code" label="角色标识" min-width="120" />
        <el-table-column v-if="session.can('members:read')" label="关联人员" width="100">
          <template #default="{ row }">{{ memberCount(row.role_id) }} 人</template>
        </el-table-column>
        <el-table-column label="权限范围" min-width="340">
          <template #default="{ row }">
            <div class="permission-tags">
              <el-tag v-for="permission in row.permissions" :key="permission" size="small" type="info" :title="permission">{{ permissionLabel(permission) }}</el-tag>
              <span v-if="!row.permissions.length" class="muted">暂无权限</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="90">
          <template #default="{ row }"><el-tag :type="row.status === 'active' ? 'success' : 'info'">{{ row.status === 'active' ? '启用' : '停用' }}</el-tag></template>
        </el-table-column>
        <el-table-column v-if="canManage" label="操作" width="220" fixed="right">
          <template #default="{ row }">
            <el-button
              link type="primary" :disabled="busy || row.is_builtin"
              :title="row.is_builtin ? '内置角色由服务端维护，不能修改' : ''"
              @click="openRole(rowRole(row))"
            >编辑</el-button>
            <el-button v-if="!row.is_builtin" link :type="row.status === 'active' ? 'danger' : 'primary'" :disabled="busy" @click="changeRoleStatus(rowRole(row))">{{ row.status === 'active' ? '停用' : '启用' }}</el-button>
            <el-button v-if="canAssign" link type="primary" :disabled="busy" @click="openAssign(row.role_id)">分配角色</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-dialog v-model="showRoleForm" :title="editing ? '编辑角色' : '新建角色'" width="min(560px, 94vw)" destroy-on-close :close-on-click-modal="false" :show-close="!busy" :close-on-press-escape="!busy">
      <el-alert v-if="admin.error" :title="admin.error" type="error" :closable="false" show-icon />
      <el-form ref="form" :model="draft" :rules="rules" label-position="top" :disabled="busy" @submit.prevent="saveRole">
        <el-form-item label="角色标识" prop="code">
          <el-input v-model="draft.code" :disabled="!!editing" maxlength="64" placeholder="例如 operator；创建后不可修改" autocomplete="off" />
        </el-form-item>
        <el-form-item label="角色名称" prop="name">
          <el-input v-model="draft.name" maxlength="128" show-word-limit placeholder="例如 运营查看者" autocomplete="off" />
        </el-form-item>
        <el-form-item label="权限范围">
          <el-checkbox-group v-model="draft.permissions" class="permission-picker">
            <el-checkbox v-for="option in permissionChoices" :key="option.code" :value="option.code">{{ option.label }}</el-checkbox>
          </el-checkbox-group>
        </el-form-item>
        <p class="muted">保存后立即生效：持有该角色的人权限随之变化。这里只能勾选你自己当前拥有的权限，超出会被服务端拒绝。</p>
        <div class="dialog-actions">
          <el-button @click="showRoleForm = false">取消</el-button>
          <el-button type="primary" native-type="submit" :loading="busy">{{ editing ? '保存角色' : '创建角色' }}</el-button>
        </div>
      </el-form>
    </el-dialog>

    <el-dialog v-model="showAssign" title="分配角色" width="min(540px, 94vw)" destroy-on-close :close-on-click-modal="false" :show-close="!busy" :close-on-press-escape="!busy">
      <el-alert v-if="admin.error" :title="admin.error" type="error" :closable="false" show-icon />
      <el-form label-position="top" :disabled="busy" @submit.prevent="saveAssign">
        <el-form-item label="团队成员" required>
          <el-select v-model="memberId" filterable placeholder="选择需要调整角色的成员" aria-label="选择团队成员" @change="selectMember">
            <el-option v-for="member in admin.members" :key="member.member_id" :value="member.member_id" :label="memberLabel(member)" />
          </el-select>
        </el-form-item>
        <el-form-item label="分配角色（可多选）" required>
          <el-select v-model="roleIds" multiple :disabled="!selected" placeholder="请至少选择一个角色" aria-label="选择角色">
            <el-option v-for="role in assignable" :key="role.role_id" :label="role.name" :value="role.role_id" />
          </el-select>
        </el-form-item>
        <p class="muted">保存后以所选角色为准（全量替换）。一个人可以同时持有多个角色，他的权限是这些角色权限的并集；至少需要保留一个角色。</p>
        <div class="dialog-actions">
          <el-button @click="showAssign = false">取消</el-button>
          <el-button type="primary" native-type="submit" :loading="busy" :disabled="!selected || !roleIds.length">保存角色</el-button>
        </div>
      </el-form>
    </el-dialog>
  </div>
</template>

<style scoped>
/* 本页标题右侧有两个入口（定义角色 / 分配角色），单按钮的间距规则不够用。 */
.heading-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
}
/* 权限勾选是一组短标签，横向排布比竖列表更省空间，也更容易一眼看全。 */
.permission-picker {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 16px;
}
.role-name {
  margin-right: 8px;
}
.role-badge {
  vertical-align: middle;
}
</style>