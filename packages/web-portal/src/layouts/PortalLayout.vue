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
  Key,
  Ticket,
  OfficeBuilding,
  Connection,
  // ★ 项目归一化用 `FolderOpened`（它配的是**目录前缀**），与供应商的
  //   `Connection` 分开：两页的配置面长得一样，但匹配语义刻意不同
  //   （精确 vs 前缀），图标相同会让人以为可以照搬供应商那套理解。
  //   单价的 `Money` 又是另一族 —— 它改的是钱怎么算。
  FolderOpened,
  // ★ 单价的图标刻意用 `Money`：这一页改的是**钱怎么算**，
  //   而它旁边的「供应商归一化」改的是名字怎么显示 —— 两者不该看起来同族。
  Money,
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
  ...(session.can('members:read')
    ? [{ path: '/members', label: '人员管理', icon: User }]
    : []),
  // ★ 与人员管理**不共用**读权限：这一页的主体是凭证列表（含凭证提示与
  //   权限范围）。能读人员名单的人未必该知道谁手里有哪些凭证。
  ...(session.can('tokens:manage')
    ? [{ path: '/appkeys', label: 'appKey 管理', icon: Ticket }]
    : []),
  ...(session.can('roles:read')
    ? [{ path: '/roles', label: '角色管理', icon: Key }]
    : []),
  ...(session.can('groups:manage')
    ? [{ path: '/groups', label: '分组管理', icon: OfficeBuilding }]
    : []),
  // ★ 归一化改的是「按供应商 / 模型看用量」的口径，与分组管理是两件事，
  //   所以不共用权限：能管分组的人不一定该改全平台的供应商与模型口径。
  ...(session.can('providers:read')
    ? [{ path: '/providers', label: '供应商模型归一化', icon: Connection }]
    : []),
  // ★ 项目归一化与供应商归一化是**两件独立的事**，权限也各管各的：
  //   能改供应商口径的人不一定该改项目口径（反之亦然）。
  ...(session.can('projects:read')
    ? [{ path: '/projects', label: '项目归一化', icon: FolderOpened }]
    : []),
  // ★ 单价决定**每一笔费用怎么算**，是配置而不是「看一眼的数字」，
  //   所以读也要求 `pricing:manage`：能看金额的人（`cost:read`）不必能改计价，
  //   两者的误操作代价完全不同（「看错一个数」vs「把全平台计价改掉」）。
  ...(session.can('pricing:manage')
    ? [{ path: '/pricing', label: '模型单价', icon: Money }]
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
      <router-link to="/overview" class="brand" aria-label="AI Token 用量总览">
        <span class="brand-mark"
          ><el-icon><DataAnalysis /></el-icon
        ></span>
        <span class="brand-copy"
          ><strong>AI <span>Token</span></strong
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
          <el-dropdown trigger="click" @command="signOut"
            ><button class="identity-menu" aria-label="账号菜单">
              <el-avatar :size="34">{{
                session.identity?.name.slice(0, 1)
              }}</el-avatar
              ><!--
                ★ 标签跟着**数据范围**走（内置管理员角色），而不是跟着
                  `members:read`：写着「管理员」却只看得到自己的数字，会让人
                  以为看板坏了。两者的区别见 `stores/session.ts` 的注释。
              --><span class="identity-copy"
                ><strong>{{ session.identity?.name }}</strong
                ><small>{{
                  session.scopedToSelf ? '普通成员' : '管理员'
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
        AI Token <span>·</span> 让每一次 AI 使用清晰可见
      </footer>
    </div>
  </div>
</template>
