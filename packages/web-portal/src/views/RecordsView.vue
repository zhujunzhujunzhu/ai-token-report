<script setup lang="ts">
/** 明细页保留共享筛选，通过服务端分页追溯单次调用。 */
import { ElCard, ElTag } from 'element-plus'
import { useDashboardStore, PAGE_SIZE } from '../stores/dashboard.js'
import RecordsTable from '../components/RecordsTable.vue'
const dashboard = useDashboardStore()
</script>
<template>
  <el-card shadow="never"
    ><template #header
      ><div class="panel-heading">
        <div>
          <h2>用量明细</h2>
          <p>每一行对应一次调用，展开可查看事件与会话标识</p>
        </div>
        <el-tag type="info" effect="plain">每页 {{ PAGE_SIZE }} 条</el-tag>
      </div></template
    ><RecordsTable
      :rows="dashboard.records"
      :total="dashboard.recordTotal"
      :page="dashboard.page"
      :page-size="PAGE_SIZE"
      :loading="dashboard.loading"
      @page="dashboard.setPage"
  /></el-card>
</template>
