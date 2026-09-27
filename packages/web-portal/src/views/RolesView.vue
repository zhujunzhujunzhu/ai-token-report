<script setup lang="ts">
/** 角色页展示服务端权限目录，并通过已有人员角色接口分配权限；角色定义由服务端维护。 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { Plus, Refresh, Search } from '@element-plus/icons-vue'
import {
  ElAlert, ElButton, ElCard, ElDialog, ElForm, ElFormItem, ElInput,
  ElMessage, ElOption, ElSelect, ElSkeleton, ElTable, ElTableColumn, ElTag,
} from 'element-plus'
import type { PortalMember } from '@ai-token-report/shared'
import { useMembersStore } from '../stores/members.js'
import { useSessionStore } from '../stores/session.js'
import * as api from '../api/admin.js'

const admin = useMembersStore(), session = useSessionStore()
const search = ref(''), showForm = ref(false), memberId = ref('')
const selected = ref<PortalMember | null>(null)
const roleIds = ref<string[]>([])
const initialRoleId = ref<string | null>(null)
const busy = computed(() => admin.loading || !!admin.busyId)
const canAssign = computed(() => session.can('roles:assign') && session.can('members:read'))
const roles = computed(() => admin.roles.filter((role) =>
  !search.value.trim() || [role.name, role.code].join(' ').toLowerCase().includes(search.value.trim().toLowerCase()),
))
const permissionNames: Record<string, string> = {
  'identity:read': '校验上报身份', 'usage:write': '上报个人用量', 'stats:read': '查看部门用量',
  'members:read': '查看人员', 'members:manage': '管理人员', 'tokens:manage': '管理上报凭证',
  'accounts:manage': '管理登录账号', 'roles:read': '查看角色', 'roles:assign': '分配角色',
  'departments:read': '查看部门', 'departments:manage': '管理部门', 'audit:read': '查看管理记录',
}
function memberCount(roleId: string): number {
  return admin.members.filter((member) => member.roles.some((role) => role.role_id === roleId)).length
}
function open(roleId: string | null = null): void {
  initialRoleId.value = roleId
  memberId.value = ''; selected.value = null; roleIds.value = []
  admin.error = null; showForm.value = true
}
function selectMember(id: string): void {
  // 保留选中时的版本，冲突后须重新确认，不能把旧表单悄悄套到新版本上。
  selected.value = admin.members.find((member) => member.member_id === id) ?? null
  const existing = selected.value?.roles.map((role) => role.role_id) ?? []
  roleIds.value = [...new Set(initialRoleId.value ? [...existing, initialRoleId.value] : existing)]
}
async function save(): Promise<void> {
  const member = selected.value
  if (busy.value || !member || !roleIds.value.length) return
  if (await admin.mutate(() => api.updateRoles({
    member_id: member.member_id, expected_version: member.version, role_ids: roleIds.value,
  }), member.member_id)) {
    showForm.value = false
    ElMessage.success('人员角色已更新')
  }
}
onMounted(() => { void admin.load('roles') })
onUnmounted(() => { admin.clear() })
</script>

<template>
  <div class="page-stack">
    <div class="page-heading">
      <div><div class="eyebrow">ROLE MANAGEMENT</div><h1>角色管理</h1><p>查看角色的权限范围，为团队成员分配合适的角色。</p></div>
      <el-button v-if="canAssign" type="primary" :icon="Plus" :disabled="busy" @click="open()">分配角色</el-button>
    </div>
    <el-alert v-if="admin.error" :title="admin.error" type="error" :closable="false" show-icon role="alert" />
    <el-card shadow="never">
      <template #header>
        <div class="panel-heading">
          <div><h2>角色列表</h2><p>角色权限由系统统一维护，可在此查看并分配给成员。</p></div>
          <el-button :icon="Refresh" :loading="admin.loading" :disabled="!!admin.busyId" @click="admin.error = null; admin.load()">刷新</el-button>
        </div>
      </template>
      <div class="member-filters">
        <el-input v-model="search" :prefix-icon="Search" clearable placeholder="搜索角色名称或标识" aria-label="搜索角色" />
        <span class="muted">共 {{ roles.length }} 个角色</span>
      </div>
      <el-skeleton v-if="admin.loading && !admin.roles.length" :rows="5" animated />
      <el-table v-else :data="roles" row-key="role_id" empty-text="暂无符合条件的角色">
        <el-table-column prop="name" label="角色名称" min-width="120" />
        <el-table-column prop="code" label="角色标识" min-width="110" />
        <el-table-column v-if="session.can('members:read')" label="关联人员" width="100"><template #default="{ row }">{{ memberCount(row.role_id) }} 人</template></el-table-column>
        <el-table-column label="权限范围" min-width="340">
          <template #default="{ row }"><div class="permission-tags"><el-tag v-for="permission in row.permissions" :key="permission" size="small" type="info" :title="permission">{{ permissionNames[permission] ?? permission }}</el-tag><span v-if="!row.permissions.length" class="muted">暂无权限</span></div></template>
        </el-table-column>
        <el-table-column v-if="canAssign" label="操作" width="130" fixed="right"><template #default="{ row }"><el-button link type="primary" :disabled="busy" @click="open(row.role_id)">分配角色</el-button></template></el-table-column>
      </el-table>
    </el-card>
    <el-dialog v-model="showForm" title="分配角色" width="min(540px, 94vw)" destroy-on-close :close-on-click-modal="false" :show-close="!busy" :close-on-press-escape="!busy">
      <el-alert v-if="admin.error" :title="admin.error" type="error" :closable="false" show-icon />
      <el-form label-position="top" :disabled="busy" @submit.prevent="save">
        <el-form-item label="团队成员" required>
          <el-select v-model="memberId" filterable placeholder="选择需要调整角色的成员" aria-label="选择团队成员" @change="selectMember">
            <el-option v-for="member in admin.members" :key="member.member_id" :value="member.member_id" :label="`${member.name} · ${member.department_name || '未分配部门'} · ${member.member_id.slice(0, 8)}`" />
          </el-select>
        </el-form-item>
        <el-form-item label="分配角色" required>
          <el-select v-model="roleIds" multiple :disabled="!selected" placeholder="请选择至少一个角色" aria-label="选择角色">
            <el-option v-for="role in admin.roles" :key="role.role_id" :label="role.name" :value="role.role_id" />
          </el-select>
        </el-form-item>
        <p class="muted">保存后将使用所选角色。角色权限立即生效，最后一个可用管理员的管理权限会受到保护。</p>
        <div class="dialog-actions"><el-button @click="showForm = false">取消</el-button><el-button type="primary" native-type="submit" :loading="busy" :disabled="!selected || !roleIds.length">保存角色</el-button></div>
      </el-form>
    </el-dialog>
  </div>
</template>
