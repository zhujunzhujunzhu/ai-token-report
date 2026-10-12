/** 助手对话的滚动跟随状态；流式内容增高不能夺走用户正在阅读的历史位置。 */
export interface AssistantScrollMetrics {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}

export interface AssistantScrollSnapshot {
  following: boolean
  away: boolean
}

const BOTTOM_THRESHOLD = 40
const UPWARD_TOLERANCE = 1

export function createAssistantScrollState() {
  let following = true, away = false
  let previousTop: number | undefined
  let previousBottom: number | undefined

  function state(): AssistantScrollSnapshot { return { following, away } }

  function observe(metrics: AssistantScrollMetrics): AssistantScrollSnapshot {
    // ★ 收起浮窗时几何值归零，不能因此恢复跟随或丢掉上次真实滚动位置。
    if (metrics.clientHeight <= 0) return state()
    const bottom = Math.max(0, metrics.scrollHeight - metrics.clientHeight)
    const top = Math.min(Math.max(0, metrics.scrollTop), bottom)
    away = bottom - top > BOTTOM_THRESHOLD
    const upward = previousTop !== undefined && previousTop - top > UPWARD_TOLERANCE
    // 向下慢拖也应能恢复跟随；一像素容差只用来过滤意外上移。
    const downward = previousTop !== undefined && top > previousTop
    const layoutClamped = previousTop !== undefined && previousBottom !== undefined
      && previousBottom - bottom > UPWARD_TOLERANCE && previousTop - bottom > UPWARD_TOLERANCE
      && bottom - top <= UPWARD_TOLERANCE
    // 内容减少或视口变高会让浏览器把原位置夹到新底部，这种上移属于布局变化。
    if (layoutClamped) following = true
    else if (upward) following = false
    // ★ 上滚意图先于原生滚动：旧位置即使仍在底部，静止测量也不能撤销暂停。
    else if (!away && downward) following = true
    previousTop = top
    previousBottom = bottom
    return state()
  }

  function pause(): AssistantScrollSnapshot {
    // 用户向上操作先于下一次布局更新，立即暂停可避免本轮流式补丁抢先滚底。
    following = false
    return state()
  }

  function reset(): AssistantScrollSnapshot {
    following = true; away = false; previousTop = undefined; previousBottom = undefined
    return state()
  }

  function jumpToLatest(metrics: AssistantScrollMetrics): AssistantScrollSnapshot {
    following = true; away = false
    // 程序滚底后的 scroll 事件要与目标位置比较，不能误认成用户上翻。
    previousBottom = metrics.clientHeight > 0 ? Math.max(0, metrics.scrollHeight - metrics.clientHeight) : undefined
    previousTop = previousBottom
    return state()
  }

  return { state, observe, pause, reset, jumpToLatest }
}
