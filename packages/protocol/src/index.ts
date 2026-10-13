import {
  AssetKind,
  type ElementTypeDefinition,
  type NodeDescriptor,
  type PluginManifest,
  type ProviderDescriptor,
  type PromptPresetDefinition,
  type TemplateDefinition,
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

// ── 项目 ──────────────────────────────────────────────

/** 项目：一部片子的容器，下面挂多张画布，项目资产（角色、场景……）可以归到项目里 */
export const Project = z.object({
  id: z.string(),
  title: z.string(),
  createdAt: z.number(),
  /** 项目或其下任一画布最后修改的时间 */
  updatedAt: z.number(),
  /** 画布数 */
  canvases: z.number(),
  /** 最近修改的画布，打开项目时进入它 */
  lastCanvasId: z.string().nullable(),
  /** 列表专用：项目里最近的几张图片 / 视频封面地址 */
  covers: z.array(z.string()).optional(),
})
export type Project = z.infer<typeof Project>

export const CreateProject = z.object({
  title: z.string().trim().min(1).max(200).default('未命名项目'),
})
export type CreateProject = z.input<typeof CreateProject>

export const UpdateProject = z.object({ title: z.string().trim().min(1).max(200) })
export type UpdateProject = z.infer<typeof UpdateProject>

// ── 画布 ──────────────────────────────────────────────

export const Canvas = z.object({
  id: z.string(),
  projectId: z.string(),
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
  /** 建在哪个项目下；不填时新建一个同名项目（旧客户端、脚本照常可用） */
  projectId: z.string().max(100).optional(),
})
export type CreateCanvas = z.input<typeof CreateCanvas>

export const UpdateCanvas = z.object({ title: z.string().trim().min(1).max(200) })
export type UpdateCanvas = z.infer<typeof UpdateCanvas>

// ── 资产 ──────────────────────────────────────────────

// 资产类型由插件 SDK 定义（AssetRef 也用它），这里再导出给前后端
export { AssetKind }

/**
 * 衍生物：图片缩略图、视频封面、音频波形；
 * filmstrip（视频等距取帧拼成的横条）和 peaks（音频峰值 JSON）给剪辑时间线用，第一次请求时才生成
 */
export const AssetVariant = z.enum([
  'thumb-256',
  'thumb-1024',
  'poster',
  'waveform',
  'filmstrip',
  'peaks',
])
export type AssetVariant = z.infer<typeof AssetVariant>

/** filmstrip 横条里的帧数：第 k 帧取在时长的 (k + 0.5) / 16 处，各帧等宽 */
export const FILMSTRIP_FRAMES = 16

/** peaks 衍生物：每秒 rate 个峰值（0–1，单声道绝对值的最大值） */
export interface AudioPeaks {
  rate: number
  peaks: number[]
}

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

// ── 资产库 ────────────────────────────────────────────

/**
 * 资产库：把画布上的设定卡固化下来，跨画布、跨项目复用。
 * 条目只存设定和资产 id，二进制在资产存储里；用到画布上时展开成对应的卡片节点和参考图。
 */
export const LibraryKind = z.enum(['character', 'scene', 'prop', 'style', 'effect'])
export type LibraryKind = z.infer<typeof LibraryKind>

/** 一张参考图放在哪个位置：槽位由各类资产自己定义（全身、半身、设定图、多角度……），见 @plein/nodes 的 LIBRARY_KINDS */
export const LibraryImage = z.object({
  slot: z.string().trim().min(1).max(40),
  assetId: z.string().regex(/^[0-9a-f]{64}$/, '资产 id 不合法'),
})
export type LibraryImage = z.infer<typeof LibraryImage>

const libraryVoice = z.object({
  provider: z.string().max(100).default(''),
  voiceId: z.string().max(200).default(''),
})

const libraryTags = z.record(z.string().max(40), z.string().max(40))

const libraryFields = {
  name: z.string().trim().min(1).max(60),
  /** 归属项目；null 表示不归属任何项目（全局可用） */
  projectId: z.string().max(100).nullable().default(null),
  /** 设定 / 风格提示词 / 运镜描述：用到画布上就是卡片的「设定」，@ 引用时并入提示词 */
  description: z.string().max(4000).default(''),
  /** 筛选用的标签，如角色的 gender / age / region / era，键与可选值见 LIBRARY_KINDS */
  tags: libraryTags.default({}),
  /** 角色音色，只有角色用 */
  voice: libraryVoice.nullable().default(null),
  images: z.array(LibraryImage).max(24).default([]),
  /** 特效 / 运镜的参考视频（只给人看，不送进模型） */
  video: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable()
    .default(null),
  /** 适配模型（展示用，如 Seedance 2.0、Kling 3.0） */
  models: z.array(z.string().trim().min(1).max(60)).max(12).default([]),
}

export const CreateLibraryItem = z.object({ kind: LibraryKind, ...libraryFields })
export type CreateLibraryItem = z.input<typeof CreateLibraryItem>

/** 部分更新；kind 不能改 */
export const UpdateLibraryItem = z
  .object({
    name: libraryFields.name,
    projectId: z.string().max(100).nullable(),
    description: z.string().max(4000),
    tags: libraryTags,
    voice: libraryVoice.nullable(),
    images: z.array(LibraryImage).max(24),
    video: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
    models: z.array(z.string().trim().min(1).max(60)).max(12),
    favorite: z.boolean(),
  })
  .partial()
export type UpdateLibraryItem = z.infer<typeof UpdateLibraryItem>

export interface LibraryItem {
  id: string
  kind: LibraryKind
  name: string
  projectId: string | null
  description: string
  tags: Record<string, string>
  voice: { provider: string; voiceId: string } | null
  images: LibraryImage[]
  video: string | null
  models: string[]
  favorite: boolean
  /** 最近一次用到画布上的时间，「最近使用」按它排 */
  usedAt: number | null
  createdAt: number
  updatedAt: number
}

// ── 媒体加工 ──────────────────────────────────────────

/**
 * 加工操作。图片走 sharp，视频 / 音频走 ffmpeg：
 * crop/rotate/flip 只对图片；separate/frame 只对视频；split 只对音频；
 * trim/speed 对视频和音频都可用（视频变速同时处理音画）。
 */
export const MediaOp = z.enum([
  'crop',
  'rotate',
  'flip',
  'trim',
  'speed',
  'split',
  'separate',
  'frame',
])
export type MediaOp = z.infer<typeof MediaOp>

/** 时间区间（秒） */
export const MediaRange = z.object({
  start: z.number().min(0).default(0),
  end: z.number().positive(),
})
export type MediaRange = z.infer<typeof MediaRange>

const assetIdField = z.string().regex(/^[0-9a-f]{64}$/, '资产 id 不合法')
const deriveName = z.string().trim().max(120).optional()

/** 加工请求：一次一个操作，产出的都是新资产，源资产不动 */
export const MediaDeriveRequest = z.discriminatedUnion('op', [
  /** 图片裁剪，坐标对应显示出来的像素（含 EXIF 方向已纠正） */
  z.object({
    op: z.literal('crop'),
    assetId: assetIdField,
    left: z.number().int().min(0),
    top: z.number().int().min(0),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    name: deriveName,
  }),
  z.object({
    op: z.literal('rotate'),
    assetId: assetIdField,
    angle: z.union([z.literal(90), z.literal(180), z.literal(270)]),
    name: deriveName,
  }),
  z.object({
    op: z.literal('flip'),
    assetId: assetIdField,
    axis: z.enum(['horizontal', 'vertical']),
    name: deriveName,
  }),
  /** 视频 / 音频截取一段 */
  z.object({
    op: z.literal('trim'),
    assetId: assetIdField,
    start: z.number().min(0).default(0),
    end: z.number().positive(),
    name: deriveName,
  }),
  /** 变速；keepPitch 只对音频有意义（视频变速本来就同步处理音画） */
  z.object({
    op: z.literal('speed'),
    assetId: assetIdField,
    speed: z.number().min(0.25).max(4),
    keepPitch: z.boolean().default(true),
    name: deriveName,
  }),
  /** 音频手动切分：按给的区间切成多个资产 */
  z.object({
    op: z.literal('split'),
    assetId: assetIdField,
    segments: z.array(MediaRange).min(2).max(20),
    name: deriveName,
  }),
  /** 从视频分离出音频与无声视频两个资产 */
  z.object({ op: z.literal('separate'), assetId: assetIdField, name: deriveName }),
  /** 抽帧：任意时刻取一帧，落成图片资产 */
  z.object({
    op: z.literal('frame'),
    assetId: assetIdField,
    at: z.number().min(0),
    name: deriveName,
  }),
])
export type MediaDeriveRequest = z.infer<typeof MediaDeriveRequest>

/** 加工结果：产物 + 来源（源资产、操作、参数），供 UI 展示与回溯 */
export const MediaDerivation = z.object({
  source: z.object({ assetId: z.string(), kind: AssetKind, name: z.string() }),
  op: MediaOp,
  /** 参数回显，例如 { start: 1, end: 3 } */
  params: z.record(z.string(), z.unknown()),
  assets: z.array(Asset),
  /** 能力降级等需要如实告知的话，例如本机没有 rubberband */
  note: z.string().optional(),
})
export type MediaDerivation = z.infer<typeof MediaDerivation>

/** 本机媒体能力，UI 据此隐藏做不到的操作 */
export interface MediaCapsInfo {
  ffmpeg: boolean
  /** 有 ass 滤镜，能烧字幕 */
  subtitles: boolean
  /** 有 rubberband 滤镜，音频变速能真正保音调 */
  rubberband: boolean
}

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

/** 从一个节点出发运行：upstream 运行到此处（含上游），downstream 运行它和下游 */
export const FlowRunOptions = z.object({
  scope: z.enum(['upstream', 'downstream']),
  /** 忽略缓存，范围内的节点全部重新运行 */
  force: z.boolean().default(false),
})
export type FlowRunOptions = z.infer<typeof FlowRunOptions>

/** 从一个节点发起批量运行（分镜的「批量出分镜图」）：这些节点重新运行，@ 到的卡片的上游先跑 */
export const BatchRunOptions = z.object({
  nodes: z.array(z.string().min(1).max(200)).min(1).max(500),
})
export type BatchRunOptions = z.infer<typeof BatchRunOptions>

/** 画布上需要重跑的节点 */
export interface StaleNodes {
  /** 自己的参数或输入变了，当前结果已经过期 */
  stale: string[]
  /** 上游过期，跟着需要重跑 */
  upstream: string[]
}

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

/** 任务面板里的一条运行记录 */
/** 任务状态；与 @plein/doc 的 RunStatus 一致，见 apps/server/src/shared-types.test.ts */
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled'

export interface JobInfo {
  id: string
  nodeId: string
  nodeType: string
  /** 整组运行时所属的那次运行 */
  groupId?: string
  status: JobStatus
  /** 已尝试次数（含自动重试） */
  attempts: number
  error?: string
  createdAt: number
  startedAt?: number
  finishedAt?: number
}

export interface GroupInfo extends GroupRunState {
  /** Frame 整组运行时是 Frame，运行到此处 / 运行下游时是出发的节点 */
  frameId: string
  scope: 'frame' | 'upstream' | 'downstream'
  createdAt: number
  finishedAt?: number
}

/** 画布最近的运行记录，新的在前 */
export interface JobList {
  jobs: JobInfo[]
  groups: GroupInfo[]
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

// ── 对外开放 MCP ────────────────────────────────────

/** 对外开放的 MCP（让 Claude Desktop、Cursor 等连本机 Plein）：令牌只在生成时返回一次 */
export interface ExternalMcpStatus {
  enabled: boolean
  createdAt?: number
}

export interface ExternalMcpToken {
  token: string
  createdAt: number
}

// ── 智能体 ────────────────────────────────────────────

/** 插件贡献的能力（给 ⌘K 和智能体面板显示） */
export interface PluginCapabilityInfo {
  /** 工具名，调用时用它 */
  name: string
  title: string
  description: string
  effect: 'read' | 'edit' | 'run' | 'destructive'
  palette?: 'always' | 'selection'
  /** 插件名 */
  plugin: string
}

/** 从 ⌘K 调用一个服务端能力 */
export const CapabilityCall = z.object({
  input: z.record(z.string(), z.unknown()).default({}),
  selection: z.array(z.string().max(200)).max(1000).default([]),
})
export type CapabilityCall = z.infer<typeof CapabilityCall>

export interface CapabilityCallResult {
  /** 能力的结果（文字） */
  result: string
  /** 改了画布时可以撤销：调用撤销接口时带上它 */
  undo?: string
}

/**
 * 智能体：
 * - builtin 内置：用已启用平台里支持工具调用的对话模型（如千问），不用装 CLI；
 * - claude / codex：服务端调用用户电脑上已安装、已登录的 CLI，通过 Plein 的 MCP 工具读写画布，
 *   只在本机免登录模式（含桌面端）可用。
 */
export const AgentKind = z.enum(['builtin', 'claude', 'codex'])
export type AgentKind = z.infer<typeof AgentKind>

/**
 * 智能体花钱、删东西前要不要问用户：
 * rules 视频、整组运行、删用户已有的东西、一轮运行超过 6 次时问；always 每次运行和删除都问；auto 都不问。
 */
export const AgentApprovalMode = z.enum(['rules', 'always', 'auto'])
export type AgentApprovalMode = z.infer<typeof AgentApprovalMode>

/**
 * 本机 CLI（Claude Code、Codex）能在电脑上做多少事：
 * auto 读文件、查资料直接做，改文件、跑命令、用你自己的 MCP 工具前先在面板里问；full 完全放开，不再询问。
 * 画布上花钱、删除的确认仍按 AgentApprovalMode。
 */
export const AgentAccess = z.enum(['auto', 'full'])
export type AgentAccess = z.infer<typeof AgentAccess>

/** 本机 CLI 的安装、登录和版本状态（设置页用） */
export interface LocalCliInfo {
  id: Exclude<AgentKind, 'builtin'>
  name: string
  installed: boolean
  version?: string
  /** 可执行文件路径 */
  path?: string
  /** 是否已登录；null 表示查不出来（版本太旧或检查超时） */
  loggedIn: boolean | null
  /** npm 上的最新版本；查不到时没有 */
  latest?: string
  updateAvailable: boolean
  /** 一键更新会执行的命令；没有时只能手动更新 */
  updateCommand?: string
  /** 在终端里安装的命令 */
  installCommand: string
  /** 在终端里登录的命令 */
  loginCommand: string
}

export interface LocalCliUpdateResult {
  ok: boolean
  /** 命令输出的最后一段，失败时给用户看 */
  output: string
  cli: LocalCliInfo
}

export interface AgentCli {
  id: AgentKind
  name: string
  /** 能用：CLI 在本机找到了可执行文件；内置的有支持工具调用的对话模型 */
  available: boolean
  version?: string
  /** 内置智能体用的模型（给人看） */
  model?: string
}

export interface AgentStatus {
  /** 服务端是否允许启动本机智能体 */
  enabled: boolean
  /** 不可用的原因（给用户看） */
  reason?: string
  agents: AgentCli[]
}

/** 对话里的一项：用户消息、智能体回复、一次工具调用或错误 */
export type AgentItem =
  | { id: string; type: 'user'; text: string; selection?: string[]; at: number }
  | { id: string; type: 'text'; text: string; at: number }
  | {
      id: string
      type: 'tool'
      /** 工具名（Plein 工具不带 MCP 前缀） */
      name: string
      /** 参数摘要，给人看 */
      detail?: string
      status: 'running' | 'done' | 'error'
      /** 结果摘要 */
      output?: string
      at: number
    }
  | { id: string; type: 'error'; text: string; at: number }
  | {
      id: string
      /** 一轮对话对画布的改动，可整轮撤销 */
      type: 'changes'
      turn: string
      created: string[]
      updated: string[]
      deleted: string[]
      /** 新增与删除的连线数 */
      edges: number
      runs: number
      /** 现在能撤销：只能从最近一轮往回撤，服务重启或会话空闲太久后不能再撤 */
      undoable: boolean
      undone?: boolean
      at: number
    }
  | {
      id: string
      /** 计划：大任务先列步骤，用户同意后执行，逐步打勾。id 就是确认单 id */
      type: 'plan'
      summary?: string
      steps: Array<{ title: string; status: 'todo' | 'doing' | 'done' | 'skipped' }>
      status: 'pending' | 'approved' | 'denied' | 'expired'
      at: number
    }
  | {
      id: string
      /** 等用户确认的操作：允许后服务端直接执行 */
      type: 'approval'
      tool: string
      reason: string
      /** 相关元素 */
      ids: string[]
      status: 'pending' | 'approved' | 'denied' | 'expired'
      at: number
    }

export interface AgentSession {
  id: string
  canvasId: string
  agent: AgentKind
  title: string
  status: 'idle' | 'running'
  createdAt: number
  updatedAt: number
  items: AgentItem[]
}

export type AgentSessionSummary = Omit<AgentSession, 'items'>

export const CreateAgentSession = z.object({ agent: AgentKind })
export type CreateAgentSession = z.infer<typeof CreateAgentSession>

export const SendAgentMessage = z.object({
  text: z.string().trim().min(1).max(20_000),
  /** 用户当前选中的元素 id，作为上下文告诉智能体 */
  selection: z.array(z.string().max(200)).max(200).optional(),
  /** 这一轮的确认方式，默认 rules */
  approval: AgentApprovalMode.optional(),
  /** 计划模式：先列计划，用户同意后才动手 */
  plan: z.boolean().optional(),
  /** 本机 CLI 的电脑权限，默认 auto */
  access: AgentAccess.optional(),
})
export type SendAgentMessage = z.infer<typeof SendAgentMessage>

/** 会话事件流（SSE）：先推一次完整会话，之后推增量 */
export type AgentEvent =
  | { type: 'session'; session: AgentSession }
  | { type: 'item'; item: AgentItem }
  | { type: 'status'; status: AgentSession['status'] }
  /** 智能体刚改动了这些元素（画布上短暂高亮） */
  | { type: 'touch'; ids: string[] }
  /** 智能体请用户的画布执行界面动作：平滑定位到元素 / 选中元素 */
  | { type: 'ui'; action: 'focus' | 'select'; ids: string[] }

// ── 路径 ──────────────────────────────────────────────

export const API = {
  session: '/api/session',
  /** Better Auth 接口前缀：sign-up/email、sign-in/email、sign-out */
  auth: '/api/auth',
  templates: '/api/templates',
  template: (id: string) => `/api/templates/${encodeURIComponent(id)}`,
  projects: '/api/projects',
  project: (id: string) => `/api/projects/${encodeURIComponent(id)}`,
  /** 项目下的画布，按最近修改排序 */
  projectCanvases: (id: string) => `/api/projects/${encodeURIComponent(id)}/canvases`,
  canvases: '/api/canvases',
  canvas: (id: string) => `/api/canvases/${encodeURIComponent(id)}`,
  /** 资产库：GET 列表（?kind=），POST 新建，body 为 CreateLibraryItem */
  library: '/api/library',
  libraryItem: (id: string) => `/api/library/${encodeURIComponent(id)}`,
  /** 记一次「用到画布上」，最近使用按它排 */
  libraryUse: (id: string) => `/api/library/${encodeURIComponent(id)}/use`,
  assets: '/api/assets',
  asset: (id: string) => `/api/assets/${id}`,
  assetMeta: (id: string) => `/api/assets/${id}/meta`,
  assetVariant: (id: string, v: AssetVariant) => `/api/assets/${id}/${v}`,
  /** 媒体加工：裁剪 / 旋转 / 镜像 / 截取 / 变速 / 切分 / 音视频分离 / 抽帧，body 为 MediaDeriveRequest */
  mediaDerive: '/api/media/derive',
  /** 本机媒体能力，返回 MediaCapsInfo */
  mediaCaps: '/api/media/caps',
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
  /** 运行到此处 / 运行下游，body 为 FlowRunOptions，返回 GroupRunStarted */
  nodeFlowRun: (canvasId: string, nodeId: string) =>
    `/api/canvases/${encodeURIComponent(canvasId)}/nodes/${encodeURIComponent(nodeId)}/run-flow`,
  /** 批量运行，body 为 BatchRunOptions，返回 GroupRunStarted */
  nodeBatchRun: (canvasId: string, nodeId: string) =>
    `/api/canvases/${encodeURIComponent(canvasId)}/nodes/${encodeURIComponent(nodeId)}/run-batch`,
  /** 需要重跑的节点，返回 StaleNodes */
  canvasStale: (canvasId: string) => `/api/canvases/${encodeURIComponent(canvasId)}/stale`,
  /** 整组运行 Frame 里的节点，返回 GroupRunStarted */
  frameRun: (canvasId: string, frameId: string) =>
    `/api/canvases/${encodeURIComponent(canvasId)}/frames/${encodeURIComponent(frameId)}/run`,
  groupRun: (groupId: string) => `/api/runs/groups/${encodeURIComponent(groupId)}`,
  groupCancel: (groupId: string) => `/api/runs/groups/${encodeURIComponent(groupId)}/cancel`,
  /** 画布最近的运行记录，返回 JobList */
  canvasJobs: (canvasId: string) => `/api/canvases/${encodeURIComponent(canvasId)}/jobs`,
  /** Yjs 同步（y-websocket 协议），房间名为画布 id */
  sync: '/sync',
  /** 本机智能体是否可用，返回 AgentStatus */
  agent: '/api/agent',
  /** 本机 CLI 的安装、登录和版本，返回 LocalCliInfo[]；?refresh=1 重新检测 */
  agentClis: '/api/agent/clis',
  /** 运行 CLI 的更新命令，返回 LocalCliUpdateResult */
  agentCliUpdate: (id: string) => `/api/agent/clis/${encodeURIComponent(id)}/update`,
  /** 画布上的智能体会话：GET 列表，POST 新建 */
  agentSessions: (canvasId: string) =>
    `/api/canvases/${encodeURIComponent(canvasId)}/agent/sessions`,
  agentSession: (id: string) => `/api/agent/sessions/${encodeURIComponent(id)}`,
  agentMessages: (id: string) => `/api/agent/sessions/${encodeURIComponent(id)}/messages`,
  agentStop: (id: string) => `/api/agent/sessions/${encodeURIComponent(id)}/stop`,
  /** 允许或跳过一张确认单，body 为 { allow: boolean } */
  agentApproval: (id: string, approvalId: string) =>
    `/api/agent/sessions/${encodeURIComponent(id)}/approvals/${encodeURIComponent(approvalId)}`,
  /** 对外开放的 MCP：GET 状态，POST 生成新令牌（旧的作废），DELETE 关闭 */
  mcpExternal: '/api/mcp/external',
  /** 插件贡献的能力，返回 PluginCapabilityInfo[] */
  capabilities: '/api/capabilities',
  /** 在画布上调用一个插件能力，body 为 CapabilityCall，返回 CapabilityCallResult */
  capabilityCall: (canvasId: string, name: string) =>
    `/api/canvases/${encodeURIComponent(canvasId)}/capabilities/${encodeURIComponent(name)}`,
  /** 撤销一次能力调用对画布的改动 */
  capabilityUndo: (id: string) => `/api/capability-calls/${encodeURIComponent(id)}/undo`,
  /** 撤销智能体某一轮对画布的改动 */
  agentUndo: (id: string, turn: string) =>
    `/api/agent/sessions/${encodeURIComponent(id)}/turns/${encodeURIComponent(turn)}/undo`,
  /** 会话事件流（SSE），见 AgentEvent */
  agentEvents: (id: string) => `/api/agent/sessions/${encodeURIComponent(id)}/events`,
} as const

export const ApiError = z.object({ error: z.string(), message: z.string() })
export type ApiError = z.infer<typeof ApiError>

/**
 * 服务端任务动态。桌面端里服务端经 parentPort 发给主进程，
 * 主进程据此显示 Dock 徽标和进度、发系统通知、有任务时退出前确认、阻止系统休眠。
 */
export type RunActivity =
  | {
      type: 'jobs'
      queued: number
      running: number
      /** 运行中且报告了进度的任务的平均进度（0–1）；都没报告时不给 */
      progress?: number
    }
  | {
      type: 'job-finished'
      canvasId: string
      nodeId: string
      groupId?: string
      /** 节点名，没有时用节点类型的标题 */
      title: string
      status: JobStatus
      error?: string
    }
  | {
      type: 'group-finished'
      canvasId: string
      /** 整组运行的 Frame，或“运行到此处 / 运行下游”的起点节点 */
      frameId: string
      title: string
      status: 'done' | 'canceled'
      summary: GroupRunSummary
    }

/** 桌面端 preload 暴露给页面的原生能力；浏览器里不存在（window.pleinDesktop 为 undefined） */
export type DesktopEditCommand = 'undo' | 'redo' | 'selectAll'
export type DesktopMenuCommand = DesktopEditCommand | 'settings'

/** 系统通知被点击：打开画布并定位到节点 */
export interface DesktopOpenNode {
  canvasId: string
  nodeId: string
}

/** 文件保存结果：savePath 只在保存成功时有 */
export interface DesktopSaved {
  name: string
  state: 'completed' | 'cancelled' | 'interrupted'
  savePath?: string
}

/** 新版本安装包的下载进度；字节数可能为 0（服务器没给长度） */
export interface DesktopUpdateProgress {
  version: string
  /** 0–100 */
  percent: number
  transferred: number
  total: number
  bytesPerSecond: number
}

export interface DesktopBridge {
  platform: string
  onMenuCommand(listener: (command: DesktopMenuCommand) => void): () => void
  nativeEdit(command: DesktopEditCommand): Promise<void>
  /** 在系统文件管理器里打开数据目录 */
  openDataDir(): Promise<void>
  /** 点击系统通知后要定位的节点 */
  onOpenNode(listener: (target: DesktopOpenNode) => void): () => void
  /** 下载（另存为）结束 */
  onSaved(listener: (saved: DesktopSaved) => void): () => void
  /** 在访达 / 资源管理器里显示刚保存的文件；只接受本次运行中保存过的路径 */
  showSavedFile(path: string): Promise<void>
  /** 更新包下载中持续推送进度，下载结束（成功或失败）推送 null */
  onUpdateProgress(listener: (progress: DesktopUpdateProgress | null) => void): () => void
}
