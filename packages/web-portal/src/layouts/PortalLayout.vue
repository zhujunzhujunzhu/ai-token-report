<script setup lang="ts">
/** 后台公共外壳：身份导航与窄屏抽屉，业务页面独立装载。 */
import {
  ElAvatar,
  ElMessage,
  ElBreadcrumb,
  ElBreadcrumbItem,
  ElButton,
  ElDropdown,
  ElDropdownItem,
  ElDropdownMenu,
  ElIcon,
  ElMenu,
  ElMenuItem,
} from 'element-plus'
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  DataAnalysis,
  DataLine,
  Document,
  FirstAidKit,
  User,
  Fold,
  Expand,
  ArrowDown,
  SwitchButton,
} from '@element-plus/icons-vue'
import { useSessionStore } from '../stores/session.js'
const session = useSessionStore()
const route = useRoute()
const router = useRouter()
const mobileOpen = ref(false)
const collapsed = ref(false)
const navigation = computed(() => [
  { path: '/overview', label: '用量总览', icon: DataAnalysis },
  { path: '/analysis', label: '用量分析', icon: DataLine },
  { path: '/records', label: '调用明细', icon: Document },
  { path: '/diagnostics', label: '采集诊断', icon: FirstAidKit },
  ...(session.isAdmin
    ? [{ path: '/members', label: '人员管理', icon: User }]
    : []),
])
watch(
  () => route.path,
  () => {
    mobileOpen.value = false
  },
)
watch(
  () => session.signedIn,
  (value) => {
    if (!value) void router.replace('/login')
  },
)
async function signOut(): Promise<void> {
  if (await session.signOut()) await router.replace('/login')
  else ElMessage.error(session.error ?? '退出失败，请重试')
}
</script>
<template>
  <div
    v-if="session.signedIn"
    class="portal-layout"
    :class="{ 'is-collapsed': collapsed }"
  >
    <button
      v-if="mobileOpen"
      class="sidebar-backdrop"
      aria-label="关闭导航"
      @click="mobileOpen = false"
    />
    <aside class="portal-sidebar" :class="{ 'is-mobile-open': mobileOpen }">
      <router-link to="/overview" class="brand" aria-label="DSH Token 用量总览">
        <span class="brand-mark"
          ><el-icon><DataAnalysis /></el-icon
        ></span>
        <span class="brand-copy"
          ><strong>DSH <span>Token</span></strong
          ><small>团队用量管理平台</small></span
        >
      </router-link>
      <div class="nav-caption">工作空间</div>
      <el-menu
        :default-active="route.path"
        :collapse="collapsed && !mobileOpen"
        :collapse-transition="false"
        router
        class="portal-menu"
      >
        <el-menu-item
          v-for="item in navigation"
          :key="item.path"
          :index="item.path"
        >
          <el-icon><component :is="item.icon" /></el-icon
          ><template #title>{{ item.label }}</template>
        </el-menu-item>
      </el-menu>
      <div class="sidebar-note">
        <span class="status-dot" /><span>只记录用量，保护对话隐私</span>
      </div>
      <button
        class="sidebar-collapse"
        :aria-label="collapsed ? '展开侧栏' : '收起侧栏'"
        @click="collapsed = !collapsed"
      >
        <el-icon><Expand v-if="collapsed" /><Fold v-else /></el-icon
        ><span v-if="!collapsed">收起导航</span>
      </button>
    </aside>
    <div class="portal-workspace">
      <header class="portal-header">
        <el-button
          class="mobile-menu-button"
          text
          aria-label="打开导航"
          @click="mobileOpen = true"
          ><el-icon><Expand /></el-icon
        ></el-button>
        <el-breadcrumb separator="/"
          ><el-breadcrumb-item>工作空间</el-breadcrumb-item
          ><el-breadcrumb-item>{{
            route.meta.title
          }}</el-breadcrumb-item></el-breadcrumb
        >
        <div class="header-right">
          <span class="workspace-label">{{
            session.identity?.dept || '部门工作空间'
          }}</span>
          <el-dropdown trigger="click" @command="signOut"
            ><button class="identity-menu" aria-label="账号菜单">
              <el-avatar :size="34">{{
                session.identity?.name.slice(0, 1)
              }}</el-avatar
              ><span class="identity-copy"
                ><strong>{{ session.identity?.name }}</strong
                ><small>{{
                  session.isAdmin ? '管理员' : '普通成员'
                }}</small></span
              ><el-icon><ArrowDown /></el-icon>
            </button>
            <template #dropdown
              ><el-dropdown-menu
                ><el-dropdown-item command="logout" :icon="SwitchButton"
                  >退出登录</el-dropdown-item
                ></el-dropdown-menu
              ></template
            >
          </el-dropdown>
        </div>
      </header>
      <main id="main-content" class="portal-content"><router-view /></main>
      <footer class="portal-footer">
        DSH Token <span>·</span> 让每一次 AI 使用清晰可见
      </footer>
    </div>
  </div>
</template>
