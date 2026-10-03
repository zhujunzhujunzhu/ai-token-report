<script setup lang="ts">
/**
 * 交付信息正文（appKey 管理页用）—— 「插件该填什么」在这里一次讲清楚。
 *
 * ## 为什么单独一个组件，而不是直接写在页面的弹框里
 *
 * ① 它是这一页唯一需要**逐字**正确的一段内容（地址填错 = 插件静默失效），
 *    拆出来才能在渲染验证里直接断言：Element Plus 的弹框正文在 SSR 下
 *    根本不渲染（`rendered` 由 `onMounted` 置位），写在页面里就测不到。
 * ② 呈现的几行与进剪贴板的那段文本由**同一个 `baseUrl`** 拼出来，
 *    不会出现「显示一个地址、复制到另一个地址」。
 *
 * ## ★ 明文不落在页面上
 *
 * `secret` 只有两个去处：拼进**隐藏的**复制源（`#delivery-text`，
 * 非安全上下文下的降级路径要整段选中它），以及算一个中间省略号的遮罩。
 * 页面上永远没有完整值 —— 要完整值就按「复制」。
 */
import { computed, ref } from 'vue'
import { CopyDocument } from '@element-plus/icons-vue'
import { ElButton, ElMessage } from 'element-plus'
import { copyText } from '../utils/clipboard.js'
import { maskSecret, tokenHint } from '../utils/credential.js'

const props = defineProps<{
  /** 使用人（姓名 + 分组），写进交付文本。 */
  owner: string
  /** 明文；只有签发 / 轮换那一次响应里有。 */
  secret: string | null
  /** 凭证提示（无明文时说明发出去的是哪一把）。 */
  prefix: string
}>()
const emit = defineEmits<{ close: [] }>()
/** 只影响按钮文案：复制成功过一次就提示可以再复制一次。 */
const copied = ref(false)
/**
 * ⚠️ SSR 下 `location` 不存在，必须判空 —— 渲染脚本会真的执行这个组件。
 *   取不到时给占位文案让使用者自己填，不猜一个可能错的地址。
 */
const baseUrl = computed(() => (typeof location === 'undefined' ? '' : location.origin) || '（你的平台地址）')
/** MCP / 插件的「上报连接」面板要填的两条接口。 */
const reportUrl = computed(() => `${baseUrl.value}/api/v1/token-usage`)
const statsUrl = computed(() => `${baseUrl.value}/api/v1/stats/*`)
/**
 * 进剪贴板的那段文本。
 *
 * ⚠️ 没有明文时必须写明「完整 appKey 只在签发或轮换时显示一次」，
 *   否则使用者会把 `d57887…39d349` 当成完整 key 发出去，
 *   然后插件怎么配都无效。
 */
const text = computed(() => [
  'AI Token 用量上报配置',
  `服务端地址：${baseUrl.value}`,
  `上报接口：${reportUrl.value}（POST，Authorization: Bearer <appKey>）`,
  `统计接口：${statsUrl.value}（GET）`,
  `使用人：${props.owner || '（未指定）'}`,
  props.secret
    ? `appKey：${props.secret}`
    : `凭证提示：${tokenHint(props.prefix)}（完整 appKey 只在签发或轮换时显示一次，请向管理员索取或让其轮换一把新的）`,
  '在 DSH 插件的「上报连接」面板里填写服务端地址与 appKey 即可。',
].join('\n'))
/**
 * 复制。
 *
 * ⚠️ 降级路径（非安全上下文里没有 `navigator.clipboard`）靠整段选中
 *   `#delivery-text` 让使用者按 Ctrl+C，所以复制目标必须在 DOM 里、
 *   而且这次要复制的内容必须就在里面 —— 复制明文时选中的是整段交付信息
 *   （它含明文），提示语也要照实说，不能只说「已复制」。
 */
async function copy(kind: 'delivery' | 'secret'): Promise<void> {
  if (kind === 'secret' && !props.secret) return
  const ok = await copyText(kind === 'secret' ? props.secret! : text.value, 'delivery-text')
  if (kind === 'secret') copied.value = ok
  ElMessage({
    type: ok ? 'success' : 'info',
    message: ok
      ? kind === 'secret' ? 'appKey 已复制' : '交付信息已复制（含完整 appKey）'
      : kind === 'secret' ? '已选中交付信息（含完整 appKey），请按 Ctrl+C 复制' : '已选中交付信息，请按 Ctrl+C 复制',
  })
}
</script>
<template>
  <div class="appkey-delivery">
    <!-- ★ 有明文时不再压一条警告条：说明就在下面 `appKey` 那一行的旁注里
         （「完整值不落在页面上」），弹框顶部再喊一遍只是把地址挤下去。 -->
    <p v-if="!secret" class="muted delivery-hint">这一行只有摘要提示：完整 appKey 只在签发或轮换成功时出现一次。</p>
    <dl class="delivery-list">
      <div><dt>服务端地址</dt><dd><code>{{ baseUrl }}</code></dd></div>
      <div><dt>上报接口</dt><dd><code>{{ reportUrl }}</code><span class="muted">POST · Authorization: Bearer appKey</span></dd></div>
      <div><dt>统计接口</dt><dd><code>{{ statsUrl }}</code><span class="muted">GET</span></dd></div>
      <div><dt>使用人</dt><dd>{{ owner || '（未指定）' }}</dd></div>
      <div><dt>appKey</dt><dd><code>{{ secret ? maskSecret(secret) : tokenHint(prefix) }}</code><span class="muted">{{ secret ? '完整值不落在页面上，复制时整段写进剪贴板' : '这里只是摘要提示，不是完整值' }}</span></dd></div>
    </dl>
    <code id="delivery-text" class="copy-source">{{ text }}</code>
    <div class="dialog-actions">
      <el-button v-if="secret" :icon="CopyDocument" @click="copy('secret')">{{ copied ? '再复制一次 appKey' : '复制 appKey' }}</el-button>
      <el-button type="primary" :icon="CopyDocument" @click="copy('delivery')">复制交付信息</el-button>
      <el-button @click="emit('close')">{{ secret ? '已保存，关闭' : '关闭' }}</el-button>
    </div>
  </div>
</template>