<script setup lang="ts">
/** 用户名、密码与一次性验证码登录；浏览器不接收上报 Token。 */
import {
  ElAlert,
  ElButton,
  ElForm,
  ElFormItem,
  ElIcon,
  ElInput,
  type FormInstance,
  type FormRules,
} from 'element-plus'
import { onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { DataAnalysis, User, Right, Lock, Check } from '@element-plus/icons-vue'
import type { PortalCaptchaResponse } from '@ai-token-report/shared'
import { request } from '../api/request.js'
import { useSessionStore } from '../stores/session.js'
import { loginDestination } from '../router/index.js'
const session = useSessionStore()
const route = useRoute()
const router = useRouter()
const form = ref<FormInstance>()
const draft = reactive({
  username: '',
  password: '',
  captcha: '',
  captcha_id: '',
})
const captchaImage = ref('')
const captchaLoading = ref(false)
const captchaError = ref('')
const rules: FormRules = {
  username: [{ required: true, message: '请输入用户名', trigger: 'blur' }],
  password: [{ required: true, message: '请输入密码', trigger: 'blur' }],
  captcha: [
    {
      required: true,
      pattern: /^[0-9]{4}$/,
      message: '请输入图片中的 4 位数字',
      trigger: 'blur',
    },
  ],
}
async function refreshCaptcha(): Promise<void> {
  if (captchaLoading.value || session.checking) return
  captchaLoading.value = true
  captchaError.value = ''
  draft.captcha = ''
  draft.captcha_id = ''
  captchaImage.value = ''
  const result = await request<PortalCaptchaResponse>('/api/v1/auth/captcha')
  if (
    result.ok &&
    result.data.image?.startsWith('data:image/png;base64,') &&
    result.data.captcha_id
  ) {
    draft.captcha_id = result.data.captcha_id
    captchaImage.value = result.data.image
  } else
    captchaError.value = result.ok ? '验证码加载失败，请重试' : result.error
  captchaLoading.value = false
}
onMounted(refreshCaptcha)
async function submit(): Promise<void> {
  if (
    session.checking ||
    captchaLoading.value ||
    !draft.captcha_id ||
    !(await form.value?.validate().catch(() => false))
  )
    return
  if (await session.signIn({ ...draft, username: draft.username.trim() })) {
    draft.password = ''
    draft.captcha = ''
    await router.replace(loginDestination(route.query.redirect))
  } else await refreshCaptcha()
}
</script>
<template>
  <main class="login-page">
    <section class="login-story">
      <div class="brand">
        <span class="brand-mark"
          ><el-icon><DataAnalysis /></el-icon></span
        ><span class="brand-copy"
          ><strong>DSH <span>Token</span></strong
          ><small>团队用量管理平台</small></span
        >
      </div>
      <div class="login-story-content">
        <span class="login-kicker">CLEAR INSIGHTS. BETTER COLLABORATION.</span>
        <h1>团队的每一份用量，<br /><span>都清晰可见。</span></h1>
        <p>
          连接团队与 AI 使用数据。<br />从用量趋势到成员管理，在一个工作空间轻松掌握。
        </p>
        <div class="login-illustration" aria-hidden="true">
          <div class="illustration-top">
            <span><i /> 团队用量概览</span
            ><span class="illustration-badge">Token insights</span>
          </div>
          <div class="illustration-lines"><span /><span /><span /></div>
          <div class="illustration-bars">
            <i
              v-for="(height, index) in [
                30, 46, 39, 61, 50, 72, 63, 82, 73, 96, 84, 100,
              ]"
              :key="index"
              :style="{ height: `${height}%` }"
            />
          </div>
          <div class="illustration-footer">
            <span>用量趋势</span><span>让数据连接每一次进步</span>
          </div>
          <div class="illustration-float">
            <el-icon><Check /></el-icon
            ><span>数据有归属<br /><small>协作更清晰</small></span>
          </div>
        </div>
      </div>
      <div class="login-story-footer">
        <el-icon><Lock /></el-icon> 仅统计 Token 用量，不采集对话内容
      </div>
    </section>
    <section class="login-form-side">
      <div class="login-form-wrap">
        <div class="login-welcome">欢迎回来</div>
        <h2>登录管理后台</h2>
        <p class="login-subtitle">使用账号密码登录，掌握团队每一份用量。</p>
        <el-form
          ref="form"
          :model="draft"
          :rules="rules"
          label-position="top"
          size="large"
          @submit.prevent="submit"
        >
          <el-form-item label="用户名" prop="username">
            <el-input
              v-model="draft.username"
              name="username"
              autocomplete="username"
              :prefix-icon="User"
              placeholder="请输入用户名"
              :maxlength="64"
              :disabled="session.checking"
              aria-label="用户名"
            />
          </el-form-item>
          <el-form-item label="密码" prop="password">
            <el-input
              v-model="draft.password"
              name="password"
              type="password"
              show-password
              autocomplete="current-password"
              :prefix-icon="Lock"
              placeholder="请输入密码"
              :maxlength="128"
              :disabled="session.checking"
              aria-label="密码"
            />
          </el-form-item>
          <el-form-item label="验证码" prop="captcha">
            <div class="captcha-row">
              <el-input
                v-model="draft.captcha"
                name="captcha"
                inputmode="numeric"
                autocomplete="off"
                placeholder="4 位数字"
                :maxlength="4"
                :disabled="session.checking"
                aria-label="验证码"
              />
              <button
                type="button"
                class="captcha-image"
                :disabled="session.checking || captchaLoading"
                aria-label="刷新验证码"
                title="看不清？点击换一张"
                @click="refreshCaptcha"
              >
                <img
                  v-if="captchaImage"
                  :src="captchaImage"
                  alt="图形验证码"
                  width="168"
                  height="56"
                />
                <span v-else>{{
                  captchaLoading ? '加载中…' : '点击重试'
                }}</span>
              </button>
            </div>
            <span class="captcha-hint">看不清？点击图片换一张</span>
          </el-form-item>
          <el-alert
            v-if="captchaError"
            :title="captchaError"
            type="error"
            :closable="false"
            class="login-error"
          />
          <el-alert
            v-if="session.error"
            :title="session.error"
            type="error"
            show-icon
            :closable="false"
            class="login-error"
            role="alert"
          />
          <el-button
            type="primary"
            native-type="submit"
            class="login-submit"
            :loading="session.checking"
            :disabled="captchaLoading || !draft.captcha_id"
            >{{ session.checking ? '正在验证身份' : '登录工作空间'
            }}<el-icon v-if="!session.checking"><Right /></el-icon
          ></el-button>
        </el-form>
        <div class="login-help">
          <el-icon><Lock /></el-icon>
          <div>
            <strong>还没有登录账号？</strong>
            <p>
              请联系管理员开通账号。忘记密码时，可请管理员在人员管理中重置。
            </p>
          </div>
        </div>
        <p class="login-session-note">
          登录状态保留 8 小时，使用完毕请在账号菜单退出。
        </p>
      </div>
      <footer class="login-copyright">DSH Token · 团队用量管理平台</footer>
    </section>
  </main>
</template>
