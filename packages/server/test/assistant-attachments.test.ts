/** 上传解析直接用完整 ZIP/PNG 夹具，防止只测伪造 MIME 或内部提取函数。 */
import { describe, expect, test } from 'bun:test'
import { crc32, deflateRawSync, deflateSync } from 'node:zlib'
import { prepareAssistantAttachments } from '../src/assistant/attachments.js'
import { IdentityError } from '../src/identity/types.js'

const encoder = new TextEncoder()
type ZipPart = { name: string; text: string; flags?: number; stored?: boolean; declaredSize?: number; badCrc?: boolean }
// 测试夹具同时写本地头、中央目录和尾记录；生产代码仍由成熟 ZIP 库解析。
function zip(parts: ZipPart[]): Uint8Array {
  const local: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const part of parts) {
    const name = Buffer.from(part.name)
    const bytes = Buffer.from(part.text)
    const data = part.stored ? bytes : deflateRawSync(bytes)
    const flags = part.flags ?? 0x800
    const checksum = part.badCrc ? crc32(bytes) ^ 1 : crc32(bytes)
    const size = part.declaredSize ?? bytes.length
    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(flags, 6)
    header.writeUInt16LE(part.stored ? 0 : 8, 8)
    header.writeUInt32LE(checksum >>> 0, 14)
    header.writeUInt32LE(data.length, 18)
    header.writeUInt32LE(size, 22)
    header.writeUInt16LE(name.length, 26)
    local.push(header, name, data)
    const record = Buffer.alloc(46)
    record.writeUInt32LE(0x02014b50)
    record.writeUInt16LE(20, 4)
    record.writeUInt16LE(20, 6)
    record.writeUInt16LE(flags, 8)
    record.writeUInt16LE(part.stored ? 0 : 8, 10)
    record.writeUInt32LE(checksum >>> 0, 16)
    record.writeUInt32LE(data.length, 20)
    record.writeUInt32LE(size, 24)
    record.writeUInt16LE(name.length, 28)
    record.writeUInt32LE(offset, 42)
    central.push(record, name)
    offset += header.length + name.length + data.length
  }
  const directory = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50)
  end.writeUInt16LE(parts.length, 8)
  end.writeUInt16LE(parts.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, directory, end])
}
const mainTypes = {
  docx: ['word/document.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'],
  xlsx: ['xl/workbook.xml', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml'],
  pptx: ['ppt/presentation.xml', 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml'],
} as const
function office(ext: keyof typeof mainTypes, parts: ZipPart[]): Uint8Array {
  const [name, type] = mainTypes[ext]
  return zip([{ name: '[Content_Types].xml', text: `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/${name}" ContentType="${type}"/></Types>` }, ...parts])
}
function word(text = '你好 &amp; 世界'): Uint8Array {
  return office('docx', [{ name: 'word/document.xml', text: `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r><w:r><w:tab/><w:t>结尾</w:t></w:r></w:p><w:p><w:r><w:t>第二段🙂</w:t></w:r></w:p></w:body></w:document>` }])
}
function png(width = 1, height = 1, depth = 8): Uint8Array {
  function chunk(type: string, data: Buffer): Buffer {
    const bytes = Buffer.alloc(data.length + 12)
    bytes.writeUInt32BE(data.length)
    bytes.write(type, 4, 'ascii')
    data.copy(bytes, 8)
    bytes.writeUInt32BE(crc32(bytes.subarray(4, 8 + data.length)), 8 + data.length)
    return bytes
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width)
  header.writeUInt32BE(height, 4)
  header[8] = depth
  header[9] = 6
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.from([0, 255, 0, 0, 255]))), chunk('IEND', Buffer.alloc(0))])
}
const file = (name: string, bytes: string | Uint8Array, type = '') => new File([bytes], name, { type })
async function fails(files: File[], status: number, phrase?: string): Promise<void> {
  try { await prepareAssistantAttachments(files); throw new Error('应拒绝该附件') }
  catch (error) {
    expect(error).toBeInstanceOf(IdentityError)
    expect((error as IdentityError).status).toBe(status)
    if (phrase) expect((error as Error).message).toContain(phrase)
  }
}

