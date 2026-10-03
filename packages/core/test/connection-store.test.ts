/**
 * 本机连接配置的读写测试。
 *
 * 这一份文件同时被**插件面板**与**本地页配置弹框**写，所以三条口径必须钉死：
 *
 * 1. **合并写**：本地页只写 `baseUrl` + `appKey`，绝不能把插件的
 *    上报间隔 / 面板位置 / 会话日志根 / 其它来源抹掉。
 *    抹掉的症状是「在本地页保存一次，插件的设置就没了」，而且不报错。
 * 2. **坏文件拒绝覆盖**：内容不是合法 JSON 对象时**不写**并回一句人话 ——
 *    那份内容可能还有救，销毁证据比报错糟得多。
 * 3. **成对才认**：只有地址没密钥（或反之）不算配好，
 *    否则「连哪台」与「我是谁」会指向不同的地方。
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  CONNECTION_FILE_NAME,
  connectionCredentialOf,
  connectionFileIn,
  connectionPath,
  readConnectionText,
  updateConnectionFile,
  writeConnectionText,
} from '../src/connection-store.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'atr-conn-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('路径', () => {
  test('落在数据目录下，文件名是历史名 plugin-connection.json', () => {
    expect(connectionFileIn(dir)).toBe(join(dir, CONNECTION_FILE_NAME))
    expect(connectionPath(undefined, dir)).toBe(join(dir, CONNECTION_FILE_NAME))
  })
})

describe('updateConnectionFile —— 合并写', () => {
  test('文件不存在时从空对象开始', () => {
    const path = connectionFileIn(dir)
    const r = updateConnectionFile(path, { baseUrl: 'http://p:8787', appKey: 'k' })
    expect(r.ok).toBe(true)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ baseUrl: 'http://p:8787', appKey: 'k' })
  })

  test('★ 只动自己那几个键：插件的偏好原样保留', () => {
    const path = connectionFileIn(dir)
    writeFileSync(path, JSON.stringify({
      baseUrl: 'http://old:8787',
      appKey: 'old-key',
      flushIntervalMillis: 5_000,
      position: 'header',
      dshHomes: ['~/.dsh'],
      extraSources: ['codex'],
    }))

    const r = updateConnectionFile(path, { baseUrl: 'http://new:8787', appKey: 'new-key' })
    expect(r.ok).toBe(true)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      baseUrl: 'http://new:8787',
      appKey: 'new-key',
      flushIntervalMillis: 5_000,
      position: 'header',
      dshHomes: ['~/.dsh'],
      extraSources: ['codex'],
    })
  })

  test('undefined = 这一项不改（不是「写成空」）', () => {
    const path = connectionFileIn(dir)
    writeFileSync(path, JSON.stringify({ baseUrl: 'http://p:8787', appKey: 'k' }))
    updateConnectionFile(path, { position: 'dock', extraSources: undefined })
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      baseUrl: 'http://p:8787', appKey: 'k', position: 'dock',
    })
  })

  test('空文件按「没写过」处理（不是「坏了」）', () => {
    const path = connectionFileIn(dir)
    writeFileSync(path, '   \n')
    expect(updateConnectionFile(path, { appKey: 'k' }).ok).toBe(true)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ appKey: 'k' })
  })

  test('★ 不是合法 JSON → 拒绝覆盖，文件原样不动', () => {
    const path = connectionFileIn(dir)
    writeFileSync(path, '{ 半份')
    const r = updateConnectionFile(path, { appKey: 'k' })
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('不是合法 JSON')
    expect(readFileSync(path, 'utf8')).toBe('{ 半份')
  })

  test('★ JSON 但不是对象（数组 / 字面量）→ 同样拒绝', () => {
    for (const bad of ['[]', '"x"', '42', 'null']) {
      const path = connectionFileIn(dir)
      writeFileSync(path, bad)
      const r = updateConnectionFile(path, { appKey: 'k' })
      expect(r.ok).toBe(false)
      expect(r.reason).toContain('不是对象')
      expect(readFileSync(path, 'utf8')).toBe(bad)
    }
  })
})

describe('writeConnectionText', () => {
  test('原子写 + 可回滚：传 null 等于删掉', () => {
    const path = connectionFileIn(dir)
    expect(writeConnectionText(path, '{"a":1}').ok).toBe(true)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ a: 1 })
    expect(writeConnectionText(path, null).ok).toBe(true)
    expect(existsSync(path)).toBe(false)
  })

  test('目录不存在时自动建（首次保存不该因为缺目录失败）', () => {
    const path = connectionFileIn(join(dir, 'nested', 'deeper'))
    expect(writeConnectionText(path, '{}').ok).toBe(true)
    expect(readConnectionText(path).text).toBe('{}')
  })
})

describe('connectionCredentialOf —— 成对才认', () => {
  test('现役写法 baseUrl + appKey', () => {
    expect(connectionCredentialOf({ baseUrl: 'http://p:8787/', appKey: 'k' }))
      .toEqual({ baseUrl: 'http://p:8787', appKey: 'k' })
  })

  test('旧版写法 endpoint + appKey（把接口后缀剥回根地址）', () => {
    expect(connectionCredentialOf({ endpoint: 'http://p:8787/api/v1/token-usage', appKey: 'k' }))
      .toEqual({ baseUrl: 'http://p:8787', appKey: 'k' })
  })

  test('★ 只有地址或只有密钥 → 不认（半份连接）', () => {
    expect(connectionCredentialOf({ baseUrl: 'http://p:8787' })).toBeUndefined()
    expect(connectionCredentialOf({ appKey: 'k' })).toBeUndefined()
    expect(connectionCredentialOf({})).toBeUndefined()
  })

  test('地址非法时抛错（由调用方决定是「整份不可用」还是「当作没配」）', () => {
    expect(() => connectionCredentialOf({ baseUrl: 'portal.example.com', appKey: 'k' })).toThrow()
    expect(() => connectionCredentialOf({ baseUrl: 'http://u:p@p:8787', appKey: 'k' })).toThrow()
  })
})

describe('readConnectionText', () => {
  test('不存在 → text:null 且没有 error；读不了才带 error', () => {
    expect(readConnectionText(connectionFileIn(dir))).toEqual({ text: null })
    // 目录冒充文件：读它会得到 EISDIR / EPERM，属于「读不了」
    const read = readConnectionText(dir)
    expect(read.text).toBeNull()
    expect(typeof read.error).toBe('string')
  })
})
