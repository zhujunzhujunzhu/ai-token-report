/**
 * 技能脚本沙箱：只能做纯数据变换 —— 没有宿主对象、没有网络/磁盘/系统接口，超时与两侧上限都硬。
 *
 * ★ 这些用例是**安全回归**，不是功能演示：任何一条放宽（例如为了「方便」把宿主函数
 *   传进上下文）都会让某条断言先红，而不是等到线上才发现。
 */
import { expect, test } from 'bun:test'
import { ASSISTANT_SKILL_SCRIPT_LIMITS } from '@ai-token-report/shared'
import { assertSkillScriptSyntax, runSkillScript } from '../src/assistant/skill-script.js'

test('脚本通过 input 读取数据、用 return 返回结果，宿主拿到的是重新解析出来的值', () => {
  const input = { rows: [{ model: 'a', tokens: 3 }, { model: 'b', tokens: 5 }] }
  const { value, duration_ms } = runSkillScript('return { total: input.rows.reduce((sum, row) => sum + row.tokens, 0), names: input.rows.map(row => row.model) }', input)
  expect(value).toEqual({ total: 8, names: ['a', 'b'] })
  expect(duration_ms).toBeGreaterThanOrEqual(0)
  // 沙箱拿到的是输入的一份副本：脚本改不到调用方手里的对象。
  runSkillScript('input.rows[0].tokens = 999; return true', input)
  expect(input.rows[0]!.tokens).toBe(3)
})

test('沙箱里只有新 realm 的内建对象：require / process / fetch / 定时器一个都不存在', () => {
  const missing = ['require', 'process', 'module', 'fetch', 'setTimeout', 'setInterval', 'queueMicrotask', 'Buffer', 'globalThis.process']
  for (const name of missing) {
    const { value } = runSkillScript(`return { present: typeof ${name} !== 'undefined' }`, null)
    expect({ name, ...(value as object) }).toEqual({ name, present: false })
  }
  // Math / Date / JSON 是新 realm 自己的内建对象，正常可用。
  const { value } = runSkillScript('return { math: Math.max(1, 2), json: JSON.parse(\'{"a":1}\').a, date: typeof Date }', null)
  expect(value).toEqual({ math: 2, json: 1, date: 'function' })
})

test('★ 关掉沙箱内的代码生成：顺着 input 摸回宿主构造器链必然失败', () => {
  for (const attempt of [
    'return input.constructor.constructor("return process")()',
    'return (function(){}).constructor("return process")()',
    'return eval("1")',
    'return Function("return 1")()',
    'return [].constructor.constructor("return globalThis")()',
  ]) {
    expect(() => runSkillScript(attempt, { a: 1 })).toThrow('脚本执行失败')
  }
})

test('死循环被超时中断，不会拖住服务端进程', () => {
  const started = Date.now()
  expect(() => runSkillScript('while (true) {}', null)).toThrow(`超过 ${ASSISTANT_SKILL_SCRIPT_LIMITS.timeout_ms} 毫秒已中断`)
  expect(Date.now() - started).toBeLessThan(ASSISTANT_SKILL_SCRIPT_LIMITS.timeout_ms + 3000)
})

test('输出与输入两侧都有硬上限，且都拒绝而不是截断', () => {
  // 上限算的是**序列化后的文本**长度：64,000 个字符的字符串再加两个引号就会越界。
  expect(() => runSkillScript(`return 'x'.repeat(${ASSISTANT_SKILL_SCRIPT_LIMITS.output_chars})`, null)).toThrow('脚本输出超过')
  expect(() => runSkillScript('return "ok"', { text: 'x'.repeat(ASSISTANT_SKILL_SCRIPT_LIMITS.input_chars) })).toThrow('脚本输入超过')
  // 恰好在上限内仍然可以跑通，说明上限不是随手写小的。
  const { value } = runSkillScript(`return 'y'.repeat(${ASSISTANT_SKILL_SCRIPT_LIMITS.output_chars - 100})`, null)
  expect(typeof value).toBe('string')
  expect((value as string).length).toBe(ASSISTANT_SKILL_SCRIPT_LIMITS.output_chars - 100)
})

test('没有 return、返回 undefined 或返回 Promise 都明确失败', () => {
  expect(() => runSkillScript('const untouched = input', null)).toThrow('需要用 return 返回一个可序列化的结果')
  expect(() => runSkillScript('return undefined', null)).toThrow('需要用 return 返回一个可序列化的结果')
  expect(() => runSkillScript('return Promise.resolve({ a: 1 })', null)).toThrow('脚本必须是同步的')
})

test('脚本自己抛错时只回一句可读原因，不把宿主栈带出去', () => {
  const failure = (() => { try { runSkillScript('throw new Error("数据里没有 model 列")', null); return null } catch (error) { return error as Error } })()
  expect(failure?.message).toBe('脚本执行失败：数据里没有 model 列')
  expect(failure?.message).not.toContain('skill-script.ts')
  expect(failure?.stack?.includes('skill-script.ts')).toBe(true)
})

test('保存时做语法检查：坏脚本在写入之前被拒绝', () => {
  expect(() => assertSkillScriptSyntax('return {')).toThrow('脚本语法错误')
  expect(() => assertSkillScriptSyntax('function () {')).toThrow('脚本语法错误')
  expect(() => assertSkillScriptSyntax('return input.rows.length')).not.toThrow()
  // 空脚本由存储层拒绝；这里只保证语法检查本身不会把它当成合法脚本放行。
  expect(() => runSkillScript('   ', null)).toThrow('这条技能没有脚本')
})

test('console 是沙箱自己定义的空实现：模型写的日志不会把执行打崩', () => {
  const { value } = runSkillScript('console.log("调试"); console.warn("x"); return { ok: true }', null)
  expect(value).toEqual({ ok: true })
  expect(() => runSkillScript('return console.log.constructor.constructor("return process")()', null)).toThrow('脚本执行失败')
})