<script setup lang="ts">
/** 人员列表采用显式确认；部署凭证、当前账号与最后管理员的护栏在页面可见。 */
import { computed, nextTick, ref } from 'vue'
import {
  ElMessage,
  ElMessageBox,
  ElAvatar,
  ElButton,
  ElTable,
  ElTableColumn,
  ElTag,
  ElTooltip,
} from 'element-plus'
import { View, Hide, CopyDocument } from '@element-plus/icons-vue'
import type { AdminMember, UserRole } from '@ai-token-report/shared'
import { formatFullDateTime } from '../utils/format.js'
import { copyText } from '../utils/clipboard.js'
const props = defineProps<{
  members: AdminMember[]
  busyToken: string | null
  writable: boolean
  currentName: string | null
  disabled?: boolean
  adminCount: number
}>()
const emit = defineEmits<{
  login: [member: AdminMember]
  rotate: [token: string]
  revoke: [token: string]
  updateRole: [token: string, role: UserRole]
}>()
const revealed = ref<string[]>([])
const busy = computed(() => props.disabled || props.busyToken !== null)
function blocked(row: AdminMember): boolean {
  return (
    !props.writable ||
    !!busy.value ||
    row.source === 'env' ||
    row.name === props.currentName
  )
}
function protectedAdmin(row: AdminMember): boolean {
  return row.role === 'admin' && props.adminCount <= 1
}
function toggle(token: string): void {
  revealed.value = revealed.value.includes(token)
    ? revealed.value.filter((t) => t !== token)
    : [...revealed.value, token]
}
async function copy(row: AdminMember, index: number): Promise<void> {
  if (!revealed.value.includes(row.token)) revealed.value.push(row.token)
  await nextTick()
  const ok = await copyText(row.token, 'member-token-' + index)
  ElMessage({
    type: ok ? 'success' : 'info',
    message: ok ? 'Token 已复制' : '已选中 Token，请按 Ctrl+C 复制',
  })
}
async function confirmAction(
  row: AdminMember,
  action: 'rotate' | 'revoke' | 'role',
): Promise<void> {
  const labels = { rotate: '重置 Token', revoke: '吊销凭证', role: '变更角色' }
  const description =
    action === 'rotate'
      ? '旧 Token 会立即失效，请将新 Token 发给本人重新填写。'
      : action === 'revoke'
        ? '该成员将立即无法上报用量和访问看板，历史用量会保留。'
        : row.role === 'admin'
          ? '该成员将失去人员管理权限，仍可查看部门用量。'
          : '该成员将可以发放、重置和吊销其他人的凭证。'
  try {
    await ElMessageBox.confirm(description, labels[action] + ' · ' + row.name, {
      confirmButtonText: '确认' + labels[action],
      cancelButtonText: '取消',
      type: 'warning',
    })
    if (action === 'role')
      emit('updateRole', row.token, row.role === 'admin' ? 'member' : 'admin')
    else if (action === 'rotate') emit('rotate', row.token)
    else emit('revoke', row.token)
  } catch {
    /* 取消操作无需反馈错误。 */
  }
}
</script>
<template>
  <el-table :data="members" row-key="token" empty-text="暂无符合条件的成员">
    <el-table-column label="成员" min-width="175"
      ><template #default="{ row }"
        ><div class="member-name">
          <el-avatar :size="32">{{ row.name.slice(0, 1) }}</el-avatar
          ><strong>{{ row.name }}</strong
          ><el-tag v-if="row.name === currentName" size="small" type="info"
            >你自己</el-tag
          >
        </div></template
      ></el-table-column
    >
    <el-table-column label="登录账号" min-width="155"
      ><template #default="{ row }"
        ><span v-if="row.login_enabled">{{ row.username }}</span
        ><el-tag v-else type="warning" size="small">待开通</el-tag></template
      ></el-table-column
    >
    <el-table-column prop="dept" label="部门" min-width="125"
      ><template #default="{ row }">{{
        row.dept || '—'
      }}</template></el-table-column
    >
    <el-table-column label="角色" width="105"
      ><template #default="{ row }"
        ><el-tag
          :type="row.role === 'admin' ? 'primary' : 'info'"
          effect="light"
          >{{ row.role === 'admin' ? '管理员' : '普通成员' }}</el-tag
        ></template
      ></el-table-column
    >
    <el-table-column label="上报 Token" min-width="280"
      ><template #default="{ row, $index }"
        ><div class="token-cell">
          <code :id="'member-token-' + $index">{{
            revealed.includes(row.token) ? row.token : 'atr-••••••••••••'
          }}</code
          ><el-button
            text
            circle
            :icon="revealed.includes(row.token) ? Hide : View"
            :aria-label="
              revealed.includes(row.token) ? '隐藏 Token' : '显示 Token'
            "
            @click="toggle(row.token)"
          /><el-button
            text
            circle
            :icon="CopyDocument"
            aria-label="复制 Token"
            @click="copy(row, $index)"
          /></div></template
    ></el-table-column>
    <el-table-column label="发放时间" min-width="155"
      ><template #default="{ row }"
        ><el-tag v-if="row.source === 'env'" type="info" size="small"
          >环境变量</el-tag
        ><span v-else>{{ formatFullDateTime(row.createdAt) }}</span></template
      ></el-table-column
    >
    <el-table-column label="操作" min-width="360"
      ><template #default="{ row }">
        <el-tooltip
          :disabled="!blocked(row) && !protectedAdmin(row)"
          :content="
            row.source === 'env'
              ? '请在部署配置中管理此凭证'
              : row.name === currentName
                ? '当前登录账号请由其他管理员维护'
                : protectedAdmin(row)
                  ? '最后一个管理员不可降级或吊销'
                  : '当前暂不可修改'
          "
        >
          <div class="row-actions">
            <el-button
              link
              type="primary"
              :disabled="!writable || busy || row.source === 'env'"
              @click="emit('login', row)"
              >{{ row.login_enabled ? '重置密码' : '设置登录' }}</el-button
            >
            <el-button
              link
              type="primary"
              :disabled="blocked(row) || protectedAdmin(row)"
              @click="confirmAction(row, 'role')"
              >变更角色</el-button
            ><el-button
              link
              type="primary"
              :disabled="blocked(row)"
              @click="confirmAction(row, 'rotate')"
              >重置 Token</el-button
            ><el-button
              link
              type="danger"
              :disabled="blocked(row) || protectedAdmin(row)"
              @click="confirmAction(row, 'revoke')"
              >吊销</el-button
            >
          </div>
        </el-tooltip>
      </template></el-table-column
    >
  </el-table>
</template>
