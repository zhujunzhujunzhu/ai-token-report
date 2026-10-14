<script setup lang="ts">
/**
 * 项目归一化规则（v11）。
 *
 * ★ 这一页配的是**看口径**，不是数据：`usage_event.cwd` 永远是上报当时的原值，
 *   规则只决定「按项目分组时用哪个名字」。所以：
 *
 * - 改一条规则**立刻**在看板的项目分布里生效，历史数据不需要回填；
 * - 配错了把规则删掉就回到原状（停用是更轻的一档：规则还在，只是不参与归一化）；
 * - 没有配规则的目录**回到旧口径**（目录最后一段，`D:\a\proj\packages\core` → `core`）
 *   —— 归一化不是「统一改名」，是「把散开的几行折回一个项目」。
 *
 * ## ★ 列表的主体是「项目」，不是「规则」
 *
 * 同一个项目在线上通常是 3~6 条规则（换盘 / 换父目录 / 盘符大小写各一条），
 * 平铺时那 6 行看起来像 6 份不同的配置。所以这一页**一个项目一行**：
 * 行上给的是摘要（几条规则、几条路径、哪些人 / 全局），点开才逐条列规则与操作。
 * 折叠的判断（计数、去重、组内顺序）都在 `projectsModel.ts` 里，由 `bun test` 钉住。
 *
 * ## ⚠️ 与「供应商归一化」刻意不同的两点，页面必须说清
 *
 * | | 供应商归一化 | 项目归一化（本页） |
 * |---|---|---|
 * | 匹配 | 原始名**精确**（一字不差） | 原始 cwd 的**仓库名**（任一路径段）或**路径前缀** |
 * | 多条命中 | 同一原始名只有一条规则 | **路径前缀规则优先**；同类型内最具体者胜出 |
 *
 * ## 为什么这一页主推「填仓库名」而不是「填完整路径」
 *
 * 路径前缀模式下同一个仓库要**每种位置各配一条**：换盘、换父目录、换盘符大小写
 * （不同客户端写 `cwd` 的方式不同）。线上实测一个仓库要 3~6 条，漏掉一个变体就
 * **静默不命中**（页面上完全看不出来，只表现为「那个项目用量偏小」）。
 * 填仓库名把这三类差异一次消掉：一条规则管所有位置。
 *
 * ## 为什么项目名要能「带过来」再新增路径
 *
 * 项目名是**自由文本**，而分组键就是它的**逐字取值**（见 `projectsModel.ts`）：
 * 手抄一遍差一个空格，看板上就多出一个项目，而页面上只表现为「怎么多了一行」。
 * 所以每一行都提供「添加路径」，把这一行的项目名原样带进表单。
 *
 * ## 为什么匹配值要「选」而不是「填」
 *
 * 匹配值是这一页最容易配错的东西：敲错一个字符（或大小写不同）＝ 规则
 * **静默不命中**，而页面上完全看不出来。所以输入框是一个
 * **可搜索的下拉**，候选项来自 `/api/v1/stats/projects`（库里真实出现过的 cwd）；
 * 也允许自己敲（那个接口需要 `stats:read`，拿不到就只剩手填，表单里会说明）。
 *
 * ## ★ 为什么那份候选**不在打开页面时取**（2026-10-13 的卡顿修复）
 *
 * 它回的是 `usage_event.cwd` 的**全表去重清单**（`cwd` 是 `TEXT`、没有索引），
 * 线上实测 **692ms / 51KB**（50.4 万行），而这一页真正要显示的规则列表只有
 * **37ms / 25KB**。以前它和列表、名册一起 `Promise.all`，于是首帧和每次
 * 「刷新 / 保存 / 删规则」后的重取都被一份「下拉里的可选值」拖住半秒以上。
 *
 * 现在它（以及同样只服务表单的人员名册）只在**打开表单**时才读，读过就留在
 * 本次页面驻留期内复用；点「刷新」时才顺手重取一次。列表因此只剩一个请求。
 *
 * 🚨 归一化按**查看者**生效：全局规则对所有人生效；人员规则只对那个人生效。
 *   同一条目录上前者被后者压住（跨作用范围时仍然是**更具体者**优先）。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { useAssistantPageSearch } from '../utils/assistantPageSearch.js'
import { useAssistantForm, assistantFormEntry, assertAssistantFormIdentity } from '../utils/assistantForms.js'
import { Delete, Plus, Refresh, Search } from '@element-plus/icons-vue'
import {
  ElAlert, ElButton, ElCard, ElDialog, ElForm, ElFormItem, ElInput,
  ElMessage, ElMessageBox, ElOption, ElSelect, ElSkeleton, ElTable, ElTableColumn, ElTag,
} from 'element-plus'
import type { FormInstance, FormRules } from 'element-plus'
import type { AssistantFormValues, PortalMember, PortalProjectAlias } from '@ai-token-report/shared'
import { fetchMembers } from '../api/admin.js'
import * as api from '../api/admin.js'
import { fetchProjectCwds } from '../api/portal.js'
import { useSessionStore } from '../stores/session.js'
import { formatFullDateTime } from '../utils/format.js'
import { groupProjectRules, projectGroupRowKey, type ProjectRuleGroup } from './projectsModel.js'

const session = useSessionStore()
const aliases = ref<PortalProjectAlias[]>([])
const people = ref<PortalMember[]>([])
/**
 * 库里出现过的原始目录（**只是候选项**，不是「已配置的目录」）。
 *
 * ⚠️ 它是空的两种含义完全不同：`catalogLoaded` 为假 = 没拿到（缺 `stats:read`
 *   或接口失败），为真且为空 = 库里确实还没有任何 cwd。表单里的文案据此分叉 ——
 *   把「读不到」说成「没有目录」会让使用者去查一个不存在的采集问题。
 */
