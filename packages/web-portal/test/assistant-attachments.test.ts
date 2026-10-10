/** 附件预检覆盖格式边界、图片能力与容量配额，避免用户到发送后才看到可预知错误。 */
import { expect, test } from 'bun:test'
import { ASSISTANT_ATTACHMENT_ACCEPT, ASSISTANT_ATTACHMENT_LIMITS } from '@ai-token-report/shared'
import { assistantAttachmentAccept, assistantAttachmentError, assistantAttachmentKind, assistantAttachmentSize, assistantCanSend } from '../src/utils/assistantAttachments.js'

const file = (name: string, size = 100) => ({ name, size })

test('扩展名不区分大小写，现代 Office 与文本归类，二进制和旧 Office 拒绝', () => {
  expect(assistantAttachmentKind('截图.PNG')).toBe('image')
  for (const name of ['报告.docx', '表格.xlsx', '演示.pptx']) expect(assistantAttachmentKind(name)).toBe('document')
  for (const name of ['资料.txt', '说明.md', '表格.csv', '数据.jsonl', '设置.conf', '代码.ts', '.env']) expect(assistantAttachmentKind(name)).toBe('text')
  for (const name of ['程序.exe', '报告.doc', '表格.xls', '演示.ppt', '无扩展名', '假图片.png.exe']) expect(assistantAttachmentKind(name)).toBeUndefined()
})

test('未启用图片理解只禁图片；旧 mock 未返回能力字段仍可选图片', () => {
  expect(assistantAttachmentError([file('截图.png')], false)).toContain('未启用图片理解')
  expect(assistantAttachmentError([file('报告.docx')], false)).toBe('')
  expect(assistantAttachmentError([file('截图.png')])).toBe('')
  expect(assistantAttachmentAccept()).toBe(ASSISTANT_ATTACHMENT_ACCEPT)
  expect(assistantAttachmentAccept(false)).not.toContain('.png')
  expect(assistantAttachmentAccept(false)).toContain('.docx')
  expect(assistantAttachmentAccept(false)).toContain('.conf')
})

test('拒绝空文件、超过单个与合计上限、超过文件数；准确接受边界', () => {
  const limits = ASSISTANT_ATTACHMENT_LIMITS
  expect(assistantAttachmentError([file('空.txt', 0)])).toContain('空文件')
  expect(assistantAttachmentError([file('大.txt', limits.max_file_bytes + 1)])).toContain('单个附件')
  expect(assistantAttachmentError([file('大.png', limits.max_image_bytes + 1)])).toContain('单个图片')
  expect(assistantAttachmentError([file('图.png', limits.max_image_bytes)])).toBe('')
  expect(assistantAttachmentError([file('a.txt', limits.max_file_bytes), file('b.txt', limits.max_file_bytes)])).toBe('')
  expect(assistantAttachmentError([file('a.txt', limits.max_file_bytes), file('b.txt', limits.max_file_bytes), file('c.txt', 1)])).toContain('总大小')
  expect(assistantAttachmentError(Array.from({ length: limits.max_files + 1 }, (_, i) => file(`${i}.txt`)))).toContain('最多添加')
  expect(assistantAttachmentError(Array.from({ length: limits.max_files }, (_, i) => file(`${i}.txt`)))).toBe('')
})

test('只附件可以发送，未启用、加载中、发送中或图片能力关闭不能提交', () => {
  expect(assistantCanSend(' ', [file('报告.docx')], { enabled: true })).toBe(true)
  expect(assistantCanSend('分析', [], { enabled: true })).toBe(true)
  expect(assistantCanSend(' ', [], { enabled: true })).toBe(false)
  for (const state of [{ enabled: false }, { enabled: true, loading: true }, { enabled: true, sending: true }, { enabled: true, supportsImages: false }]) {
    expect(assistantCanSend('看图', [file('图.png')], state)).toBe(false)
  }
  expect(assistantCanSend('分析', [file('病毒.exe')], { enabled: true })).toBe(false)
})

test('文件卡同时呈现小文件与 MiB 大文件的可读容量', () => {
  expect(assistantAttachmentSize(14)).toBe('14 B')
  expect(assistantAttachmentSize(1024)).toBe('1.0 KB')
  expect(assistantAttachmentSize(5 * 1024 * 1024)).toBe('5.0 MB')
})
