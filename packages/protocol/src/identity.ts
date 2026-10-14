import { z } from 'zod'

export const Role = z.enum(['owner', 'editor', 'viewer'])
export type Role = z.infer<typeof Role>

export const Principal = z.object({ id: z.string(), role: Role })
export type Principal = z.infer<typeof Principal>

/** 本机单用户模式下的默认身份 */
export const LOCAL_PRINCIPAL: Principal = { id: 'local', role: 'owner' }

export const SessionInfo = z.object({
  /** 未登录时为 null */
  principal: Principal.nullable(),
  /** 服务端是否要求登录（监听非本机地址时） */
  authRequired: z.boolean(),
  /** 要求登录但还没有所有者账号：前端显示创建账号 */
  needsSetup: z.boolean(),
})
export type SessionInfo = z.infer<typeof SessionInfo>
