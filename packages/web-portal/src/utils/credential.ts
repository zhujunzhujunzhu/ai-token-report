/**
 * 凭证的展示形态（appKey 管理页用）。
 *
 * ## 为什么省略号只在这里加
 *
 * `report_tokens.token_prefix` 存的是**摘要前缀**（12 位十六进制），那是数据；
 * 「…」是「这串被截断了」的展示提示。把展示符号写进库，等于让「列表里那一列
 * 长什么样」变成一次存储决定，改版还得迁移历史行 —— 所以旧格式
 * `…d5788739d349`（带前导省略号）也在这里统一重排成中间省略号：
 * 老数据不需要迁移，也不会显示成两截。
 */

/**
 * 摘要提示：`d5788739d349` → `d57887…39d349`。
 * 顺带吃下旧格式 `…d5788739d349`（先剥掉已有省略号再重排，因此是幂等的）。
 */
export function tokenHint(prefix: string): string {
  const raw = prefix.replace(/…/g, '').trim()
  if (raw.length <= 8) return raw
  return `${raw.slice(0, 6)}…${raw.slice(-6)}`
}

/**
 * 明文 appKey 的遮罩：`atr-ab12cd…ef34`。
 *
 * 留前 4 / 后 4 位是为了**能比对**（轮换后确认自己粘的是新那把），
 * 又不足以被抄走。短到遮不出信息量的值（测试夹具、异常数据）原样返回 ——
 * 把 `atr-演示凭证` 显示成 `atr-演示…凭证` 只是难看，并不会更安全；
 * 真实 key 永远是 `randomSecret()` 的 43 位。
 */
export function maskSecret(secret: string): string {
  const at = secret.indexOf('-')
  const head = at >= 0 ? secret.slice(0, at + 1) : ''
  const body = at >= 0 ? secret.slice(at + 1) : secret
  if (body.length <= 12) return secret
  return `${head}${body.slice(0, 4)}…${body.slice(-4)}`
}