import type { ElementRenderer, Engine } from '@plein/canvas-core'
import { type CanvasElement } from '@plein/doc'
import {
  ANIMATIC_TYPE,
  MOTION_TYPE,
  SEQUENCE_TYPE,
  STAGE_TYPE,
  STORYBOARD_TYPE,
} from '@plein/nodes'
import type { ReactNode } from 'react'
import { RendererRegistry } from '@plein/canvas-core'
import { useCanvas } from '../stores/canvas'
import type { Upstream } from './nodes'

/** 双击节点时打开编辑器的上下文 */
export interface EditorContext {
  engine: Engine
  el: CanvasElement
}

/** 生成器面板里节点专属块的上下文；ups 是当前输入连线带来的上游 */
export interface PanelContext extends EditorContext {
  canvasId: string
  ups: Map<string, Upstream[]>
}

/**
 * 画布上特殊节点的前端行为登记：nodeType → 行为。
 *
 * catalog 只决定「有哪些节点可用」——它是可序列化的 HTTP 数据，推导不出
 * Pixi 渲染器或 React 面板；打开行为、编辑器形态、渲染器这类不可序列化的
 * 能力在这里登记一次，分发处不再按 nodeType 字面量分支。
 * 新增特殊节点需要专门的打开行为或编辑器时，在这里加一条。
 */
export interface NodeRegistration {
  /** 双击节点时打开的编辑器；缺省聚焦生成器 */
  open?: (id: string) => void
  /** Pixi 渲染器：RendererRegistry 的 nodeType 查找层；缺省用 node 通用渲染器 */
  renderer?: ElementRenderer
  /** 新建节点时的默认尺寸；缺省按节点声明与画幅推导 */
  size?: { width: number; height: number }
  /** 生成器（节点编辑面板）的定制 */
  editor?: EditorRegistration
  /** 结果条（ResultBar / ResultActions）的定制 */
  result?: ResultRegistration
  /** 右键菜单（单选该节点时）的条目 */
  menu?: MenuRegistration
}

export interface EditorRegistration {
  /** 面板尺寸；缺省按节点形态取（资产卡宽、纯文本窄、其余标准宽） */
  size?: { width: number; height: number }
  /** 锁定 / 只读时浮动在节点下方的入口；缺省没有 */
  lockedEntry?: (ctx: EditorContext) => ReactNode
  /** 替代默认生成器面板的内容；缺省 GeneratorPanel */
  content?: (ctx: EditorContext) => ReactNode
  /** 追加在生成器面板内容里的节点专属块（编辑分镜表等入口按钮） */
  panel?: (ctx: PanelContext) => ReactNode
}

export interface ResultRegistration {
  /** 锁定 / 只读时结果条上的面板入口（拉片清单） */
  lockedEntry?: (el: CanvasElement) => ReactNode
  /** 结果是空间参考（构图截图），不是普通成图：不提供重绘、宫格等再加工入口 */
  reference?: boolean
}

export interface MenuRegistration {
  label: string
  onClick(id: string): void
}

const REGISTRY = new Map<string, NodeRegistration>([
  [STORYBOARD_TYPE, { open: (id) => useCanvas.getState().openStoryboard(id) }],
  [SEQUENCE_TYPE, { open: (id) => useCanvas.getState().openSequence(id) }],
  [ANIMATIC_TYPE, { open: (id) => useCanvas.getState().openSequence(id) }],
  [STAGE_TYPE, { open: (id) => useCanvas.getState().openStage(id) }],
  [MOTION_TYPE, { open: (id) => useCanvas.getState().openMotion(id) }],
])

/** 按节点类型取登记；未登记的节点走各分发处的缺省行为 */
export const nodeRegistration = (nodeType: string | undefined): NodeRegistration | undefined =>
  nodeType ? REGISTRY.get(nodeType) : undefined

/** 双击节点：登记了打开行为的进专属编辑器，其余聚焦生成器 */
export function activateNode(el: CanvasElement): void {
  if (el.kind !== 'node') return
  const open = nodeRegistration(el.nodeType)?.open
  if (open) return open(el.id)
  // 面板在选中后的下一帧才挂载，等一帧再聚焦生成器的提示词
  requestAnimationFrame(() =>
    window.dispatchEvent(new CustomEvent('plein:focus-generator', { detail: el.id })),
  )
}

/** 由注册表生成渲染器注册表：nodeType 查找层优先，未登记的类型落回 kind 通用渲染器 */
export function rendererRegistry(): RendererRegistry {
  const registry = new RendererRegistry()
  for (const [nodeType, registration] of REGISTRY)
    if (registration.renderer) registry.registerNodeType(nodeType, registration.renderer)
  return registry
}
