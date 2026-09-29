<script setup lang="ts">
/**
 * appKey 管理页 —— 一行一把上报凭证，并说明它发给了谁。
 *
 * ## 为什么主体是凭证列表，而不是成员名单
 *
 * 这一页要回答两个分开的问题：
 *
 * | 问题 | 落点 |
 * |---|---|
 * | 「这把 key 发给了谁」 | 列表每行由服务端按 `member_id` 关联出人员与分组 |
 * | 「现在给某人发一把」 | 右上角「发放 appKey」开弹框：选人 + 选有效期 → 发放 |
 *
 * 旧版把成员名单当主体，于是「哪些 key 还活着、什么时候到期、谁被吊销过」
 * 这一屏根本看不到 —— 而它恰恰是管理员来这一页的原因。
 *
 * ## 页面只留列表，两个动作都走弹框
 *
 * 「发放」与「交付信息」都不是常驻内容：前者一天用不了几次，后者是一锤子
 * 买卖（照抄地址 + 复制明文）。铺在页面上会把唯一值得看的东西 ——
 * 凭证列表 —— 挤到折叠线以下。所以发放表单在弹框里（`IssueAppKeyForm.vue`），
 * 交付信息同样（`AppKeyDelivery.vue`），签发成功后自动接力到后者。
 *
 * ## ★ 完整 appKey 只显示这一次，而且不落在页面上
 *
 * 服务端只存摘要（`token_hash`），明文仅随签发 / 轮换响应返回。所以「复制」
 * 是页面上的第一动作：明文**不进 DOM**，页面最多显示中间省略号的遮罩
 * （`atr-ab12…ef34`），完整值只在剪贴板里。交付信息也不再铺在页面上，
 * 而是点「交付信息」开弹框看 —— 弹框给的是要照着填的**上报地址**。
 *
 * ## 有效期：签发能设，事后能改
 *
 * `null` = 长期有效，其余必须是未来时刻（服务端也会拒过去时刻）。
 * 「已到期」不是库里的状态，而是 `expires_at_ms` 与当前时间比出来的，
 * 所以过期 key 还能在这里**续期** —— 不必轮换出一把新的（那会换掉明文，
 * 已经发出去的插件配置全部作废）。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { Refresh, Search, Ticket } from '@element-plus/icons-vue'
import { ElAlert, ElButton, ElCard, ElDatePicker, ElDialog, ElInput, ElMessage, ElMessageBox, ElOption, ElSelect, ElSkeleton, ElTable, ElTableColumn, ElTag } from 'element-plus'
import type { PortalAppKeyEntry, PortalMember, PortalReportToken } from '@ai-token-report/shared'
import AppKeyDelivery from '../components/AppKeyDelivery.vue'
import IssueAppKeyForm from '../components/IssueAppKeyForm.vue'
import { useSessionStore } from '../stores/session.js'
import { useMembersStore } from '../stores/members.js'
import * as api from '../api/admin.js'
import { expiryOf, type ExpiryMode } from '../utils/expiry.js'
import { formatFullDateTime } from '../utils/format.js'
import { tokenHint } from '../utils/credential.js'
import { groupLabel, memberLabel } from '../utils/memberLabel.js'

/** 交付弹框的目标：有明文（刚签发 / 轮换）或只有摘要（列表行）。 */
interface DeliveryTarget {
  owner: string
  secret: string | null
  prefix: string
}

const session = useSessionStore(), admin = useMembersStore()
const search = ref(''), status = ref('')
/** 发放弹框是否打开（表单状态跟着弹框一起销毁重建）。 */
const issueOpen = ref(false)
/** 明文属于谁（姓名 + 分组）。★ 必须在请求**之前**定下来：明文随响应一起到。 */
const issuedFor = ref('')
/** 列表行点开的交付信息（只有摘要提示，没有明文）。 */
const listedTarget = ref<DeliveryTarget | null>(null)
/** 改有效期弹框的目标行（`null` = 关闭）。 */
const expiryTarget = ref<PortalAppKeyEntry | null>(null)
const expiryTtl = ref<ExpiryMode>('permanent')
const expiryCustom = ref<Date | null>(null)
const canIssue = computed(() => session.can('tokens:manage'))
/** 选人需要人员名单；只有 `tokens:manage` 的角色仍能看列表与轮换。 */
const canPick = computed(() => session.can('members:read'))
const candidates = computed(() => admin.members.filter((m) => m.status === 'active'))
/**
 * 弹框目标：**明文优先**。
 *
 * ★ 这样写而不是「签发成功后手动开弹框」，是为了让「store 里有明文」与
 *   「页面上看得见它」成为同一条不变量：明文只随响应来一次，它不可能
 *   静静躺在 store 里没人接手（关掉弹框即 `dismissSecret`，只能轮换）。
 */
