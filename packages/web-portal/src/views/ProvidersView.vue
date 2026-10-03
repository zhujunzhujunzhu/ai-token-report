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
import { Delete, Plus, Refresh, Search } from '@element-plus/icons-vue'
import {
  ElAlert, ElButton, ElCard, ElDialog, ElForm, ElFormItem, ElInput,
  ElMessage, ElMessageBox, ElOption, ElRadioButton, ElRadioGroup, ElSelect,
  ElSkeleton, ElTable, ElTableColumn, ElTag,
} from 'element-plus'
import type { FormInstance, FormRules } from 'element-plus'
import { ANY_PROVIDER, type PortalMember, type PortalProviderAlias } from '@ai-token-report/shared'
import { fetchMembers } from '../api/admin.js'
import * as api from '../api/admin.js'
import { useSessionStore } from '../stores/session.js'
import { formatFullDateTime } from '../utils/format.js'

const session = useSessionStore()
const aliases = ref<PortalProviderAlias[]>([])
const people = ref<PortalMember[]>([])
const loading = ref(false)
const busy = ref(false)
const error = ref<string | null>(null)
const search = ref('')
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
/** 一条规则折叠哪个维度，由 `model` 是否有值决定（见 `PortalProviderAlias`）。 */
const isModelRule = (entry: PortalProviderAlias): boolean => entry.model !== null
/** 「作用对象」列的文字。 */
const targetOf = (entry: PortalProviderAlias): string => (isModelRule(entry) ? '模型' : '供应商')
/**
 * 规则匹配的**原始值**，拼成一行给列表看。
 *
 * ★ 模型规则要把「限定供应商」一并显示：只显示模型名的话，
 *   「`gpt-4o`（任意供应商）」与「`azure-openai` 下的 `gpt-4o`」在列表里长得一样，
 *   而这两条规则的射程完全不同。
 */
const sourceOf = (entry: PortalProviderAlias): string => {
  if (entry.model === null) return entry.provider
  const scope = entry.provider === ANY_PROVIDER ? '任意供应商' : entry.provider
  return `${scope} · ${entry.model}`
}
const rows = computed(() => aliases.value.filter((entry) =>
  (!scopeFilter.value || entry.scope === scopeFilter.value) &&
  (!targetFilter.value || (targetFilter.value === 'model') === isModelRule(entry)) &&
  (!search.value.trim() || `${entry.provider} ${entry.model ?? ''} ${entry.alias} ${entry.member_name ?? ''}`.toLowerCase().includes(search.value.trim().toLowerCase())),
))
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
const rowAlias = (row: unknown): PortalProviderAlias => row as PortalProviderAlias

async function load(): Promise<void> {
  if (loading.value) return
  loading.value = true
  error.value = null
  const [list, roster] = await Promise.all([
    api.fetchProviderAliases(),
    session.can('members:read') ? fetchMembers() : null,
  ])
  if (list.status === 401) { session.expire('登录已失效，请重新登录'); loading.value = false; return }
  if (!list.ok) error.value = list.reason ?? '规则加载失败'
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
  draft.target = entry && isModelRule(entry) ? 'model' : 'provider'
  // ★ 任意供应商在表单里显示成**空**（placeholder 写着「*（不限供应商）」）：
  //   让使用者看到一个字面量 `*` 会以为要自己记住这个魔法值，
  //   而它其实是「留空」这一件事的另一种写法。
  draft.provider = entry ? (isModelRule(entry) && entry.provider === ANY_PROVIDER ? '' : entry.provider) : ''
  draft.model = entry?.model ?? ''
  draft.alias = entry?.alias ?? ''
  error.value = null
  showForm.value = true
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
  if (result.status === 401) { session.expire('登录已失效，请重新登录'); return }
  if (!result.ok) { error.value = result.reason ?? '保存失败'; return }
  showForm.value = false
  ElMessage.success('规则已保存，看板上的口径立即生效')
  await load()
}

async function changeStatus(entry: PortalProviderAlias): Promise<void> {
  if (busy.value) return
  busy.value = true
  const result = await api.setProviderAliasStatus({ alias_id: entry.alias_id, enabled: !entry.enabled })
  busy.value = false
  if (result.status === 401) { session.expire('登录已失效，请重新登录'); return }
  if (!result.ok) { ElMessage.error(result.reason ?? '操作失败'); return }
  ElMessage.success(entry.enabled ? '规则已停用，该项回到原始名' : '规则已启用')
  await load()
}

