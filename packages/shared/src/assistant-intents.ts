/** 浏览器与服务端使用同一份本轮写入授权识别；页面内容与工具参数不能自行开启写操作。 */
export function assistantWriteIntent(prompt: string): boolean {
  const action = '(?:修改|编辑|更新|新增|新建|创建|添加|保存|写入|删除|移除|停用|禁用|启用|恢复|归档|改成|改为|改名|设置|设为|调整|rename|delete|remove|disable|enable|restore|archive|update|create|edit|save)'
  const prefix = '(?:是的|好的|好|嗯|那就|那么|那|请(?:你)?|帮我|帮助我|麻烦(?:你)?|直接|现在|我(?:希望|需要|想要|想)(?:你)?|你可以(?:帮我)?|可以(?:帮我)?|能否(?:帮我)?)'
  const directAction = new RegExp('^(?:(?:把|将)[\\s\\S]*' + action + '|' + action + '|(?:点击|按下|点一下)\\s*(?:保存|恢复|归档|save|restore|archive))', 'i')
  // ★ 分句只去掉连接词；“并将/并把”中的将/把仍是直接修改指令的语法边界。
  const saveClause = /(?:并(?=(?:(?:请|直接|帮我|你)\s*)*(?:保存|写入|save))|(?:填好|填完|填写完成)后(?=(?:(?:请|直接|帮我|你)\s*)*(?:保存|写入|save)))/i
  return prompt.split(/[。！？!?\n；;]|(?:然后|并且|并(?=将|把))/).flatMap(clause => {
    // ★ “等我核对并保存”保留用户自己保存的主语，不能拆成授权助手保存的新指令。
    return /等我|让我|由我|我来|我自己|不要|不需要|无需|禁止|不允许|不能/.test(clause) ? [clause] : clause.split(saveClause)
  }).some(clause => {
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