const delivery = computed<DeliveryTarget | null>(() => admin.issuedSecret
  ? { owner: issuedFor.value, secret: admin.issuedSecret, prefix: '' }
  : listedTarget.value)

/**
 * 状态只在这里算一次。
 *
 * ⚠️ 「已到期」不是库里的状态：库里只有 active / revoked，到期靠
 *   `expires_at_ms` 与当前时间比较得出。判断分散到模板里就会出现
 *   「列表说有效、操作按钮却点不动」这种自相矛盾的界面。
 */
type KeyState = 'active' | 'revoked' | 'expired'
const STATE_TEXT: Record<KeyState, string> = { active: '有效', revoked: '已吊销', expired: '已到期' }
function keyState(token: PortalReportToken): KeyState {
  if (token.status === 'revoked') return 'revoked'
  return token.expires_at_ms !== null && token.expires_at_ms <= Date.now() ? 'expired' : 'active'
}
/** 「姓名（分组）」与分组拼接都放在 `utils/memberLabel.ts`：发放下拉与这一列必须同一个拼法。 */
/** 表格行键。⚠️ 写在 script 里而不是模板内联箭头函数 —— 模板不认类型注解。 */
const rowKey = (entry: PortalAppKeyEntry): string => entry.token.token_id
/**
 * 表格插槽给的 `row` 是 Element Plus 自己的 `DefaultRow`（`Record<PropertyKey, any>`），
 * 不是本页的契约类型 —— 模板里做不了类型断言，所以入口收 `unknown`、
 * 在这里收窄一次。行的真实形状由 `GET /api/v1/admin/appkeys` 决定。
 */
const rowEntry = (row: unknown): PortalAppKeyEntry => row as PortalAppKeyEntry
const appKeys = computed(() => admin.appKeys.filter((entry) => {
  const keyword = search.value.trim().toLowerCase()
  const matched = !keyword || [entry.member.name, groupLabel(entry.member.groups), entry.token.label, entry.token.token_prefix, entry.member.member_id]
    .join(' ').toLowerCase().includes(keyword)
  return matched && (!status.value || keyState(entry.token) === status.value)
}))
/**
 * 「档位 + 自定义时刻」→ 请求里的 `expires_at_ms` 在 `utils/expiry.ts`：
 * 发放弹框与下面的「设置有效期」问的是同一个问题，换算与校验只留一处。
 */
/** 关闭交付弹框＝放弃这次明文（库里只有摘要，关掉就找不回来）。 */
function closeDelivery(): void {
  listedTarget.value = null
  if (admin.issuedSecret) admin.dismissSecret()
}
function refresh(): void {
  admin.error = null
  void admin.load('members')
  void admin.loadAppKeys()
}
/**
 * 发放（发放弹框提交回这里）。
 *
 * ⚠️ `issuedFor` 必须在请求**之前**定下来：明文随响应一起回来，
 *   交付弹框出现的那一刻就要能写出「使用人」。
 */
