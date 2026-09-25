/** 插件内署名与连接配置页。凭证只提交、不回显，也不写入浏览器存储。 */
import { createElement as h, useEffect, useState, type ReactNode, type FormEvent } from 'react'
import { UI_SETTINGS_PATH } from './protocol.js'

export function SettingsPanel(props: { onClose(): void }): ReactNode {
  const [name, setName] = useState('')
  const [token, setToken] = useState('')
  const [appKey, setAppKey] = useState('')
  const [endpoint, setEndpoint] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(true)
  const [ready, setReady] = useState(false)
  const [locked, setLocked] = useState(false)
  useEffect(() => {
    const controller = new AbortController()
    void fetch(UI_SETTINGS_PATH, { signal: controller.signal }).then(async (res) => {
      if (!res.ok) throw new Error(`配置读取失败（HTTP ${res.status}）`)
      const data = await res.json()
      if (controller.signal.aborted) return
      setName(data.name ?? '')
      setEndpoint(data.endpoint ?? '')
      setLocked(!!data.locked)
      setReady(true)
      setMessage(data.restartRequired ? '已保存配置，请重启 DSH 后启用新的署名与连接。' :
        data.signed ? `当前署名：${data.name}${data.dept ? ` · ${data.dept}` : ''}。修改时请重新填写 Key。` : '尚未署名：只查看本机统计，不采集也不上报。')
    }).catch((err: Error) => { if (!controller.signal.aborted) setMessage(err.message) })
      .finally(() => { if (!controller.signal.aborted) setBusy(false) })
    return () => controller.abort()
  }, [])

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (busy || locked || !ready) return
    setBusy(true)
    try {
      const response = await fetch(UI_SETTINGS_PATH, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, token, appKey, endpoint }),
      })
      if (!response.ok) throw new Error(`保存失败（HTTP ${response.status}）`)
      const result = await response.json()
      if (!result.ok) { setMessage(result.reason ?? '保存失败'); return }
      setName(result.name)
      setToken('')
      setAppKey('')
      setMessage(`已保存署名 ${result.name}。请重启 DSH 后启用新的署名与上报连接；当前进程仍使用启动时的配置。`)
    } catch { setMessage('无法保存配置，请检查宿主连接后重试。') }
    finally { setBusy(false) }
  }
  const field = (label: string, value: string, change: (value: string) => void, type = 'text', required = false): ReactNode =>
    h('label', { className: 'atr-field' }, label,
      h('input', { type, value, required, disabled: busy || locked || !ready, autoComplete: 'off',
        onChange: (event: { target: { value: string } }) => change(event.target.value) }))

  return h('section', { className: 'atr-settings' },
    h('div', { className: 'atr-head' }, h('strong', null, '署名与上报连接'), h('span', { className: 'atr-grow' }),
      h('button', { type: 'button', className: 'atr-btn', onClick: props.onClose, disabled: busy }, '返回我的用量')),
    h('p', { role: 'status' }, message),
    locked ? h('p', null, '此配置由部署文件或环境变量管理，请联系管理员修改。') : null,
    h('form', { onSubmit: submit, className: 'atr-form' },
      field('姓名', name, setName, 'text', true),
      field('身份 Key（管理员发放）', token, setToken, 'password', true),
      field('上报地址（完整 /api/v1/token-usage 地址）', endpoint, setEndpoint, 'url', true),
      field('上报 appKey（选填，留空使用本次身份 Key）', appKey, setAppKey, 'password'),
      h('p', { className: 'atr-note' }, '姓名与部门以服务端校验结果为准。Key 保存在本机，不回显；不采集对话内容。'),
      h('button', { className: 'atr-btn atr-primary', type: 'submit', disabled: busy || locked || !ready || !name.trim() || !token.trim() },
        busy ? '处理中…' : '验证并保存')))
}
