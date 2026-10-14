/** 写工具只由本轮用户直接指令启用，联网内容与旧工具结果不能开启它。 */
export { assistantWriteIntent } from '@ai-token-report/shared'

/**
 * 建技能只认本轮用户自己的原话。
 *
 * ★ `assistantWriteIntent()` 认不出「帮我**建**一个技能」（它的动词表是新建/创建/添加），
 *   所以建技能另立一条：**去掉礼貌前缀后必须以创建动作开头**，且宾语里要有「技能/命令」。
 *   这样可以挡住「这个技能怎么用」「保存技能要注意什么」「技能列表有什么」这类提问 ——
 *   它们都含「技能」，但都不是让助手写一条技能。
 * ★ 技能草稿、附件与网页内容都不是授权来源（调用点只传 `intent`）。
 */
export function assistantSkillCreateIntent(prompt: string): boolean {
  const action = '(?:新建|创建|添加|保存|存成|做成|建立|定义|定制|生成|建)'
  const noun = '(?:技能|命令|skill)'
  const prefix = '(?:是的|好的|好|嗯|那就|那么|那|请(?:你)?|帮我|帮助我|麻烦(?:你)?|直接|现在|我(?:希望|需要|想要|想|要)(?:你)?|你可以(?:帮我)?|可以(?:帮我)?|能否(?:帮我)?)'
  return prompt.split(/[。！？!?\n；;]/).some(clause => {
    let text = clause.trim()
    if (!text || /不要|不需要|无需|禁止|不允许|不能|如何|怎么|为什么|方法|教程|步骤|什么|哪些|注意事项?/.test(text)) return false
    if (/^(?:查询|查看|看看|搜索|查找|解释|告诉我|介绍|学习|了解|删除|移除|停用|分享)/.test(text)) return false
    text = text.replace(new RegExp('^(?:' + prefix + '\\s*[，,、]?\\s*)+', 'i'), '')
    if (new RegExp('^' + action).test(text)) return new RegExp(action + '[\\s\\S]{0,20}' + noun).test(text)
    // 「把刚才那套流程存成一个技能」也是明确指令：动词不在句首，但仍是用户本人的要求。
    return new RegExp('^(?:把|将)[\\s\\S]{0,40}' + action + '[\\s\\S]{0,20}' + noun).test(text)
  })
}

/**
 * 保存为**公开**技能必须由用户本轮自己说出来。
 *
 * ★ 默认只有 private：替用户决定「公开给全部门」是另一个量级的决定，不能让模型顺手做。
 * ★ 同一句里既要提到技能/命令、又要有公开字面量；否则「帮我建个技能。另外把报告公开」
 *   会被读成「这条技能公开」—— 那是拿分享报告的意图去授权全员可见。
 * ★ 第二种写法也要认：`/create-skill` 预填的模板本身分好几行（名称 / 用途 / 输出 /
 *   数据处理方式），用户把「所有人可见」补在名称或用途那一行是最自然的写法。所以
 *   **已经确认本轮就是要建技能**时，允许公开字面量单独成句 —— 但仍然拒绝同一句里带着
 *   别的对象（分享 / 报告 / 文件 / 链接 / 页面…）的写法，那些说的是那份东西，不是这条技能。
 */
export function assistantPublicSkillIntent(prompt: string): boolean {
  const clauses = prompt.split(/[。！？!?\n；;]/)
  const denied = (text: string): boolean => !text || /不要|不需要|无需|禁止|不允许|不能|如何|怎么|为什么/.test(text)
  const shared = /所有人可见|全员可见|所有人可用|部门共享|共享给所有人|共享给全部门|公开/
  // ① 同一句里既提到技能、又说了公开范围：最明确的写法。但同一句里在讲「导出 / 分享
  //    一份东西」时不算 —— 那说的是那份报表或文件，不是这条技能的可见范围。
  if (clauses.some(clause => {
    const text = clause.trim()
    return !denied(text) && /(?:技能|命令|skill)/.test(text) && shared.test(text) && !/分享|发布|导出|邮件|链接/.test(text)
  })) return true
  // ② 本轮确实是要建技能时，公开字面量可以单独一句；带别的对象就不算（见上方注释）。
  if (!assistantSkillCreateIntent(prompt)) return false
  return clauses.some(clause => {
    const text = clause.trim()
    return !denied(text) && shared.test(text) && !/分享|发布|导出|链接|报告|文件|邮件|页面|报表|HTML/.test(text)
  })
}
export function assistantShareIntent(prompt: string): boolean {
  return prompt.split(/[。！？!?\n；;]/).some(clause => {
    const text = clause.trim()
    if (!text || /不要|不需要|无需|禁止|如何|怎么|为什么|方法|教程|解释|搜索/.test(text)) return false
    if (/^(?:请|帮我|请帮我)?(?:查看|查询|看看|给我看|提供说明|介绍|了解)/.test(text)) return false
    // ★ “把公开的页面列出来”只读取已有链接，不能因为宾语含“公开/分享”就开放发布工具。
    const listing = /^(?:(?:请|帮我|请帮我|麻烦你)\s*)?(?:把|将)([\s\S]*?)(?:列出来?|列一下|列给我|给我看)([\s\S]*)$/.exec(text)
    if (listing && !/(?:分享|共享|公开|发布)/.test(listing[2]!)) {
      const object = listing[1]!
      if ([...object.matchAll(/分享|共享|公开|发布/g)].every(match => /(?:已|曾)$/.test(object.slice(0, match.index)) || /^(?:过)?的/.test(object.slice(match.index + match[0].length)))) return false
    }
    return /^(?:(?:请|帮我|请帮我|麻烦你|直接|我希望你|我需要你)\s*)?(?:分享|共享|发布|share|publish)/i.test(text)
      || /^(?:(?:请|再|然后|并|帮我|请帮我)\s*)*(?:把|将)[\s\S]*(?:分享|共享|公开|发布)/.test(text)
      || /(?:并|然后|再)(?:请|帮我|给我)?(?:分享|共享|发布)/.test(text)
      || /^(?:我希望|我需要|我想要)(?:一个|一份)?(?:分享链接|公开链接)/.test(text)
      || /(?:给我|提供|生成|创建)(?:一个|一份)?[\s\S]{0,30}(?:分享|共享|公开)链接/.test(text)
  })
}
