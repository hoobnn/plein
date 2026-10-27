import { z } from 'zod'

/**
 * 把校验失败写成一句人话：字段名 + 原因。
 *
 * zod 的 `error.message` 是整段 JSON（带换行和转义），直接展示给用户看到的是
 * 一堆 "code"/"path" 字段，既看不懂也不知道该改哪里。这里按字段逐条列出。
 */
export function validationMessage(error: z.ZodError, fallback = '参数不合法'): string {
  const parts: string[] = []
  for (const issue of error.issues) {
    const path = issue.path.join('.')
    const field = path ? `${path}：` : ''
    const message = issue.message.trim()
    if (!message) continue
    const text = `${field}${message}`
    if (!parts.includes(text)) parts.push(text)
  }
  return parts.length ? parts.join('；') : fallback
}
