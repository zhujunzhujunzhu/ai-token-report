<script setup lang="ts">
/**
 * 筛选草稿与已应用条件分开，填写期间不会触发无效查询。
 * 四个离散选择（时间范围 / 分组 / 人员 / 厂商）选中即应用到列表，不必再点「查询」；
 * 模型是子串输入，逐字符查询没有意义，仍由按钮或回车提交。
 *
 * ★ 分组在人员**之前**：它是人员的上一位筛选（见模板里的说明）。
 * ⚠️ 「人员」只对能看到全员的人渲染（`session.scopedToSelf` 为假）——
 *   少一个筛不了的控件，也**不说**自己在数据范围上受限（见模板里的说明）。
 *
 * ★ 厂商是**多选 + 可搜索 + 可新建**：候选来自看板接口
 *   `/api/v1/stats/providers`（库里出现过的名字，已归一化），使用者还能在框里
 *   手输一个库里没有的名字并回车（`allow-create`）——那个名字只记在**本机浏览器**
 *   里（`utils/providerCatalog.ts`），绝不写库。服务端对每个值仍是子串匹配，
 *   与 CLI 的 `--provider` 同义。
 */
import {
  ElAlert,
  ElButton,
  ElCard,
  ElDatePicker,
  ElForm,
  ElFormItem,
  ElInput,
  ElOption,
  ElOptionGroup,
  ElSelect,
} from 'element-plus'
import { onUnmounted, reactive, watch } from 'vue'
import { Search, RefreshLeft } from '@element-plus/icons-vue'
import { useDashboardStore } from '../stores/dashboard.js'
import { useSessionStore } from '../stores/session.js'
import {
  TIME_RANGES,
  CUSTOM_PERIOD,
  periodReadyForQuery,
} from '../types/portal.js'
const dashboard = useDashboardStore()
/** 身份只用来决定「画不画人员下拉」（数据范围由服务端强制，见模板里的说明）。 */
const session = useSessionStore()
const draft = reactive({
  ...dashboard.filters,
  users: [...dashboard.filters.users],
  groups: [...dashboard.filters.groups],
  providers: [...dashboard.filters.providers],
})
watch(
  () => dashboard.filters,
  (value) =>
    Object.assign(draft, {
      ...value,
      users: [...value.users],
      groups: [...value.groups],
      providers: [...value.providers],
    }),
)
let selectTimer: ReturnType<typeof setTimeout> | undefined
/** 此刻的时间范围是否可以直接查询（自定义区间要等起止时间填齐）。 */
function periodReady(): boolean {
  return periodReadyForQuery(draft.period, draft.customFrom, draft.customTo)
}
async function apply(): Promise<void> {
  // 立即应用时取消排队中的防抖查询，避免同一份草稿查两遍。
  clearTimeout(selectTimer)
  await dashboard.applyFilters(draft)
}
function applyPeriod(): void {
  // 自定义区间在起止时间填齐前不查，否则切过去就弹一次「请选择开始与结束时间」。
  if (!periodReady()) return
  void apply()
}
function applySelectsSoon(): void {
  // 多选每勾一项都会触发 change，短暂防抖合并成一次查询。
  clearTimeout(selectTimer)
  selectTimer = setTimeout(() => void apply(), 250)
}
async function reset(): Promise<void> {
  // ★ 分组 / 人员 / 厂商是三个独立维度，重置必须**都**清空 ——
  //   漏掉一个就会留下「看不见的筛选」，数字对不上却找不到原因。
  Object.assign(draft, {
    ...dashboard.filters,
    providers: [],
    model: '',
    users: [],
    groups: [],
  })
  await apply()
}
watch(
  () => [draft.customFrom, draft.customTo],
  () => {
    // 起止时间补齐后自动生效；具名周期下改这两个输入框不发查询。
    if (draft.period === CUSTOM_PERIOD && periodReady()) void apply()
  },
)
onUnmounted(() => clearTimeout(selectTimer))
</script>
<template>
  <el-card shadow="never" class="filter-card">
    <el-form label-position="top" class="filter-form" @submit.prevent="apply">
      <el-form-item label="时间范围"
        ><el-select
          v-model="draft.period"
          aria-label="时间范围"
          @change="applyPeriod"
          ><el-option
            v-for="option in TIME_RANGES"
            :key="option.value"
            :value="option.value"
            :label="option.label" /></el-select
      ></el-form-item>
      <!--
        分组 / 人员的顺序是**有语义的**：先选分组，再选人。
        分组是人员的上一位筛选 —— 未选分组时人员下拉列出全部人员（含当前
        时间窗内零用量的人，名册来自 `GET /api/v1/stats/members`）；
        选中分组后只列该分组的成员。反过来放会让人以为「先挑人再挑分组」
        也能筛出东西，而服务端是按 AND 叠加的。
      -->
      <!--
        分组筛选的候选项来自看板接口 `/api/v1/stats/groups`（`stats:read`），
        不是管理接口 `/api/v1/admin/groups`（那是 `groups:read`）。
        ⚠️ 多选是 OR / 展开（多对多）：命中任一所选分组即计入。
        ⚠️ 已停用的分组**照样列出**并标注：停用只影响「以后还能不能选它」，
          历史用量仍在，排行里也仍有它那一行 —— 藏起来会让人以为用量丢了。
      -->
      <el-form-item
        label="分组"
        ><el-select
          v-model="draft.groups"
          multiple
          filterable
          clearable
          collapse-tags
          collapse-tags-tooltip
          placeholder="全部分组"
          aria-label="分组筛选"
          @change="applySelectsSoon"
          ><el-option
            v-for="group in dashboard.groupOptions"
            :key="group.group_id"
            :value="group.group_id"
            :label="
              group.status === 'active' ? group.name : `${group.name}（已停用）`
            " /></el-select
      ></el-form-item>
      <!--
        人员候选项 = 人员名册 ∪ 未署名 / 待确认历史，再按所选分组收窄
        （见 `types/portal.ts` 的 `memberFilterOptions`）。
        ⚠️ 标签随分组变化，是为了让「怎么只剩这几个人」有现成的答案 ——
          下拉变短本身不该需要使用者去猜原因。

        🚨 **只看自己的身份没有人员下拉**：那个下拉对他来说只有一个选项
        （而且服务端无论如何都只回他自己的数据，见 `stats-route.ts` 的
        `applyDataScope()`）。留一个筛不了任何东西的下拉，只会让人以为自己筛到了别人。
        ★ 这里也**刻意不写那行「不是管理员」的提示**：页面既筛不了别人的数据，
          也没有资格替服务端解释数据范围 —— 那句话只是占着一个筛不了控件的位置，
          去讲一件与筛选无关的事。真正的收窄在服务端，与页面画了什么无关。
      -->
      <el-form-item
        v-if="!session.scopedToSelf"
        :label="draft.groups.length ? '人员（仅所选分组）' : '人员'"
        ><el-select
          v-model="draft.users"
          multiple
          filterable
          clearable
          collapse-tags
          collapse-tags-tooltip
          placeholder="全部人员"
          aria-label="人员筛选"
          @change="applySelectsSoon"
          ><el-option
            v-for="option in dashboard.userOptions"
            :key="option.key"
            :value="option.key"
            :label="option.label" /></el-select
      ></el-form-item>
      <!--
        厂商：多选（OR）+ 可搜索 + 可新建。

        ★ 候选 = 库里出现过的名字（`GET /api/v1/stats/providers`，已归一化）
          ∪ 使用者自己建的（只存在本机浏览器里，不写库）。
        ★ `allow-create` + `default-first-option` 让「库里还没有的名字」也能筛：
          输入后回车即成为一枚标签 —— 这正是原来的自由输入能力，只是现在
          它会留在下拉里、下次直接可选。
        ⚠️ 服务端对每个值仍是**子串**匹配（与 CLI `--provider` 同义），
          页面不把它翻译成精确匹配 —— 那会造出第二套口径。
        ⚠️ 已选中的值不会因为「清除自定义」而失效：那是两件事。
      -->
      <el-form-item label="厂商"
        ><el-select
          v-model="draft.providers"
          multiple
          filterable
          clearable
          collapse-tags
          collapse-tags-tooltip
          allow-create
          default-first-option
          :reserve-keyword="false"
          placeholder="全部厂商（可输入后回车新建）"
          aria-label="厂商筛选"
          data-testid="provider-filter"
          @change="applySelectsSoon"
          ><el-option-group
            v-if="dashboard.providerChoices.some((option) => !option.custom)"
            label="数据中出现过的供应商"
            ><el-option
              v-for="option in dashboard.providerChoices.filter((item) => !item.custom)"
              :key="option.value"
              :value="option.value"
              :label="option.label" /></el-option-group
          ><el-option-group
            v-if="dashboard.providerChoices.some((option) => option.custom)"
            label="自定义（只保存在本机浏览器）"
            ><el-option
              v-for="option in dashboard.providerChoices.filter((item) => item.custom)"
              :key="option.value"
              :value="option.value"
              :label="option.label" /></el-option-group
        ></el-select>
        <!--
          ★ 自定义项必须说明它存在哪里：使用者会以为「我配了一个供应商」，
            而它其实只是本机浏览器里的一条记忆（换台机器就没有了）。
        -->
        <span v-if="dashboard.customProviders.length" class="filter-note muted"
          >自定义供应商只记在本机浏览器（不写入数据库）<el-button
            link
            type="primary"
            size="small"
            @click="dashboard.clearCustomProviders()"
            >清除</el-button
          ></span
        >
      </el-form-item>
      <el-form-item label="模型"
        ><el-input
          v-model="draft.model"
          clearable
          placeholder="搜索模型"
          aria-label="模型筛选"
      /></el-form-item>
      <div class="filter-actions">
        <el-button
          type="primary"
          native-type="submit"
          :icon="Search"
          :loading="dashboard.loading"
          >查询</el-button
        ><el-button :icon="RefreshLeft" @click="reset">重置</el-button>
      </div>
      <div v-if="draft.period === CUSTOM_PERIOD" class="custom-range">
        <el-form-item label="开始时间"
          ><el-date-picker
            v-model="draft.customFrom"
            type="datetime"
            value-format="YYYY-MM-DDTHH:mm"
            format="YYYY-MM-DD HH:mm"
            placeholder="选择开始时间"
            aria-label="开始时间"
        /></el-form-item>
        <span>至</span>
        <el-form-item label="结束时间"
          ><el-date-picker
            v-model="draft.customTo"
            type="datetime"
            value-format="YYYY-MM-DDTHH:mm"
            format="YYYY-MM-DD HH:mm"
            placeholder="选择结束时间"
            aria-label="结束时间"
        /></el-form-item>
      </div>
    </el-form>
    <el-alert
      v-if="dashboard.rangeError"
      :title="dashboard.rangeError"
      type="warning"
      :closable="false"
      show-icon
    />
  </el-card>
</template>