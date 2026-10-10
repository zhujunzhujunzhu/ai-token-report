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
 * ## ⚠️ 与「供应商归一化」刻意不同的两点，页面必须说清
 *
 * | | 供应商归一化 | 项目归一化（本页） |
 * |---|---|---|
 * | 匹配 | 原始名**精确**（一字不差） | 原始 cwd 的**仓库名**（任一路径段）或**路径前缀** |
 * | 多条命中 | 同一原始名只有一条规则 | **路径前缀规则优先**；同类型内最具体者胜出 |
 *
 * 所以本页**不会**出现「一个目录一行」的提示：一条 `suit-g92-parent` 的规则本来就该
 * 覆盖它在任意磁盘下的所有子目录 —— 那正是这个功能的目的。
 *
 * ## 为什么这一页主推「填仓库名」而不是「填完整路径」
 *
 * 路径前缀模式下同一个仓库要**每种位置各配一条**：换盘、换父目录、换盘符大小写
 * （不同客户端写 `cwd` 的方式不同）。线上实测一个仓库要 3~6 条，漏掉一个变体就
 * **静默不命中**（页面上完全看不出来，只表现为「那个项目用量偏小」）。
 * 填仓库名把这三类差异一次消掉：一条规则管所有位置。
 *
 * ## 为什么匹配值要「选」而不是「填」
 *
 * 匹配值是这一页最容易配错的东西：敲错一个字符（或大小写不同）＝ 规则
 * **静默不命中**，而页面上完全看不出来。所以输入框是一个
 * **可搜索的下拉**，候选项来自 `/api/v1/stats/projects`（库里真实出现过的 cwd）；
 * 也允许自己敲（那个接口需要 `stats:read`，拿不到就只剩手填，表单里会说明）。
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
import type { PortalMember, PortalProjectAlias } from '@ai-token-report/shared'
import { fetchMembers } from '../api/admin.js'
import * as api from '../api/admin.js'
import { fetchProjectCwds } from '../api/portal.js'
import { useSessionStore } from '../stores/session.js'
import { formatFullDateTime } from '../utils/format.js'

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
const rows = computed(() => aliases.value.filter((entry) =>
  (!scopeFilter.value || entry.scope === scopeFilter.value) &&
  (!search.value.trim() || `${entry.prefix} ${entry.alias} ${entry.member_name ?? ''}`.toLowerCase().includes(search.value.trim().toLowerCase())),
))
const rules: FormRules = {
  prefix: [{ required: true, message: '请填写要归一化的目录前缀', trigger: 'blur' }],
  alias: [{ required: true, message: '请填写归一化后的项目名', trigger: 'blur' }],
}
const rowAlias = (row: unknown): PortalProjectAlias => row as PortalProjectAlias

async function load(): Promise<void> {
  if (loading.value) return
  loading.value = true
  error.value = null
  const [list, roster, catalog] = await Promise.all([
    api.fetchProjectAliases(),
    session.can('members:read') ? fetchMembers() : null,
    // ⚠️ 候选项只影响「填起来方不方便」，所以它失败**不能让整页判定为不可用**：
    //   与下面的人员名册同样处理，只是退回手填。
    session.can('stats:read') ? fetchProjectCwds() : null,
  ])
  // ⚠️ 判空顺序是 `!ok` 在前：`ApiResult` 是**判别联合**，`status` / `error`
  //   只存在于失败那一支，先读字段是取不到的（`ProvidersView.vue` 里就是这么写错的）。
  if (!list.ok) {
    if (list.status === 401) { session.expire('登录已失效，请重新登录'); loading.value = false; return }
    error.value = list.error
  } else aliases.value = list.data.aliases
  if (roster?.ok) people.value = roster.data.members
  if (catalog?.ok) { cwds.value = catalog.data.projects; catalogLoaded.value = true }
  loading.value = false
}

