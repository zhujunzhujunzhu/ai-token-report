<script setup lang="ts">
/**
 * 「新建技能」表单主体：保存一段可复用的 `/命令 + 指令草稿`，并选择仅自己或所有人可见。
 *
 * ★ 表单与弹框拆开：Element Plus 的 `el-dialog` 内容只在客户端渲染，SSR 验证拿不到它；
 *   拆成组件后既能在真实页面里复用，也能被 SSR 直接执行核对外文案（同仓库其它弹框的做法）。
 * ★ 技能不携带权限：公开技能进入全部门的斜杠菜单，但每个人调用时仍按自己的身份取数。
 */
import { computed, reactive, ref, watch } from 'vue'
import { ElAlert, ElButton, ElForm, ElFormItem, ElInput, ElMessage, ElMessageBox, ElRadioButton, ElRadioGroup } from 'element-plus'
import { ASSISTANT_CUSTOM_SKILL_LIMITS, type AssistantCustomSkill } from '@ai-token-report/shared'
import { createAssistantSkill, deleteAssistantSkill } from '../api/assistant.js'
import { ASSISTANT_POPUP_Z_INDEX } from '../utils/assistantLayer.js'
import { assistantSkillFormError, assistantSkillInput, emptyAssistantSkillForm } from '../utils/assistantSkillForm.js'
import { assistantSkillBadge } from '../utils/assistantSkills.js'

const props = defineProps<{ skills: readonly AssistantCustomSkill[]; loadError?: string; open?: boolean }>()
const emit = defineEmits<{ close: []; changed: []; created: [skill: AssistantCustomSkill] }>()

const draft = reactive(emptyAssistantSkillForm())
const busy = ref(false)
const error = ref('')
const visibilityHint = computed(() => draft.visibility === 'public'
  ? '所有人可见：会出现在每个成员的斜杠菜单里；任何人都能调用，但它不会让别人多看见一行数据。'
  : '仅自己可见：只有你的斜杠菜单里有这条命令。')
const privateCount = computed(() => props.skills.filter(skill => skill.visibility === 'private' && skill.mine).length)
const publicCount = computed(() => props.skills.filter(skill => skill.visibility === 'public').length)

// 每次打开都是新的一份草稿：上次填到一半的内容不该被当成本次要保存的技能。
watch(() => props.open, open => {
  if (!open) return
  Object.assign(draft, emptyAssistantSkillForm())
  error.value = ''
}, { immediate: true })

async function submit(): Promise<void> {
  if (busy.value) return
  const invalid = assistantSkillFormError(draft)
  if (invalid) { error.value = invalid; return }
  busy.value = true
  error.value = ''
  try {
    const result = await createAssistantSkill(assistantSkillInput(draft))
    if (!result.ok) { error.value = result.error; return }
    ElMessage.success(`已保存技能 ${result.data.skill.command}`)
    emit('created', result.data.skill)
    emit('changed')
    emit('close')
  } finally { busy.value = false }
}

async function remove(skill: AssistantCustomSkill): Promise<void> {
  if (busy.value) return
  try {
    await ElMessageBox.confirm(`删除技能 ${skill.command} 后，斜杠菜单里不再出现它。已保存的对话记录不受影响。`, '删除技能', { type: 'warning', zIndex: ASSISTANT_POPUP_Z_INDEX, customClass: 'assistant-layer-popup' })
  } catch { return }
  busy.value = true
  error.value = ''
  try {
    await deleteAssistantSkill(skill.skill_id)
    ElMessage.success(`已删除技能 ${skill.command}`)
    emit('changed')
  } catch (err) { error.value = err instanceof Error ? err.message : '删除技能失败，请重试' }
  finally { busy.value = false }
}
</script>

