/** 写工具只由本轮用户直接指令启用，联网内容与旧工具结果不能开启它。 */
export function assistantWriteIntent(prompt: string): boolean {
  const action = '(?:修改|编辑|更新|新增|新建|创建|添加|保存|写入|删除|移除|停用|禁用|启用|改成|改为|改名|设置|设为|调整|rename|delete|remove|disable|enable|update|create|edit|save)'
  const prefix = '(?:是的|好的|好|嗯|那就|那么|那|请(?:你)?|帮我|帮助我|麻烦(?:你)?|直接|现在|我(?:希望|需要|想要|想)(?:你)?|你可以(?:帮我)?|可以(?:帮我)?|能否(?:帮我)?)'
  const directAction = new RegExp('^(?:(?:把|将)[\\s\\S]*' + action + '|' + action + ')', 'i')
  // ★ 分句只去掉连接词；“并将/并把”中的将/把仍是直接修改指令的语法边界。
  return prompt.split(/[。！？!?\n；;]|(?:然后|并且|并(?=将|把))/).some(clause => {
    let text = clause.trim()
    // ★ “别名”“分别”是规则填写的正常用词；否定的“别”需要处在命令边界。
    if (!text || /不要|不需要|无需|禁止|不允许|(?:^|[，,、\s]|请|也|但|还是|先|就|现在)别(?!名)|不能|如何|怎么|为什么|方法|教程|步骤/.test(text)) return false
    // ★ 续聊常把肯定、请求与“直接”叠在一起；去掉前缀后仍必须有明确动作，纯肯定不授权。
    text = text.replace(new RegExp('^(?:' + prefix + '\\s*[，,、]?\\s*)+', 'i'), '')
    // ★ 新建弹框与预填表单只请求填写；不能把宾语里的“新建”或用户之后点击“保存”当直接写入。
    if (/(?:弹框|弹窗|表单|对话框)/.test(text)
      && /(?:打开|弹出|预填|填写|点击保存|(?:新建|创建)[\s\S]*(?:弹框|弹窗|表单|对话框))/.test(text)
      && !/^(?:保存|写入|save)/i.test(text)) return false
    // ★ “查询可编辑规则”“搜索修改方法”没有写入授权；直接指令可包含被修改的对象。
    if (/^(?:查询|查看|看看|搜索|查找|解释|告诉我|介绍|学习|了解)/.test(text)) return false
    return directAction.test(text)
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
