/**
 * 插件内「上报连接」配置页 —— **只有两个字段：服务端地址 + appKey**。
 *
 * ## 为什么不再问姓名
 *
 * 姓名以**服务端校验结果**为准：appKey 在服务端绑定到某个人，
 * 校验响应里的姓名就是那个人的姓名。让用户自己填一遍姓名，
 * 除了多一个填错的机会之外没有任何作用（详见 `identity-attribution` 约定）。
 *
 * ## 凭证只提交、不回显
 *
 * GET 只回「填没填」，appKey 绝不发回浏览器；保存成功后立刻清空输入框。
 * 浏览器存储（localStorage / cookie）里也不留任何一份。
 */
import { createElement as h, useEffect, useState, type ReactNode, type FormEvent } from 'react'
import { UI_SETTINGS_PATH } from './protocol.js'

export function SettingsPanel(props: { onClose(): void }): ReactNode {
  const [baseUrl, setBaseUrl] = useState('')
  const [appKey, setAppKey] = useState('')
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
      setBaseUrl(data.baseUrl ?? '')
      setLocked(!!data.locked)
      setReady(true)
      setMessage(data.restartRequired ? '已保存配置，请重启 DSH 后启用新的上报连接。' :
        data.signed ? `当前署名：${data.name}${data.dept ? ` · ${data.dept}` : ''}。换人时请重新填写 appKey。` : '尚未配置 appKey：只查看本机统计，不采集也不上报。')
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
        body: JSON.stringify({ baseUrl, appKey }),
      })
      if (!response.ok) throw new Error(`保存失败（HTTP ${response.status}）`)
      const result = await response.json()
      if (!result.ok) { setMessage(result.reason ?? '保存失败'); return }
      setAppKey('')
      setMessage(`已保存署名 ${result.name}。请重启 DSH 后启用新的上报连接；当前进程仍使用启动时的配置。`)
    } catch { setMessage('无法保存配置，请检查宿主连接后重试。') }
    finally { setBusy(false) }
  }
  const field = (label: string, value: string, change: (value: string) => void, type = 'text', placeholder = ''): ReactNode =>
    h('label', { className: 'atr-field' }, label,
      h('input', { type, value, placeholder, disabled: busy || locked || !ready, autoComplete: 'off',
        onChange: (event: { target: { value: string } }) => change(event.target.value) }))

  return h('section', { className: 'atr-settings' },
    h('div', { className: 'atr-head' }, h('strong', null, '上报连接'), h('span', { className: 'atr-grow' }),
      h('button', { type: 'button', className: 'atr-btn', onClick: props.onClose, disabled: busy }, '返回我的用量')),
    h('p', { role: 'status' }, message),
    locked ? h('p', null, '此配置由部署文件或环境变量管理，请联系管理员修改。') : null,
    h('form', { onSubmit: submit, className: 'atr-form' },
      field('服务端地址', baseUrl, setBaseUrl, 'url', '例如 http://127.0.0.1:8787'),
      field('appKey（管理员发放）', appKey, setAppKey, 'password', '粘贴平台「appKey 发放」页面复制的凭证'),
      h('p', { className: 'atr-note' }, 'appKey 保存在本机、不回显；姓名与部门以服务端校验结果为准。启用后自动补报本机全部历史用量，失败会重试。只上报用量统计，不采集对话内容。'),
      h('button', { className: 'atr-btn atr-primary', type: 'submit', disabled: busy || locked || !ready || !baseUrl.trim() || !appKey.trim() },
        busy ? '处理中…' : '验证并保存')))
}