async function remove(entry: PortalProviderAlias): Promise<void> {
  if (busy.value) return
  try {
    await ElMessageBox.confirm(
      `删除后 ${sourceOf(entry)} 会恢复成自己的原始名。历史用量不会被改动 —— 归一化只作用在查询上。`,
      `删除规则 · ${sourceOf(entry)}`,
      { type: 'warning', confirmButtonText: '删除规则', cancelButtonText: '取消' },
    )
  } catch { return }
  busy.value = true
  const result = await api.deleteProviderAlias({ alias_id: entry.alias_id })
  busy.value = false
  if (result.status === 401) { session.expire('登录已失效，请重新登录'); return }
  if (!result.ok) { ElMessage.error(result.reason ?? '删除失败'); return }
  ElMessage.success('规则已删除')
  await load()
}

onMounted(() => { void load() })
</script>

<template>
  <div class="page-stack">
    <div class="page-heading">
      <div>
        <div class="eyebrow">PROVIDER &amp; MODEL NORMALIZATION</div>
        <h1>供应商模型归一化</h1>
        <p>
          把上报里出现的多个<strong>供应商名</strong>或<strong>模型名</strong>折叠成同一个展示名
          （例如 <code>dashscope</code> 与 <code>bailian</code> 都记成 <code>bailian-tpp</code>；
          <code>qwen-max</code> 与 <code>Qwen-Max</code> 都记成 <code>通义千问-Max</code>），
          这样按供应商 / 模型看用量时才不会一个东西散成好几行。
          <strong>没有配规则的项保持自己的原始名</strong>；明细里始终同时显示原值，方便核对规则配得对不对。
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
            <p>全局规则对所有人生效；人员规则只对该人员生效，未提到的项仍回落全局。</p>
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
        <span class="muted">共 {{ rows.length }} 条规则</span>
      </div>
      <el-skeleton v-if="loading && !aliases.length" :rows="5" animated />
      <el-table v-else :data="rows" row-key="alias_id" empty-text="还没有规则：现在所有供应商与模型都按原始名展示">
        <el-table-column label="作用范围" width="140">
          <template #default="{ row }">
            <el-tag :type="row.scope === 'global' ? 'info' : 'success'">{{ row.scope === 'global' ? '全局' : '按人员' }}</el-tag>
            <span v-if="row.member_name" class="muted"> {{ row.member_name }}</span>
          </template>
        </el-table-column>
        <el-table-column label="作用对象" width="100">
          <template #default="{ row }">
            <el-tag :type="isModelRule(row) ? 'warning' : 'primary'" effect="plain">{{ targetOf(row) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="匹配的原始值" min-width="220">
          <template #default="{ row }"><code>{{ sourceOf(row) }}</code></template>
        </el-table-column>
        <el-table-column label="归一化后" min-width="180">
          <template #default="{ row }">
            {{ row.alias }}<span v-if="row.alias === (isModelRule(row) ? row.model : row.provider)" class="muted">（与原始名相同）</span>
          </template>
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
    <el-card shadow="never">
      <template #header><h2>怎么配才对</h2></template>
      <ul class="muted">
        <li>原始名要<strong>一字不差</strong>：匹配是大小写敏感的精确比较，写错大小写或结尾多一个空格都会静默不命中。</li>
        <li><strong>一条规则只折叠一个维度</strong>：要同时改供应商与模型的展示名，就配两条规则。</li>
        <li>模型规则的「限定供应商」留空表示<strong>任意供应商</strong>（显示为 <code>*</code>）；填真实供应商名则只在那家内匹配。</li>
        <li>归一化名允许中文（例如 <code>阿里百炼</code>、<code>通义千问-Max</code>），但不能包含 <code>/</code> —— 它会被当成 provider 与 model 的分隔符。</li>
        <li>没配规则的项保持原始名，所以只配你真正想折叠的那几个。</li>
        <li>要确认某个东西到底上报成了什么，去「调用明细」页看模型与供应商那两列原始值。</li>
        <li>费用按<strong>原始</strong>供应商与模型计价，改名不会影响金额。</li>
      </ul>
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
        </el-form-item>
        <div class="dialog-actions">
          <el-button @click="showForm = false">取消</el-button>
          <el-button type="primary" native-type="submit" :loading="busy">保存规则</el-button>
        </div>
      </el-form>
    </el-dialog>
  </div>
</template>
