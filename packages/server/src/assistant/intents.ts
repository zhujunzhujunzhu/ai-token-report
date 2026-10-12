/** 写工具只由本轮用户直接指令启用，联网内容与旧工具结果不能开启它。 */
export { assistantWriteIntent } from '@ai-token-report/shared'
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
