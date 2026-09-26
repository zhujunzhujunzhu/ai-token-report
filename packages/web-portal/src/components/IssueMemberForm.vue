<script setup lang="ts">
/** 人员建档与凭证签发分开；角色和部门只能来自服务端目录。 */
import { reactive, ref } from 'vue'
import { ElButton, ElForm, ElFormItem, ElInput, ElSelect, ElOption } from 'element-plus'
import type { FormInstance, FormRules } from 'element-plus'
import { validateName, type PortalRole, type PortalDepartment, type PortalCreateMemberRequest } from '@ai-token-report/shared'
const props = defineProps<{ busy: boolean; roles: PortalRole[]; departments: PortalDepartment[] }>()
const emit = defineEmits<{ issue: [input: PortalCreateMemberRequest]; cancel: [] }>()
const form = ref<FormInstance>()
const draft = reactive({ name: '', department_id: '', role_ids: props.roles.filter((r) => r.code === 'member').map((r) => r.role_id) })
const rules: FormRules = {
  name: [{ required: true, validator: (_rule, value, done) => {
    const result = validateName(String(value)); done(result.ok ? undefined : new Error(result.reason))
  }, trigger: 'blur' }],
  role_ids: [{ type: 'array', required: true, min: 1, message: '请选择至少一个角色', trigger: 'change' }],
}
async function submit(): Promise<void> {
  if (props.busy || !(await form.value?.validate().catch(() => false))) return
  emit('issue', { name: draft.name.trim(), department_id: draft.department_id || null, role_ids: draft.role_ids })
}
</script>
<template>
  <el-form ref="form" :model="draft" :rules="rules" label-position="top" :disabled="busy" @submit.prevent="submit">
    <el-form-item label="姓名" prop="name"><el-input v-model="draft.name" maxlength="32" autocomplete="off" /></el-form-item>
    <el-form-item label="部门"><el-select v-model="draft.department_id" clearable placeholder="未分配部门">
      <el-option v-for="dept in departments.filter(d => d.status === 'active')" :key="dept.department_id" :value="dept.department_id" :label="dept.name" />
    </el-select></el-form-item>
    <el-form-item label="角色" prop="role_ids"><el-select v-model="draft.role_ids" multiple placeholder="选择角色">
      <el-option v-for="role in roles" :key="role.role_id" :value="role.role_id" :label="role.name" />
    </el-select></el-form-item>
    <p class="muted form-hint">同名人员会分别保存。添加后可独立开通登录账号、签发上报 Token。</p>
    <div class="dialog-actions"><el-button @click="emit('cancel')">取消</el-button><el-button type="primary" native-type="submit" :loading="busy">添加成员</el-button></div>
  </el-form>
</template>
