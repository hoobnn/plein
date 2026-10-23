import type { ProductionRecord } from './production'
import type { CompositionSourceRef } from '@plein/plugin-sdk/ports'
import type { CreativeReview } from './review-types'
import type { DeliveryRecord } from './delivery'
import type { GenerationOrigin, VideoSegment } from './video-segment'

/** 画布元素类型。工作流节点统一为 `node`，具体节点由 `nodeType` 区分。 */
export type ElementKind = 'image' | 'video' | 'audio' | 'markdown' | 'node' | 'frame' | 'sequence'

export const ELEMENT_KINDS: readonly ElementKind[] = [
  'image',
  'video',
  'audio',
  'markdown',
  'node',
  'frame',
  'sequence',
]

/** 可以作为父元素（分组容器）的类型 */
export const CONTAINER_KINDS: ReadonlySet<ElementKind> = new Set(['frame'])

/** 素材元素：尺寸由内容决定（媒体按原始比例、Markdown 按正文高度），不能手动缩放 */
export const AUTO_SIZE_KINDS: ReadonlySet<ElementKind> = new Set([
  'image',
  'video',
  'audio',
  'markdown',
])

/** 音频素材的固定尺寸：波形条 */
export const AUDIO_SIZE = { w: 384, h: 96 } as const

export type PortType = 'text' | 'image' | 'video' | 'audio' | 'json' | 'any'

export interface Port {
  id: string
  label: string
  type: PortType
  /** 输入端口可接多条连线（如多张参考图）；否则新连线替换旧连线 */
  multiple?: boolean
  /** 输入端口必须连线才能运行 */
  required?: boolean
}

export interface Ports {
  inputs: Port[]
  outputs: Port[]
}

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/**
 * 元素的只读快照。文档里每个元素是一个嵌套 Y.Map，这里是它的普通对象视图。
 * x / y 是相对父元素左上角的局部坐标；没有父元素时即世界坐标。
 */
export interface CanvasElement extends Rect {
  id: string
  kind: ElementKind
  rotation: number
  /** 分数索引，同一父元素下按字符串升序绘制（相同时按 id） */
  z: string
  parentId: string | null
  locked: boolean
  name?: string
  /** 强调色（#rrggbb），目前用于 Frame 的底色和边框 */
  color?: string
  /** 指向资产系统，二进制不进文档 */
  assetId?: string
  videoSegment?: VideoSegment
  /** Markdown 等文本内容（文档里是 Y.Text） */
  text?: string
  /** 节点参数（文档里是 Y.Map，按键合并并发修改） */
  params?: Record<string, unknown>
  ports?: Ports
  nodeType?: string
  nodeVersion?: number
  /** 节点结果，新到旧 */
  results?: NodeResult[]
  /** 当前采用的结果 id；null 表示候选均待采用，未设置时兼容使用最新结果 */
  adopted?: string | null
  /** 人工验收按具体候选保存，独立于生成参数与采用状态。 */
  reviews?: CreativeReview[]
  production?: ProductionRecord
  deliveries?: DeliveryRecord[]
  run?: NodeRun
}

/** 节点结果的值：文本直接存，媒体只存资产 id */
export type ResultValue =
  | { type: 'text'; text: string }
  | { type: 'json'; value: unknown }
  | {
      type: 'image' | 'video' | 'audio'
      assetId: string
      mime?: string
      compositionSource?: CompositionSourceRef
      /** 语音的台词（配音节点写入，导出时用作字幕） */
      caption?: string
    }

/** 节点的一个结果（候选）。一次运行可能产出多个，按时间新到旧排列 */
export interface NodeResult {
  id: string
  /** 输出端口 id */
  port: string
  value: ResultValue
  /** 同一次运行的结果共享 runId */
  runId: string
  /** Immutable original execution identity; local job aliases and copied carriers never rewrite it. */
  generationOrigin?: GenerationOrigin
  /** 本次运行内的候选关联键，例如一条视频与它自己的尾帧。 */
  outputGroup?: string
  at: number
}

export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled'

/**
 * 运行中调用外部平台的阶段：
 * waiting 等本地平台调用空位 → submitting 提交（同步平台在这一步直接出结果）→
 * accepted 平台已受理、状态待查询 →
 * queued 平台排队 → generating 平台生成中 → saving 下载结果存入资产库；
 * retrying 是出错后等待自动重试
 */
export type RunPhase =
  | 'waiting'
  | 'submitting'
  | 'accepted'
  | 'queued'
  | 'generating'
  | 'saving'
  | 'retrying'

/** 节点最近一次运行的状态，由服务端写入，不进撤销栈 */
export interface NodeRun {
  id: string
  status: RunStatus
  /** 0–1 */
  progress?: number
  /** 执行器自己的提示（如“识别对白…”）；重试时是出错原因 */
  message?: string
  error?: string
  /** 失败时的错误类别（ProviderErrorCode / NodeRunError 的 code），界面据此给出处理建议 */
  errorCode?: string
  /** 运行中当前所处的阶段，没有时只知道“生成中” */
  phase?: RunPhase
  /** 正在调用的平台和模型，如“火山方舟 · Seedance 1.0 Pro” */
  via?: string
  /** 开始运行的时间，界面据此显示已用时长 */
  startedAt?: number
  /** 等待自动重试时，下次重试的时间 */
  retryAt?: number
  /** 第几次尝试（含自动重试），大于 1 时显示 */
  attempt?: number
  at: number
}

export type PortAddress = [elementId: string, portId: string]

export interface Edge {
  id: string
  from: PortAddress
  to: PortAddress
  /** 目标端口内的稳定顺序；旧文档升级时一次性固化空间顺序。 */
  order?: string
}

/** 新建元素的输入：未给的字段取默认值 */
export interface NewElement extends Rect {
  kind: ElementKind
  id?: string
  rotation?: number
  parentId?: string | null
  locked?: boolean
  name?: string
  color?: string
  assetId?: string
  videoSegment?: VideoSegment
  text?: string
  params?: Record<string, unknown>
  ports?: Ports
  nodeType?: string
  nodeVersion?: number
  /** 复制节点时带上结果 */
  results?: NodeResult[]
  adopted?: string | null
  reviews?: CreativeReview[]
  production?: ProductionRecord
  deliveries?: DeliveryRecord[]
}

/** 可直接覆盖的元素字段；z、parentId、text、params 走专门的命令 */
export type ElementPatch = Partial<
  Pick<
    CanvasElement,
    | 'x'
    | 'y'
    | 'w'
    | 'h'
    | 'rotation'
    | 'locked'
    | 'name'
    | 'color'
    | 'assetId'
    | 'ports'
    | 'nodeType'
    | 'nodeVersion'
    | 'deliveries'
  >
>

/** 按帧归并后的变更：集合里的 id 可能已被删除，订阅方自行用 get 判断 */
export interface DocChange {
  elements: ReadonlySet<string>
  edges: ReadonlySet<string>
}
