<script setup lang="ts">
/**
 * 供应商 / 模型归一化规则（v6 供应商，v12 追加模型）。
 *
 * ★ 这一页配的是**看口径**，不是数据：`usage_event.provider` / `.model` 永远是
 *   上报当时的原值，规则只决定「分组与筛选时按哪个名字算」。所以：
 *
 * - 改一条规则**立刻**在看板的供应商 / 模型分布里生效，历史数据不需要回填；
 * - 配错了把规则删掉就恢复原状（停用是更轻的一档：规则还在，只是不参与归一化）；
 * - 没有配规则的供应商 / 模型**保持自己的原始名** —— 归一化不是「统一改名」，
 *   是「折叠少数几个」。
 *
 * ## 一条规则只折叠一个维度
 *
 * 表单里的「作用对象」决定这条规则折叠**供应商名**还是**模型名**：
 *
 * | 作用对象 | 匹配的原始值 | 折叠 |
 * |---|---|---|
 * | 供应商 | `provider` | 供应商展示名 |
 * | 模型 | `model` | 模型展示名 |
 *
 * 想同时改一个 `(供应商, 模型)` 的文字，就配两条规则 —— 两个维度分开配，
 * 才不会出现「改个模型名顺手把供应商也改了」这种看不出原因的连带效果。
 *
 * ⚠️ 模型规则可以**限定供应商**：填 `*` 表示「不管哪家报的，这个模型名都折叠」，
 *   填一个真实供应商名则只在那家内匹配（`azure-openai` 的 `gpt-4o` 与别家的
 *   `gpt-4o` 不是一回事，那正是要能分开配的理由）。
 *
 * ⚠️ 归一化按**查看者**生效：全局规则对所有人生效，人员规则只对那个人生效
 *   （逐条覆盖，没提到的仍然回落全局）。这也是为什么这一页的「作用范围」
 *   要写清楚是谁 —— 同一个库，两个人看到的分布可以不同。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { useAssistantPageSearch } from '../utils/assistantPageSearch.js'
import { useAssistantForm, assistantFormEntry, assertAssistantFormIdentity } from '../utils/assistantForms.js'
import { Delete, Plus, Refresh, Search } from '@element-plus/icons-vue'
import {
  ElAlert, ElButton, ElCard, ElDialog, ElForm, ElFormItem, ElInput,
  ElMessage, ElMessageBox, ElOption, ElRadioButton, ElRadioGroup, ElSelect,
  ElSkeleton, ElTable, ElTableColumn, ElTag,
} from 'element-plus'
import type { FormInstance, FormRules } from 'element-plus'
import { ANY_PROVIDER, type AssistantFormValues, type PortalMember, type PortalProviderAlias } from '@ai-token-report/shared'
import { fetchMembers } from '../api/admin.js'
import * as api from '../api/admin.js'
import { useSessionStore } from '../stores/session.js'
import { formatFullDateTime } from '../utils/format.js'
import {
  groupProviderRules, providerGroupRowKey, providerRuleKeepsSourceName, providerRuleSourceOf, providerRuleTarget,
  type ProviderRuleGroup, type ProviderRuleTarget,
} from './providersModel.js'

const session = useSessionStore()
const aliases = ref<PortalProviderAlias[]>([])
const people = ref<PortalMember[]>([])
const loading = ref(false)
const busy = ref(false)
const error = ref<string | null>(null)
const search = useAssistantPageSearch(() => { void load() }, () => loading.value)
const scopeFilter = ref('')
/** 按「作用对象」筛：供应商规则与模型规则混在一张表里，一类可能只有两三条。 */
const targetFilter = ref('')
const showForm = ref(false)
const selected = ref<PortalProviderAlias | null>(null)
const form = ref<FormInstance>()
const draft = reactive({
  scope: 'global' as 'global' | 'member',
  member_id: '',
  target: 'provider' as 'provider' | 'model',
  /** 供应商规则：匹配的原始供应商名。模型规则：**限定供应商**（留空 = 任意供应商）。 */
  provider: '',
  /** 模型规则：匹配的原始模型名。 */
  model: '',
  alias: '',
})

