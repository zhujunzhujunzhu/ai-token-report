<script setup lang="ts">
/** 应用根只负责组件库配置与路由出口。 */
import { ElConfigProvider } from 'element-plus'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
</script>
<template>
  <el-config-provider :locale="zhCn"><router-view /></el-config-provider>
</template>
