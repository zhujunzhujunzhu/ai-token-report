/** 对修改能力的询问不是授权；模型只能使用当前用户直接提出的命令。 */
import { expect, test } from 'bun:test'
import { assistantWriteIntent, assistantShareIntent } from '../src/assistant/intents.js'
test('编辑说明、联网教程、否定和查询不会挂载写工具', () => {
  for (const prompt of ['查询可编辑的项目规则', '为什么不能删除这条规则', '网上搜索修改模型单价的方法', '请告诉我如何删除人员', '不要删除这条规则', '查询一下是否需要修改价格', '解释修改规则会有什么影响']) expect(assistantWriteIntent(prompt)).toBe(false)
})
test('直接指令支持新建、编辑、删除以及续聊指向已有对象', () => {
  for (const prompt of ['请新建项目规则', '帮我把张三名字改成李四', '把刚才那条删除', '删除这条规则', '我希望添加一条项目归一化规则', '我想修改这条规则', '可以删除刚才的规则吗', '可以帮我停用这个分组吗', '请将这条规则启用', '搜索官网价格；然后更新这条单价', 'Update this rule']) expect(assistantWriteIntent(prompt)).toBe(true)
})
test('肯定续聊与请求前缀可叠加，明确保存和写入也是授权', () => {
  for (const prompt of ['是的直接帮我新建两条', '好的请帮我新增规则', '嗯那就直接保存', '好的，麻烦你直接帮我添加一条规则', '现在请帮我把这条规则改为新名称', '请直接写入这两条规则', '帮我保存刚才的修改', '请帮我新增两条规则，别名分别是 dashscope 和 deepseek-official', 'Save this rule']) expect(assistantWriteIntent(prompt)).toBe(true)
})
test('肯定本身、叠加前缀的查询以及否定不开放写入', () => {
  for (const prompt of ['是的', '好', '好的', '嗯那就这样', '好的请帮我查询新增的规则', '是的直接帮我查看可编辑规则', '好的请告诉我保存规则的步骤', '嗯那就不要保存', '是的，但不需要修改', '好的，请解释新增规则的影响', '请别帮我新增规则', '帮我新建草稿但别保存']) expect(assistantWriteIntent(prompt)).toBe(false)
})
test('打开新建弹框和预填等待用户保存不授权直接写入，独立的保存指令可以授权', () => {
  for (const prompt of ['帮我新建供应商规则的填写弹框', '请打开新建规则表单，我填写后保存', '帮我把这些预填到新建弹框，等我点击保存', '直接帮我新建规则弹框', '帮我打开供应商规则新建弹框，预填原供应商，让我填写后保存']) expect(assistantWriteIntent(prompt)).toBe(false)
  for (const prompt of ['先打开表单，然后直接帮我保存这条规则', '保存刚才在表单中填写的价格']) expect(assistantWriteIntent(prompt)).toBe(true)
})
test('并将与并把保留修改对象，查询与否定仍不构成授权', () => {
  for (const prompt of ['先处理前两个，并将阿里云百炼的部分改为 数字集阿里云', '先查询现有规则，并把这条规则改名为新名称']) expect(assistantWriteIntent(prompt)).toBe(true)
  for (const prompt of ['先查询现有规则，并将查询结果列出来', '先查询现有规则，并把如何修改的步骤告诉我', '先查询现有规则，并将这条规则保留，不要修改']) expect(assistantWriteIntent(prompt)).toBe(false)
})
test('文件默认私有；明确分享指令才开放发布工具', () => {
  for (const prompt of ['生成HTML', '不要分享文件', '如何分享HTML', '解释分享链接的规则', '查询公开资料', '查看之前分享的HTML报告', '生成一份介绍公开API的HTML', '给我看看之前的公开链接', '提供说明介绍如何生成分享链接', '只查一下，不要分享']) expect(assistantShareIntent(prompt)).toBe(false)
  for (const prompt of ['生成HTML并分享24小时', '分享刚才的HTML', '再把 HTML 分享给我，有效期24小时', '把刚才这份模型用量整理成 Word、Excel 和 HTML 三个可下载文件，表格要保留同一份真实数据；再把 HTML 分享给我，有效期24小时。', '请给我一个24小时HTML分享链接', '生成HTML并给我一个有效24小时的分享链接', 'Share this report']) expect(assistantShareIntent(prompt)).toBe(true)
})
test('历史分享查询不开放发布工具；独立的发布请求仍可授权', () => {
  for (const prompt of ['目前对外开放的 html 页面有哪些', '列出目前对外开放的 HTML 页面', '查询已有分享链接', '把目前公开的 HTML 列出来', '请把之前分享的报告列一下', '请给我看看已分享报告的链接和有效期']) expect(assistantShareIntent(prompt)).toBe(false)
  for (const prompt of ['列出当前分享页面，然后分享刚才的 HTML', '查看已有分享；分享刚才的 HTML', '生成HTML并分享24小时', '分享当前查询结果的HTML', '把刚才的 HTML 分享给我，再把之前的公开页面列出来', '请把当前公开的 HTML 列出来，然后把刚才的报告分享给我', '把已分享页面列一下，并将新报告公开24小时', '把之前的 HTML 分享给我并列出链接']) expect(assistantShareIntent(prompt)).toBe(true)
})
