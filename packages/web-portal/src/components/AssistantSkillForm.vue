<script setup lang="ts">
/**
 * 「技能管理」主体：看已保存的 `/命令` 与它带的脚本，删除不用的。
 *
 * ★ 建技能不在这里：用户对着助手说清名称与用途，助手用 `create_skill` 生成并保存；
 *   手填四个字段的旧表单已经删掉（它要求用户先想好命令与草稿，正好是用户不想要的那一步）。
 * ★ 脚本用 `<details>` 原样展示、**绝不在这里执行**：执行发生在服务端沙箱里，而且只在
 *   用户本轮明确调用这条技能的那一轮；页面连一个 eval 都没有，也没有任何「运行」按钮。
 *   `<details>` 而不是 JS 折叠状态：脚本原文始终在 DOM 里，SSR 校验能直接断言它。
 * ★ 技能不携带权限：公开技能进入全部门的斜杠菜单，但每个人调用时仍按自己的身份取数。
 */
import { computed, ref, watch } from 'vue'
import { ElAlert, ElButton, ElMessage, ElMessageBox } from 'element-plus'
import { ASSISTANT_CUSTOM_SKILL_LIMITS, type AssistantCustomSkill } from '@ai-token-report/shared'
import { deleteAssistantSkill } from '../api/assistant.js'
import { ASSISTANT_POPUP_Z_INDEX } from '../utils/assistantLayer.js'
import { assistantSkillBadge } from '../utils/assistantSkills.js'

const props = defineProps<{ skills: readonly AssistantCustomSkill[]; loadError?: string; open?: boolean }>()
const emit = defineEmits<{ close: []; changed: [] }>()

const busy = ref(false)
const error = ref('')
const privateCount = computed(() => props.skills.filter(skill => skill.visibility === 'private' && skill.mine).length)
const publicCount = computed(() => props.skills.filter(skill => skill.visibility === 'public').length)
const scriptCount = computed(() => props.skills.filter(skill => skill.script).length)

// 每次打开都把上一次的删除失败清掉：那是上一轮的错误，不该跟着弹框留下来。
watch(() => props.open, open => { if (open) error.value = '' }, { immediate: true })

function badge(skill: AssistantCustomSkill): string {
  return assistantSkillBadge({ id: skill.skill_id, command: skill.command, title: skill.title, description: skill.description, prompt: skill.prompt, kind: 'custom', visibility: skill.visibility, hasScript: !!skill.script })
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
    <p class="skill-note">
      技能由对话生成：对助手说「帮我建一个技能」并写清名称与用途即可（斜杠菜单里的
      <code>/create-skill</code> 会先把模板填进输入框）。技能与内置的管理报表技能共用同一套能力与权限，
      不会新增数据范围，也不自动分享或写入任何配置。
    </p>
    <p class="skill-note">
      带脚本的技能只在<strong>你本轮明确调用它</strong>时执行：脚本在服务端受限沙箱里同步运行，没有网络、文件与系统接口，
      输入输出与耗时都有上限；结果是脚本算出来的，引用时会标明它不是平台统计口径。
    </p>
    <el-alert v-if="loadError" :title="loadError" type="warning" :closable="false" show-icon />
    <section v-if="skills.length" class="skill-list" aria-label="已有技能">
      <h3>已有技能 · {{ skills.length }}<span v-if="scriptCount" class="skill-count-note">（其中 {{ scriptCount }} 条带脚本）</span></h3>
      <div v-for="skill in skills" :key="skill.skill_id" class="skill-row">
        <div class="skill-row-main">
          <span class="skill-command">{{ skill.command }}</span>
          <strong>{{ skill.title }}<em v-if="skill.script" class="skill-flag">含脚本</em></strong>
          <small>{{ badge(skill) }}{{ skill.visibility === 'public' && skill.owner_name ? ` · 由 ${skill.owner_name} 创建` : '' }}</small>
          <p v-if="skill.description" class="skill-description">{{ skill.description }}</p>
        </div>
        <el-button v-if="skill.can_delete" text type="danger" :disabled="busy" :aria-label="`删除技能 ${skill.command}`" @click="remove(skill)">删除</el-button>
        <span v-else class="skill-readonly">不可删除</span>
        <details v-if="skill.script" class="skill-script-box">
          <summary>查看脚本</summary>
          <pre class="skill-script">{{ skill.script }}</pre>
        </details>
      </div>
    </section>
    <p v-else class="skill-empty">还没有自定义技能。试试对助手说：帮我建一个技能，名称「按模型汇总」，用途是把查询到的行按模型汇总。</p>
    <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon />
    <div class="dialog-actions">
      <span class="skill-quota">私有 {{ privateCount }} / {{ ASSISTANT_CUSTOM_SKILL_LIMITS.private_per_member }} · 公开 {{ publicCount }} / {{ ASSISTANT_CUSTOM_SKILL_LIMITS.public_total }}</span>
      <el-button @click="emit('close')">关闭</el-button>
    </div>
  </div>
</template>

<style scoped>
.skill-note { margin: 0 0 10px; color: #7b8ba3; font-size: 12px; line-height: 1.8; }
.skill-note code { padding: 1px 5px; border-radius: 4px; background: #f0f4fb; color: #46618c; font-size: 11px; }
.skill-quota { flex: 1; color: #92a1b6; font-size: 11px; }
.skill-list { margin-top: 14px; padding-top: 12px; border-top: 1px solid #edf1f8; }
.skill-list h3 { margin: 0 0 8px; color: #53637a; font-size: 12px; font-weight: 600; }
.skill-count-note { color: #93a3b8; font-weight: 400; }
.skill-row { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; padding: 8px 0; border-bottom: 1px solid #f2f5fa; }
.skill-row:last-child { border-bottom: 0; }
.skill-row-main { flex: 1; min-width: 0; }
.skill-command { display: block; color: #3275ed; font-family: ui-monospace, monospace; font-size: 11px; }
.skill-row-main strong { display: block; margin-top: 3px; color: #465e7f; font-size: 12px; font-weight: 500; }
.skill-row-main small { display: block; margin-top: 3px; color: #8b9bb1; font-size: 10px; overflow-wrap: anywhere; }
.skill-description { margin: 4px 0 0; color: #8b9bb1; font-size: 11px; line-height: 1.6; }
.skill-flag { margin-left: 6px; padding: 1px 5px; border-radius: 4px; background: #eef4ff; color: #4b6ea8; font-size: 10px; font-style: normal; font-weight: 400; }
.skill-script-box { flex: 1 0 100%; margin: 2px 0 0; }
.skill-script-box summary { color: #6b7d96; font-size: 11px; cursor: pointer; }
.skill-script { max-height: 180px; margin: 6px 0 0; padding: 8px 10px; overflow: auto; border-radius: 8px; background: #f6f8fc; color: #46618c; font-family: ui-monospace, monospace; font-size: 11px; line-height: 1.7; white-space: pre-wrap; overflow-wrap: anywhere; }
.skill-readonly { color: #9aa8bb; font-size: 10px; }
.skill-empty { margin: 12px 0 0; padding: 12px; border-radius: 8px; background: #f6f8fc; color: #7b8ba3; font-size: 12px; line-height: 1.8; }
</style>