const canManage = computed(() => session.can('providers:manage'))
/** 「作用对象」列 / 标签的文字。折叠哪个维度由 `model` 是否有值决定（见 `providersModel.ts`）。 */
const targetLabel = (target: ProviderRuleTarget): string => (target === 'model' ? '模型' : '供应商')
/** 列表主体：一行 = 一个归一化后的名字（折叠与筛选规则全在 `providersModel.ts`）。 */
const groups = computed(() => groupProviderRules(aliases.value, { search: search.value, scope: scopeFilter.value, target: targetFilter.value }))
/**
 * 列表上**真正显示**的规则条数。
 *
 * ⚠️ 刻意不复用「命中的条数」：关键字命中一条规则时整个名字都会展开（见
 *   `groupProviderRules`），所以显示的条数会比命中的多 —— 计数若按命中算，
 *   使用者会看到「2 条规则」却能数出 4 行，然后去查一个不存在的 bug。
 *   筛选逻辑只此一处（一个 `filter` 谓词 + 一次分组），页面不再自己算一遍。
 */
const shownRules = computed(() => groups.value.reduce((total, group) => total + group.ruleCount, 0))
/**
 * 已展开的名字行。
 *
 * ★ 用受控的 `expand-row-keys` 而不是让表格自己记：这样「全部展开 / 全部收起」
 *   与逐行点开共用同一份状态 —— 否则按钮只能靠重新挂载表格（`:key`）来强制展开，
 *   点一下就把滚动位置和排序一起丢掉。
 */
const expandedKeys = ref<string[]>([])
const allExpanded = computed(() => groups.value.length > 0 && expandedKeys.value.length >= groups.value.length)
/** 汇总列最多列几个人名：成员多的展示名会把这一列撑成一屏，其余折成「等 N 人」。 */
const VISIBLE_MEMBERS = 4
const visibleMembers = (group: ProviderRuleGroup) => group.members.slice(0, VISIBLE_MEMBERS)
/**
 * 行插槽给的 `row` 是 Element Plus 自己的 `DefaultRow`（`Record<PropertyKey, any>`），
 * 不是本页的契约类型，而模板里做不了类型断言 —— 所以入口收 `unknown`、在这里收窄一次。
 */
const asGroup = (row: unknown): ProviderRuleGroup => row as ProviderRuleGroup
/**
 * 校验随「作用对象」变：供应商规则要原始供应商名，模型规则要原始模型名
 *   （「限定供应商」可以留空 = 任意供应商，所以它不是必填）。
 */
const rules = computed<FormRules>(() => ({
  provider: draft.target === 'provider'
    ? [{ required: true, message: '请填写上报里出现的供应商名', trigger: 'blur' }]
    : [],
  model: draft.target === 'model'
    ? [{ required: true, message: '请填写上报里出现的模型名', trigger: 'blur' }]
    : [],
  alias: [{ required: true, message: '请填写归一化后的名字', trigger: 'blur' }],
}))

/** 展开 / 收起一行。 */
function onExpandChange(_row: unknown, expanded: unknown): void {
  // ⚠️ `type="expand"` 的列，`expand-change` 的第二参是**当前已展开的行数组**
  //   （树形表格才是布尔值）—— 所以这里只认数组形态，两种写法都不必特判。
  expandedKeys.value = Array.isArray(expanded)
    ? expanded.map((item) => providerGroupRowKey(item as ProviderRuleGroup))
    : []
}

function toggleExpandAll(): void {
  expandedKeys.value = allExpanded.value ? [] : groups.value.map(providerGroupRowKey)
}

async function load(): Promise<void> {
  if (loading.value) return
  loading.value = true
  error.value = null
  const [list, roster] = await Promise.all([
    api.fetchProviderAliases(),
    session.can('members:read') ? fetchMembers() : null,
  ])
  if (!list.ok && list.status === 401) { session.expire('登录已失效，请重新登录'); loading.value = false; return }
  if (!list.ok) error.value = list.error
  else aliases.value = list.data.aliases
  // ⚠️ 人员目录只是为了让「作用范围」能选人；读不到就不给选（表单里明确说明），
  //   不因为一个附带请求失败把整页判定为不可用。
  if (roster?.ok) people.value = roster.data.members
  loading.value = false
}

