/** 对话侧栏的固定行高窗口；只渲染视口附近的行，历史页追加不扩大 DOM。 */
export const ASSISTANT_SESSION_ROW_HEIGHT = 64
const OVERSCAN = 3

export function assistantSessionWindow(count: number, scrollTop: number, viewportHeight: number) {
  const height = count * ASSISTANT_SESSION_ROW_HEIGHT
  // 删除尾部会话时浏览器的 scrollTop 可能尚未回落，先钳住窗口，避免短暂空白。
  const top = Math.min(Math.max(0, scrollTop), Math.max(0, height - viewportHeight))
  const start = Math.max(0, Math.floor(top / ASSISTANT_SESSION_ROW_HEIGHT) - OVERSCAN)
  const end = Math.min(count, Math.ceil((top + viewportHeight) / ASSISTANT_SESSION_ROW_HEIGHT) + OVERSCAN)
  return { start, end, height, offset: start * ASSISTANT_SESSION_ROW_HEIGHT }
}

export function assistantSessionsNearEnd(count: number, scrollTop: number, viewportHeight: number): boolean {
  // 收起的浮窗高度为零，不能因此把所有历史页都自动读完。
  return viewportHeight > 0 && scrollTop + viewportHeight >= count * ASSISTANT_SESSION_ROW_HEIGHT - ASSISTANT_SESSION_ROW_HEIGHT
}
