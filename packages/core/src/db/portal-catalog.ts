/** 受控 CHECK 表达式的目录比对：保留逻辑分组，忽略引擎增加的无意义括号与标识符引号。 */
type Expression = string | Expression[]

function tokensOf(sql: string): string[] {
  const tokens: string[] = []
  const pattern = /\s+|'(?:''|\\.|[^'\\])*'|`(?:``|[^`])*`|[a-zA-Z_][a-zA-Z_0-9]*|\d+|<=|>=|<>|!=|[(),=<>+.-]/gy
  let offset = 0
  while (offset < sql.length) {
    pattern.lastIndex = offset
    const match = pattern.exec(sql)
    if (!match) throw new Error('CHECK 目录包含未支持的表达式，拒绝猜测等价性')
    offset = pattern.lastIndex
    const token = match[0]
    if (/^\s/.test(token)) continue
    if (/^_[a-z0-9]+$/i.test(token) && sql[offset] === "'") continue
    tokens.push(token[0] === "'" ? token : token.replace(/^`|`$/g, '').toLowerCase())
  }
  return tokens
}

/** 仅接受本仓 DDL 使用的函数、比较与布尔语法；未知 SQL 明确拒绝。 */
export function canonicalCheck(sql: string): string {
  const tokens = tokensOf(sql)
  let at = 0
  const take = (expected: string) => { if (tokens[at++] !== expected) throw new Error('CHECK 目录表达式结构不符') }
  function atom(): Expression {
    const token = tokens[at++]
    if (!token) throw new Error('CHECK 目录表达式不完整')
    if (token === '(') { const value = expression(0); take(')'); return value }
    if (token === '-') return ['negative', atom()]
    if (tokens[at] !== '(') return token
    at++
    const args: Expression[] = []
    if (tokens[at] !== ')') for (;;) {
      args.push(expression(0))
      if (tokens[at] !== ',') break
      at++
    }
    take(')')
    // MySQL 8.4 把 a REGEXP b 展开成 regexp_like(a,b)。
    return token === 'regexp_like' && args.length === 2 ? ['regexp', ...args] : ['call', token, ...args]
  }
  function expression(minimum: number): Expression {
    let left = atom()
    for (;;) {
      const op = tokens[at]
      const priority = op === 'or' ? 1 : op === 'and' ? 2 : op && ['=','!=','<>','<','>','<=','>=','is','between','in','like','regexp','glob','not'].includes(op) ? 3 : 0
      if (priority === 0 || priority < minimum) return left
      at++
      if (op === 'between') {
        const lower = expression(4); take('and'); left = ['between', left, lower, expression(4)]
      } else if (op === 'is') {
        const negated = tokens[at] === 'not'; if (negated) at++
        take('null'); left = [negated ? 'is-not-null' : 'is-null', left]
      } else if (op === 'in') {
        take('('); const values: Expression[] = []
        for (;;) { values.push(expression(0)); if (tokens[at] !== ',') break; at++ }
        take(')'); left = ['in', left, ...values]
      } else if (op === 'not') {
        const comparison = tokens[at++]
        if (comparison !== 'glob' && comparison !== 'like') throw new Error('CHECK 目录包含未支持的 NOT')
        left = [`not-${comparison}`, left, expression(4)]
      } else left = [op === '!=' ? '<>' : op!, left, expression(priority + 1)]
    }
  }
  const value = expression(0)
  if (at !== tokens.length) throw new Error('CHECK 目录表达式存在未校验的尾部')
  return JSON.stringify(value)
}

/** 读取每个 CHECK 的完整括号体，不能用贪婪正则吞并多个约束。 */
export function checkExpressions(sql: string): string[] {
  const expressions: string[] = []
  const pattern = /\bCHECK\s*\(/gi
  for (let match = pattern.exec(sql); match; match = pattern.exec(sql)) {
    let depth = 1, quote = false, at = pattern.lastIndex
    const start = at
    for (; at < sql.length && depth > 0; at++) {
      const char = sql[at]
      if (char === "'") {
        if (quote && sql[at + 1] === "'") { at++; continue }
        quote = !quote
      } else if (!quote) { if (char === '(') depth++; if (char === ')') depth-- }
    }
    if (depth) throw new Error('CHECK 定义括号未闭合')
    expressions.push(sql.slice(start, at - 1))
    pattern.lastIndex = at
  }
  return expressions
}

export function sameChecks(actual: string[], expected: string[]): boolean {
  return JSON.stringify(actual.map(canonicalCheck).sort()) === JSON.stringify(expected.map(canonicalCheck).sort())
}

/** 触发器只忽略空白/IF NOT EXISTS；保留字符串与逻辑分组。 */
export function normalizeTrigger(sql: string): string {
  return sql.replace(/\bIF NOT EXISTS\s+/i, '').replace(/'(?:''|[^'])*'|\s+|;/g, value => value.startsWith("'") ? value : '').toLowerCase()
}
