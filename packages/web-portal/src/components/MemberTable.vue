<script setup lang="ts">
/**
 * 表格只按稳定 ID 定位人员；最终权限与最后管理入口护栏由后端事务决定。
 *
 * ⚠️ 这里**没有**任何凭证入口：上报凭证（appKey）统一在 appKey 管理页
 *   签发与轮换。把人名和凭证放在同一张表里，会让人误以为「停用人员」
 *   与「吊销凭证」是同一件事 —— 前者连登录会话一起停，后者只废一把 key。
 */
import { ElAvatar, ElButton, ElTable, ElTableColumn, ElTag } from 'element-plus'
import type { PortalMember } from '@ai-token-report/shared'
const props = defineProps<{ members: PortalMember[]; currentId: string | null; busy: boolean; permissions: string[] }>()
const emit = defineEmits<{
  edit: [member: PortalMember]; login: [member: PortalMember]
  status: [member: PortalMember]; loginStatus: [member: PortalMember]
}>()
const can = (permission: string) => props.permissions.includes(permission)
/**
 * 表格插槽给的 `row` 是 Element Plus 自己的 `DefaultRow`（`Record<PropertyKey, any>`），
 * 不是本页的契约类型，而模板里做不了类型断言 —— 所以入口收 `unknown`、
 * 在这里收窄一次。行的真实形状由 `GET /api/v1/admin/members` 决定。
 */
const rowMember = (row: unknown): PortalMember => row as PortalMember
</script>
<template>
  <el-table :data="members" row-key="member_id" empty-text="暂无符合条件的成员">
    <el-table-column label="成员" min-width="185"><template #default="{ row }">
      <div class="member-name"><el-avatar :size="32">{{ row.name.slice(0, 1) }}</el-avatar><strong>{{ row.name }}</strong><el-tag v-if="row.member_id === currentId" size="small">你自己</el-tag></div>
      <small class="muted">{{ row.member_id.slice(0, 8) }}</small>
    </template></el-table-column>
    <!-- 人员与分组是多对多：一个人可以同时属于多个分组，空数组表示未分组。 -->
    <el-table-column label="分组" min-width="150"><template #default="{ row }"><el-tag v-for="group in row.groups" :key="group.group_id" size="small" type="info" effect="plain">{{ group.name }}</el-tag><span v-if="!row.groups.length" class="muted">未分组</span></template></el-table-column>
    <el-table-column label="角色" min-width="120"><template #default="{ row }"><el-tag v-for="role in row.roles" :key="role.role_id" size="small">{{ role.name }}</el-tag></template></el-table-column>
    <el-table-column label="登录账号" min-width="150"><template #default="{ row }"><span>{{ row.account?.username || '未开通' }}</span><el-tag v-if="row.account && !row.account.enabled" type="warning" size="small">已停用</el-tag></template></el-table-column>
    <el-table-column label="状态" width="90"><template #default="{ row }"><el-tag :type="row.status === 'active' ? 'success' : 'info'">{{ row.status === 'active' ? '启用' : row.status === 'archived' ? '已归档' : '停用' }}</el-tag></template></el-table-column>
    <el-table-column label="操作" min-width="340"><template #default="{ row }"><div class="row-actions">
      <el-button v-if="can('members:manage')" link :disabled="busy" @click="emit('edit', rowMember(row))">编辑资料</el-button>
      <el-button v-if="can('accounts:manage')" link :disabled="busy || row.status !== 'active'" @click="emit('login', rowMember(row))">{{ row.account ? '重置密码' : '开通登录' }}</el-button>
      <el-button v-if="can('accounts:manage') && row.account" link :disabled="busy || row.status !== 'active'" @click="emit('loginStatus', rowMember(row))">{{ row.account.enabled ? '停用登录' : '恢复登录' }}</el-button>
      <el-button v-if="can('members:manage')" link :type="row.status === 'active' ? 'danger' : 'primary'" :disabled="busy" @click="emit('status', rowMember(row))">{{ row.status === 'active' ? '停用人员' : '恢复人员' }}</el-button>
    </div></template></el-table-column>
  </el-table>
</template>