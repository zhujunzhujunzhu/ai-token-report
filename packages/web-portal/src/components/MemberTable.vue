<script setup lang="ts">
/** 表格只按稳定 ID 定位人员；最终权限与最后管理入口护栏由后端事务决定。 */
import { ElAvatar, ElButton, ElTable, ElTableColumn, ElTag } from 'element-plus'
import type { PortalMember } from '@ai-token-report/shared'
const props = defineProps<{ members: PortalMember[]; currentId: string | null; busy: boolean; permissions: string[] }>()
const emit = defineEmits<{
  edit: [member: PortalMember]; roles: [member: PortalMember]; login: [member: PortalMember]
  tokens: [member: PortalMember]; status: [member: PortalMember]; loginStatus: [member: PortalMember]
}>()
const can = (permission: string) => props.permissions.includes(permission)
</script>
<template>
  <el-table :data="members" row-key="member_id" empty-text="暂无符合条件的成员">
    <el-table-column label="成员" min-width="185"><template #default="{ row }">
      <div class="member-name"><el-avatar :size="32">{{ row.name.slice(0, 1) }}</el-avatar><strong>{{ row.name }}</strong><el-tag v-if="row.member_id === currentId" size="small">你自己</el-tag></div>
      <small class="muted">{{ row.member_id.slice(0, 8) }}</small>
    </template></el-table-column>
    <el-table-column label="部门" min-width="110"><template #default="{ row }">{{ row.department_name || '未分配' }}</template></el-table-column>
    <el-table-column label="角色" min-width="120"><template #default="{ row }"><el-tag v-for="role in row.roles" :key="role.role_id" size="small">{{ role.name }}</el-tag></template></el-table-column>
    <el-table-column label="登录账号" min-width="150"><template #default="{ row }"><span>{{ row.account?.username || '未开通' }}</span><el-tag v-if="row.account && !row.account.enabled" type="warning" size="small">已停用</el-tag></template></el-table-column>
    <el-table-column label="状态" width="90"><template #default="{ row }"><el-tag :type="row.status === 'active' ? 'success' : 'info'">{{ row.status === 'active' ? '启用' : row.status === 'archived' ? '已归档' : '停用' }}</el-tag></template></el-table-column>
    <el-table-column prop="active_token_count" label="有效凭证" width="95" />
    <el-table-column label="操作" min-width="370"><template #default="{ row }"><div class="row-actions">
      <el-button v-if="can('members:manage')" link :disabled="busy" @click="emit('edit', row)">编辑资料</el-button>
      <el-button v-if="can('roles:assign')" link :disabled="busy" @click="emit('roles', row)">角色</el-button>
      <el-button v-if="can('accounts:manage')" link :disabled="busy || row.status !== 'active'" @click="emit('login', row)">{{ row.account ? '重置密码' : '开通登录' }}</el-button>
      <el-button v-if="can('accounts:manage') && row.account" link :disabled="busy || row.status !== 'active'" @click="emit('loginStatus', row)">{{ row.account.enabled ? '停用登录' : '恢复登录' }}</el-button>
      <el-button v-if="can('tokens:manage')" link type="primary" :disabled="busy" @click="emit('tokens', row)">上报凭证</el-button>
      <el-button v-if="can('members:manage')" link :type="row.status === 'active' ? 'danger' : 'primary'" :disabled="busy" @click="emit('status', row)">{{ row.status === 'active' ? '停用人员' : '恢复人员' }}</el-button>
    </div></template></el-table-column>
  </el-table>
</template>