async function issue(member: PortalMember, expires: number | null): Promise<void> {
  issuedFor.value = memberLabel(member)
  if (!await admin.appKeyAction(() => api.issueAppKey({ member_id: member.member_id, expires_at_ms: expires }), member.member_id)) return
  // ★ 签发成功 → 收起发放弹框，让位给自动出现的交付弹框（明文只此一次）。
  //   失败时**不**关闭：已选的人与有效期还在，重试不必从头再填一遍。
  issueOpen.value = false
  ElMessage.success(`已为 ${member.name} 生成 appKey，请立即复制`)
}
async function action(entry: PortalAppKeyEntry, kind: 'rotate' | 'revoke'): Promise<void> {
  try {
    await ElMessageBox.confirm(
      kind === 'rotate' ? '旧 appKey 将立即失效，新 appKey 只显示一次。' : '此 appKey 将立即失效，历史用量保留。',
      kind === 'rotate' ? '轮换 appKey' : '吊销 appKey',
      { confirmButtonText: '确认', cancelButtonText: '取消', type: 'warning' },
    )
  } catch { return /* 用户取消。 */ }
  const version = { member_id: entry.member.member_id, token_id: entry.token.token_id, expected_version: entry.token.version }
  if (kind === 'rotate') issuedFor.value = memberLabel(entry.member)
  const ok = await admin.appKeyAction(
    () => kind === 'rotate' ? api.rotateToken(version) : api.revokeToken(version),
    entry.token.token_id,
  )
  if (!ok) return
  if (kind === 'rotate') ElMessage.success(`已为 ${entry.member.name} 轮换 appKey，请立即复制`)
}
/** 打开改有效期弹框。★ 已有的到期时间摆到「自定义」档上，别让人对着档位重猜原值。 */
function openExpiry(entry: PortalAppKeyEntry): void {
  admin.error = null
  expiryTarget.value = entry
  expiryTtl.value = entry.token.expires_at_ms === null ? 'permanent' : 'custom'
  expiryCustom.value = entry.token.expires_at_ms === null ? null : new Date(entry.token.expires_at_ms)
}
async function saveExpiry(): Promise<void> {
  const entry = expiryTarget.value
  if (!entry) return
  const expires = expiryOf(expiryTtl.value, expiryCustom.value)
  if (expires === 'invalid') { ElMessage.warning('自定义到期时间需要晚于当前时间'); return }
  const saved = await admin.mutate(
    () => api.setTokenExpiry({ member_id: entry.member.member_id, token_id: entry.token.token_id, expected_version: entry.token.version, expires_at_ms: expires }),
    entry.token.token_id,
  )
  if (!saved) return
  expiryTarget.value = null
  await admin.loadAppKeys()
  ElMessage.success(expires === null ? '已改为长期有效' : '有效期已更新')
}
onMounted(refresh)
onUnmounted(() => { admin.clear() })
</script>
<template>
  <div class="page-stack">
    <div class="page-heading">
      <div>
        <div class="eyebrow">APP KEY</div>
        <h1>appKey 管理</h1>
        <p>一行一把凭证，标明它发给了谁；权限固定为「上报用量」和「获取统计信息」。</p>
      </div>
      <div class="page-actions">
        <el-button :icon="Refresh" :loading="admin.appKeysLoading" :disabled="!!admin.busyId" @click="refresh">刷新</el-button>
        <!-- ★ 发放收进弹框：它是低频动作，常驻一块卡片会把凭证列表挤到折叠线以下。
             无 `tokens:manage` 时连入口都不给（服务端同样会 403）。 -->
        <el-button v-if="canIssue" type="primary" :icon="Ticket" :disabled="!!admin.busyId" @click="issueOpen = true">发放 appKey</el-button>
      </div>
    </div>
    <el-alert v-if="admin.error" :title="admin.error" type="error" :closable="false" show-icon role="alert" />
    <el-card shadow="never">
      <template #header>
        <div class="panel-heading">
          <div><h2>已发放 appKey</h2><p>完整 appKey 只在签发或轮换成功时出现一次，之后只能轮换一把新的；过期前可以延长有效期。</p></div>
        </div>
      </template>
      <div class="member-filters">
        <el-input v-model="search" :prefix-icon="Search" clearable placeholder="搜索人员、分组或凭证提示" aria-label="搜索 appKey" />
        <el-select v-model="status" clearable placeholder="全部状态" aria-label="筛选凭证状态">
          <el-option value="active" label="有效" /><el-option value="revoked" label="已吊销" /><el-option value="expired" label="已到期" />
        </el-select>
        <span class="muted">共 {{ appKeys.length }} 把</span>
      </div>
      <el-skeleton v-if="admin.appKeysLoading && !admin.appKeys.length" :rows="5" animated />
      <el-table v-else :data="appKeys" :row-key="rowKey" empty-text="还没有发放过 appKey">
        <el-table-column label="发给谁" min-width="170"><template #default="{ row }">
          <div class="member-name"><strong>{{ row.member.name }}</strong><el-tag v-if="row.member.status !== 'active'" type="warning" size="small">已停用</el-tag></div>
          <small class="muted">{{ groupLabel(row.member.groups) || '未分组' }}</small>
        </template></el-table-column>
        <el-table-column label="凭证提示" min-width="140"><template #default="{ row }"><code>{{ tokenHint(row.token.token_prefix) }}</code></template></el-table-column>
        <el-table-column label="状态 / 到期" min-width="150"><template #default="{ row }">{{ STATE_TEXT[keyState(row.token)] }}<br /><small>{{ row.token.expires_at_ms ? formatFullDateTime(row.token.expires_at_ms) : '长期有效' }}</small></template></el-table-column>
        <el-table-column label="签发时间" min-width="150"><template #default="{ row }">{{ formatFullDateTime(row.token.created_at_ms) }}</template></el-table-column>
        <el-table-column label="操作" min-width="260"><template #default="{ row }"><div class="row-actions">
          <!-- 轮换要求凭证仍然可用（服务端拒已到期的轮换：换不出明文就等于白换）；
               而「有效期」与「吊销」对已到期的凭证仍要能点 —— 续期是过期的补救，
               吊销是「别再让它活过来」的唯一手段。 -->
          <el-button link :disabled="!!admin.busyId" @click="listedTarget = { owner: memberLabel(rowEntry(row).member), secret: null, prefix: row.token.token_prefix }">交付信息</el-button>
          <el-button link :disabled="!!admin.busyId || row.token.status === 'revoked'" @click="openExpiry(rowEntry(row))">有效期</el-button>
          <el-button link :disabled="!!admin.busyId || keyState(row.token) !== 'active'" @click="action(rowEntry(row), 'rotate')">轮换</el-button>
          <el-button link type="danger" :disabled="!!admin.busyId || row.token.status === 'revoked'" @click="action(rowEntry(row), 'revoke')">吊销</el-button>
        </div></template></el-table-column>
      </el-table>
    </el-card>
    <!-- ★ 发放弹框：`destroy-on-close` 让「选的人 / 有效期」不跨次残留 ——
         否则上一次给张三选的 90 天会静静等着下一次打开，看起来像默认值。 -->
    <el-dialog v-model="issueOpen" title="发放 appKey" width="min(520px, 94vw)" destroy-on-close :close-on-click-modal="false"
      :show-close="!admin.busyId" :close-on-press-escape="!admin.busyId">
      <IssueAppKeyForm :members="candidates" :can-pick="canPick" :busy="!!admin.busyId" @issue="issue" @cancel="issueOpen = false" />
    </el-dialog>
    <el-dialog :model-value="delivery !== null" title="交付信息" width="min(560px, 94vw)" :close-on-click-modal="false"
      :show-close="!delivery?.secret" :close-on-press-escape="!delivery?.secret" @close="closeDelivery">
      <AppKeyDelivery v-if="delivery" :owner="delivery.owner" :secret="delivery.secret" :prefix="delivery.prefix" @close="closeDelivery" />
    </el-dialog>
    <el-dialog :model-value="expiryTarget !== null" title="设置有效期" width="min(460px, 94vw)" :close-on-click-modal="false" @close="expiryTarget = null">
      <template v-if="expiryTarget">
        <p class="muted delivery-hint">
          凭证提示 <code>{{ tokenHint(expiryTarget.token.token_prefix) }}</code> · 使用人 {{ expiryTarget.member.name }}。
          到期后该 appKey 立即失效（历史用量保留），要继续上报请延长有效期或重新签发。
        </p>
        <div class="member-filters">
          <el-select v-model="expiryTtl" aria-label="新的有效期" :disabled="!!admin.busyId">
            <el-option value="permanent" label="长期有效" />
            <el-option value="30" label="30 天" />
            <el-option value="90" label="90 天" />
            <el-option value="custom" label="自定义到期时间" />
          </el-select>
          <el-date-picker v-if="expiryTtl === 'custom'" v-model="expiryCustom" type="datetime" placeholder="选择到期时间" aria-label="自定义到期时间" :disabled="!!admin.busyId" />
        </div>
        <div class="dialog-actions">
          <el-button @click="expiryTarget = null">取消</el-button>
          <el-button type="primary" :loading="!!admin.busyId" @click="saveExpiry">保存有效期</el-button>
        </div>
      </template>
    </el-dialog>
  </div>
</template>