const cwds = ref<string[]>([])
const catalogLoaded = ref(false)
/** 正在读候选（只影响表单里那句提示，不影响列表）。 */
const catalogLoading = ref(false)
/**
 * 人员名册（表单里那个「成员」下拉）与它对应的两个状态。
 *
 * ⚠️ 与目录候选同样**只在打开表单时才读**：列表上的人名来自规则行自带的
 *   `member_name`（服务端返回时已经带上），这一页不需要名册就能画完表格。
 */
const rosterLoaded = ref(false)
const rosterLoading = ref(false)
const loading = ref(false)
const busy = ref(false)
const error = ref<string | null>(null)
const search = useAssistantPageSearch(() => { void load() }, () => loading.value)
const scopeFilter = ref('')
const showForm = ref(false)
const selected = ref<PortalProjectAlias | null>(null)
const form = ref<FormInstance>()
const draft = reactive({ scope: 'global' as 'global' | 'member', member_id: '', prefix: '', alias: '' })

const canManage = computed(() => session.can('projects:manage'))
/** 列表主体：一行 = 一个归一化后的项目（折叠与筛选规则全在 `projectsModel.ts`）。 */
const groups = computed(() => groupProjectRules(aliases.value, { search: search.value, scope: scopeFilter.value }))
/**
 * 列表上**真正显示**的规则条数。
 *
 * ⚠️ 刻意不复用「命中的条数」：关键字命中一条规则时整个项目都会展开（见
 *   `groupProjectRules`），所以显示的条数会比命中的多 —— 计数若按命中算，
 *   使用者会看到「3 条规则」却能数出 6 行，然后去查一个不存在的 bug。
 *   筛选逻辑只此一处（一个 `filter` 谓词 + 一次分组），页面不再自己算一遍。
 */
const shownRules = computed(() => groups.value.reduce((total, group) => total + group.ruleCount, 0))
/**
 * 已展开的项目行。
 *
 * ★ 用受控的 `expand-row-keys` 而不是让表格自己记：这样「全部展开 / 全部收起」
 *   与逐行点开共用同一份状态 —— 否则按钮只能靠重新挂载表格（`:key`）来强制展开，
 *   点一下就把滚动位置和排序一起丢掉。
 */
