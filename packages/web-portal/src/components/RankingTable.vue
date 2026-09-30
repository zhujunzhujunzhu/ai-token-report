<script setup lang="ts">
/**
 * 人员排行保留未归属行；条形宽度只用于排版，所有展示数值来自接口。
 *
 * ★ 人员维度每行还带**当前所属分组**（`row.group_names`，多对多）：
 *   同一个名字可能属于不同分组，分组标签是分辨他们的第一手信息；
 *   未分组的人显式标「未分组」—— 那一部分正是「各分组之和不等于总量」的差额。
 *
 * ★ 费用列**按「服务端有没有下发 `cost`」决定出不出现**（不是按数值大小）：
 *   没有 `cost:read` 时字段整个缺席，此时不显示这一列，
 *   而不是显示一列 `¥0.00` —— 后者会把「没权限」渲染成「没花钱」。
 */
import { ElButton, ElTable, ElTableColumn, ElTag } from 'element-plus'
import { computed } from 'vue'
import type { BreakdownRow } from '@ai-token-report/shared'
import { formatCount, formatPercent } from '../utils/format.js'
import { UNPRICED_TEXT, costText, unpricedText } from '../utils/cost.js'
import { isUnattributed, userLabel } from '../types/portal.js'
const props = defineProps<{ rows: BreakdownRow[] }>()
defineEmits<{ select: [userId: string] }>()
const maxTotal = computed(() =>
  Math.max(1, ...props.rows.map((row) => row.totalTokens)),
)
/** 只在确实有金额可展示时才加这一列（空数组 / 无权限都不加）。 */
const showCost = computed(() => props.rows.some((row) => row.cost))
</script>
<template>
  <el-table
    :data="rows"
    row-key="key"
    class="ranking-table"
    empty-text="这段时间没有任何调用记录"
    @row-click="(row) => $emit('select', row.key)"
  >
    <el-table-column label="排名" width="72"
      ><template #default="{ $index }"
        ><span class="rank-number" :class="{ 'rank-leading': $index < 3 }">{{
          String($index + 1).padStart(2, '0')
        }}</span></template
      ></el-table-column
    >
    <el-table-column label="成员" min-width="200"
      ><template #default="{ row }"
        ><el-button
          link
          :type="isUnattributed(row.key) ? 'warning' : 'primary'"
          @click.stop="$emit('select', row.key)"
          >{{ row.label ?? userLabel(row.key) }}</el-button
        ><el-tag
          v-for="name in row.group_names ?? []"
          :key="name"
          size="small"
          type="info"
          effect="plain"
          class="member-group-tag"
          >{{ name }}</el-tag
        ><small
          v-if="row.member_id && !row.group_names?.length"
          class="muted member-group-tag"
          >未分组</small
        ><br v-if="row.member_id" /><small v-if="row.member_id" class="muted">{{
          row.member_id.slice(0, 8)
        }}</small></template
      ></el-table-column
    >
    <el-table-column label="计费总量" min-width="155" align="right"
      ><template #default="{ row }"
        ><strong class="tabular">{{
          formatCount(row.totalTokens)
        }}</strong></template
      ></el-table-column
    >
    <el-table-column label="相对用量" min-width="140"
      ><template #default="{ row }"
        ><div class="usage-bar">
          <i
            :style="{ width: (row.totalTokens / maxTotal) * 100 + '%' }"
          /></div></template
    ></el-table-column>
    <el-table-column label="调用次数" min-width="110" align="right"
      ><template #default="{ row }">{{
        formatCount(row.calls)
      }}</template></el-table-column
    >
    <!--
      ★ 费用列：`showCost` 为假时整列不出现（无权限 / 无数据）。
      ⚠️ 单元格里两种「没有数」的措辞不同：
         `row.cost` 缺席 = 这一趟没算过；`costs` 为空 = 算了但没配上价。
    -->
    <el-table-column
      v-if="showCost"
      label="费用（估算）"
      min-width="150"
      align="right"
    >
      <template #default="{ row }">
        <span class="tabular">{{ costText(row.cost) ?? UNPRICED_TEXT }}</span>
        <div v-if="unpricedText(row.cost)" class="muted cost-unpriced">
          {{ unpricedText(row.cost) }}
        </div>
      </template>
    </el-table-column>
    <el-table-column label="缓存命中率" min-width="115" align="right"
      ><template #default="{ row }"
        ><el-tag type="success" effect="light">{{
          formatPercent(row.cacheHitRate)
        }}</el-tag></template
      ></el-table-column
    >
    <el-table-column width="85" align="right"
      ><template #default="{ row }"
        ><el-button link type="primary" @click.stop="$emit('select', row.key)"
          >详情</el-button
        ></template
      ></el-table-column
    >
  </el-table>
</template>
