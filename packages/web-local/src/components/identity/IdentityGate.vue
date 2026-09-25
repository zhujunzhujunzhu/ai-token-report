<script setup lang="ts">
/**
 * 首次署名引导页。
 *
 * ## 为什么是这个形态
 *
 * 员工打开页面第一件事就是填姓名与 token —— 这是「主动署名」的落点。
 * 页面必须把三件事讲清楚，否则会招致两类问题（用户乱填 / 拒绝填写）：
 *
 * 1. **填什么** —— 姓名 + 管理员发放的 token
 * 2. **为什么** —— 把用量归属到部门统计；不填就没法归属
 * 3. **不填会怎样** —— ★ 明确承诺「不采集也不上报」，这是知情同意的关键
 *
 * 第 3 点尤其重要：含糊其辞会让人怀疑在偷偷采集，反而更容易被拒绝。
 *
 * ## 校验时机
 *
 * 提交时才向服务端校验 token（本地不做「看起来对不对」的猜测）。
 * 校验失败的原因由服务端给出并直接展示 —— 特别是要区分
 * 「token 填错了」（重试有用）与「管理员还没发凭证」（重试没用）。
 */
import { computed, ref } from 'vue'

import { submitIdentity } from '@/api/identity'
import UiButton from '@/components/ui/UiButton.vue'

const props = withDefaults(
  defineProps<{
    /** 服务端给出的默认提示文案 */
    hint?: string | null
    /** 是否允许跳过（只看本机统计，不上报） */
    allowSkip?: boolean
    /** 配置页复用校验流程，取消时保留原署名。 */
    settings?: boolean
    initialName?: string
    initialDept?: string | null
  }>(),
  { hint: null, allowSkip: true, settings: false, initialName: '', initialDept: null },
)

const emit = defineEmits<{
  /** 署名完成（skip 时 name 为空串） */
  (e: 'signed', payload: { name: string; dept?: string }): void
  (e: 'cancel'): void
}>()

const name = ref(props.initialName)
const token = ref('')
const dept = ref(props.initialDept ?? '')
const submitting = ref(false)
const error = ref<string | null>(null)

/** 两项必填都非空才允许提交 */
const canSubmit = computed(
  () => name.value.trim().length > 0 && token.value.trim().length > 0 && !submitting.value,
)

async function onSubmit(): Promise<void> {
  if (!canSubmit.value) return

  error.value = null
  submitting.value = true

  try {
    const res = await submitIdentity({
      name: name.value.trim(),
      token: token.value.trim(),
      ...(dept.value.trim() ? { dept: dept.value.trim() } : {}),
    })

    // 网络层失败
    if (!res.ok) {
      error.value = res.error
      return
    }

    // 业务层失败（token 无效 / 服务端未配置凭证等）
    if (!res.data.ok) {
      error.value = res.data.reason ?? '署名失败，请重试'
      return
    }

    emit('signed', {
      name: res.data.name ?? name.value.trim(),
      ...(res.data.dept ? { dept: res.data.dept } : {}),
    })
  } finally {
    submitting.value = false
  }
}

function onSkip(): void {
  emit('signed', { name: '' })
}
</script>

