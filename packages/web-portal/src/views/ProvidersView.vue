<script setup lang="ts">
/**
 * 供应商归一化规则（v6）。
 *
 * ★ 这一页配的是**看口径**，不是数据：`usage_event.provider` 永远是上报当时的原值，
 *   规则只决定「分组与筛选时按哪个名字算」。所以：
 *
 * - 改一条规则**立刻**在看板的供应商分布里生效，历史数据不需要回填；
 * - 配错了把规则删掉就恢复原状（停用是更轻的一档：规则还在，只是不参与归一化）；
 * - 没有配规则的供应商**保持自己的原始名** —— 归一化不是「统一改名」，是「折叠少数几个」。
 *
 * ⚠️ 归一化按**查看者**生效：全局规则对所有人生效，人员规则只对那个人生效
 *   （逐条覆盖，没提到的仍然回落全局）。这也是为什么这一页的「作用范围」
 *   要写清楚是谁 —— 同一个库，两个人看到的供应商分布可以不同。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { Delete, Plus, Refresh, Search } from '@element-plus/icons-vue'
import {
  ElAlert, ElButton, ElCard, ElDialog, ElForm, ElFormItem, ElInput,
  ElMessage, ElMessageBox, ElOption, ElSelect, ElSkeleton, ElTable, ElTableColumn, ElTag,
} from 'element-plus'
import type { FormInstance, FormRules } from 'element-plus'
import type { PortalMember, PortalProviderAlias } from '@ai-token-report/shared'
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
const showForm = ref(false)
const selected = ref<PortalProviderAlias | null>(null)
const form = ref<FormInstance>()
const draft = reactive({ scope: 'global' as 'global' | 'member', member_id: '', provider: '', alias: '' })

const canManage = computed(() => session.can('providers:manage'))
const rows = computed(() => aliases.value.filter((entry) =>
  (!scopeFilter.value || entry.scope === scopeFilter.value) &&
  (!search.value.trim() || `${entry.provider} ${entry.alias} ${entry.member_name ?? ''}`.toLowerCase().includes(search.value.trim().toLowerCase())),
))
/**
 * 归一化名与原始名相同的规则是**没配到点上**的规则（它什么也没折叠），
 * 用一条提示标出来 —— 只有部分会改正是使用者的原意。
 */
const rules: FormRules = {
  provider: [{ required: true, message: '请填写上报里出现的供应商名', trigger: 'blur' }],
  alias: [{ required: true, message: '请填写归一化后的名字', trigger: 'blur' }],
}
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
  draft.provider = entry?.provider ?? ''
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
    provider: draft.provider.trim(),
    alias: draft.alias.trim(),
  })
  busy.value = false
  if (result.status === 401) { session.expire('登录已失效，请重新登录'); return }
  if (!result.ok) { error.value = result.reason ?? '保存失败'; return }
  showForm.value = false
  ElMessage.success('规则已保存，看板上的供应商口径立即生效')
  await load()
}

async function changeStatus(entry: PortalProviderAlias): Promise<void> {
  if (busy.value) return
  busy.value = true
  const result = await api.setProviderAliasStatus({ alias_id: entry.alias_id, enabled: !entry.enabled })
  busy.value = false
  if (result.status === 401) { session.expire('登录已失效，请重新登录'); return }
  if (!result.ok) { ElMessage.error(result.reason ?? '操作失败'); return }
  ElMessage.success(entry.enabled ? '规则已停用，该供应商回到原始名' : '规则已启用')
  await load()
}