function open(entry: PortalProviderAlias | null = null): void {
  selected.value = entry
  draft.scope = entry?.scope ?? 'global'
  draft.member_id = entry?.member_id ?? ''
  draft.target = entry ? providerRuleTarget(entry) : 'provider'
  // ★ 任意供应商在表单里显示成**空**（placeholder 写着「*（不限供应商）」）：
  //   让使用者看到一个字面量 `*` 会以为要自己记住这个魔法值，
  //   而它其实是「留空」这一件事的另一种写法。
  draft.provider = entry ? (providerRuleTarget(entry) === 'model' && entry.provider === ANY_PROVIDER ? '' : entry.provider) : ''
  draft.model = entry?.model ?? ''
  draft.alias = entry?.alias ?? ''
  error.value = null
  showForm.value = true
}

/**
 * 「给这个展示名再加一条规则」：名字与作用对象原样带进表单。
 *
 * ★ 带过来的是**这一行显示的那个字符串**（不带 trim、不改大小写），因为分组键就是它 ——
 *   使用者照着屏幕重打一遍，差一个字符就会变成另一个展示名。
 *   ⚠️ 只带名字与作用对象：这一组的「原始值」逐条不同（模型规则还要挑限定供应商），
 *   带哪一条都是猜 —— 猜错会静默不命中，比留空更坏。
 */
function openForGroup(group: ProviderRuleGroup): void {
  open()
  draft.target = group.target
  draft.alias = group.alias
}

async function save(): Promise<void> {
  if (busy.value || !(await form.value?.validate().catch(() => false))) return
  if (draft.scope === 'member' && !draft.member_id) { error.value = '请选择这条规则作用于哪位成员'; return }
  busy.value = true
  const result = await api.setProviderAlias({
    scope: draft.scope,
    ...(draft.scope === 'member' ? { member_id: draft.member_id } : {}),
    // 模型规则里留空 = 任意供应商（`*`）—— 这个值来自 shared 的常量，不在这里另写一遍。
    provider: draft.target === 'model' ? (draft.provider.trim() || ANY_PROVIDER) : draft.provider.trim(),
    ...(draft.target === 'model' ? { model: draft.model.trim() } : {}),
    alias: draft.alias.trim(),
  })
  busy.value = false
  if (!result.ok && result.status === 401) { session.expire('登录已失效，请重新登录'); return }
  if (!result.ok) { error.value = result.error; return }
  showForm.value = false
  ElMessage.success('规则已保存，看板上的口径立即生效')
  await load()
}

async function changeStatus(entry: PortalProviderAlias): Promise<void> {
  if (busy.value) return
  busy.value = true
  const result = await api.setProviderAliasStatus({ alias_id: entry.alias_id, enabled: !entry.enabled })
  busy.value = false
  if (!result.ok && result.status === 401) { session.expire('登录已失效，请重新登录'); return }
  if (!result.ok) { ElMessage.error(result.error); return }
  ElMessage.success(entry.enabled ? '规则已停用，该项回到原始名' : '规则已启用')
  await load()
}

async function remove(entry: PortalProviderAlias): Promise<void> {
  if (busy.value) return
  try {
    await ElMessageBox.confirm(
      `删除后 ${providerRuleSourceOf(entry)} 会恢复成自己的原始名。历史用量不会被改动 —— 归一化只作用在查询上。`,
      `删除规则 · ${providerRuleSourceOf(entry)}`,
      { type: 'warning', confirmButtonText: '删除规则', cancelButtonText: '取消' },
    )
  } catch { return }
  busy.value = true
  const result = await api.deleteProviderAlias({ alias_id: entry.alias_id })
  busy.value = false
  if (!result.ok && result.status === 401) { session.expire('登录已失效，请重新登录'); return }
  if (!result.ok) { ElMessage.error(result.error); return }
  ElMessage.success('规则已删除')
  await load()
}

