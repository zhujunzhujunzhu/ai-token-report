<script setup lang="ts">
/**
 * 发放 appKey 的正文（appKey 管理页用）—— 装在弹框里，不再是页面上常驻的一块。
 *
 * ## 为什么单独一个组件
 *
 * ① 与 `AppKeyDelivery.vue` 同款理由：Element Plus 的弹框正文在 SSR 下
 *    根本不渲染（`rendered` 由 `onMounted` 置位），写在页面模板里就断言不到
 *    「能选人」「能设有效期」这两件发放必备的事。
 * ② 归属由服务端按 `member_id` 决定，所以这里**只选人、不填名字** ——
 *    客户端自称的姓名一律被忽略，凭空多一个姓名输入框只会让人以为它能生效。
 *
 * ## 明文不在这一步出现
 *
 * 签发成功的响应里带回明文，页面随即打开「交付信息」弹框（见 `AppKeyView.vue`
 * 的 `delivery`）：明文只随那次响应来一次，这里不持有它。
 */
import { ref } from 'vue'
import { Ticket } from '@element-plus/icons-vue'
import { ElButton, ElDatePicker, ElForm, ElFormItem, ElMessage, ElOption, ElSelect } from 'element-plus'
import type { PortalMember } from '@ai-token-report/shared'
import { expiryOf, type ExpiryMode } from '../utils/expiry.js'
import { memberLabel } from '../utils/memberLabel.js'

const props = defineProps<{
  /** 可选的成员（在职）；空数组说明当前身份没有人员读权限。 */
  members: PortalMember[]
  /** 是否有人员读权限 —— 没有就只能提示，选不了人。 */
  canPick: boolean
  busy: boolean
}>()
const emit = defineEmits<{
  /** ★ 归属对象与到期时刻一起交回父组件：父组件要在**发请求之前**记下「使用人」。 */
  issue: [member: PortalMember, expires: number | null]
  cancel: []
}>()

const target = ref('')
const ttl = ref<ExpiryMode>('permanent')
const customExpiry = ref<Date | null>(null)

function submit(): void {
  if (props.busy) return
  const member = props.members.find((m) => m.member_id === target.value)
  if (!member) return
  const expires = expiryOf(ttl.value, customExpiry.value)
  if (expires === 'invalid') { ElMessage.warning('自定义到期时间需要晚于当前时间'); return }
  emit('issue', member, expires)
}
</script>
<template>
  <el-form label-position="top" :disabled="busy" @submit.prevent="submit">
    <el-form-item label="使用人">
      <el-select v-model="target" filterable clearable placeholder="选择在职成员" aria-label="选择成员">
        <el-option v-for="member in members" :key="member.member_id" :value="member.member_id" :label="memberLabel(member)" />
      </el-select>
    </el-form-item>
    <el-form-item label="有效期">
      <el-select v-model="ttl" aria-label="有效期">
        <el-option value="permanent" label="长期有效" />
        <el-option value="30" label="30 天" />
        <el-option value="90" label="90 天" />
        <el-option value="custom" label="自定义到期时间" />
      </el-select>
    </el-form-item>
    <el-form-item v-if="ttl === 'custom'" label="到期时刻">
      <el-date-picker v-model="customExpiry" type="datetime" placeholder="选择到期时间" aria-label="自定义到期时间" />
    </el-form-item>
    <p class="muted form-hint">
      归属由服务端按成员 ID 决定，客户端自称无效；有效期可以留空（长期有效）或指定到期时刻。
      签发后完整 appKey 只显示这一次，请立即复制交付信息。
    </p>
    <p v-if="!canPick" class="muted form-hint">需要人员读权限才能选择成员。</p>
    <div class="dialog-actions">
      <el-button @click="emit('cancel')">取消</el-button>
      <el-button type="primary" :icon="Ticket" :loading="busy" :disabled="!canPick || !target" @click="submit">发放 appKey</el-button>
    </div>
  </el-form>
</template>