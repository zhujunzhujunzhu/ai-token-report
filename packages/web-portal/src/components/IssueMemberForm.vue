<script setup lang="ts">
/** 签发表单复用共享姓名校验；失败保留输入，只有落盘成功后才关闭。 */
import {
  ElAlert,
  ElButton,
  ElForm,
  ElFormItem,
  ElInput,
  ElRadio,
  ElRadioGroup,
} from 'element-plus'
import { reactive, ref } from 'vue'
import type { FormInstance, FormRules } from 'element-plus'
import {
  NAME_MAX_LENGTH,
  validateName,
  type UserRole,
} from '@ai-token-report/shared'
const props = defineProps<{ disabled: boolean; busy: boolean }>()
const emit = defineEmits<{
  issue: [input: { name: string; dept?: string; role: UserRole }]
  cancel: []
}>()
const form = ref<FormInstance>()
const draft = reactive({ name: '', dept: '', role: 'member' as UserRole })
const rules: FormRules = {
  name: [
    {
      required: true,
      validator: (_rule, value, callback) => {
        const result = validateName(String(value).trim())
        callback(result.ok ? undefined : new Error(result.reason))
      },
      trigger: 'blur',
    },
  ],
  dept: [{ max: 64, message: '部门名称最多 64 个字符', trigger: 'blur' }],
}
async function submit(): Promise<void> {
  if (
    props.disabled ||
    props.busy ||
    !(await form.value?.validate().catch(() => false))
  )
    return
  emit('issue', {
    name: draft.name.trim(),
    dept: draft.dept.trim(),
    role: draft.role,
  })
}
</script>
<template>
  <el-form
    ref="form"
    :model="draft"
    :rules="rules"
    label-position="top"
    :disabled="disabled || busy"
    @submit.prevent="submit"
  >
    <el-form-item label="姓名" prop="name"
      ><el-input
        v-model="draft.name"
        :maxlength="NAME_MAX_LENGTH"
        placeholder="请输入成员姓名"
        autocomplete="off"
    /></el-form-item>
    <el-form-item label="部门（选填）" prop="dept"
      ><el-input
        v-model="draft.dept"
        maxlength="64"
        placeholder="例如：研发一部"
    /></el-form-item>
    <el-form-item label="角色"
      ><el-radio-group v-model="draft.role"
        ><el-radio value="member">普通成员</el-radio
        ><el-radio value="admin">管理员</el-radio></el-radio-group
      ></el-form-item
    >
    <el-alert
      :title="
        draft.role === 'admin'
          ? '管理员可以发放、重置与吊销其他成员的凭证。'
          : '普通成员可以查看全部门用量，不能管理人员。'
      "
      type="info"
      :closable="false"
    />
    <p class="muted form-hint">
      姓名用于归属用量，请确保唯一。添加后可继续设置后台登录账号和密码。
    </p>
    <div class="dialog-actions">
      <el-button @click="$emit('cancel')">取消</el-button
      ><el-button type="primary" native-type="submit" :loading="busy"
        >添加并设置登录</el-button
      >
    </div>
  </el-form>
</template>