<template>
  <div class="signin">
    <div class="signin__card">
      <header class="signin__head">
        <h1 class="signin__title">{{ props.settings ? '配置' : '署名后开始统计' }}</h1>
        <p class="signin__sub">
          设置管理员发放的 Key，用于验证身份并将用量归属到部门统计。
        </p>
        <p v-if="props.settings && props.initialName" class="signin__hint">
          当前已配置：{{ props.initialName }}。更新 Key 时请重新输入，已保存的 Key 不会回显。
        </p>
      </header>

      <form class="signin__form" @submit.prevent="onSubmit">
        <label class="field">
          <span class="field__label">姓名<em class="field__req">必填</em></span>
          <input
            v-model="name"
            class="field__input"
            type="text"
            placeholder="例如：张三"
            autocomplete="off"
            maxlength="32"
          />
        </label>

        <label class="field">
          <span class="field__label">Key<em class="field__req">必填</em></span>
          <input
            v-model="token"
            class="field__input"
            type="password"
            placeholder="请输入管理员发放的 Key"
            autocomplete="off"
            maxlength="256"
          />
          <span class="field__help">Key 是身份凭证，保存前会向部门服务端校验</span>
        </label>

        <label class="field">
          <span class="field__label">部门<em class="field__opt">选填</em></span>
          <input
            v-model="dept"
            class="field__input"
            type="text"
            placeholder="例如：研发一部"
            autocomplete="off"
            maxlength="32"
          />
        </label>

        <p v-if="error" class="signin__error" role="alert">{{ error }}</p>

        <div class="signin__actions">
          <UiButton variant="primary" :disabled="!canSubmit" @click="onSubmit">
            {{ submitting ? '校验中…' : props.settings ? '验证并保存' : '保存并开始统计' }}
          </UiButton>
          <button
            v-if="props.allowSkip || props.settings"
            type="button"
            class="signin__skip"
            :disabled="submitting"
            @click="props.settings ? emit('cancel') : onSkip()"
          >
            {{ props.settings ? '返回我的用量' : '暂不填写，只看本机统计' }}
          </button>
        </div>
      </form>

      <footer class="signin__foot">
        <div class="notice">
          <strong class="notice__title">数据与隐私</strong>
          <ul class="notice__list">
            <li>未配置身份时不采集，也不向服务端上报数据</li>
            <li>只看 token 数值与模型名，<b>不采集对话内容</b></li>
            <li>姓名与 Key 保存在本机</li>
          </ul>
        </div>
        <p v-if="props.hint" class="signin__hint">{{ props.hint }}</p>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.signin {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  padding: 32px 16px;
  background-color: var(--c-bg-page, #f6f7f9);
}

.signin__card {
  width: 100%;
  max-width: 460px;
  padding: 32px;
  background-color: #fff;
  border: 1px solid var(--c-border, #e8eaed);
  border-radius: 14px;
}

.signin__head {
  margin-bottom: 24px;
}

.signin__title {
  margin: 0 0 8px;
  font-size: 20px;
  font-weight: 600;
  color: var(--c-text-primary, #1a1a1a);
}

.signin__sub {
  margin: 0;
  font-size: 13px;
  line-height: 1.6;
  color: var(--c-text-secondary, #6b7280);
}

.signin__form {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.field__label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 500;
  color: var(--c-text-primary, #1a1a1a);
}

.field__req,
.field__opt {
  font-size: 11px;
  font-style: normal;
  font-weight: 400;
  padding: 1px 5px;
  border-radius: 4px;
}

.field__req {
  color: #b42318;
  background-color: #fef3f2;
}

.field__opt {
  color: var(--c-text-secondary, #6b7280);
  background-color: var(--c-bg-subtle, #f3f4f6);
}

.field__input {
  height: var(--control-height, 36px);
  padding: 0 12px;
  font-size: 13px;
  color: var(--c-text-primary, #1a1a1a);
  background-color: #fff;
  border: 1px solid var(--c-border, #e8eaed);
  border-radius: 8px;
  outline: none;
  transition: border-color 0.15s var(--ease, ease);
}

.field__input:focus {
  border-color: var(--c-text-primary, #1a1a1a);
}

.field__help {
  font-size: 12px;
  color: var(--c-text-secondary, #6b7280);
}

.signin__error {
  margin: 0;
  padding: 10px 12px;
  font-size: 13px;
  line-height: 1.5;
  color: #b42318;
  background-color: #fef3f2;
  border-radius: 8px;
}

.signin__actions {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 4px;
}

.signin__skip {
  padding: 0;
  font-size: 13px;
  color: var(--c-text-secondary, #6b7280);
  background: none;
  border: none;
  text-decoration: underline;
  text-underline-offset: 3px;
}

.signin__skip:hover:not(:disabled) {
  color: var(--c-text-primary, #1a1a1a);
}

.signin__skip:disabled {
  opacity: 0.5;
}

.signin__foot {
  margin-top: 24px;
  padding-top: 20px;
  border-top: 1px solid var(--c-border, #e8eaed);
}

.notice__title {
  display: block;
  margin-bottom: 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--c-text-primary, #1a1a1a);
}

.notice__list {
  margin: 0;
  padding-left: 18px;
  font-size: 12px;
  line-height: 1.9;
  color: var(--c-text-secondary, #6b7280);
}

.signin__hint {
  margin: 12px 0 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--c-text-secondary, #6b7280);
}
</style>