const expandedKeys = ref<string[]>([])
const allExpanded = computed(() => groups.value.length > 0 && expandedKeys.value.length >= groups.value.length)
/** 汇总列最多列几个人名：成员多的项目会把这一列撑成一屏，其余折成「等 N 人」。 */
const VISIBLE_MEMBERS = 4
const visibleMembers = (group: ProjectRuleGroup) => group.members.slice(0, VISIBLE_MEMBERS)
/**
 * 行插槽给的 `row` 是 Element Plus 自己的 `DefaultRow`（`Record<PropertyKey, any>`），
 * 不是本页的契约类型，而模板里做不了类型断言 —— 所以入口收 `unknown`、在这里收窄一次。
 */
const asGroup = (row: unknown): ProjectRuleGroup => row as ProjectRuleGroup
const rules: FormRules = {
  prefix: [{ required: true, message: '请填写要归一化的目录前缀', trigger: 'blur' }],
  alias: [{ required: true, message: '请填写归一化后的项目名', trigger: 'blur' }],
}

/**
 * 取列表（规则本身）。
 *
 * ## ★ 候选（目录 / 人员名册）**不在这里取** —— 这是这一页首帧的唯一大头
 *
 * `/api/v1/stats/projects` 回的是 `usage_event.cwd` 的**全表去重清单**，而 `cwd`
 * 是 `TEXT` 且没有索引：线上实测（2026-10-13，50.4 万行）SQL 中位 **774ms**、
 * 接口中位 **692ms / 51KB**，而同屏的规则列表只有 **37ms / 25KB**。
 * 以前三者 `Promise.all` 一起等，于是**首帧、以及每次「刷新 / 保存 / 删规则」后的
 * 重取**都被那一份「下拉里的候选」拖住半秒以上（服务端并发争抢时更长）。
 *
 * 候选只影响「填起来方不方便」，所以改成**打开表单时才读**（`ensureCatalog()` /
 * `ensureRoster()`），列表不再等它。已经读过的那份留在本次页面驻留期内复用 ——
 * 点「刷新」时才顺手重取一次（见下）。
 */
async function load(): Promise<void> {
  if (loading.value) return
  loading.value = true
  error.value = null
  const list = await api.fetchProjectAliases()
  // ⚠️ 判空顺序是 `!ok` 在前：`ApiResult` 是**判别联合**，`status` / `error`
  //   只存在于失败那一支，先读字段是取不到的（`ProvidersView.vue` 里就是这么写错的）。
  if (!list.ok) {
    if (list.status === 401) { session.expire('登录已失效，请重新登录'); loading.value = false; return }
    error.value = list.error
  } else aliases.value = list.data.aliases
  loading.value = false
  // ★ 「刷新」是使用者明确要求的一份新数据，所以**已经读过**的候选也重取一遍；
  //   没读过就不取（那正是上面要避免的那次全表扫）。两处都不阻塞列表：
  //   候选迟到只表现为下拉里晚几百毫秒有值，而列表已经画完了。
  if (catalogLoaded.value) void ensureCatalog(true)
  if (rosterLoaded.value) void ensureRoster(true)
}

/**
 * 目录候选（`GET /api/v1/stats/projects`）—— 用到时才读，读过就复用。
 *
 * ⚠️ 失败**不写 `catalogLoaded`**：它是空的两种含义完全不同（「没读到」与
 *   「库里确实还没有目录」），表单里的文案据此分叉（见 `cwds` 上的说明）。
 *   `force` 来自「刷新」按钮与返回值仍为 `catalogLoaded` 的后续调用。
 */
async function ensureCatalog(force = false): Promise<void> {
  if (catalogLoading.value || (catalogLoaded.value && !force)) return
  // 缺 `stats:read` 时**不打这个请求**：打过去只会拿到 403，而表单里那句
  // 「读不到目录候选（需要 stats:read）」才是使用者要的答案。
  if (!session.can('stats:read')) return
  catalogLoading.value = true
  const catalog = await fetchProjectCwds()
  catalogLoading.value = false
  if (!catalog.ok) {
    if (catalog.status === 401) { session.expire('登录已失效，请重新登录'); return }
    return
  }
  cwds.value = catalog.data.projects
  catalogLoaded.value = true
}