async function remove(entry: PortalProviderAlias): Promise<void> {
  if (busy.value) return
  try {
    await ElMessageBox.confirm(
      `删除后 ${entry.provider} 会恢复成自己的原始名。历史用量不会被改动 —— 归一化只作用在查询上。`,
      `删除规则 · ${entry.provider}`,
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
        <div class="eyebrow">PROVIDER NORMALIZATION</div>
        <h1>供应商归一化</h1>
        <p>
          把上报里出现的多个供应商名折叠成同一个展示名（例如 <code>dashscope</code> 与 <code>bailian</code>
          都记成 <code>bailian-tpp</code>），这样按供应商看用量时才不会一个来源散成好几行。
          <strong>没有配规则的供应商保持自己的原始名</strong>；明细里始终同时显示原值，方便核对规则配得对不对。
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
            <p>全局规则对所有人生效；人员规则只对该人员生效，未提到的供应商仍回落全局。</p>
          </div>
          <el-button :icon="Refresh" :loading="loading" :disabled="busy" @click="load">刷新</el-button>
        </div>
      </template>
      <div class="member-filters">
        <el-input v-model="search" :prefix-icon="Search" clearable placeholder="搜索供应商或归一化名" aria-label="搜索规则" />
        <el-select v-model="scopeFilter" clearable placeholder="全部作用范围" aria-label="筛选作用范围">
          <el-option label="全局" value="global" /><el-option label="按人员" value="member" />
        </el-select>
        <span class="muted">共 {{ rows.length }} 条规则</span>
      </div>
      <el-skeleton v-if="loading && !aliases.length" :rows="5" animated />
      <el-table v-else :data="rows" row-key="alias_id" empty-text="还没有规则：现在所有供应商都按原始名展示">
        <el-table-column label="作用范围" width="150">
          <template #default="{ row }">
            <el-tag :type="row.scope === 'global' ? 'info' : 'success'">{{ row.scope === 'global' ? '全局' : '按人员' }}</el-tag>
            <span v-if="row.member_name" class="muted"> {{ row.member_name }}</span>
          </template>
        </el-table-column>
        <el-table-column label="上报原始名" min-width="180">
          <template #default="{ row }"><code>{{ row.provider }}</code></template>
        </el-table-column>
        <el-table-column label="归一化后" min-width="180">
          <template #default="{ row }">{{ row.alias }}<span v-if="row.alias === row.provider" class="muted">（与原始名相同）</span></template>
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
        <li>归一化名允许中文（例如 <code>阿里百炼</code>），但不能包含 <code>/</code> —— 它会被当成 provider 与 model 的分隔符。</li>
        <li>没配规则的供应商保持原始名，所以只配你真正想折叠的那几个。</li>
        <li>要看某个供应商到底上报成了什么，去「调用明细」页看那一列原始值。</li>
      </ul>
    </el-card>
    <el-dialog v-model="showForm" :title="selected ? '编辑规则' : '添加规则'" width="min(520px, 94vw)" destroy-on-close :close-on-click-modal="false" :show-close="!busy" :close-on-press-escape="!busy">
      <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon />
      <el-form ref="form" :model="draft" :rules="rules" label-position="top" :disabled="busy" @submit.prevent="save">
        <el-form-item label="作用范围">
          <el-select v-model="draft.scope" :disabled="!!selected" aria-label="作用范围">
            <el-option label="全局（所有人）" value="global" />
            <el-option label="按人员（只对该成员生效）" value="member" />
          </el-select>
          <p v-if="selected" class="muted">作用范围与原始名是这条规则的标识，要换请删掉重建。</p>
        </el-form-item>
        <el-form-item v-if="draft.scope === 'member'" label="成员">
          <el-select v-model="draft.member_id" filterable placeholder="选择成员" aria-label="选择成员">
            <el-option v-for="person in people" :key="person.member_id" :label="person.name" :value="person.member_id" />
          </el-select>
          <p v-if="!people.length" class="muted">读不到人员名单（需要 <code>members:read</code>），暂时只能配置全局规则。</p>
        </el-form-item>
        <el-form-item label="上报原始名" prop="provider">
          <el-input v-model="draft.provider" maxlength="128" placeholder="例如 dashscope" autocomplete="off" />
          <p class="muted">必须与上报值逐字一致（区分大小写）。</p>
        </el-form-item>
        <el-form-item label="归一化后的名字" prop="alias">
          <el-input v-model="draft.alias" maxlength="128" placeholder="例如 bailian-tpp 或 阿里百炼" autocomplete="off" />
        </el-form-item>
        <div class="dialog-actions">
          <el-button @click="showForm = false">取消</el-button>
          <el-button type="primary" native-type="submit" :loading="busy">保存规则</el-button>
        </div>
      </el-form>
    </el-dialog>
  </div>
</template>