<script setup lang="ts">
/**
 * 「配置」弹框 —— **只有两栏：部门服务端地址 + appKey**。
 *
 * ## 为什么收敛成两栏（与 DSH 插件的「连接配置」同一形态）
 *
 * 员工手上真正拿到的只有两样东西：部门平台的**地址**，和管理员发的一串 **appKey**。
 * 旧版这一页让人填「姓名 / Key / 分组」三栏，其中：
 *
 * | 旧栏 | 问题 |
 * |---|---|
 * | 姓名 | ★ 服务端按 appKey 解析出的才是权威，用户填什么都不作数（见 `identity-attribution` 不变量） |
 * | 分组 | 同上，同样由服务端给出 |
 * | Key | 唯一真正需要用户提供的东西 |
 *
 * 三栏里有两栏是**做不到的承诺**：用户以为「填了姓名就归属到这个名字」，
 * 而实际上服务端会覆盖它。收成两栏之后，界面上每一个输入框都真的有用。
 *
 * ## 为什么是弹框
 *
 * 统计页始终在下面（本机数据本来就能看），配置只是暂时压在上面的一层。
 * 整页替换会让人以为「不填就看不到任何东西」，而真实约定恰恰相反：
 * **未配置身份时不采集、不上报，但本机用量照看**。
 *
 * ## 校验时机
 *
 * 提交时才向服务端校验 appKey（本地不做「看起来对不对」的猜测）。
 * 校验失败的原因由服务端给出并直接展示 —— 特别是要区分
 * 「appKey 填错了」（重试有用）与「管理员还没发凭证」（重试没用）。
 */
import { computed, ref } from 'vue'

import { submitIdentity } from '@/api/identity'
import UiButton from '@/components/ui/UiButton.vue'
import UiModal from '@/components/ui/UiModal.vue'

const props = withDefaults(
  defineProps<{
    /** 服务端给出的默认提示文案 */
    hint?: string | null
    /** 是否允许跳过（只看本机统计，不上报） */
    allowSkip?: boolean
    /** 从统计页的「配置」入口打开（取消时返回用量，而不是「跳过署名」）。 */
    settings?: boolean
    /** 回填的服务端地址（本机存过的 > 部署参数 `--portal`）。 */
    initialBaseUrl?: string
    /** 已保存的署名（姓名），空串 = 未署名。 */
    signedName?: string
    /** 已保存的分组。 */
    signedGroup?: string | null
  }>(),
  {
    hint: null,
    allowSkip: true,
    settings: false,
    initialBaseUrl: '',
    signedName: '',
    signedGroup: null,
  },
)

const emit = defineEmits<{
  /** 配置完成（skip 时 name 为空串） */
  (e: 'signed', payload: { name: string; group?: string; baseUrl?: string }): void
  (e: 'cancel'): void
}>()

const baseUrl = ref(props.initialBaseUrl)
const token = ref('')
const submitting = ref(false)
const error = ref<string | null>(null)

/**
 * ★ 两栏都非空才允许提交。
 *
 * 地址不能靠「服务端猜」：没有地址时本地服务不知道向谁校验，
 * 而一个猜出来的地址等于把用量发给一台谁也不知道的机器。
 * 没配 `--portal` 时地址栏就是空的，用户必须填（那时页面上也会说明）。
 */
const canSubmit = computed(
  () => baseUrl.value.trim().length > 0 && token.value.trim().length > 0 && !submitting.value,
)

/** 已保存署名时的说明行（姓名与分组**都来自服务端校验结果**）。 */
const savedLabel = computed(() => {
  if (!props.signedName) return ''
  return props.signedGroup ? `${props.signedName} · ${props.signedGroup}` : props.signedName
})

