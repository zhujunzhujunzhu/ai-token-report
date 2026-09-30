/**
 * 身份存储测试。
 *
 * 重点验证三件事：
 * 1. 损坏的文件降级为「未署名」而不是抛错（否则页面白屏）
 * 2. 原子写入不留半截文件
 * 3. 重复保存不刷新 createdAt（保留首次署名时间，供审计）
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  clearIdentity,
  identityPath,
  readIdentity,
  writeIdentity,
} from '../src/identity-store.js'

let home: string
let dataDir: string
let path: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'atr-identity-'))
  // 显式给数据目录：缺省值在家目录下（`~/.ai-token-report`），
  // 测试若走缺省就会**覆盖使用者真实的身份文件**。
  dataDir = join(home, 'token-report')
  path = identityPath(home, dataDir)
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

describe('写入与读取', () => {
  test('路径落在 <dataDir>/identity.json', () => {
    expect(path).toBe(join(dataDir, 'identity.json'))
  })

  test('写入后能读回，且字段一致', () => {
    const r = writeIdentity(path, { name: '张三', token: 'tok-abc', group: '研发一部' })
    expect(r.ok).toBe(true)

    const got = readIdentity(path)
    expect(got.exists).toBe(true)
    expect(got.identity?.name).toBe('张三')
    expect(got.identity?.token).toBe('tok-abc')
    expect(got.identity?.group).toBe('研发一部')

    // ★ 写出侧只写 `group`：`dept` 仅作为旧文件的读取兼容保留，
    //   新写的文件里出现 `dept` 就说明写出路径又退回了旧字段名。
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    expect(raw['group']).toBe('研发一部')
    expect('dept' in raw).toBe(false)
  })

  test('目录不存在时自动创建', () => {
    expect(existsSync(dataDir)).toBe(false)
    writeIdentity(path, { name: '张三', token: 'tok-abc' })
    expect(existsSync(path)).toBe(true)
  })

  test('首尾空白被裁剪', () => {
    writeIdentity(path, { name: '  张三  ', token: '  tok-abc  ' })
    const got = readIdentity(path)
    expect(got.identity?.name).toBe('张三')
    expect(got.identity?.token).toBe('tok-abc')
  })

  test('不填分组时不写入 group 字段', () => {
    writeIdentity(path, { name: '张三', token: 'tok-abc' })
    expect(readIdentity(path).identity?.group).toBeUndefined()
    // 空值不落字段（而不是落一个 null/空串）：两者在读取侧的语义不同 ——
    // 字段在但为空算「未署名」，字段缺失才算「没填过」
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    expect('group' in raw).toBe(false)
    expect('dept' in raw).toBe(false)
  })

  test('★ 兼容旧文件：只含 dept 的对象读出来是 group', () => {
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(
      path,
      JSON.stringify({ name: '张三', token: 'tok-abc', dept: '研发一部', createdAt: 1, updatedAt: 2 }),
      'utf8',
    )

    const got = readIdentity(path)
    // 读取侧按 `group ?? dept` 归一（见 src/identity-store.ts 的 normalize）：
    // 已经署过名的同学升级一次不该变成「未署名」—— 那会直接停止上报，
    // 而不是报一个错，最难被发现。
    expect(got.identity?.group).toBe('研发一部')
    expect(got.identity?.dept).toBeUndefined()

    // 再保存一次就只剩新字段：兼容只是读取期的事，不会把旧字段继续写下去
    writeIdentity(path, { name: '张三', token: 'tok-abc', group: got.identity!.group! })
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    expect(raw['group']).toBe('研发一部')
    expect('dept' in raw).toBe(false)
  })

  test('同时含 group 与 dept 时以 group 为准（旧值不会盖掉新值）', () => {
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(
      path,
      JSON.stringify({ name: '张三', token: 'tok-abc', group: '新分组', dept: '旧部门', createdAt: 1, updatedAt: 2 }),
      'utf8',
    )
    expect(readIdentity(path).identity?.group).toBe('新分组')
  })
})

describe('校验', () => {
  test('空姓名被拒绝，且给出可展示的原因', () => {
    const r = writeIdentity(path, { name: '   ', token: 'tok-abc' })
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('姓名')
    expect(existsSync(path)).toBe(false)
  })

  test('空 token 被拒绝', () => {
    const r = writeIdentity(path, { name: '张三', token: '' })
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('token')
  })

  test('token 含空格被拒绝', () => {
    const r = writeIdentity(path, { name: '张三', token: 'tok abc' })
    expect(r.ok).toBe(false)
  })

  test('超长姓名被拒绝', () => {
    const r = writeIdentity(path, { name: 'x'.repeat(33), token: 'tok-abc' })
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('过长')
  })
})

describe('损坏降级（关键：不能抛错）', () => {
  test('文件不存在 → exists=false, identity=null', () => {
    const got = readIdentity(path)
    expect(got.exists).toBe(false)
    expect(got.identity).toBeNull()
    expect(got.error).toBeUndefined()
  })

  test('非法 JSON → identity=null 且带 error，不抛错', () => {
    writeIdentity(path, { name: '张三', token: 'tok-abc' })
    writeFileSync(path, '{ 这不是 JSON', 'utf8')

    const got = readIdentity(path)
    expect(got.identity).toBeNull()
    expect(got.exists).toBe(true)
    expect(got.error).toContain('JSON')
  })

  test('空文件 → 视为未署名', () => {
    writeIdentity(path, { name: '张三', token: 'tok-abc' })
    writeFileSync(path, '', 'utf8')

    const got = readIdentity(path)
    expect(got.identity).toBeNull()
    expect(got.exists).toBe(true)
  })

  test('字段类型不对 → 视为损坏', () => {
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(path, JSON.stringify({ name: 123, token: null }), 'utf8')
    const got = readIdentity(path)
    expect(got.identity).toBeNull()
    expect(got.error).toBeTruthy()
  })

  test('字段在但值为空 → 视为未署名（不是损坏）', () => {
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(path, JSON.stringify({ name: '', token: '' }), 'utf8')
    const got = readIdentity(path)
    expect(got.identity).toBeNull()
    expect(got.error).toBeUndefined()
  })

  test('截断的 JSON → 不抛错', () => {
    writeIdentity(path, { name: '张三', token: 'tok-abc' })
    const full = readFileSync(path, 'utf8')
    writeFileSync(path, full.slice(0, Math.floor(full.length / 2)), 'utf8')

    expect(() => readIdentity(path)).not.toThrow()
    expect(readIdentity(path).identity).toBeNull()
  })
})

describe('原子性', () => {
  test('写入后不残留临时文件', () => {
    writeIdentity(path, { name: '张三', token: 'tok-abc' })
    const files = readdirSync(dataDir)
    expect(files).toEqual(['identity.json'])
  })

  test('重复保存不刷新 createdAt（保留首次署名时间）', () => {
    const first = writeIdentity(path, { name: '张三', token: 'tok-1' })
    const createdAt = first.identity!.createdAt

    // 确保两次调用落在不同毫秒
    const start = Date.now()
    while (Date.now() === start) { /* busy wait */ }

    const second = writeIdentity(path, { name: '张三', token: 'tok-2' })
    expect(second.identity!.createdAt).toBe(createdAt)
    expect(second.identity!.updatedAt).toBeGreaterThanOrEqual(createdAt)
  })

  test('改 token 会覆盖，不是追加', () => {
    writeIdentity(path, { name: '张三', token: 'tok-old' })
    writeIdentity(path, { name: '李四', token: 'tok-new' })

    const got = readIdentity(path)
    expect(got.identity?.name).toBe('李四')
    expect(got.identity?.token).toBe('tok-new')
  })
})

describe('清除', () => {
  test('清除后读不到', () => {
    writeIdentity(path, { name: '张三', token: 'tok-abc' })
    expect(clearIdentity(path)).toBe(true)
    expect(readIdentity(path).exists).toBe(false)
  })

  test('清除不存在的文件返回 false，不抛错', () => {
    expect(clearIdentity(path)).toBe(false)
  })
})