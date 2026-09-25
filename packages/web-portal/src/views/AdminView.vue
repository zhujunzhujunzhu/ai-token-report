<script setup lang="ts">
/** 人员管理独立装载，普通成员不会触发名单或凭证请求。 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { Plus, Refresh, Search } from '@element-plus/icons-vue'
import {
  ElMessage,
  ElAlert,
  ElButton,
  ElCard,
  ElCollapse,
  ElCollapseItem,
  ElDialog,
  ElInput,
  ElOption,
  ElResult,
  ElSelect,
  ElSkeleton,
} from 'element-plus'
import type {
  AdminIssueMemberRequest,
  AdminLoginAccountRequest,
  AdminMember,
} from '@ai-token-report/shared'
import { useSessionStore } from '../stores/session.js'
import { useMembersStore } from '../stores/members.js'
import IssueMemberForm from '../components/IssueMemberForm.vue'
import MemberTable from '../components/MemberTable.vue'
import LoginAccountForm from '../components/LoginAccountForm.vue'
import { copyText } from '../utils/clipboard.js'
const session = useSessionStore()
const admin = useMembersStore()
const search = ref('')
const role = ref('')
const showIssue = ref(false)
const loginMember = ref<AdminMember | null>(null)
const showLogin = ref(false)
function editLogin(member: AdminMember): void {
  loginMember.value = member
  showLogin.value = true
  admin.error = null
}
async function saveLogin(input: AdminLoginAccountRequest): Promise<void> {
  const isSelf = loginMember.value?.name === session.identity?.name
  if (await admin.setLogin(input)) {
    showLogin.value = false
    loginMember.value = null
    ElMessage.success('登录账号已保存，原登录会话已失效')
    if (isSelf) session.expire('密码已更新，请使用新密码登录')
  }
}
const members = computed(() =>
  admin.members.filter(
    (m) =>
      (!role.value || m.role === role.value) &&
      (!search.value.trim() ||
        (m.name + ' ' + (m.dept ?? ''))
          .toLowerCase()
          .includes(search.value.trim().toLowerCase())),
  ),
)
const adminCount = computed(
  () => admin.members.filter((m) => m.role === 'admin').length,
)
const blocked = computed(
  () => !admin.writable || admin.loading || admin.issuing || !!admin.busyToken,
)
onMounted(() => {
  void admin.load()
})
onUnmounted(() => {
  admin.clear()
})
async function issue(input: AdminIssueMemberRequest): Promise<void> {
  if (await admin.issue(input)) {
    showIssue.value = false
    if (admin.justIssued) editLogin(admin.justIssued)
  }
}
async function copyIssued(): Promise<void> {
  if (!admin.justIssued) return
  const ok = await copyText(admin.justIssued.token, 'issued-token')
  ElMessage({
    type: ok ? 'success' : 'info',
    message: ok ? 'Token 已复制' : '已选中 Token，请按 Ctrl+C 复制',
  })
}
</script>
<template>
  <div class="page-stack">
    <div class="page-heading">
      <div>
        <div class="eyebrow">TEAM MANAGEMENT</div>
        <h1>人员管理</h1>
        <p>管理团队成员、访问角色与身份凭证。</p>
      </div>
      <el-button
        type="primary"
        :icon="Plus"
        :disabled="blocked || !!admin.forbidden"
        @click="showIssue = true"
        >添加成员</el-button
      >
    </div>
    <el-result
      v-if="admin.forbidden"
      icon="warning"
      title="没有管理权限"
      :sub-title="admin.forbidden"
      ><template #extra
        ><router-link to="/overview"
          ><el-button type="primary">返回总览</el-button></router-link
        ></template
      ></el-result
    >
    <template v-else>
      <div class="member-summary">
        <el-card shadow="never"
          ><span>团队成员</span
          ><strong>{{ admin.members.length }}<small>人</small></strong></el-card
        ><el-card shadow="never"
          ><span>管理员</span
          ><strong>{{ adminCount }}<small>人</small></strong></el-card
        ><el-card shadow="never"
          ><span>凭证状态</span
          ><strong class="storage-status">{{
            admin.loading ? '加载中' : admin.writable ? '可维护' : '暂不可写'
          }}</strong></el-card
        >
      </div>
      <el-alert
        v-if="!admin.writable && !admin.loading"
        :title="
          admin.writeBlockedReason ||
          '当前凭证暂不可修改，请刷新或联系部署管理员。'
        "
        type="warning"
        :closable="false"
        show-icon
      />
      <el-alert
        v-if="admin.error"
        :title="admin.error"
        type="error"
        :closable="false"
        show-icon
        role="alert"
      />
      <el-card v-if="admin.justIssued" class="issued-card" shadow="never"
        ><div class="panel-heading">
          <div>
            <h2>{{ admin.justIssued.name }} 的新 Token 已就绪</h2>
            <p>请复制并交给本人，在本地页或插件填写。</p>
          </div>
          <el-button text @click="admin.dismissIssued">收起</el-button>
        </div>
        <div class="issued-row">
          <code id="issued-token">{{ admin.justIssued.token }}</code
          ><el-button type="primary" @click="copyIssued">复制 Token</el-button>
        </div></el-card
      >
      <el-card shadow="never"
        ><template #header
          ><div class="panel-heading">
            <div>
              <h2>人员列表</h2>
              <p>凭证变更立即生效，历史用量记录保留。</p>
            </div>
            <el-button
              :icon="Refresh"
              :loading="admin.loading"
              :disabled="!!admin.busyToken || admin.issuing"
              @click="admin.load"
              >刷新</el-button
            >
          </div></template
        >
        <div class="member-filters">
          <el-input
            v-model="search"
            :prefix-icon="Search"
            clearable
            placeholder="搜索姓名或部门"
            aria-label="搜索成员"
          /><el-select
            v-model="role"
            clearable
            placeholder="全部角色"
            aria-label="筛选角色"
            ><el-option label="管理员" value="admin" /><el-option
              label="普通成员"
              value="member" /></el-select
          ><span class="muted">共 {{ members.length }} 人</span>
        </div>
        <el-skeleton
          v-if="admin.loading && !admin.members.length"
          :rows="5"
          animated
        />
        <MemberTable
          v-else
          :members="members"
          :admin-count="adminCount"
          :busy-token="admin.busyToken"
          :writable="admin.writable"
          :disabled="admin.issuing || admin.loading"
          :current-name="session.identity?.name ?? null"
          @login="editLogin"
          @rotate="admin.rotate"
          @revoke="admin.revoke"
          @update-role="admin.updateRole"
        />
      </el-card>
      <el-collapse class="storage-info"
        ><el-collapse-item title="凭证存储与维护说明" name="storage"
          ><p>
            凭证文件：<code>{{ admin.credentialsPath || '暂未获取' }}</code>
          </p>
          <p>
            环境变量凭证在部署配置中维护；当前登录账号请由其他管理员维护。最后一个管理员不能降级或吊销。
          </p>
          <p>
            姓名用于用量归属，同名会被并成一个人，请使用可区分的姓名。
          </p></el-collapse-item
        ></el-collapse
      >
    </template>
    <el-dialog
      v-model="showLogin"
      :title="'设置登录 · ' + (loginMember?.name ?? '')"
      width="min(480px, 94vw)"
      destroy-on-close
      :close-on-click-modal="false"
      :show-close="!admin.busyToken"
      :close-on-press-escape="!admin.busyToken"
    >
      <el-alert
        v-if="admin.error"
        :title="admin.error"
        type="error"
        :closable="false"
        class="form-error"
      />
      <LoginAccountForm
        v-if="loginMember"
        :member="loginMember"
        :busy="!!admin.busyToken"
        @save="saveLogin"
        @cancel="showLogin = false"
      />
    </el-dialog>
    <el-dialog
      v-model="showIssue"
      title="添加团队成员"
      width="min(480px, 94vw)"
      destroy-on-close
      :close-on-click-modal="false"
      :close-on-press-escape="!admin.issuing"
      :show-close="!admin.issuing"
    >
      <el-alert
        v-if="admin.error"
        :title="admin.error"
        type="error"
        :closable="false"
        show-icon
        class="form-error"
      />
      <IssueMemberForm
        :disabled="!admin.writable"
        :busy="admin.issuing"
        @issue="issue"
        @cancel="showIssue = false"
      />
    </el-dialog>
  </div>
</template>