describe('助手附件正文解析', () => {
  test('UTF-8、UTF-16 两种 BOM、Markdown 与代码按原文解析', async () => {
    const text = '中文🙂\r\n一行'
    const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])
    const be = Buffer.from(le)
    be.swap16()
    const prepared = await prepareAssistantAttachments([file('说明.md', text), file('数据.txt', le), file('数据.conf', be), file('code.ts', 'const x = "<script>"')])
    for (const item of prepared.slice(0, 3)) expect(item.text).toBe('中文🙂\n一行')
    expect(prepared[3]!.text).toBe('const x = "<script>"')
    expect(prepared[0]!.metadata.kind).toBe('text')
    expect(prepared[0]!.metadata.file_name).toBe('说明.md')
    expect(prepared[0]!.metadata.attachment_id).not.toBe(prepared[1]!.metadata.attachment_id)
  })

  test('Word 保留分段、制表符、Unicode 与内置 XML 实体', async () => {
    const input = word()
    const [prepared] = await prepareAssistantAttachments([file('报告.docx', input, 'application/octet-stream')])
    expect(prepared!.text).toBe('你好 & 世界\t结尾\n第二段🙂')
    expect(prepared!.metadata.kind).toBe('document')
    expect(prepared!.metadata.media_type).toContain('wordprocessingml.document')
    expect(prepared!.bytes).toEqual(input)
    expect(prepared!.metadata.note).toContain('图片')
  })

  test('Word 表格保留每行与单元格列关系，正文不重复', async () => {
    const input = office('docx', [{ name: 'word/document.xml', text: '<w:document xmlns:w="urn:w"><w:body><w:p><w:r><w:t>人员统计</w:t></w:r></w:p><w:tbl><w:tblPr/><w:tr><w:tc><w:tcPr/><w:p><w:r><w:t>姓名</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>用量</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>小明</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>123</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p><w:r><w:t>表后结论</w:t></w:r></w:p></w:body></w:document>' }])
    expect((await prepareAssistantAttachments([file('表格.docx', input)]))[0]!.text).toBe('人员统计\n姓名\t用量\n小明\t123\n表后结论')
  })

  test('Excel 按工作簿顺序提取工作表、稀疏列、共享/富文本与公式缓存', async () => {
    const input = office('xlsx', [
      { name: 'xl/workbook.xml', text: '<workbook xmlns:r="urn:r"><sheets><sheet name="第二张先看" sheetId="2" r:id="r2"/><sheet name="第一张后看" sheetId="1" r:id="r1"/></sheets></workbook>' },
      { name: 'xl/_rels/workbook.xml.rels', text: '<Relationships><Relationship Id="r1" Target="worksheets/sheet1.xml"/><Relationship Id="r2" Target="worksheets/sheet2.xml"/></Relationships>' },
      { name: 'xl/sharedStrings.xml', text: '<sst><si><r><t>共享</t></r><r><t>🙂</t></r></si></sst>' },
      { name: 'xl/worksheets/sheet1.xml', text: '<worksheet><sheetData><row r="3"><c r="B3" t="s"><v>0</v></c><c r="D3"><f>SUM(A1:B1)</f><v>12.5</v></c></row></sheetData></worksheet>' },
      { name: 'xl/worksheets/sheet2.xml', text: '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>内联 &amp; 文本</t></is></c><c r="C1" t="b"><v>1</v></c></row></sheetData></worksheet>' },
    ])
    const [prepared] = await prepareAssistantAttachments([file('账表.xlsx', input)])
    expect(prepared!.text).toBe('工作表：第二张先看\n第 1 行\tA1=内联 & 文本\tC1=TRUE\n\n工作表：第一张后看\n第 3 行\tB3=共享🙂\tD3==SUM(A1:B1)（缓存值：12.5）')
    expect(prepared!.metadata.note).toContain('未执行公式')
  })

  test('PowerPoint 按 presentation 关系顺序而非文件名排序', async () => {
    const input = office('pptx', [
      { name: 'ppt/presentation.xml', text: '<p:presentation xmlns:p="urn:p" xmlns:r="urn:r"><p:sldIdLst><p:sldId id="256" r:id="r2"/><p:sldId id="257" r:id="r1"/></p:sldIdLst></p:presentation>' },
      { name: 'ppt/_rels/presentation.xml.rels', text: '<Relationships><Relationship Id="r1" Target="slides/slide1.xml"/><Relationship Id="r2" Target="slides/slide2.xml"/></Relationships>' },
      { name: 'ppt/slides/slide1.xml', text: '<p:sld xmlns:p="urn:p" xmlns:a="urn:a"><a:p><a:r><a:t>实际第二页</a:t></a:r></a:p></p:sld>' },
      { name: 'ppt/slides/slide2.xml', text: '<p:sld xmlns:p="urn:p" xmlns:a="urn:a"><a:p><a:r><a:t>实际首页</a:t></a:r></a:p></p:sld>' },
    ])
    expect((await prepareAssistantAttachments([file('汇报.pptx', input)]))[0]!.text).toBe('幻灯片 1\n实际首页\n\n幻灯片 2\n实际第二页')
  })

  test('本轮累计正文限长、不截断代理对、原文件仍完整', async () => {
    const first = 'a'.repeat(59999) + '🙂尾部'
    const prepared = await prepareAssistantAttachments([file('first.txt', first), file('second.txt', '后来'), file('third.txt', '全部仍保留')])
    expect(prepared[0]!.metadata.extracted_chars).toBe(59999)
    expect(prepared[1]!.text).toBe('后')
    expect(prepared[2]!.text).toBe('')
    expect(prepared.reduce((count, item) => count + (item.text?.length ?? 0), 0)).toBe(60000)
    expect(prepared[2]!.metadata.note).toContain('前 0 字符')
    expect(prepared[0]!.metadata.note).toContain('原文件完整保留')
    expect(prepared[0]!.bytes).toEqual(encoder.encode(first))
  })

  test('Excel 共享字符串多次引用在提取时限长，避免正文膨胀', async () => {
    const input = office('xlsx', [
      { name: 'xl/workbook.xml', text: '<workbook xmlns:r="urn:r"><sheet name="文本" r:id="r1"/></workbook>' },
      { name: 'xl/_rels/workbook.xml.rels', text: '<Relationships><Relationship Id="r1" Target="worksheets/sheet1.xml"/></Relationships>' },
      { name: 'xl/sharedStrings.xml', text: `<sst><si><t>${'文'.repeat(20000)}</t></si></sst>` },
      { name: 'xl/worksheets/sheet1.xml', text: '<worksheet><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>0</v></c><c r="C1" t="s"><v>0</v></c><c r="D1" t="s"><v>0</v></c></row></worksheet>' },
    ])
    const [prepared] = await prepareAssistantAttachments([file('重复.xlsx', input)])
    expect(prepared!.text!.length).toBe(60000)
    expect(prepared!.metadata.note).toContain('仅向助手提供前 60000 字符')
  })
})

