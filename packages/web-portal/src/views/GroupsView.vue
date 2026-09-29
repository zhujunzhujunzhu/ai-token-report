<script setup lang="ts">
/**
 * 分组目录独立维护；编辑与启停沿用服务端版本检查，不改变人员历史归属。
 *
 * ★ 人员与分组是**多对多**：一个人可同时属于多个分组，归属的权威是关联表
 *   （见 `PortalMember.groups`）。所以改名或停用只影响「以后怎么选」，
 *   既不改写任何人的现有归属，也不改写历史用量（用量按事件归属展开统计）。
 */
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import { Plus, Refresh, Search } from '@element-plus/icons-vue'
import {
  ElAlert, ElButton, ElCard, ElDialog, ElForm, ElFormItem, ElInput,
  ElMessage, ElMessageBox, ElOption, ElSelect, ElSkeleton, ElTable, ElTableColumn, ElTag,
} from 'element-plus'
import type { FormInstance, FormRules } from 'element-plus'
import type { PortalGroup } from '@ai-token-report/shared'
import { useMembersStore } from '../stores/members.js'
import { useSessionStore } from '../stores/session.js'
import * as api from '../api/admin.js'
import { formatFullDateTime } from '../utils/format.js'

const admin = useMembersStore(), session = useSessionStore()
const search = ref(''), status = ref('')
const showForm = ref(false)
const selected = ref<PortalGroup | null>(null)
const form = ref<FormInstance>()
const draft = reactive({ name: '' })
const busy = computed(() => admin.loading || !!admin.busyId)
const groups = computed(() => admin.groups.filter((group) =>
  (!status.value || group.status === status.value) &&
  (!search.value.trim() || group.name.toLowerCase().includes(search.value.trim().toLowerCase())),
))
const rules: FormRules = {
  name: [{ required: true, validator: (_rule, value, done) => {
    const name = String(value)
    done(name.trim() && name.trim().length <= 64 && !/[\r\n\t]/.test(name)
      ? undefined : new Error('分组名称须为 1～64 个字符，不能包含换行或制表符'))
  }, trigger: 'blur' }],
}
/**
 * 表格插槽给的 `row` 是 Element Plus 自己的 `DefaultRow`（`Record<PropertyKey, any>`），
 * 不是本页的契约类型，而模板里做不了类型断言 —— 所以入口收 `unknown`、
 * 在这里收窄一次。行的真实形状由 `GET /api/v1/groups` 决定。
 */
const rowGroup = (row: unknown): PortalGroup => row as PortalGroup
function open(group: PortalGroup | null = null): void {
  selected.value = group
  draft.name = group?.name ?? ''
  admin.error = null
  showForm.value = true
}
async function save(): Promise<void> {
  if (busy.value || !(await form.value?.validate().catch(() => false))) return
  const group = selected.value
  const name = draft.name.trim()
  const result = await admin.mutate(() => group
    ? api.updateGroup({ group_id: group.group_id, expected_version: group.version, name })
    : api.createGroup(name), group?.group_id ?? 'new-group')
  if (result) {
    showForm.value = false
    ElMessage.success(group ? '分组已更新' : '分组已添加')
  }
}
async function changeStatus(group: PortalGroup): Promise<void> {
  if (busy.value) return
  const enabling = group.status !== 'active'
  try {
    await ElMessageBox.confirm(enabling
      ? '启用后，可以为人员选择此分组。'
      : '停用后，新增或调整人员时不能再选择此分组，现有归属和历史用量会保留。',
    `${enabling ? '启用' : '停用'}分组 · ${group.name}`,
    { type: 'warning', confirmButtonText: enabling ? '启用分组' : '停用分组', cancelButtonText: '取消' })
    if (await admin.mutate(() => api.updateGroupStatus({
      group_id: group.group_id, expected_version: group.version,
      status: enabling ? 'active' : 'disabled',
    }), group.group_id)) ElMessage.success(enabling ? '分组已启用' : '分组已停用')
  } catch { /* 用户取消。 */ }
}
onMounted(() => { void admin.load('groups') })
onUnmounted(() => { admin.clear() })
</script>