function open(entry: PortalProjectAlias | null = null): void {
  selected.value = entry
  draft.scope = entry?.scope ?? 'global'
  draft.member_id = entry?.member_id ?? ''
  draft.prefix = entry?.prefix ?? ''
  draft.alias = entry?.alias ?? ''
  error.value = null
  showForm.value = true
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

useAssistantForm('project-aliases', {
  canOpen: () => canManage.value, isLoading: () => loading.value, isBusy: () => busy.value,
  isOpen: () => showForm.value, error: () => error.value,
  open: request => {
    const entry = assistantFormEntry(request, aliases.value, row => row.alias_id)
    assertAssistantFormIdentity(request.values, entry, ['scope', 'member_id', 'prefix'])
    open(entry)
    const values = request.values
    if (values.scope === 'global' || values.scope === 'member') draft.scope = values.scope
    if (values.member_id !== undefined) draft.member_id = String(values.member_id ?? '')
    if (typeof values.prefix === 'string') draft.prefix = values.prefix
    if (typeof values.alias === 'string') draft.alias = values.alias
  },
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
            <h2>规则列表</h2>
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
        <span class="muted">共 {{ rows.length }} 条规则</span>
      </div>
      <el-skeleton v-if="loading && !aliases.length" :rows="5" animated />
      <el-table v-else :data="rows" row-key="alias_id" empty-text="还没有规则：现在所有目录都按「目录最后一段」显示">
        <el-table-column label="作用范围" width="150">
          <template #default="{ row }">
            <el-tag :type="row.scope === 'global' ? 'info' : 'success'">{{ row.scope === 'global' ? '全局' : '按人员' }}</el-tag>
            <span v-if="row.member_name" class="muted"> {{ row.member_name }}</span>
          </template>
        </el-table-column>
        <el-table-column label="仓库名 / 目录前缀" min-width="260">
          <template #default="{ row }"><code>{{ row.prefix }}</code></template>
        </el-table-column>
        <el-table-column label="归一化后的项目" min-width="180">
          <template #default="{ row }">{{ row.alias }}</template>
        </el-table-column>
        <el-table-column label="状态" width="100">
          <template #default="{ row }"><el-tag :type="row.enabled ? 'success' : 'info'">{{ row.enabled ? '启用' : '停用' }}</el-tag></template>
        </el-table-column>
        <el-table-column label="更新时间" min-width="170"><template #default="{ row }">{{ formatFullDateTime(row.updated_at_ms) }}</template></el-table-column>
        <el-table-column v-if="canManage" label="操作" width="190" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" :disabled="busy" @click="open(rowAlias(row))">编辑</el-button>
            <el-button link :type="row.enabled ? 'warning' : 'success'" :disabled="busy" @click="changeStatus(rowAlias(row))">{{ row.enabled ? '停用' : '启用' }}</el-button>
            <el-button link type="danger" :disabled="busy" :icon="Delete" @click="remove(rowAlias(row))">删除</el-button>
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
          <p v-if="!people.length" class="muted">读不到人员名单（需要 <code>members:read</code>），暂时只能配置全局规则。</p>
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
            <template v-if="catalogLoaded">库里目前出现过 {{ cwds.length }} 个目录，可从上面选。</template>
            <template v-else>读不到目录候选（需要 <code>stats:read</code>），请手动填写仓库名。</template>
          </p>
        </el-form-item>
        <el-form-item label="归一化后的项目名" prop="alias">
          <el-input v-model="draft.alias" maxlength="128" placeholder="例如 AI Token 用量平台" autocomplete="off" />
          <p class="muted">这是看板「项目」维度里显示的名字，允许中文。</p>
        </el-form-item>
        <div class="dialog-actions">
          <el-button @click="showForm = false">取消</el-button>
          <el-button type="primary" native-type="submit" :loading="busy">保存规则</el-button>
        </div>
      </el-form>
    </el-dialog>
  </div>
</template>
