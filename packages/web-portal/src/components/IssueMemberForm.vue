<script setup lang="ts">
/** 人员建档与凭证签发分开；角色和分组只能来自服务端目录。 */
import { reactive, ref } from 'vue'
import { ElButton, ElForm, ElFormItem, ElInput, ElSelect, ElOption } from 'element-plus'
import type { FormInstance, FormRules } from 'element-plus'
import { validateName, type PortalRole, type PortalGroup, type PortalCreateMemberRequest } from '@ai-token-report/shared'
import { assistantMemberDraft } from '../utils/assistantForms.js'
const props = defineProps<{ busy: boolean; roles: PortalRole[]; groups: PortalGroup[]; initialValues?: { name?: string; group_ids?: string[] } }>()
const emit = defineEmits<{ issue: [input: PortalCreateMemberRequest]; cancel: [] }>()
const form = ref<FormInstance>()
const draft = reactive({ ...assistantMemberDraft({ name: '', group_ids: [] }, props.initialValues), role_ids: props.roles.filter((r) => r.code === 'member').map((r) => r.role_id) })
const rules: FormRules = {
  name: [{ required: true, validator: (_rule, value, done) => {
    const result = validateName(String(value)); done(result.ok ? undefined : new Error(result.reason))
  }, trigger: 'blur' }],
  role_ids: [{ type: 'array', required: true, min: 1, message: '请选择至少一个角色', trigger: 'change' }],
}
async function submit(): Promise<void> {
  if (props.busy || !(await form.value?.validate().catch(() => false))) return
  // ★ `group_ids` 是**全量替换**语义：这里给的就是这个人建档时的完整分组集合，
  //   不是「追加这几个」。用增量语义的话，「一个分组都不给」与「没填这项」长得一模一样。
  emit('issue', { name: draft.name.trim(), group_ids: [...draft.group_ids], role_ids: draft.role_ids })
}
</script>
<template>
  <el-form ref="form" :model="draft" :rules="rules" label-position="top" :disabled="busy" @submit.prevent="submit">
    <el-form-item label="姓名" prop="name"><el-input v-model="draft.name" maxlength="32" autocomplete="off" /></el-form-item>
    <el-form-item label="分组"><el-select v-model="draft.group_ids" multiple filterable clearable collapse-tags collapse-tags-tooltip placeholder="未分组（可多选）" aria-label="选择分组">
      <el-option v-for="group in groups.filter(g => g.status === 'active')" :key="group.group_id" :value="group.group_id" :label="group.name" />
    </el-select></el-form-item>
    <el-form-item label="角色" prop="role_ids"><el-select v-model="draft.role_ids" multiple placeholder="选择角色">
      <el-option v-for="role in roles" :key="role.role_id" :value="role.role_id" :label="role.name" />
    </el-select></el-form-item>
    <p class="muted form-hint">同名人员会分别保存。一名成员可以同时属于多个分组，用量会按其所属的每个分组统计。添加后可独立开通登录账号；上报 appKey 在 appKey 管理页按人发放。</p>
    <div class="dialog-actions"><el-button @click="emit('cancel')">取消</el-button><el-button type="primary" native-type="submit" :loading="busy">添加成员</el-button></div>
  </el-form>
</template>
