/**
 * 技能脚本的受限沙箱。
 *
 * 这是本仓**唯一**执行成员提交代码的地方，边界必须写在最前面：
 * - 沙箱里**没有任何宿主对象或宿主函数**。输入以 JSON 字符串字面量注入、在沙箱内
 *   用沙箱自己的 `JSON.parse` 解出来，因此脚本手上只有新 realm 的价值对象；
 *   连 `console` 都是脚本里自己定义的（预置）。把宿主函数递进去等于把宿主的
 *   `Function` 构造器递进去 —— 那是 vm 逃逸最经典的一条路。
 * - `codeGeneration.strings: false` 关掉沙箱内的 `eval` / `new Function`，
 *   于是 `input.constructor.constructor('return process')()` 这一串必然抛错。
 * - 没有 `require` / `process` / `fetch` / 定时器 / 文件系统：不是「禁止调用」，
 *   而是**根本没有这些东西**。
 * - 同步、限时（`timeout_ms`）、限输入、限输出；脚本必须是同步的（返回 Promise 直接报错）。
 *
 * ⚠️ 这不等于「vm 是安全边界」。Node 官方明确说 vm 不是安全机制；这里的定位是
 *   **把「部门成员写的脚本」限制成纯数据变换**：没有网络、没有磁盘、没有权限放大，
 *   剩下的是可被超时与上限约束的 CPU。要跑不可信的多租户代码，需要独立进程与容器。
 * ⚠️ 输入输出都走 JSON 文本：**宿主对象一个都不进上下文，一个都不出上下文**。
 *   否则脚本可以顺着传进去的对象摸回宿主 realm 的构造器链。
 * ⚠️ 执行走 `script.runInContext(...)`。**不要**写成 `runInContext(script, ctx)` ——
 *   Bun 的 `node:vm` 把它当源码字符串，直接得到 `Unexpected identifier 'Script'`，
 *   而服务端线上跑的是 Node、单测跑的是 Bun，两边都要能用。
 */
import { createContext, Script } from 'node:vm'
import { ASSISTANT_SKILL_SCRIPT_LIMITS } from '@ai-token-report/shared'
import { IdentityError } from '../identity/types.js'

const FILENAME = 'assistant-skill-script.js'

/**
 * 包装：脚本本身是 `function (input) { … }` 的**函数体**，用 `return` 返回结果。
 * `console` 由沙箱自己定义（空实现），让带日志的脚本不会因为缺 `console` 直接崩。
 */
function wrapper(source: string, inputJson: string): string {
  return `(function () {
'use strict';
const console = { log() {}, info() {}, warn() {}, error() {} };
function __skill(input) {
${source}
}
const __input = JSON.parse(${JSON.stringify(inputJson)});
const __value = __skill(__input);
if (__value && typeof __value.then === 'function') throw new Error('脚本必须是同步的，不能返回 Promise');
const __output = JSON.stringify(__value);
if (typeof __output !== 'string') throw new Error('脚本需要用 return 返回一个可序列化的结果');
if (__output.length > ${ASSISTANT_SKILL_SCRIPT_LIMITS.output_chars}) throw new Error('脚本输出超过 ${ASSISTANT_SKILL_SCRIPT_LIMITS.output_chars} 个字符');
return __output;
})()`
}

function messageOf(error: unknown): string {
  // ⚠️ 跨 realm 抛出来的 Error 在 Bun 上带 `Error: ` 前缀、在 Node 上不带：
  //   同一个失败在两种运行时必须给出同一句话（服务端线上 Node、单测 Bun）。
  return (error instanceof Error ? error.message : String(error)).replace(/^Error: /, '').slice(0, 300)
}

/**
 * 保存技能时的语法检查。
 *
 * ★ 编译在宿主侧执行（只编译、不运行），所以坏脚本在**写入之前**就被拒绝：
 *   存一条永远跑不起来的脚本，用户要到调用时才发现。
 */
export function assertSkillScriptSyntax(source: string): void {
  try { new Script(wrapper(source, 'null'), { filename: FILENAME }) }
  catch (error) { throw new IdentityError(400, `脚本语法错误：${messageOf(error)}`) }
}

/**
 * 执行技能脚本。`source` 必须是**已保存技能的脚本**，不是模型当场给的代码 ——
 * 调用点（`run_skill_script`）只允许运行「用户本轮明确调用」的那条技能自带脚本。
 */
export function runSkillScript(source: string, input: unknown): { value: unknown; duration_ms: number } {
  if (typeof source !== 'string' || !source.trim()) throw new IdentityError(400, '这条技能没有脚本')
  let inputJson: string
  try { inputJson = JSON.stringify(input) }
  catch { throw new IdentityError(400, '脚本输入无法序列化') }
  if (typeof inputJson !== 'string') throw new IdentityError(400, '脚本输入无法序列化')
  if (inputJson.length > ASSISTANT_SKILL_SCRIPT_LIMITS.input_chars) throw new IdentityError(400, `脚本输入超过 ${ASSISTANT_SKILL_SCRIPT_LIMITS.input_chars} 个字符，请缩小数据范围`)
  let script: Script
  try { script = new Script(wrapper(source, inputJson), { filename: FILENAME }) }
  catch (error) { throw new IdentityError(400, `脚本语法错误：${messageOf(error)}`) }
  // ★ 空的 sandbox 对象（无原型）：上下文只有新 realm 自己的内建对象，没有任何宿主注入。
  const context = createContext(Object.create(null) as object, { name: 'assistant-skill-script', codeGeneration: { strings: false, wasm: false } })
  const started = Date.now()
  let output: unknown
  try { output = script.runInContext(context, { timeout: ASSISTANT_SKILL_SCRIPT_LIMITS.timeout_ms, breakOnSigint: false }) }
  catch (error) {
    if ((error as { code?: unknown } | undefined)?.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') throw new IdentityError(400, `脚本执行超过 ${ASSISTANT_SKILL_SCRIPT_LIMITS.timeout_ms} 毫秒已中断，请简化脚本或缩小输入`)
    throw new IdentityError(400, `脚本执行失败：${messageOf(error)}`)
  }
  const duration_ms = Date.now() - started
  if (typeof output !== 'string') throw new IdentityError(500, '脚本执行结果无效')
  try { return { value: JSON.parse(output) as unknown, duration_ms } }
  catch { throw new IdentityError(500, '脚本输出不是有效 JSON') }
}