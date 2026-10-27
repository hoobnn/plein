import { describe, expect, it } from 'vite-plus/test'
import { z } from 'zod'
import { validationMessage } from './validation'

describe('校验失败文案', () => {
  it('写出字段名和原因，不把 zod 的 JSON 抛给用户', () => {
    const schema = z.object({
      baseURL: z.string().refine(() => false, '远端渠道必须使用 HTTPS；HTTP 仅支持 localhost'),
    })
    const result = schema.safeParse({ baseURL: 'http://x.example' })
    expect(result.success).toBe(false)
    const message = validationMessage(result.error!)
    expect(message).toBe('baseURL：远端渠道必须使用 HTTPS；HTTP 仅支持 localhost')
    expect(message).not.toContain('"code"')
    expect(message).not.toContain('\\n')
  })

  it('多个问题按字段逐条列出，重复的只留一条', () => {
    const schema = z.object({
      a: z.string().min(1, '不能为空'),
      b: z.number().int('必须是整数'),
    })
    const result = schema.safeParse({ a: '', b: 1.5 })
    expect(result.success).toBe(false)
    const message = validationMessage(result.error!)
    expect(message).toBe('a：不能为空；b：必须是整数')
  })

  it('没有字段名的问题只写原因，没有可用原因时给兜底文案', () => {
    const schema = z.string().refine(() => false, '整体不对')
    const result = schema.safeParse('x')
    expect(result.success).toBe(false)
    expect(validationMessage(result.error!)).toBe('整体不对')
    expect(validationMessage(result.error!, '参数不合法')).toBe('整体不对')
  })
})
