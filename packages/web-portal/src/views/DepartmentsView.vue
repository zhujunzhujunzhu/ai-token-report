<script setup lang="ts">
/** 部门目录独立维护；编辑与启停沿用服务端版本检查，不改变人员历史归属。 */
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import { Plus, Refresh, Search } from '@element-plus/icons-vue'
import {
  ElAlert, ElButton, ElCard, ElDialog, ElForm, ElFormItem, ElInput,
  ElMessage, ElMessageBox, ElOption, ElSelect, ElSkeleton, ElTable, ElTableColumn, ElTag,
} from 'element-plus'
import type { FormInstance, FormRules } from 'element-plus'
import type { PortalDepartment } from '@ai-token-report/shared'
import { useMembersStore } from '../stores/members.js'
import { useSessionStore } from '../stores/session.js'
import * as api from '../api/admin.js'
import { formatFullDateTime } from '../utils/format.js'

const admin = useMembersStore(), session = useSessionStore()
const search = ref(''), status = ref('')
const showForm = ref(false)
const selected = ref<PortalDepartment | null>(null)
const form = ref<FormInstance>()
const draft = reactive({ name: '' })
const busy = computed(() => admin.loading || !!admin.busyId)
const departments = computed(() => admin.departments.filter((department) =>
  (!status.value || department.status === status.value) &&
  (!search.value.trim() || department.name.toLowerCase().includes(search.value.trim().toLowerCase())),
))
const rules: FormRules = {
  name: [{ required: true, validator: (_rule, value, done) => {
    const name = String(value)
    done(name.trim() && name.trim().length <= 64 && !/[\r\n\t]/.test(name)
      ? undefined : new Error('部门名称须为 1～64 个字符，不能包含换行或制表符'))
  }, trigger: 'blur' }],
}
function open(department: PortalDepartment | null = null): void {
  selected.value = department
  draft.name = department?.name ?? ''
  admin.error = null
  showForm.value = true
}
async function save(): Promise<void> {
  if (busy.value || !(await form.value?.validate().catch(() => false))) return
  const department = selected.value
  const name = draft.name.trim()
  const result = await admin.mutate(() => department
    ? api.updateDepartment({ department_id: department.department_id, expected_version: department.version, name })
    : api.createDepartment(name), department?.department_id ?? 'new-department')
  if (result) {
    showForm.value = false
    ElMessage.success(department ? '部门已更新' : '部门已添加')
  }
}
async function changeStatus(department: PortalDepartment): Promise<void> {
  if (busy.value) return
  const enabling = department.status !== 'active'
  try {
    await ElMessageBox.confirm(enabling
      ? '启用后，可以为人员选择此部门。'
      : '停用后，新增或调整人员时不能再选择此部门，现有人员和历史用量会保留。',
    `${enabling ? '启用' : '停用'}部门 · ${department.name}`,
    { type: 'warning', confirmButtonText: enabling ? '启用部门' : '停用部门', cancelButtonText: '取消' })
    if (await admin.mutate(() => api.updateDepartmentStatus({
      department_id: department.department_id, expected_version: department.version,
      status: enabling ? 'active' : 'disabled',
    }), department.department_id)) ElMessage.success(enabling ? '部门已启用' : '部门已停用')
  } catch { /* 用户取消。 */ }
}
onMounted(() => { void admin.load('departments') })
onUnmounted(() => { admin.clear() })
</script>

<template>
  <div class="page-stack">
    <div class="page-heading">
      <div><div class="eyebrow">DEPARTMENT MANAGEMENT</div><h1>部门管理</h1><p>维护部门名称与启用状态，为团队成员分配清晰的组织归属。</p></div>
      <el-button v-if="session.can('departments:manage')" type="primary" :icon="Plus" :disabled="busy" @click="open()">添加部门</el-button>
    </div>
    <el-alert v-if="admin.error" :title="admin.error" type="error" :closable="false" show-icon role="alert" />
    <el-card shadow="never">
      <template #header>
        <div class="panel-heading">
          <div><h2>部门列表</h2><p>部门改名或停用后，已有的人员记录与历史用量仍会保留。</p></div>
          <el-button :icon="Refresh" :loading="admin.loading" :disabled="!!admin.busyId" @click="admin.error = null; admin.load()">刷新</el-button>
        </div>
      </template>
      <div class="member-filters">
        <el-input v-model="search" :prefix-icon="Search" clearable placeholder="搜索部门名称" aria-label="搜索部门" />
        <el-select v-model="status" clearable placeholder="全部状态" aria-label="筛选部门状态">
          <el-option label="启用" value="active" /><el-option label="停用" value="disabled" />
        </el-select>
        <span class="muted">共 {{ departments.length }} 个部门</span>
      </div>
      <el-skeleton v-if="admin.loading && !admin.departments.length" :rows="5" animated />
      <el-table v-else :data="departments" row-key="department_id" empty-text="暂无符合条件的部门">
        <el-table-column prop="name" label="部门名称" min-width="180" />
        <el-table-column label="状态" width="110"><template #default="{ row }"><el-tag :type="row.status === 'active' ? 'success' : 'info'">{{ row.status === 'active' ? '启用' : '停用' }}</el-tag></template></el-table-column>
        <el-table-column label="创建时间" min-width="170"><template #default="{ row }">{{ formatFullDateTime(row.created_at_ms) }}</template></el-table-column>
        <el-table-column label="更新时间" min-width="170"><template #default="{ row }">{{ formatFullDateTime(row.updated_at_ms) }}</template></el-table-column>
        <el-table-column v-if="session.can('departments:manage')" label="操作" width="160" fixed="right">
          <template #default="{ row }"><el-button link type="primary" :disabled="busy" @click="open(row)">编辑</el-button><el-button link :type="row.status === 'active' ? 'danger' : 'primary'" :disabled="busy" @click="changeStatus(row)">{{ row.status === 'active' ? '停用' : '启用' }}</el-button></template>
        </el-table-column>
      </el-table>
    </el-card>
    <el-dialog v-model="showForm" :title="selected ? '编辑部门' : '添加部门'" width="min(500px, 94vw)" destroy-on-close :close-on-click-modal="false" :show-close="!busy" :close-on-press-escape="!busy">
      <el-alert v-if="admin.error" :title="admin.error" type="error" :closable="false" show-icon />
      <el-form ref="form" :model="draft" :rules="rules" label-position="top" :disabled="busy" @submit.prevent="save">
        <el-form-item label="部门名称" prop="name"><el-input v-model="draft.name" maxlength="64" show-word-limit placeholder="请输入部门名称" autocomplete="off" /></el-form-item>
        <p class="muted">{{ selected ? '修改名称不会改变成员当前所属的部门，也不会改写历史用量。' : '新部门创建后默认为启用，可在人员管理中分配给成员。' }}</p>
        <div class="dialog-actions"><el-button @click="showForm = false">取消</el-button><el-button type="primary" native-type="submit" :loading="busy">{{ selected ? '保存部门' : '添加部门' }}</el-button></div>
      </el-form>
    </el-dialog>
  </div>
</template>
