/** 纯位图验证码：答案只留在服务端，PNG 不含文本、元数据或字体依赖。 */
import { randomInt } from 'node:crypto'
import { deflateSync } from 'node:zlib'

const DIGITS = [
  ['01110', '11011', '11011', '11011', '11011', '11011', '01110'],
  ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  ['01110', '11011', '00011', '00110', '01100', '11000', '11111'],
  ['11110', '00011', '00011', '01110', '00011', '00011', '11110'],
  ['00010', '00110', '01110', '11010', '11111', '00010', '00010'],
  ['11111', '11000', '11000', '11110', '00011', '11011', '01110'],
  ['01110', '11000', '11000', '11110', '11011', '11011', '01110'],
  ['11111', '00011', '00110', '00110', '01100', '01100', '01100'],
  ['01110', '11011', '11011', '01110', '11011', '11011', '01110'],
  ['01110', '11011', '11011', '01111', '00011', '00011', '01110'],
]

/** 此函数只供服务端调用；响应序列化时必须排除 answer。 */
export function createCaptchaImage(): { answer: string; image: string } {
  const width = 168,
    height = 56
  const pixels = Buffer.alloc((width * 3 + 1) * height, 246)
  for (let y = 0; y < height; y++) pixels[y * (width * 3 + 1)] = 0
  function dot(x: number, y: number, color: number[]): void {
    x = Math.round(x)
    y = Math.round(y)
    if (x < 0 || x >= width || y < 0 || y >= height) return
    const offset = y * (width * 3 + 1) + 1 + x * 3
    for (let c = 0; c < 3; c++) pixels[offset + c] = color[c]!
  }
  const answer = Array.from({ length: 4 }, () => String(randomInt(10))).join('')
  for (let i = 0; i < 800; i++)
    dot(randomInt(width), randomInt(height), [185, 207, 224])
  for (let i = 0; i < 4; i++) {
    const rows = DIGITS[Number(answer[i])]!
    const top = randomInt(8, 18),
      skew = randomInt(-5, 6) / 10
    const color = [randomInt(25, 65), randomInt(65, 105), randomInt(125, 175)]
    rows.forEach((row, y) =>
      [...row].forEach((bit, x) => {
        if (bit !== '1') return
        for (let dy = 0; dy < 4; dy++)
          for (let dx = 0; dx < 4; dx++)
            dot(
              15 + i * 38 + x * 4 + dx + skew * (y * 4 + dy),
              top + y * 4 + dy,
              color,
            )
      }),
    )
  }
  for (let line = 0; line < 3; line++) {
    const base = randomInt(8, 45),
      phase = randomInt(6)
    for (let x = 0; x < width; x++)
      dot(x, base + Math.sin(x / 18 + phase) * 6, [120, 159, 190])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 2
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0)),
  ])
  return { answer, image: 'data:image/png;base64,' + png.toString('base64') }
}

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type), data])
  let crc = 0xffffffff
  for (const byte of body) {
    crc ^= byte
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  const result = Buffer.alloc(body.length + 8)
  result.writeUInt32BE(data.length, 0)
  body.copy(result, 4)
  result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4)
  return result
}