describe('助手附件真实内容与资源护栏', () => {
  test('真实 PNG 检测、MIME 来自文件内容、保留原图宽高', async () => {
    const [prepared] = await prepareAssistantAttachments([file('图.PNG', png(), 'text/plain')])
    expect(prepared!.image).toEqual({ mediaType: 'image/png', width: 1, height: 1 })
    expect(prepared!.metadata.kind).toBe('image')
    expect(prepared!.text).toBeUndefined()
  })

  test('真实 JPEG 的 jpg/jpeg 扩展均支持，损坏扫描段拒绝', async () => {
    // 由 System.Drawing 的 JPEG 编码器生成的 1×1 红色照片，而不是只有尺寸的伪头。
    const jpeg = Buffer.from('/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD50ooor8MP9Uz/2Q==', 'base64')
    const prepared = await prepareAssistantAttachments([file('photo.jpg', jpeg), file('photo.jpeg', jpeg)])
    expect(prepared.map((item) => item.image)).toEqual([{ mediaType: 'image/jpeg', width: 1, height: 1 }, { mediaType: 'image/jpeg', width: 1, height: 1 }])
    const scan = jpeg.indexOf(Buffer.from([0xff, 0xda]))
    const broken = Buffer.concat([jpeg.subarray(0, scan + 2), Buffer.from([0xff, 0xd9])])
    await fails([file('broken.jpg', broken)], 400, '扫描段')
  })

  test('真实 GIF 和 WebP 识别；缺失像素块与尾部的图片拒绝', async () => {
    const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')
    const webp = Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA', 'base64')
    const prepared = await prepareAssistantAttachments([file('tiny.gif', gif), file('tiny.webp', webp)])
    expect(prepared.map((item) => item.image)).toEqual([{ mediaType: 'image/gif', width: 1, height: 1 }, { mediaType: 'image/webp', width: 1, height: 1 }])
    await fails([file('broken.gif', gif.subarray(0, 20))], 400)
    await fails([file('broken.webp', webp.subarray(0, 30))], 400)
  })

  test('拒绝伪扩展、损坏图片、过大像素与 16 位 PNG', async () => {
    await fails([file('伪装.jpg', png())], 415, '扩展名')
    await fails([file('伪装.png', 'text')], 400)
    await fails([file('损坏.png', png().subarray(0, 40))], 400)
    await fails([file('巨大.png', png(4097))], 413, '分辨率')
    await fails([file('像素.png', png(4096, 4096))], 413, '分辨率')
    await fails([file('深色.png', png(1, 1, 16))], 415, '16 位')
    const corrupt = Buffer.from(png())
    corrupt[29] = corrupt[29]! ^ 1
    await fails([file('校验.png', corrupt)], 400, '校验和')
  })

  test('旧 Office/宏文件、不支持扩展、空文件与二进制文本均拒绝', async () => {
    await fails([file('旧.doc', 'x')], 415, '旧版')
    await fails([file('宏.docm', word())], 415)
    await fails([file('执行.exe', 'x')], 415)
    await fails([file('empty.txt', '')], 400, '空文件')
    await fails([file('blank.txt', '  \r\n')], 400, '没有可解析')
    await fails([file('binary.txt', Buffer.from([0x41, 0, 0x42]))], 415, '二进制')
    await fails([file('bad.txt', Buffer.from([0xff, 0xff, 0x80]))], 400, '编码')
    await fails([file('truncated.txt', Buffer.from([0xff, 0xfe, 0x01]))], 400, 'UTF-16')
  })

  test('Office 真实类型不匹配、损坏 ZIP、CRC 错误和空正文拒绝', async () => {
    await fails([file('伪.xlsx', word())], 415, '扩展名')
    await fails([file('伪.docx', 'plain text')], 415)
    await fails([file('坏.docx', word().subarray(0, 70))], 400, 'ZIP')
    await fails([file('crc.docx', zip([{ name: 'word/document.xml', text: '<document/>', badCrc: true }]))], 400, '校验和')
    await fails([file('empty.docx', office('docx', [{ name: 'word/document.xml', text: '<document/>' }]))], 400, '没有可解析')
  })

  test('ZIP 膨胀、声明超大、条目过多、重复路径与密码保护拒绝', async () => {
    await fails([file('bomb.docx', zip([{ name: 'word/document.xml', text: 'a'.repeat(200000) }]))], 413, '膨胀')
    await fails([file('large.docx', zip([{ name: 'word/document.xml', text: 'abc', declaredSize: 50 * 1024 * 1024 }]))], 413, '解压')
    await fails([file('many.docx', zip(Array.from({ length: 2049 }, (_, i) => ({ name: `x/${i}`, text: '' }))))], 413, '条目')
    await fails([file('duplicate.docx', zip([{ name: 'word/document.xml', text: 'a' }, { name: 'word/document.xml', text: 'b' }]))], 400, '重复')
    await fails([file('password.docx', zip([{ name: 'word/document.xml', text: 'abc', flags: 0x801 }]))], 415, '密码')
    await fails([file('macro.docx', zip([{ name: 'word/vbaProject.bin', text: 'macro' }]))], 415, '宏')
    await fails([file('traversal.docx', zip([{ name: '../outside.xml', text: 'x' }]))], 400)
  })

  test('DTD/实体声明、损坏 XML、过深嵌套与外链工作表拒绝', async () => {
    await fails([file('entity.docx', office('docx', [{ name: 'word/document.xml', text: '<!DOCTYPE document [<!ENTITY x SYSTEM "file:///secret">]><document><p><t>&x;</t></p></document>' }]))], 400, '实体')
    await fails([file('xml.docx', office('docx', [{ name: 'word/document.xml', text: '<document><p></document>' }]))], 400, 'XML')
    await fails([file('deep.docx', office('docx', [{ name: 'word/document.xml', text: '<x>'.repeat(110) + 'x' + '</x>'.repeat(110) }]))], 400, '嵌套')
    await fails([file('external.xlsx', office('xlsx', [
      { name: 'xl/workbook.xml', text: '<workbook xmlns:r="urn:r"><sheet name="a" r:id="r1"/></workbook>' },
      { name: 'xl/_rels/workbook.xml.rels', text: '<Relationships><Relationship Id="r1" Target="https://example.test/a.xml" TargetMode="External"/></Relationships>' },
    ]))], 400, '引用')
  })

  test('文件数、单个文件、累计文件与单张图片大小分别限制', async () => {
    await fails(Array.from({ length: 7 }, (_, i) => file(`${i}.txt`, 'x')), 413, '6 个')
    await fails([file('large.txt', new Uint8Array(10 * 1024 * 1024 + 1))], 413, '10 MiB')
    await fails([file('a.txt', new Uint8Array(8 * 1024 * 1024)), file('b.txt', new Uint8Array(8 * 1024 * 1024)), file('c.txt', new Uint8Array(8 * 1024 * 1024))], 413, '20 MiB')
    await fails([file('large.png', new Uint8Array(5 * 1024 * 1024 + 1))], 413, '5 MiB')
  })
})
