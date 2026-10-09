import { expect, test } from 'bun:test'
import { assistantTableCsv } from '../src/utils/assistantCsv.js'
test('CSV 保留原数值、空值及逗号引号换行；来自接口文本的公式只作为文本', () => {
  const output = assistantTableCsv({ columns: [{ key: 'label', label: '模型' }, { key: 'value', label: '数值' }], rows: [
    { label: '模型,"别名"\n换行', value: 1234.56789 },
    { label: '=HYPERLINK("https://example.test")', value: null },
    { label: '\t+1', value: -5 },
    { label: '@SUM(1,2)', value: 0 },
  ], total_rows: 4 })
  expect(output).toStartWith('\ufeff"模型","数值"\r\n')
  expect(output).toContain('"模型,""别名""\n换行","1234.56789"')
  expect(output).toContain('"\'=HYPERLINK(""https://example.test"")",""')
  expect(output).toContain('"\'\t+1","-5"')
  expect(output).toContain('"\'@SUM(1,2)","0"')
})
