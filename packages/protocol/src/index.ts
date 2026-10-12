import type {
  ElementTypeDefinition,
  NodeDescriptor,
  PluginManifest,
  ProviderDescriptor,
  PromptPresetDefinition,
  TemplateDefinition,
} from '@plein/plugin-sdk'
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

export const SessionInfo = z.object({
  /** 未登录时为 null */
  principal: Principal.nullable(),
  /** 服务端是否要求登录（监听非本机地址时） */
  authRequired: z.boolean(),
  /** 要求登录但还没有所有者账号：前端显示创建账号 */
  needsSetup: z.boolean(),
})
export type SessionInfo = z.infer<typeof SessionInfo>

// ── 画布 ──────────────────────────────────────────────

export const Canvas = z.object({
  id: z.string(),
  title: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  /** 列表专用：画布里最近的几张图片 / 视频封面地址，做首页缩略图 */
  covers: z.array(z.string()).optional(),
  /** 列表专用：顶层以外也算在内的元素数 */
  elements: z.number().optional(),
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

// ── 插件 ──────────────────────────────────────────────

export interface PluginInfo {
  id: string
  name: string
  version: string
  description?: string
  builtin: boolean
  status: 'active' | 'error'
  error?: string
  contributes: PluginManifest['contributes']
  permissions: PluginManifest['permissions']
}

export interface ProviderInfo extends ProviderDescriptor {
  enabled: boolean
  /** 必填密钥是否都已填写 */
  configured: boolean
}

/** 已安装插件提供的全部能力，前端据此生成节点菜单、表单和设置页 */
export interface Catalog {
  plugins: PluginInfo[]
  nodes: Array<NodeDescriptor & { executable: boolean }>
  providers: ProviderInfo[]
  templates: Array<TemplateDefinition & { plugin: string }>
  prompts: Array<PromptPresetDefinition & { plugin: string }>
  elements: Array<
    Pick<ElementTypeDefinition, 'type' | 'title' | 'description' | 'defaultSize'> & {
      dataSchema: Record<string, unknown>
      plugin: string
    }
  >
}

/** 平台配置的读取视图：密钥只返回是否已填写 */
export interface ProviderConfigView {
  enabled: boolean
  settings: Record<string, unknown>
  secrets: Record<string, boolean>
}

export const ProviderConfigUpdate = z.object({
  enabled: z.boolean().optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
  /** 值为 null 或空串表示删除 */
  secrets: z.record(z.string(), z.string().nullable()).optional(),
})
export type ProviderConfigUpdate = z.infer<typeof ProviderConfigUpdate>

export interface ProviderTestResult {
  ok: boolean
  code?: string
  message?: string
}

export interface NodeRunStarted {
  runId: string
}

/** 整组运行（Frame）的选项 */
export const GroupRunOptions = z.object({
  /** 是否包含视频节点（贵且慢，默认不跑） */
  video: z.boolean().default(false),
  /** 忽略缓存：参数和输入都没变的节点也重新运行 */
  force: z.boolean().default(false),
})
export type GroupRunOptions = z.infer<typeof GroupRunOptions>

export interface GroupRunStarted {
  groupId: string
  /** 组内要运行的节点数 */
  total: number
}

export interface GroupRunSummary {
  succeeded: number
  /** 参数和输入都没变，沿用已有结果 */
  cached: number
  failed: number
  canceled: number
  /** 上游失败或取消而没有运行 */
  skipped: number
}

export interface GroupRunState {
  id: string
  status: 'running' | 'done' | 'canceled'
  total: number
  summary?: GroupRunSummary
}

/** 用户存的模板：Frame 和里面的元素、内部连线，格式同复制粘贴（ClipboardData） */
export const TemplateData = z.object({
  plein: z.literal(1),
  elements: z
    .array(z.looseObject({ id: z.string(), kind: z.string() }))
    .min(1)
    .max(500),
  edges: z.array(z.looseObject({ id: z.string() })).max(2000),
})
export const CreateTemplate = z.object({
  title: z.string().trim().min(1).max(60),
  data: TemplateData,
})
export interface UserTemplate {
  id: string
  title: string
  createdAt: number
  data: z.infer<typeof TemplateData>
}

// ── 提示词改写 ────────────────────────────────────────

/**
 * 用已启用的对话模型改写提示词：
 * - optimize：按目标（出图 / 视频）补全主体、景别、光线、运镜等；
 * - translate：中英互译。
 * `@引用` 与 `【占位】` 原样保留。
 */
export const RewritePrompt = z.object({
  text: z.string().trim().min(1).max(8000),
  mode: z.enum(['optimize', 'translate']),
  target: z.enum(['image', 'video']).default('image'),
  /** 模型引用 vendor/name:model；不填用第一个已启用的对话模型 */
  model: z.string().optional(),
  /** 画布上可被 @ 引用的名字，用来识别要原样保留的引用 */
  mentions: z.array(z.string().min(1).max(100)).max(500).optional(),
})
export type RewritePrompt = z.input<typeof RewritePrompt>

export interface RewritePromptResult {
  text: string
  /** 实际使用的模型引用 */
  model: string
}

// ── 路径 ──────────────────────────────────────────────

export const API = {
  session: '/api/session',
  /** Better Auth 接口前缀：sign-up/email、sign-in/email、sign-out */
  auth: '/api/auth',
  templates: '/api/templates',
  template: (id: string) => `/api/templates/${encodeURIComponent(id)}`,
  canvases: '/api/canvases',
  canvas: (id: string) => `/api/canvases/${encodeURIComponent(id)}`,
  assets: '/api/assets',
  asset: (id: string) => `/api/assets/${id}`,
  assetMeta: (id: string) => `/api/assets/${id}/meta`,
  assetVariant: (id: string, v: AssetVariant) => `/api/assets/${id}/${v}`,
  catalog: '/api/catalog',
  /** 优化 / 翻译提示词，见 RewritePrompt */
  promptRewrite: '/api/prompt/rewrite',
  /** Provider id 形如 vendor/name，直接作为两段路径 */
  providerConfig: (id: string) => `/api/providers/${id}/config`,
  providerTest: (id: string) => `/api/providers/${id}/test`,
  /** 运行画布上的一个节点；状态与结果经 Yjs 同步回画布 */
  nodeRun: (canvasId: string, nodeId: string) =>
    `/api/canvases/${encodeURIComponent(canvasId)}/nodes/${encodeURIComponent(nodeId)}/run`,
  nodeCancel: (canvasId: string, nodeId: string) =>
    `/api/canvases/${encodeURIComponent(canvasId)}/nodes/${encodeURIComponent(nodeId)}/cancel`,
  /** 整组运行 Frame 里的节点，返回 GroupRunStarted */
  frameRun: (canvasId: string, frameId: string) =>
    `/api/canvases/${encodeURIComponent(canvasId)}/frames/${encodeURIComponent(frameId)}/run`,
  groupRun: (groupId: string) => `/api/runs/groups/${encodeURIComponent(groupId)}`,
  groupCancel: (groupId: string) => `/api/runs/groups/${encodeURIComponent(groupId)}/cancel`,
  /** Yjs 同步（y-websocket 协议），房间名为画布 id */
  sync: '/sync',
} as const

export const ApiError = z.object({ error: z.string(), message: z.string() })
export type ApiError = z.infer<typeof ApiError>

/** 桌面端 preload 暴露给页面的原生能力；浏览器里不存在（window.pleinDesktop 为 undefined） */
export type DesktopEditCommand = 'undo' | 'redo' | 'selectAll'
export type DesktopMenuCommand = DesktopEditCommand | 'settings'

export interface DesktopBridge {
  platform: string
  onMenuCommand(listener: (command: DesktopMenuCommand) => void): () => void
  nativeEdit(command: DesktopEditCommand): Promise<void>
  /** 在系统文件管理器里打开数据目录 */
  openDataDir(): Promise<void>
}
