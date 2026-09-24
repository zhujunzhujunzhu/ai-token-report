<script setup lang="ts">
/**
 * 部门看板 —— 骨架占位。
 *
 * ⚠️ 当前**不是可用页面**。S8 阶段才实现真正的看板：
 *
 *   - DeptOverview.vue   部门总览
 *   - UserRanking.vue    ★ 人员排行（核心诉求）
 *   - UserDetail.vue     单人下钻
 *   - Diagnostics.vue    采集覆盖率 / 未归属监控
 *
 * 数据来自服务端 `GET /api/v1/stats/*`（见 `packages/shared/src/protocol.ts`）。
 * 这里只做最小挂载，让 `bun run build` 与 `bun run typecheck` 在整仓可用，
 * 避免一个空目录把根级脚本整体拖挂。
 */
</script>

<template>
  <main class="placeholder">
    <h1>部门用量看板</h1>
    <p>此页面尚未实现（计划于 S8 阶段）。</p>
    <p>本地用量统计请使用 <code>dsh-token --web</code> 打开的本地页面。</p>
  </main>
</template>

<style scoped>
.placeholder {
  max-width: 40rem;
  margin: 4rem auto;
  padding: 0 1.5rem;
  font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
  line-height: 1.7;
  color: #1f2329;
}

h1 {
  font-size: 1.5rem;
  margin-bottom: 1rem;
}

code {
  padding: 0.15em 0.4em;
  border-radius: 4px;
  background: #f2f3f5;
  font-size: 0.9em;
}
</style>