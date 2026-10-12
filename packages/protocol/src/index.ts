import { z } from 'zod'

/**
 * 前后端共享的接口约定：路径、请求 / 响应 schema 与类型。
 * 服务端用 schema 校验输入，前端用类型约束调用。
 */

// ── 身份 ──────────────────────────────────────────────

export const Role = z.enum(['owner', 'editor', 'viewer'])
export type Role = z.infer<typeof Role>

export const Principal = z.object({ id: z.string(), role: Role })
export type Principal = z.infer<typeof Principal>

/** 本机单用户模式下的默认身份 */
export const LOCAL_PRINCIPAL: Principal = { id: 'local', role: 'owner' }

export const LoginRequest = z.object({ token: z.string().min(1) })
export type LoginRequest = z.infer<typeof LoginRequest>

export const SessionInfo = z.object({
  principal: Principal,
  /** 服务端是否要求令牌（监听非本机地址时） */
  authRequired: z.boolean(),
})
export type SessionInfo = z.infer<typeof SessionInfo>

// ── 画布 ──────────────────────────────────────────────

export const Canvas = z.object({
  id: z.string(),
  title: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
})
export type Canvas = z.infer<typeof Canvas>

export const CreateCanvas = z.object({
  title: z.string().trim().min(1).max(200).default('未命名画布'),
})
export type CreateCanvas = z.input<typeof CreateCanvas>

export const UpdateCanvas = z.object({ title: z.string().trim().min(1).max(200) })
export type UpdateCanvas = z.infer<typeof UpdateCanvas>

// ── 资产 ──────────────────────────────────────────────

export const AssetKind = z.enum(['image', 'video', 'audio', 'file'])
export type AssetKind = z.infer<typeof AssetKind>

/** 衍生物：图片缩略图、视频封面、音频波形 */
export const AssetVariant = z.enum(['thumb-256', 'thumb-1024', 'poster', 'waveform'])
export type AssetVariant = z.infer<typeof AssetVariant>

export const Asset = z.object({
  /** 内容的 SHA-256（十六进制），写入即不可变 */
  id: z.string().regex(/^[0-9a-f]{64}$/),
  kind: AssetKind,
  mime: z.string(),
  name: z.string(),
  size: z.number(),
  width: z.number().optional(),
  height: z.number().optional(),
  /** 秒 */
  duration: z.number().optional(),
  variants: z.array(AssetVariant),
  createdAt: z.number(),
})
export type Asset = z.infer<typeof Asset>

// ── 路径 ──────────────────────────────────────────────

export const API = {
  session: '/api/session',
  login: '/api/auth/login',
  logout: '/api/auth/logout',
  canvases: '/api/canvases',
  canvas: (id: string) => `/api/canvases/${encodeURIComponent(id)}`,
  assets: '/api/assets',
  asset: (id: string) => `/api/assets/${id}`,
  assetMeta: (id: string) => `/api/assets/${id}/meta`,
  assetVariant: (id: string, v: AssetVariant) => `/api/assets/${id}/${v}`,
  /** Yjs 同步（y-websocket 协议），房间名为画布 id */
  sync: '/sync',
} as const

export const ApiError = z.object({ error: z.string(), message: z.string() })
export type ApiError = z.infer<typeof ApiError>
