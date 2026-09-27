<script setup lang="ts">
/**
 * appKey 发放页 —— 按成员签发插件 / CLI 用的上报凭证。
 *
 * ## 为什么单独一页，而不是塞进「人员管理」的凭证弹窗
 *
 * 人员管理那边的凭证弹窗是**通用**凭证工具：权限范围可多选、可改，
 * 面向「这个人需要什么权限」的问题。而 appKey 的语义是**固定的**：
 *
 * | 能力 | 接口 | scope |
 * |---|---|---|
 * | 上报用量 | `POST /api/v1/token-usage` | `usage:write` |
 * | 获取统计信息 | `GET /api/v1/stats/*` | `stats:read` |
 *
 * 它不该有第 3 项，也不该在界面上让人犹豫「勾哪个」。
 *
 * ## ★ 完整 appKey 只显示这一次
 *
 * 服务端只存摘要（`token_hash`），明文仅随签发 / 轮换响应返回 ——
 * 所以这里把「复制」做成页面上的第一动作，而不是让管理员去列表里找。
 * 关掉卡片后就只能轮换一把新的（旧的立即失效）。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { CopyDocument, Refresh, Search, Ticket } from '@element-plus/icons-vue'
import { ElAlert, ElButton, ElCard, ElDialog, ElInput, ElMessage, ElMessageBox, ElSkeleton, ElTable, ElTableColumn } from 'element-plus'
import { APP_KEY_SCOPES, type PortalMember, type PortalReportToken } from '@ai-token-report/shared'
import { useSessionStore } from '../stores/session.js'
import { useMembersStore } from '../stores/members.js'
import * as api from '../api/admin.js'
import { copyText } from '../utils/clipboard.js'
import { formatFullDateTime } from '../utils/format.js'

const session = useSessionStore(), admin = useMembersStore()
const search = ref(''), managed = ref<PortalMember | null>(null), copied = ref(false)
const canIssue = computed(() => session.can('tokens:manage'))
const members = computed(() => admin.members.filter((m) =>
  !search.value.trim() ||
  [m.name, m.department_name, m.member_id].join(' ').toLowerCase().includes(search.value.trim().toLowerCase()),
))
/**
 * 面板里要让使用者知道「插件该填哪个地址」。
 *
 * ⚠️ SSR 下 `location` 不存在，必须判空 —— 渲染脚本会真的执行这个组件。
 *   取不到时留空，由使用者自己填（不猜一个可能错的地址）。
 */
const baseUrl = computed(() => (typeof location === 'undefined' ? '' : location.origin))
/** 固定两项权限的展示文案。键来自 `APP_KEY_SCOPES`，这里只做翻译。 */
const SCOPE_TEXT: Record<string, string> = {
  'usage:write': '上报用量（/api/v1/token-usage）',
  'stats:read': '获取统计信息（/api/v1/stats/*）',
}
const scopeLabel = (scope: string): string => SCOPE_TEXT[scope] ?? scope