/** 人员名册 —— 与目录候选同一形态：只在打开表单时读，读过就复用。 */
async function ensureRoster(force = false): Promise<void> {
  if (rosterLoading.value || (rosterLoaded.value && !force)) return
  if (!session.can('members:read')) return
  rosterLoading.value = true
  const roster = await fetchMembers()
  rosterLoading.value = false
  if (!roster.ok) {
    if (roster.status === 401) { session.expire('登录已失效，请重新登录'); return }
    return
  }
  people.value = roster.data.members
  rosterLoaded.value = true
}

/** 展开 / 收起一行。 */
function onExpandChange(_row: unknown, expanded: unknown): void {
  // ⚠️ `type="expand"` 的列，`expand-change` 的第二参是**当前已展开的行数组**
  //   （树形表格才是布尔值）—— 所以这里只认数组形态，两种写法都不必特判。
  expandedKeys.value = Array.isArray(expanded)
    ? expanded.map((item) => projectGroupRowKey(item as ProjectRuleGroup))
    : []
}

function toggleExpandAll(): void {
  expandedKeys.value = allExpanded.value ? [] : groups.value.map(projectGroupRowKey)
}

function open(entry: PortalProjectAlias | null = null): void {
  selected.value = entry
  draft.scope = entry?.scope ?? 'global'
  draft.member_id = entry?.member_id ?? ''
  draft.prefix = entry?.prefix ?? ''
  draft.alias = entry?.alias ?? ''
  error.value = null
  showForm.value = true
  // ★ 表单要用的两份候选在这里才去读（读过就复用，见 `load()` 上的说明）。
  //   不 await：弹框立刻出现，下拉里的值晚到几百毫秒不影响已经能敲字。
  void ensureRoster()
  void ensureCatalog()
}

/**
 * 「给这个项目再加一条路径」：项目名原样带进表单。
 *
 * ★ 带过来的是**这一行显示的那个字符串**（不带 trim、不改大小写），因为分组键就是它 ——
 *   使用者照着屏幕重打一遍，差一个字符就会变成另一个项目。
 */
function openForProject(group: ProjectRuleGroup): void {
  open()
  draft.alias = group.alias
}

async function save(): Promise<void> {
  if (busy.value || !(await form.value?.validate().catch(() => false))) return
  if (draft.scope === 'member' && !draft.member_id) { error.value = '请选择这条规则作用于哪位成员'; return }
  busy.value = true
  const result = await api.setProjectAlias({
    scope: draft.scope,
    ...(draft.scope === 'member' ? { member_id: draft.member_id } : {}),
    prefix: draft.prefix.trim(),
    alias: draft.alias.trim(),
  })
  busy.value = false
  if (!result.ok) {
    if (result.status === 401) { session.expire('登录已失效，请重新登录'); return }
    error.value = result.error
    return
  }
  showForm.value = false
  ElMessage.success('规则已保存，看板上的项目口径立即生效')
  await load()
}

async function changeStatus(entry: PortalProjectAlias): Promise<void> {
  if (busy.value) return
  busy.value = true
  const result = await api.setProjectAliasStatus({ alias_id: entry.alias_id, enabled: !entry.enabled })
  busy.value = false
  if (!result.ok) {
    if (result.status === 401) { session.expire('登录已失效，请重新登录'); return }
    ElMessage.error(result.error)
    return
  }
  ElMessage.success(entry.enabled ? '规则已停用，这些目录回到「目录最后一段」的旧口径' : '规则已启用')
  await load()
}

async function remove(entry: PortalProjectAlias): Promise<void> {
  if (busy.value) return
  try {
    await ElMessageBox.confirm(
      `删除后 ${entry.prefix} 命中的那些目录会回到「目录最后一段」的旧口径。历史用量不会被改动 —— 归一化只作用在查询上。`,
      `删除规则 · ${entry.prefix}`,
      { type: 'warning', confirmButtonText: '删除规则', cancelButtonText: '取消' },
    )
  } catch { return }
  busy.value = true
  const result = await api.deleteProjectAlias({ alias_id: entry.alias_id })
  busy.value = false
  if (!result.ok) {
    if (result.status === 401) { session.expire('登录已失效，请重新登录'); return }
    ElMessage.error(result.error)
    return
  }
  ElMessage.success('规则已删除')
  await load()
}

