<script setup lang="ts">
/** 人员排行保留未归属行；条形宽度只用于排版，所有展示数值来自接口。 */
import { ElButton, ElTable, ElTableColumn, ElTag } from 'element-plus'
import { computed } from 'vue'
import type { BreakdownRow } from '@ai-token-report/shared'
import { formatCount, formatPercent } from '../utils/format.js'
import { userLabel, isUnattributed } from '../types/portal.js'
const props = defineProps<{ rows: BreakdownRow[] }>()
defineEmits<{ select: [userId: string] }>()
const maxTotal = computed(() =>
  Math.max(1, ...props.rows.map((row) => row.totalTokens)),
)
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
    <el-table-column label="成员" min-width="150"
      ><template #default="{ row }"
        ><el-button
          link
          :type="isUnattributed(row.key) ? 'warning' : 'primary'"
          @click.stop="$emit('select', row.key)"
          >{{ userLabel(row.key) }}</el-button
        ></template
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
