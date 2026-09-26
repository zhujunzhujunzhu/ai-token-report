<script setup lang="ts">
/** 密码只保留在当前表单，保存后销毁；不回显既有密码。 */
import { reactive, ref } from 'vue'
import {
  ElAlert,
  ElButton,
  ElForm,
  ElFormItem,
  ElInput,
  type FormInstance,
  type FormRules,
} from 'element-plus'
import type {
  PortalLoginAccountRequest,
  PortalMember,
} from '@ai-token-report/shared'
const props = defineProps<{ member: PortalMember; busy: boolean }>()
const emit = defineEmits<{
  save: [input: PortalLoginAccountRequest]
  cancel: []
}>()
const form = ref<FormInstance>()
const draft = reactive({
  username: props.member.account?.username ?? '',
  password: '',
  confirm: '',
})
const rules: FormRules = {
  username: [
    {
      required: true,
      pattern: /^[a-zA-Z0-9][a-zA-Z0-9_.-]{2,63}$/,
      message: '请输入 3～64 位字母、数字、点、下划线或连字符',
      trigger: 'blur',
    },
  ],
  password: [
    {
      required: true,
      min: 12,
      max: 128,
      message: '密码长度为 12～128 个字符',
      trigger: 'blur',
    },
  ],
  confirm: [
    {
      required: true,
      validator: (_rule, value, done) =>
        done(
          value === draft.password && value
            ? undefined
            : new Error('两次输入的密码不一致'),
        ),
      trigger: 'blur',
    },
  ],
}
async function submit(): Promise<void> {
  if (props.busy || !(await form.value?.validate().catch(() => false))) return
  emit('save', {
    member_id: props.member.member_id,
    expected_version: props.member.version,
    username: draft.username.trim(),
    password: draft.password,
  })
}
</script>
<template>
  <el-form
    ref="form"
    :model="draft"
    :rules="rules"
    label-position="top"
    :disabled="busy"
    @submit.prevent="submit"
  >
    <el-form-item label="用户名" prop="username"
      ><el-input
        v-model="draft.username"
        autocomplete="off"
        maxlength="64"
        placeholder="例如：zhangsan"
    /></el-form-item>
    <el-form-item label="新密码" prop="password"
      ><el-input
        v-model="draft.password"
        type="password"
        show-password
        autocomplete="new-password"
        maxlength="128"
        placeholder="请输入 12～128 位密码"
    /></el-form-item>
    <el-form-item label="确认密码" prop="confirm"
      ><el-input
        v-model="draft.confirm"
        type="password"
        show-password
        autocomplete="new-password"
        maxlength="128"
        placeholder="再次输入密码"
    /></el-form-item>
    <el-alert
      title="保存后原登录会话立即失效，上报 Token 保持不变。"
      type="info"
      :closable="false"
    />
    <div class="dialog-actions">
      <el-button @click="emit('cancel')">取消</el-button
      ><el-button type="primary" native-type="submit" :loading="busy"
        >保存登录账号</el-button
      >
    </div>
  </el-form>
</template>