async function onSubmit(): Promise<void> {
  if (!canSubmit.value) return

  error.value = null
  submitting.value = true

  try {
    const res = await submitIdentity({
      token: token.value.trim(),
      baseUrl: baseUrl.value.trim(),
    })

    // 网络层失败
    if (!res.ok) {
      error.value = res.error
      return
    }

    // 业务层失败（appKey 无效 / 服务端未配置凭证 / 地址不可达等）
    if (!res.data.ok) {
      error.value = res.data.reason ?? '保存失败，请重试'
      return
    }

    // ★ 服务端一定会回署名；没回就是没保存成功，**绝不退回我们提交过的任何内容**
    //   （姓名根本不在提交体里，所以这里只能如实报错）。
    if (!res.data.name) {
      error.value = res.data.reason ?? '服务端未返回有效署名，未保存配置'
      return
    }

    // 服务端归一化过的地址才是权威（它可能剥掉了 /api/v1/token-usage）
    baseUrl.value = res.data.baseUrl ?? baseUrl.value.trim()
    token.value = ''

    emit('signed', {
      name: res.data.name,
      ...(res.data.group ? { group: res.data.group } : {}),
      ...(res.data.baseUrl ? { baseUrl: res.data.baseUrl } : {}),
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
  <UiModal
    :title="props.settings ? '配置' : '署名后开始统计'"
    subtitle="填写部门服务端地址与管理员发放的 appKey，用于验证身份并将用量归属到分组统计。"
    @close="props.settings ? emit('cancel') : onSkip()"
  >
    <p v-if="savedLabel" class="signin__saved">
      当前署名：<b>{{ savedLabel }}</b>（按 appKey 从服务端解析，不是在这里填的）。
      换地址或换凭证后重新保存即可，appKey 不会回显。
    </p>

    <form class="signin__form" @submit.prevent="onSubmit">
      <label class="field">
        <span class="field__label">服务端地址<em class="field__req">必填</em></span>
        <input
          v-model="baseUrl"
          class="field__input"
          type="text"
          placeholder="例如：http://127.0.0.1:8787"
          autocomplete="off"
          spellcheck="false"
          maxlength="256"
        />
        <span class="field__help">部门服务端的根地址；粘贴完整上报地址也会自动去掉 /api/… 后缀</span>
      </label>

      <label class="field">
        <span class="field__label">appKey<em class="field__req">必填</em></span>
        <input
          v-model="token"
          class="field__input"
          type="password"
          :placeholder="
            props.signedName ? '已配置（不回显）；换地址或换凭证时重新粘贴' : '粘贴管理员发放的 appKey'
          "
          autocomplete="off"
          maxlength="256"
        />
        <span class="field__help">appKey 是身份凭证，保存前会向上面的地址校验</span>
      </label>

      <p v-if="error" class="signin__error" role="alert">{{ error }}</p>

      <div class="signin__actions">
        <UiButton variant="primary" :disabled="!canSubmit" @click="onSubmit">
          {{ submitting ? '校验中…' : '验证并保存' }}
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

      <p class="signin__note">
        姓名与分组以服务端校验结果为准；保存成功后立即生效，失败会重试。
      </p>
    </form>

    <footer class="signin__foot">
      <div class="notice">
        <strong class="notice__title">数据与隐私</strong>
        <ul class="notice__list">
          <li>未配置身份时不采集，也不向服务端上报数据</li>
          <li>只看 token 数值与模型名，<b>不采集对话内容</b></li>
          <li>appKey 保存在本机，不回显；姓名与分组由服务端按 appKey 解析</li>
        </ul>
      </div>
      <p v-if="props.hint" class="signin__hint">{{ props.hint }}</p>
    </footer>
  </UiModal>
</template>

<style scoped>
.signin__form {
  display: flex;
  flex-direction: column;
  gap: 16px;
  margin-top: 20px;
}

.signin__saved {
  margin: 14px 0 0;
  padding: 10px 12px;
  font-size: 12px;
  line-height: 1.7;
  color: var(--c-text-secondary);
  background-color: var(--c-bg-subtle);
  border-radius: var(--radius-sm);
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
  color: var(--c-text-primary);
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

.field__input {
  height: var(--control-height);
  padding: 0 12px;
  font-size: 13px;
  color: var(--c-text-primary);
  background-color: #fff;
  border: 1px solid var(--c-border);
  border-radius: 8px;
  outline: none;
  transition: border-color 0.15s var(--ease);
}

.field__input:focus {
  border-color: var(--c-text-primary);
}

.field__help {
  font-size: 12px;
  color: var(--c-text-secondary);
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
  color: var(--c-text-secondary);
  background: none;
  border: none;
  text-decoration: underline;
  text-underline-offset: 3px;
}

.signin__skip:hover:not(:disabled) {
  color: var(--c-text-primary);
}

.signin__skip:disabled {
  opacity: 0.5;
}

.signin__note {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--c-text-tertiary);
}

.signin__foot {
  margin-top: 24px;
  padding-top: 20px;
  border-top: 1px solid var(--c-border);
}

.notice__title {
  display: block;
  margin-bottom: 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--c-text-primary);
}

.notice__list {
  margin: 0;
  padding-left: 18px;
  font-size: 12px;
  line-height: 1.9;
  color: var(--c-text-secondary);
}

.signin__hint {
  margin: 12px 0 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--c-text-secondary);
}
</style>