function prefillAssistantForm(values: AssistantFormValues): void {
  assertAssistantFormIdentity(values, selected.value, ['scope', 'member_id', 'provider', 'model'])
  if (values.scope === 'global' || values.scope === 'member') draft.scope = values.scope
  if (values.member_id !== undefined) draft.member_id = String(values.member_id ?? '')
  if (values.model !== undefined) { draft.target = values.model === null ? 'provider' : 'model'; draft.model = String(values.model ?? '') }
  if (typeof values.provider === 'string') draft.provider = draft.target === 'model' && values.provider === ANY_PROVIDER ? '' : values.provider
  if (typeof values.alias === 'string') draft.alias = values.alias
}
useAssistantForm('provider-aliases', {
  canOpen: () => canManage.value, isLoading: () => loading.value, isBusy: () => busy.value,
  isOpen: () => showForm.value, error: () => error.value,
  currentForm: () => showForm.value ? { resource: 'provider-aliases', operation: selected.value ? 'update' : 'create', ...(selected.value ? { target_id: selected.value.alias_id } : {}) } : null,
  open: request => {
    const entry = assistantFormEntry(request, aliases.value, row => row.alias_id)
    assertAssistantFormIdentity(request.values, entry, ['scope', 'member_id', 'provider', 'model'])
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
        <div class="eyebrow">PROVIDER &amp; MODEL NORMALIZATION</div>
        <h1>供应商模型归一化</h1>
      </div>
      <el-button v-if="canManage" type="primary" :icon="Plus" :disabled="busy" @click="open()">添加规则</el-button>
    </div>
    <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon role="alert" />
    <el-card shadow="never">
      <template #header>
        <div class="panel-heading">
          <div>
            <h2>归一化名字列表</h2>
          </div>
          <el-button :icon="Refresh" :loading="loading" :disabled="busy" @click="load">刷新</el-button>
        </div>
      </template>
      <div class="member-filters">
        <el-input v-model="search" :prefix-icon="Search" clearable placeholder="搜索原始名或归一化名" aria-label="搜索规则" />
        <el-select v-model="targetFilter" clearable placeholder="全部作用对象" aria-label="筛选作用对象">
          <el-option label="供应商" value="provider" /><el-option label="模型" value="model" />
        </el-select>
        <el-select v-model="scopeFilter" clearable placeholder="全部作用范围" aria-label="筛选作用范围">
          <el-option label="全局" value="global" /><el-option label="按人员" value="member" />
        </el-select>
        <el-button :disabled="busy || !groups.length" @click="toggleExpandAll">{{ allExpanded ? '全部收起' : '全部展开' }}</el-button>
        <span class="muted">共 {{ groups.length }} 个名字 · {{ shownRules }} 条规则</span>
      </div>
      <el-skeleton v-if="loading && !aliases.length" :rows="5" animated />
      <el-table
        v-else
        :data="groups"
        :row-key="providerGroupRowKey"
        :expand-row-keys="expandedKeys"
        empty-text="还没有规则：现在所有供应商与模型都按原始名展示"
        @expand-change="onExpandChange"
      >
        <!--
          展开区 = 这个展示名的规则清单：一条规则一行，作用范围、原始值、状态与三个操作都在这里。
          名字行只放摘要，否则几十条规则会把首屏铺满，又回到「一行一条规则、看不出哪些是一组的」。
        -->
        <el-table-column type="expand" width="48">
          <template #default="{ row }">
            <div class="rule-lines">
              <div class="rule-lines-head">
                <span>作用范围</span><span>匹配的原始值</span><span>状态</span><span>更新时间</span><span v-if="canManage">操作</span>
              </div>
              <div v-for="entry in asGroup(row).rules" :key="entry.alias_id" class="rule-line">
                <span class="rule-scope">
                  <el-tag size="small" :type="entry.scope === 'global' ? 'info' : 'success'">{{ entry.scope === 'global' ? '全局' : '按人员' }}</el-tag>
                  <span v-if="entry.member_name" class="muted">{{ entry.member_name }}</span>
                </span>
                <span class="rule-source">
                  <code class="rule-prefix">{{ providerRuleSourceOf(entry) }}</code>
                  <span v-if="providerRuleKeepsSourceName(entry)" class="muted">与原始名相同</span>
                </span>
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
        <el-table-column prop="alias" label="归一化后的名字" min-width="220" sortable>
          <template #default="{ row }">
            <strong>{{ asGroup(row).alias }}</strong>
            <el-tag size="small" effect="plain" :type="asGroup(row).target === 'model' ? 'warning' : 'primary'" class="member-chip">{{ targetLabel(asGroup(row).target) }}</el-tag>
            <span class="muted">{{ asGroup(row).ruleCount }} 条规则</span>
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
        <el-table-column prop="sourceCount" label="匹配的原始值" min-width="280" sortable>
          <template #default="{ row }">
            <code v-for="source in asGroup(row).sources.slice(0, 2)" :key="source" class="rule-prefix">{{ source }}</code>
            <span v-if="asGroup(row).sourceCount > 2" class="muted">共 {{ asGroup(row).sourceCount }} 个原始值，展开后逐条看</span>
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
            <el-button link type="primary" :disabled="busy" @click="openForGroup(asGroup(row))">添加规则</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>
    <el-dialog v-model="showForm" :title="selected ? '编辑规则' : '添加规则'" width="min(520px, 94vw)" destroy-on-close :close-on-click-modal="false" :show-close="!busy" :close-on-press-escape="!busy">
      <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon />
      <el-form ref="form" :model="draft" :rules="rules" label-position="top" :disabled="busy" @submit.prevent="save">
        <el-form-item label="作用对象">
          <el-radio-group v-model="draft.target" :disabled="!!selected" aria-label="作用对象">
            <el-radio-button value="provider">供应商</el-radio-button>
            <el-radio-button value="model">模型</el-radio-button>
          </el-radio-group>
          <p class="muted">
            {{ draft.target === 'provider'
              ? '折叠供应商展示名（按供应商看用量时的分组口径）。'
              : '折叠模型展示名（按模型看用量、以及「供应商 / 模型」组合分组的口径）。' }}
          </p>
        </el-form-item>
        <el-form-item label="作用范围">
          <el-select v-model="draft.scope" :disabled="!!selected" aria-label="作用范围">
            <el-option label="全局（所有人）" value="global" />
            <el-option label="按人员（只对该成员生效）" value="member" />
          </el-select>
          <p v-if="selected" class="muted">作用范围、作用对象与原始名是这条规则的标识，要换请删掉重建。</p>
        </el-form-item>
        <el-form-item v-if="draft.scope === 'member'" label="成员">
          <el-select v-model="draft.member_id" filterable placeholder="选择成员" aria-label="选择成员">
            <el-option v-for="person in people" :key="person.member_id" :label="person.name" :value="person.member_id" />
          </el-select>
          <p v-if="!people.length" class="muted">读不到人员名单（需要 <code>members:read</code>），暂时只能配置全局规则。</p>
        </el-form-item>
        <el-form-item v-if="draft.target === 'model'" label="限定供应商（留空 = 任意供应商）">
          <el-input v-model="draft.provider" maxlength="128" placeholder="留空表示任意供应商；也可填 azure-openai 之类" autocomplete="off" />
          <p class="muted">填了供应商名，这条规则就只对<strong>那家</strong>报上来的这个模型生效。</p>
        </el-form-item>
        <el-form-item v-else label="上报原始供应商名" prop="provider">
          <el-input v-model="draft.provider" maxlength="128" placeholder="例如 dashscope" autocomplete="off" />
          <p class="muted">必须与上报值逐字一致（区分大小写）。</p>
        </el-form-item>
        <el-form-item v-if="draft.target === 'model'" label="上报原始模型名" prop="model">
          <el-input v-model="draft.model" maxlength="255" placeholder="例如 qwen-max" autocomplete="off" />
          <p class="muted">必须与上报值逐字一致（区分大小写）；去「调用明细」页能看到真实值。</p>
        </el-form-item>
        <el-form-item label="归一化后的名字" prop="alias">
          <el-input v-model="draft.alias" maxlength="128" placeholder="例如 阿里百炼 或 通义千问-Max" autocomplete="off" />
          <p class="muted">
            <strong>要并进已有名字请逐字一致</strong>（多一个空格就是另一个名字）——
            从列表行上的「添加规则」进来时会自动带上那一行的名字与作用对象。
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
