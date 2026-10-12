/** 带前缀、按时间大致有序的短 id（任务、会话条目等） */
export const newId = (prefix: string) =>
  `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
