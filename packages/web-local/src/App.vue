<script setup lang="ts">
/**
 * 本地统计页根组件。
 *
 * 职责：**决定展示引导页还是统计页**。
 *
 * 状态分派见 `useIdentity.ts`。这里只做展示，
 * 业务逻辑都在 composable 里，便于单独测试。
 */
import { ref } from 'vue'

import IdentityGate from '@/components/identity/IdentityGate.vue'
import UiButton from '@/components/ui/UiButton.vue'
import { useIdentity } from '@/composables/useIdentity'
import UsageStatsView from '@/views/UsageStatsView.vue'

const { state, onSigned, refresh } = useIdentity()

const configuring = ref(false)

function saveSettings(payload: { name: string; dept?: string }): void {
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

  <!-- 首次使用：引导署名 -->
  <IdentityGate v-else-if="state.kind === 'signin'" :hint="state.hint" @signed="onSigned" />

  <!-- 已署名 / 已跳过：统计页 -->
  <div v-else class="shell">
    <IdentityGate
      v-if="configuring"
      settings
      :initial-name="state.kind === 'ready' ? state.name : ''"
      :initial-dept="state.kind === 'ready' ? state.dept : null"
      @signed="saveSettings"
      @cancel="configuring = false"
    />
    <UsageStatsView v-show="!configuring" @configure="configuring = true" />
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
  background-color: var(--c-bg-page, #f6f7f9);
}

.shell__tip {
  font-size: 13px;
  color: var(--c-text-secondary, #6b7280);
}

.shell__error {
  max-width: 420px;
  padding: 28px;
  text-align: center;
  background-color: #fff;
  border: 1px solid var(--c-border, #e8eaed);
  border-radius: 14px;
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
  color: var(--c-text-secondary, #6b7280);
}

</style>
