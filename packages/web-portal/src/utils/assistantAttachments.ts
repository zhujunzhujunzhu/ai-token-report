/** 输入框附件只在发送时上传；本地校验让格式与容量错误在发起请求前可见。 */
import { ASSISTANT_ATTACHMENT_ACCEPT, ASSISTANT_ATTACHMENT_LIMITS, type AssistantAttachment } from '@ai-token-report/shared'

const imageExtensions = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif'])
const documentExtensions = new Set(['docx', 'xlsx', 'pptx'])
const acceptedExtensions = new Set(ASSISTANT_ATTACHMENT_ACCEPT.split(',').map(extension => extension.trim().replace(/^\./, '').toLowerCase()))

export function assistantAttachmentKind(fileName: string): AssistantAttachment['kind'] | undefined {
  const extension = fileName.split('.').at(-1)?.toLowerCase() ?? ''
  if (!fileName.includes('.') || !acceptedExtensions.has(extension)) return undefined
  return imageExtensions.has(extension) ? 'image' : documentExtensions.has(extension) ? 'document' : 'text'
}

export function assistantAttachmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function assistantAttachmentError(files: readonly Pick<File, 'name' | 'size'>[], supportsImages?: boolean): string {
  if (files.length > ASSISTANT_ATTACHMENT_LIMITS.max_files) return `每次最多添加 ${ASSISTANT_ATTACHMENT_LIMITS.max_files} 个附件`
  let total = 0
  for (const file of files) {
    const kind = assistantAttachmentKind(file.name)
    if (!kind) return `「${file.name}」格式不支持，请选择图片、Office 文件或文本文件`
    if (kind === 'image' && supportsImages === false) return '当前助手未启用图片理解，请联系管理员配置支持图片的模型；仍可上传 Office 和文本文件'
    if (file.size === 0) return `「${file.name}」是空文件`
    const limit = kind === 'image' ? ASSISTANT_ATTACHMENT_LIMITS.max_image_bytes : ASSISTANT_ATTACHMENT_LIMITS.max_file_bytes
    if (file.size > limit) return `「${file.name}」超过单个${kind === 'image' ? '图片' : '附件'} ${assistantAttachmentSize(limit)} 的限制`
    total += file.size
  }
  return total > ASSISTANT_ATTACHMENT_LIMITS.max_total_bytes ? `附件总大小不能超过 ${assistantAttachmentSize(ASSISTANT_ATTACHMENT_LIMITS.max_total_bytes)}` : ''
}

export function assistantAttachmentAccept(supportsImages?: boolean): string {
  return supportsImages === false ? ASSISTANT_ATTACHMENT_ACCEPT.split(',').filter(extension => !imageExtensions.has(extension.trim().replace(/^\./, ''))).join(',') : ASSISTANT_ATTACHMENT_ACCEPT
}

/** 没有文字也可以提交附件；服务端接受本轮之后才清除可重试的草稿。 */
export function assistantCanSend(prompt: string, files: readonly Pick<File, 'name' | 'size'>[], state: { enabled?: boolean; sending?: boolean; loading?: boolean; supportsImages?: boolean }): boolean {
  return !!state.enabled && !state.sending && !state.loading && (!!prompt.trim() || !!files.length) && !assistantAttachmentError(files, state.supportsImages)
}