<template>
  <div class="assistant-skill-form">
    <p class="skill-note">技能 = 一条 <code>/命令</code> + 一段默认指令草稿。它与内置的管理报表技能共用同一套能力与权限，不会新增数据范围，也不自动分享或写入任何配置。</p>
    <el-alert v-if="loadError" :title="loadError" type="warning" :closable="false" show-icon />
    <el-form label-position="top" :disabled="busy" @submit.prevent="submit">
      <el-form-item label="命令">
        <el-input v-model="draft.command" placeholder="/weekly-cost" :maxlength="ASSISTANT_CUSTOM_SKILL_LIMITS.command_chars" autocomplete="off" />
      </el-form-item>
      <el-form-item label="技能标题"><el-input v-model="draft.title" placeholder="例如：上周费用对比" :maxlength="ASSISTANT_CUSTOM_SKILL_LIMITS.title_chars" show-word-limit autocomplete="off" /></el-form-item>
      <el-form-item label="技能说明"><el-input v-model="draft.description" placeholder="一句话说明这条技能解决什么问题" :maxlength="ASSISTANT_CUSTOM_SKILL_LIMITS.description_chars" show-word-limit autocomplete="off" /></el-form-item>
      <el-form-item label="指令草稿">
        <el-input v-model="draft.prompt" type="textarea" :autosize="{ minRows: 3, maxRows: 6 }" resize="vertical" :maxlength="ASSISTANT_CUSTOM_SKILL_LIMITS.prompt_chars" show-word-limit placeholder="例如：生成上月的费用分析报表，按供应商和模型分布，导出 Excel" />
      </el-form-item>
      <el-form-item label="可见范围">
        <el-radio-group v-model="draft.visibility" aria-label="技能可见范围">
          <el-radio-button value="private">仅自己可见</el-radio-button>
          <el-radio-button value="public">所有人可见</el-radio-button>
        </el-radio-group>
        <p class="skill-hint">{{ visibilityHint }}</p>
      </el-form-item>
      <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon />
      <div class="dialog-actions">
        <span class="skill-quota">私有 {{ privateCount }} / {{ ASSISTANT_CUSTOM_SKILL_LIMITS.private_per_member }} · 公开 {{ publicCount }} / {{ ASSISTANT_CUSTOM_SKILL_LIMITS.public_total }}</span>
        <el-button @click="emit('close')">取消</el-button>
        <el-button type="primary" native-type="submit" :loading="busy">保存技能</el-button>
      </div>
    </el-form>
    <section v-if="skills.length" class="skill-list" aria-label="已有技能">
      <h3>已有技能 · {{ skills.length }}</h3>
      <div v-for="skill in skills" :key="skill.skill_id" class="skill-row">
        <div class="skill-row-main">
          <span class="skill-command">{{ skill.command }}</span>
          <strong>{{ skill.title }}</strong>
          <small>{{ skill.visibility === 'public' ? (skill.owner_name ? `部门共享 · 由 ${skill.owner_name} 创建` : '部门共享') : '仅自己可见' }}</small>
        </div>
        <el-button v-if="skill.can_delete" text type="danger" :disabled="busy" :aria-label="`删除技能 ${skill.command}`" @click="remove(skill)">删除</el-button>
        <span v-else class="skill-readonly">{{ assistantSkillBadge({ id: skill.skill_id, command: skill.command, title: skill.title, description: skill.description, prompt: skill.prompt, kind: 'custom', visibility: skill.visibility }) }}</span>
      </div>
    </section>
  </div>
</template>

<style scoped>
.skill-note { margin: 0 0 12px; color: #7b8ba3; font-size: 12px; line-height: 1.8; }
.skill-note code { padding: 1px 5px; border-radius: 4px; background: #f0f4fb; color: #46618c; font-size: 11px; }
.skill-hint { margin: 6px 0 0; color: #8b9bb1; font-size: 11px; line-height: 1.7; }
.skill-quota { flex: 1; color: #92a1b6; font-size: 11px; }
.skill-list { margin-top: 14px; padding-top: 12px; border-top: 1px solid #edf1f8; }
.skill-list h3 { margin: 0 0 8px; color: #53637a; font-size: 12px; font-weight: 600; }
.skill-row { display: flex; align-items: center; gap: 10px; padding: 7px 0; border-bottom: 1px solid #f2f5fa; }
.skill-row:last-child { border-bottom: 0; }
.skill-row-main { flex: 1; min-width: 0; }
.skill-command { display: block; color: #3275ed; font-family: ui-monospace, monospace; font-size: 11px; }
.skill-row-main strong { display: block; margin-top: 3px; color: #465e7f; font-size: 12px; font-weight: 500; }
.skill-row-main small { display: block; margin-top: 3px; color: #8b9bb1; font-size: 10px; overflow-wrap: anywhere; }
.skill-readonly { color: #9aa8bb; font-size: 10px; }
</style>