async function issue(member: PortalMember): Promise<void> {
  copied.value = false
  // ★ 先取一次该成员的凭证：签发成功的明文只在这一次响应里，Store 靠
  //   `tokenMemberId` 判断「这份秘密属于谁」，不设它就会当场丢掉明文。
  await admin.loadTokens(member.member_id)
  if (await admin.tokenAction(() => api.issueAppKey({ member_id: member.member_id }), member.member_id))
    ElMessage.success(`已为 ${member.name} 生成 appKey，请立即复制`)
}
async function copy(): Promise<void> {
  if (!admin.issuedSecret) return
  const ok = await copyText(admin.issuedSecret, 'issued-appkey')
  copied.value = ok
  ElMessage({ type: ok ? 'success' : 'info', message: ok ? 'appKey 已复制' : '已选中 appKey，请按 Ctrl+C 复制' })
}
async function manage(member: PortalMember): Promise<void> {
  managed.value = member
  await admin.loadTokens(member.member_id)
}
async function action(token: PortalReportToken, kind: 'rotate' | 'revoke'): Promise<void> {
  const member = managed.value
  if (!member) return
  try {
    await ElMessageBox.confirm(
      kind === 'rotate' ? '旧 appKey 将立即失效，新 appKey 只显示一次。' : '此 appKey 将立即失效，历史用量保留。',
      kind === 'rotate' ? '轮换 appKey' : '吊销 appKey',
      { confirmButtonText: '确认', cancelButtonText: '取消', type: 'warning' },
    )
    const version = { member_id: member.member_id, token_id: token.token_id, expected_version: token.version }
    await admin.tokenAction(() => kind === 'rotate' ? api.rotateToken(version) : api.revokeToken(version), member.member_id)
  } catch { /* 用户取消。 */ }
}
onMounted(() => { void admin.load('members') })
onUnmounted(() => { admin.clear() })
</script>
<template>
  <div class="page-stack">
    <div class="page-heading">
      <div>
        <div class="eyebrow">APP KEY</div>
        <h1>appKey 发放</h1>
        <p>为每位成员生成上报用的 appKey，权限固定为「上报用量」和「获取统计信息」。</p>
      </div>
      <el-button :icon="Refresh" :loading="admin.loading" :disabled="!!admin.busyId" @click="admin.error = null; admin.load()">刷新</el-button>
    </div>
    <el-alert v-if="admin.error" :title="admin.error" type="error" :closable="false" show-icon role="alert" />
    <el-alert type="info" :closable="false" show-icon
      title="appKey 的权限只有两项"
      :description="`上报用量与获取统计信息（${APP_KEY_SCOPES.join(' + ')}）。不能进入管理页面、不能签发凭证。`" />
    <div v-if="admin.issuedSecret" class="issued-card">
      <el-alert type="warning" :closable="false" show-icon title="请现在保存：完整 appKey 只显示这一次，关闭后无法找回，只能轮换。" />
      <div class="issued-row">
        <code id="issued-appkey">{{ admin.issuedSecret }}</code>
        <el-button type="primary" :icon="CopyDocument" @click="copy">{{ copied ? '再复制一次' : '复制 appKey' }}</el-button>
        <el-button @click="admin.dismissSecret">已保存，收起</el-button>
      </div>
      <p class="issued-hint">
        在 DSH 插件的「上报连接」或本地页面里填写：服务端地址
        <code>{{ baseUrl || '（你的平台地址）' }}</code>、appKey 粘贴上面这串。
      </p>
    </div>
    <el-card shadow="never">
      <template #header>
        <div class="panel-heading">
          <div><h2>成员列表</h2><p>appKey 绑定到成员本人：看板上的归属由服务端按 appKey 解析，客户端自称无效。</p></div>
        </div>
      </template>
      <div class="member-filters">
        <el-input v-model="search" :prefix-icon="Search" clearable placeholder="搜索姓名、部门或 ID" aria-label="搜索成员" />
        <span class="muted">共 {{ members.length }} 人</span>
      </div>
      <el-skeleton v-if="admin.loading && !admin.members.length" :rows="5" animated />
      <el-table v-else :data="members" row-key="member_id" empty-text="还没有成员">
        <el-table-column prop="name" label="姓名" min-width="120" />
        <el-table-column label="部门" min-width="140"><template #default="{ row }">{{ row.department_name ?? '—' }}</template></el-table-column>
        <el-table-column label="状态" min-width="90"><template #default="{ row }">{{ row.status === 'active' ? '在职' : row.status === 'disabled' ? '已停用' : '已归档' }}</template></el-table-column>
        <el-table-column label="有效凭证" min-width="100"><template #default="{ row }">{{ row.active_token_count }} 个</template></el-table-column>
        <el-table-column label="操作" min-width="200">
          <template #default="{ row }">
            <el-button type="primary" link :icon="Ticket" :disabled="!canIssue || !!admin.busyId || row.status !== 'active'" @click="issue(row)">发放 appKey</el-button>
            <el-button link :disabled="!!admin.busyId" @click="manage(row)">已有凭证</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>
    <el-dialog :model-value="managed !== null" :title="'已有凭证 · ' + (managed?.name ?? '')" width="min(860px, 96vw)" destroy-on-close :close-on-click-modal="false" @close="managed = null; admin.closeTokens()">
      <el-alert v-if="admin.error" :title="admin.error" type="error" :closable="false" />
      <p class="muted">轮换 / 吊销随时可用；完整 appKey 只在签发或轮换成功时显示一次。</p>
      <el-table :data="admin.tokens" row-key="token_id" empty-text="尚未签发凭证">
        <el-table-column prop="label" label="用途" min-width="120" />
        <el-table-column prop="token_prefix" label="凭证提示" min-width="120" />
        <el-table-column label="权限" min-width="230"><template #default="{ row }"><span class="scope-text">{{ row.scopes.map(scopeLabel).join('、') }}</span></template></el-table-column>
        <el-table-column label="状态 / 到期" min-width="150"><template #default="{ row }">{{ row.status === 'revoked' ? '已吊销' : row.expires_at_ms && row.expires_at_ms <= Date.now() ? '已到期' : '有效' }}<br /><small>{{ row.expires_at_ms ? formatFullDateTime(row.expires_at_ms) : '长期有效' }}</small></template></el-table-column>
        <el-table-column label="操作" min-width="140"><template #default="{ row }"><el-button link :disabled="!!admin.busyId || row.status !== 'active'" @click="action(row, 'rotate')">轮换</el-button><el-button link type="danger" :disabled="!!admin.busyId || row.status !== 'active'" @click="action(row, 'revoke')">吊销</el-button></template></el-table-column>
      </el-table>
    </el-dialog>
  </div>
</template>