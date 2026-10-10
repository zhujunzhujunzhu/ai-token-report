<script setup lang="ts">
/**
 * 人员资料编辑表单：姓名 / 分组 / 角色。
 *
 * ★ 表单只收集草稿，**不自己发请求** —— 提交顺序与版本号传递在
 *   `views/memberEditModel.ts`（能被 `bun test` 直接断言），而「谁能改哪一栏」
 *   由 `AdminView` 按会话权限决定（组件不猜权限，也不隐藏失败）。
 *
 * ⚠️ 角色那一栏只在 `canAssignRoles` 为真时出现：没有 `roles:assign` 的人
 *   看到这一栏、填完再被服务端 403，比看不见它更糟。
 * ⚠️ 草稿由 `props.member` 初始化一次，所以调用方必须给这个组件挂
 *   `:key="member.member_id"` —— 否则换一个人打开时还是上一个人的草稿。
 */
import { reactive } from 'vue'
import { ElButton, ElForm, ElFormItem, ElInput, ElOption, ElSelect } from 'element-plus'
import type { PortalGroup, PortalMember } from '@ai-token-report/shared'
import type { MemberEditDraft } from '../views/memberEditModel.js'
import type { RolePickerOption } from '../views/rolesModel.js'
import { assistantMemberDraft } from '../utils/assistantForms.js'

const props = defineProps<{
  member: PortalMember
  groups: PortalGroup[]
  roleOptions: RolePickerOption[]
  canAssignRoles: boolean
  busy: boolean
  initialValues?: { name?: string; group_ids?: string[] }
}>()
const emit = defineEmits<{ save: [draft: MemberEditDraft]; cancel: [] }>()
// 打开时把「当前归属」抄进草稿：这里给的就是全量替换后的集合，取消即不提交，
// 所以不存在「只发变化量」这种需要服务端求差的语义。
const draft = reactive({
  ...assistantMemberDraft({ name: props.member.name, group_ids: props.member.groups.map((group) => group.group_id) }, props.initialValues),
  role_ids: props.member.roles.map((role) => role.role_id),
})
/**
 * 姓名合法性刻意**不在这里**判：判据（含那句中文原因）只有一份，在
 * `memberEditModel.ts`，本组件只负责把草稿交出去。
 */
function submit(): void {
  if (props.busy) return
  emit('save', { name: draft.name, group_ids: [...draft.group_ids], role_ids: [...draft.role_ids] })
}
</script>
<template>
  <el-form label-position="top" :disabled="busy" @submit.prevent="submit">
    <el-form-item label="姓名"><el-input v-model="draft.name" maxlength="32" autocomplete="off" /></el-form-item>
    <el-form-item label="分组">
      <el-select v-model="draft.group_ids" multiple filterable clearable collapse-tags collapse-tags-tooltip placeholder="未分组（可多选）" aria-label="选择分组">
        <el-option v-for="group in groups.filter((item) => item.status === 'active' || draft.group_ids.includes(item.group_id))" :key="group.group_id" :label="group.name" :value="group.group_id" />
      </el-select>
    </el-form-item>
    <el-form-item v-if="canAssignRoles" label="角色">
      <el-select v-model="draft.role_ids" multiple filterable clearable collapse-tags collapse-tags-tooltip placeholder="请至少选择一个角色" aria-label="选择角色">
        <el-option v-for="option in roleOptions" :key="option.value" :label="option.label" :value="option.value" />
      </el-select>
    </el-form-item>
    <p class="muted">保存后以所选分组与角色为准（两者都是全量替换）：一名成员可同时属于多个分组、持有多个角色，权限取其各角色权限的并集。</p>
    <div class="dialog-actions"><el-button @click="emit('cancel')">取消</el-button><el-button type="primary" native-type="submit" :loading="busy">保存资料</el-button></div>
  </el-form>
</template>