<template>
  <div class="page-stack">
    <div class="page-heading">
      <div><div class="eyebrow">GROUP MANAGEMENT</div><h1>分组管理</h1><p>维护分组名称与启用状态；一名成员可同时属于多个分组，用量会按其所属的每个分组统计。</p></div>
      <el-button v-if="session.can('groups:manage')" type="primary" :icon="Plus" :disabled="busy" @click="open()">添加分组</el-button>
    </div>
    <el-alert v-if="admin.error" :title="admin.error" type="error" :closable="false" show-icon role="alert" />
    <el-card shadow="never">
      <template #header>
        <div class="panel-heading">
          <div><h2>分组列表</h2><p>分组改名或停用后，已有的人员归属与历史用量仍会保留。</p></div>
          <el-button :icon="Refresh" :loading="admin.loading" :disabled="!!admin.busyId" @click="admin.error = null; admin.load()">刷新</el-button>
        </div>
      </template>
      <div class="member-filters">
        <el-input v-model="search" :prefix-icon="Search" clearable placeholder="搜索分组名称" aria-label="搜索分组" />
        <el-select v-model="status" clearable placeholder="全部状态" aria-label="筛选分组状态">
          <el-option label="启用" value="active" /><el-option label="停用" value="disabled" />
        </el-select>
        <span class="muted">共 {{ groups.length }} 个分组</span>
      </div>
      <el-skeleton v-if="admin.loading && !admin.groups.length" :rows="5" animated />
      <el-table v-else :data="groups" row-key="group_id" empty-text="暂无符合条件的分组">
        <el-table-column prop="name" label="分组名称" min-width="180" />
        <el-table-column label="状态" width="110"><template #default="{ row }"><el-tag :type="row.status === 'active' ? 'success' : 'info'">{{ row.status === 'active' ? '启用' : '停用' }}</el-tag></template></el-table-column>
        <el-table-column label="创建时间" min-width="170"><template #default="{ row }">{{ formatFullDateTime(row.created_at_ms) }}</template></el-table-column>
        <el-table-column label="更新时间" min-width="170"><template #default="{ row }">{{ formatFullDateTime(row.updated_at_ms) }}</template></el-table-column>
        <el-table-column v-if="session.can('groups:manage')" label="操作" width="160" fixed="right">
          <template #default="{ row }"><el-button link type="primary" :disabled="busy" @click="open(rowGroup(row))">编辑</el-button><el-button link :type="row.status === 'active' ? 'danger' : 'primary'" :disabled="busy" @click="changeStatus(rowGroup(row))">{{ row.status === 'active' ? '停用' : '启用' }}</el-button></template>
        </el-table-column>
      </el-table>
    </el-card>
    <el-dialog v-model="showForm" :title="selected ? '编辑分组' : '添加分组'" width="min(500px, 94vw)" destroy-on-close :close-on-click-modal="false" :show-close="!busy" :close-on-press-escape="!busy">
      <el-alert v-if="admin.error" :title="admin.error" type="error" :closable="false" show-icon />
      <el-form ref="form" :model="draft" :rules="rules" label-position="top" :disabled="busy" @submit.prevent="save">
        <el-form-item label="分组名称" prop="name"><el-input v-model="draft.name" maxlength="64" show-word-limit placeholder="请输入分组名称" autocomplete="off" /></el-form-item>
        <p class="muted">{{ selected ? '修改名称不会改变成员当前所属的分组（多对多），也不会改写历史用量。' : '新分组创建后默认为启用，可在人员管理中分配给成员；一名成员可以同时属于多个分组。' }}</p>
        <div class="dialog-actions"><el-button @click="showForm = false">取消</el-button><el-button type="primary" native-type="submit" :loading="busy">{{ selected ? '保存分组' : '添加分组' }}</el-button></div>
      </el-form>
    </el-dialog>
  </div>
</template>