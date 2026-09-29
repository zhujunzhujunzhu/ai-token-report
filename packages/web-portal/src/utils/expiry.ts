/**
 * 有效期档位 → 请求里的 `expires_at_ms`（发放与改有效期两处共用）。
 *
 * ## 为什么单独一个文件
 *
 * 发放弹框与「设置有效期」弹框问的是同一个问题，只是问的时机不同。
 * 两边各写一遍「档位 → 毫秒」的换算，早晚会出现「发放接受自定义时间、
 * 续期拒绝」这类只有一侧修过的差异，而且不会报错。
 *
 * ⚠️ 校验也只在这里做一次：服务端同样会拒过去时刻（400），但页面必须先把
 *   「你选的时间已经过去了」说清楚，而不是让管理员去读一句接口报错。
 *   返回 `'invalid'` 表示自定义时间不合法。
 */

/** 有效期档位：长期有效 / 若干天 / 自定义时刻。 */
export type ExpiryMode = 'permanent' | '30' | '90' | 'custom'

const DAY_MS = 24 * 60 * 60 * 1000

export function expiryOf(mode: ExpiryMode, custom: Date | null): number | null | 'invalid' {
  if (mode === 'permanent') return null
  if (mode !== 'custom') return Date.now() + Number(mode) * DAY_MS
  const ms = custom?.getTime() ?? 0
  return ms > Date.now() ? ms : 'invalid'
}