/** 导出本次查询的原始标量；防止来自模型名等文本的 CSV 公式注入。 */
import type { AssistantResult } from '@ai-token-report/shared'
function csvCell(value: string | number | null | undefined): string {
  let text = value == null ? '' : String(value)
  if (typeof value === 'string' && /^[\s]*[=+\-@]/.test(text)) text = `'${text}`
  return `"${text.replaceAll('"', '""')}"`
}
export function assistantTableCsv(table: NonNullable<AssistantResult['table']>): string {
  const lines = [table.columns.map(column => csvCell(column.label)).join(','), ...table.rows.map(row => table.columns.map(column => csvCell(row[column.key])).join(','))]
  return '\ufeff' + lines.join('\r\n')
}
