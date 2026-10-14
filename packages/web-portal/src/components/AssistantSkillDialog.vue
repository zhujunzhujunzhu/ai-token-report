<script setup lang="ts">
/**
 * 「技能管理」弹框外壳：`/skills` 与斜杠菜单里的「管理技能」都打开这里，不经过模型。
 *
 * ★ 建技能已经不在弹框里：用户在对话里说清名称与用途，助手用 `create_skill` 生成并保存
 *   （带脚本的技能也会一起保存）。所以这里只剩「看有哪些、看看脚本、删掉不用的」。
 * ★ 表单主体在 `AssistantSkillForm.vue`：`el-dialog` 的内容只在客户端渲染，
 *   SSR 与构建期校验都拿不到它，所以文案与校验放在那个组件里。
 * ★ `class="assistant-layer-popup"` 必须保留：页面操作桥据此排除助手自己的浮层，
 *   否则弹框里的按钮会被当成当前页面的可操作控件暴露给模型。
 */
import { ElDialog } from 'element-plus'
import type { AssistantCustomSkill } from '@ai-token-report/shared'
import AssistantSkillForm from './AssistantSkillForm.vue'
import { ASSISTANT_POPUP_Z_INDEX } from '../utils/assistantLayer.js'

defineProps<{ modelValue: boolean; skills: readonly AssistantCustomSkill[]; loadError?: string }>()
const emit = defineEmits<{ 'update:modelValue': [open: boolean]; changed: [] }>()
</script>

<template>
  <el-dialog
    :model-value="modelValue" class="assistant-layer-popup" title="技能管理" width="min(560px, 94vw)"
    :z-index="ASSISTANT_POPUP_Z_INDEX" destroy-on-close append-to-body
    :close-on-click-modal="false" :close-on-press-escape="true"
    @update:model-value="value => emit('update:modelValue', value)"
  >
    <AssistantSkillForm :open="modelValue" :skills="skills" :load-error="loadError" @close="emit('update:modelValue', false)" @changed="emit('changed')" />
  </el-dialog>
</template>