function prefillAssistantForm(values: AssistantFormValues): void {
  assertAssistantFormIdentity(values, selected.value, ['scope', 'member_id', 'prefix'])
  if (values.scope === 'global' || values.scope === 'member') draft.scope = values.scope
  if (values.member_id !== undefined) draft.member_id = String(values.member_id ?? '')
  if (typeof values.prefix === 'string') draft.prefix = values.prefix
  if (typeof values.alias === 'string') draft.alias = values.alias
}
useAssistantForm('project-aliases', {
  canOpen: () => canManage.value, isLoading: () => loading.value, isBusy: () => busy.value,
  isOpen: () => showForm.value, error: () => error.value,
  currentForm: () => showForm.value ? { resource: 'project-aliases', operation: selected.value ? 'update' : 'create', ...(selected.value ? { target_id: selected.value.alias_id } : {}) } : null,
  open: request => {
    const entry = assistantFormEntry(request, aliases.value, row => row.alias_id)
    assertAssistantFormIdentity(request.values, entry, ['scope', 'member_id', 'prefix'])
    open(entry)
    prefillAssistantForm(request.values)
  },
  patch: request => prefillAssistantForm(request.values),
})
onMounted(() => { void load() })
</script>

<template>
  <div class="page-stack">
    <div class="page-heading">
      <div>
        <div class="eyebrow">PROJECT NORMALIZATION</div>
        <h1>项目归一化</h1>
        <p>
          把上报里散开的多个工作目录折叠成同一个项目名：配一条<strong>仓库名</strong>规则，
          仓库根与各子目录就一起记到同一个项目名下。
          <strong>没有配规则的目录保持原样</strong>（仍按「目录最后一段」显示）。
        </p>
      </div>
      <el-button v-if="canManage" type="primary" :icon="Plus" :disabled="busy" @click="open()">添加规则</el-button>
    </div>
    <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon role="alert" />
    <el-card shadow="never">
      <template #header>
        <div class="panel-heading">
          <div>
            <h2>项目列表</h2>
            <p>
              一个项目一行：这一列是<strong>归一化后</strong>的名字，展开后能看到它关联了哪些路径、
              以及每条规则是<strong>全局</strong>的还是配给了某几个人。
              项目名<strong>逐字一致</strong>才会折进同一个项目 —— 差一个字符（多一个空格也算）
              就是另一个项目，看板上也会分成两行，所以行上提供了「添加路径」把名字原样带过去。
            </p>
            <p>
              全局规则对所有人生效，人员规则只对该人员生效。多条命中同一目录时<strong>路径前缀规则优先于仓库名规则</strong>，
              同类里<strong>前缀最长的胜出</strong>。前缀按<strong>路径分隔符边界</strong>判定、<strong>区分大小写</strong>，
              两端的尾部分隔符会被自动去掉；<strong>没有配规则的目录仍然按「目录最后一段」显示</strong>。
            </p>
          </div>
          <el-button :icon="Refresh" :loading="loading" :disabled="busy" @click="load">刷新</el-button>
        </div>
      </template>
      <div class="member-filters">
        <el-input v-model="search" :prefix-icon="Search" clearable placeholder="搜索仓库名或项目名" aria-label="搜索规则" />
        <el-select v-model="scopeFilter" clearable placeholder="全部作用范围" aria-label="筛选作用范围">
          <el-option label="全局" value="global" /><el-option label="按人员" value="member" />
        </el-select>
        <el-button :disabled="busy || !groups.length" @click="toggleExpandAll">{{ allExpanded ? '全部收起' : '全部展开' }}</el-button>
        <span class="muted">共 {{ groups.length }} 个项目 · {{ shownRules }} 条规则</span>
      </div>
      <el-skeleton v-if="loading && !aliases.length" :rows="5" animated />
      <el-table
        v-else
        :data="groups"
        :row-key="projectGroupRowKey"
        :expand-row-keys="expandedKeys"
        empty-text="还没有规则：现在所有目录都按「目录最后一段」显示"
        @expand-change="onExpandChange"
      >
        <!--
          展开区 = 这个项目的规则清单：一条规则一行，作用范围、路径、状态与三个操作都在这里。
          项目行只放摘要，否则 30 条规则会把首屏铺满，又回到「一行一条规则、看不出哪些是一组」。
        -->
        <el-table-column type="expand" width="48">
          <template #default="{ row }">
            <div class="rule-lines">
              <div class="rule-lines-head">
                <span>作用范围</span><span>仓库名 / 目录前缀</span><span>状态</span><span>更新时间</span><span v-if="canManage">操作</span>
              </div>
              <div v-for="entry in asGroup(row).rules" :key="entry.alias_id" class="rule-line">
                <span class="rule-scope">
                  <el-tag size="small" :type="entry.scope === 'global' ? 'info' : 'success'">{{ entry.scope === 'global' ? '全局' : '按人员' }}</el-tag>
                  <span v-if="entry.member_name" class="muted">{{ entry.member_name }}</span>
                </span>
                <code class="rule-prefix">{{ entry.prefix }}</code>
                <el-tag size="small" :type="entry.enabled ? 'success' : 'info'">{{ entry.enabled ? '启用' : '停用' }}</el-tag>
                <span class="muted">{{ formatFullDateTime(entry.updated_at_ms) }}</span>
                <span v-if="canManage" class="rule-ops">
                  <el-button link type="primary" :disabled="busy" @click="open(entry)">编辑</el-button>
                  <el-button link :type="entry.enabled ? 'warning' : 'success'" :disabled="busy" @click="changeStatus(entry)">{{ entry.enabled ? '停用' : '启用' }}</el-button>
                  <el-button link type="danger" :disabled="busy" :icon="Delete" @click="remove(entry)">删除</el-button>
                </span>
              </div>
            </div>
          </template>
        </el-table-column>
        <el-table-column prop="alias" label="归一化后的项目" min-width="200" sortable>
          <template #default="{ row }">
            <strong>{{ asGroup(row).alias }}</strong>
            <span class="muted"> {{ asGroup(row).ruleCount }} 条规则</span>
          </template>
        </el-table-column>
        <el-table-column label="关联人员 / 作用范围" min-width="230">
          <template #default="{ row }">
            <el-tag v-if="asGroup(row).globalRules" size="small" type="info" class="member-chip">全局</el-tag>
            <el-tag v-for="owner in visibleMembers(asGroup(row))" :key="owner.member_id" size="small" type="success" class="member-chip">
              {{ owner.name }}<span v-if="owner.ruleCount > 1"> ×{{ owner.ruleCount }}</span>
            </el-tag>
            <span v-if="asGroup(row).members.length > VISIBLE_MEMBERS" class="muted">等 {{ asGroup(row).members.length }} 人</span>
          </template>
        </el-table-column>
        <el-table-column prop="pathCount" label="关联路径" min-width="280" sortable>
          <template #default="{ row }">
            <code v-for="prefix in asGroup(row).prefixes.slice(0, 2)" :key="prefix" class="rule-prefix">{{ prefix }}</code>
            <span v-if="asGroup(row).pathCount > 2" class="muted">共 {{ asGroup(row).pathCount }} 条路径，展开后逐条看</span>
          </template>
        </el-table-column>
        <el-table-column prop="enabledRules" label="状态" width="140" sortable>
          <template #default="{ row }">
            <el-tag size="small" :type="asGroup(row).enabledRules ? 'success' : 'info'" class="member-chip">启用 {{ asGroup(row).enabledRules }}</el-tag>
            <el-tag v-if="asGroup(row).disabledRules" size="small" type="warning" class="member-chip">停用 {{ asGroup(row).disabledRules }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="updatedAtMs" label="最近更新" min-width="170" sortable><template #default="{ row }">{{ formatFullDateTime(asGroup(row).updatedAtMs) }}</template></el-table-column>
        <el-table-column v-if="canManage" label="操作" width="140" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" :disabled="busy" @click="openForProject(asGroup(row))">添加路径</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>
    <el-dialog v-model="showForm" :title="selected ? '编辑规则' : '添加规则'" width="min(560px, 94vw)" destroy-on-close :close-on-click-modal="false" :show-close="!busy" :close-on-press-escape="!busy">
      <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon />
      <el-form ref="form" :model="draft" :rules="rules" label-position="top" :disabled="busy" @submit.prevent="save">
        <el-form-item label="作用范围">
          <el-select v-model="draft.scope" :disabled="!!selected" aria-label="作用范围">
            <el-option label="全局（所有人）" value="global" />
            <el-option label="按人员（只对该成员生效）" value="member" />
          </el-select>
          <p v-if="selected" class="muted">作用范围与目录前缀是这条规则的标识，要换请删掉重建。</p>
        </el-form-item>
        <el-form-item v-if="draft.scope === 'member'" label="成员">
          <el-select v-model="draft.member_id" filterable placeholder="选择成员" aria-label="选择成员">
            <el-option v-for="person in people" :key="person.member_id" :label="person.name" :value="person.member_id" />
          </el-select>
          <p v-if="rosterLoading" class="muted">正在读取人员名单…</p>
          <p v-else-if="!people.length" class="muted">读不到人员名单（需要 <code>members:read</code>），暂时只能配置全局规则。</p>
        </el-form-item>
        <el-form-item label="仓库名 / 目录前缀" prop="prefix">
          <!--
            ★ `filterable` + `allow-create`：优先让人**从真实 cwd 里选**
              （敲错一个字符的规则会静默不命中），同时保底能自己填
              （接口要 `stats:read`，而且规则可能指向一个当下还没数据的目录）。
              ⚠️ 候选项是**完整路径**，但这一栏**不需要**照抄完整路径 ——
                 填仓库目录名（如 `suit-g92-parent`）就能覆盖它出现在任何位置的情况。
          -->
          <el-select
            v-model="draft.prefix"
            filterable
            allow-create
            default-first-option
            clearable
            placeholder="填仓库名（如 suit-g92-parent），或从下拉里选完整路径"
            aria-label="仓库名或目录前缀"
          >
            <el-option v-for="dir in cwds" :key="dir" :label="dir" :value="dir" />
          </el-select>
          <p class="muted">
            <strong>只填仓库目录名就够了</strong>（不带 <code>\</code> 和 <code>/</code>）——
            它会匹配该仓库在任意磁盘、任意父目录下的所有子目录。
            需要<strong>限定位置</strong>时才填完整路径，那种写法按路径前缀匹配。
            尾部的 <code>\</code> 或 <code>/</code> 会被自动去掉。
            <!--
              ★ 候选是**打开表单时才取**的（`ensureCatalog()`），所以这里有三种状态：
                正在读 / 读到了（报个数）/ 没读到（缺权限或失败）。把「正在读」说成
                「读不到」会让使用者去查一个不存在的权限问题。
            -->
            <template v-if="catalogLoading">正在读取目录候选…</template>
            <template v-else-if="catalogLoaded">库里目前出现过 {{ cwds.length }} 个目录，可从上面选。</template>
            <template v-else>读不到目录候选（需要 <code>stats:read</code>），请手动填写仓库名。</template>
          </p>
        </el-form-item>
        <el-form-item label="归一化后的项目名" prop="alias">
          <el-input v-model="draft.alias" maxlength="128" placeholder="例如 AI Token 用量平台" autocomplete="off" />
          <p class="muted">
            这是看板「项目」维度里显示的名字，允许中文。
            <strong>要并进已有项目请逐字一致</strong>（多一个空格就是另一个项目）——
            从列表行上的「添加路径」进来时会自动带上那一行的名字。
          </p>
        </el-form-item>
        <div class="dialog-actions">
          <el-button @click="showForm = false">取消</el-button>
          <el-button type="primary" native-type="submit" :loading="busy">保存规则</el-button>
        </div>
      </el-form>
    </el-dialog>
  </div>
</template>