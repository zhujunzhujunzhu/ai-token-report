<script setup lang="ts">
/**
 * 本地统计页根组件。
 *
 * 职责：**统计页 + 压在它上面的「配置」弹框**。
 *
 * ★ 未配置身份时**不再整页挡住**：弹框浮在统计页上方（页面上能看见本机用量，
 *   这本来就是用户自己的数据），关掉它照样能看 —— 只是不采集也不上报。
 *   状态分派见 `useIdentity.ts`，这里只做展示。
 */
import { computed, ref } from 'vue'

import IdentityGate from '@/components/identity/IdentityGate.vue'
import UiButton from '@/components/ui/UiButton.vue'
import { useIdentity } from '@/composables/useIdentity'
import UsageStatsView from '@/views/UsageStatsView.vue'

const { state, onSigned, refresh } = useIdentity()

/** 用户从统计页的「配置」按钮主动打开弹框。 */
const configuring = ref(false)

/** 弹框开着 = 「配置」被点开，或首次进入时尚未配置身份。 */
const gateOpen = computed(() => configuring.value || state.value.kind === 'signin')

// 载荷字段是 `group`（原 `dept`），地址是 `baseUrl` —— 契约真源见 shared 的
// `LocalIdentityResponse` / `LocalIdentitySubmit`，本地页面不带任何兼容别名。
function saveSettings(payload: { name: string; group?: string; baseUrl?: string }): void {
  onSigned(payload)
  configuring.value = false
}
</script>

<template>
  <!-- 加载中 -->
  <div v-if="state.kind === 'loading'" class="shell shell--center">
    <p class="shell__tip">正在检查署名状态…</p>
  </div>

  <!-- 服务不可达：先确认服务，再让用户填表 -->
  <div v-else-if="state.kind === 'error'" class="shell shell--center">
    <div class="shell__error">
      <h2 class="shell__error-title">无法连接本地服务</h2>
      <p class="shell__error-msg">{{ state.message }}</p>
      <UiButton variant="primary" @click="refresh">重试</UiButton>
    </div>
  </div>

  <!-- 统计页始终在；未配置身份时配置弹框压在上面 -->
  <div v-else class="shell">
    <UsageStatsView @configure="configuring = true" />
    <IdentityGate
      v-if="gateOpen"
      :settings="configuring"
      :hint="state.kind === 'signin' ? state.hint : null"
      :initial-base-url="state.baseUrl ?? ''"
      :signed-name="state.kind === 'ready' ? state.name : ''"
      :signed-group="state.kind === 'ready' ? state.group : null"
      @signed="saveSettings"
      @cancel="configuring = false"
    />
  </div>
</template>

<style scoped>
.shell {
  min-height: 100vh;
}

.shell--center {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  padding: 32px 16px;
  background-color: var(--c-bg-page, #fff);
}

.shell__tip {
  font-size: 13px;
  color: var(--c-text-secondary, #4d4d4d);
}

.shell__error {
  max-width: 420px;
  padding: 28px;
  text-align: center;
  background-color: #fff;
  border: 1px solid var(--c-border, #e8e8e8);
  border-radius: var(--radius-lg, 14px);
}

.shell__error-title {
  margin: 0 0 8px;
  font-size: 17px;
  font-weight: 600;
  color: var(--c-text-primary, #1a1a1a);
}

.shell__error-msg {
  margin: 0 0 20px;
  font-size: 13px;
  line-height: 1.6;
  color: var(--c-text-secondary, #4d4d4d);
}
</style>
