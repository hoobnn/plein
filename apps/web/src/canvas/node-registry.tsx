import type { ElementRenderer, Engine } from '@plein/canvas-core'
import { type CanvasElement } from '@plein/doc'
import {
  AI_SCENE_TYPE,
  AI_SUMMARY_TYPE,
  ANIMATIC_TYPE,
  MOTION_TYPE,
  SEQUENCE_TYPE,
  SHOT_ANALYSIS_TYPE,
  STAGE_TYPE,
  STORYBOARD_TYPE,
  stageSnapshotsOf,
} from '@plein/nodes'
import type { ReactNode } from 'react'
import { RendererRegistry } from '@plein/canvas-core'
import { AiAnalysisEntry } from '../features/ai-shot-analysis/AiAnalysisEditor'
import { ProfileSummary } from '../features/generator/ProfileSummary'
import { shotsOf } from '../features/storyboard/model'
import { useCanvas } from '../stores/canvas'
import type { Upstream } from './nodes'

/** 双击节点时打开编辑器的上下文 */
export interface EditorContext {
  engine: Engine
  el: CanvasElement
}

/** 生成器面板里节点专属块的上下文；ups 是当前输入连线带来的上游，canvasId 本地演示时为 null */
export interface PanelContext extends EditorContext {
  canvasId: string | null
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

/** 3D 构图节点的编辑器尺寸 */
const STAGE_EDITOR_W = 420
const STAGE_EDITOR_H = 180
/** AI 分析草稿的入口尺寸 */
const ANALYSIS_ENTRY_W = 560
const ANALYSIS_ENTRY_H = 96

/** AI 分析草稿：入口替代生成面板；锁定 / 只读时浮出同一个入口 */
const AI_ANALYSIS_EDITOR: NodeRegistration = {
  editor: {
    size: { width: ANALYSIS_ENTRY_W, height: ANALYSIS_ENTRY_H },
    lockedEntry: ({ engine, el }) => <AiAnalysisEntry engine={engine} el={el} />,
    content: ({ el }) => (
      <div className="p-4">
        <button
          type="button"
          className="ui-btn ui-btn-secondary w-full"
          onClick={() => useCanvas.getState().openAiAnalysis({ kind: 'node', nodeId: el.id })}
        >
          查看 AI 分析与预检
        </button>
      </div>
    ),
  },
}

const REGISTRY = new Map<string, NodeRegistration>([
  [
    STORYBOARD_TYPE,
    {
      open: (id) => useCanvas.getState().openStoryboard(id),
      editor: {
        panel: ({ el }) => (
          <div className="px-4 pt-4">
            <button
              type="button"
              onClick={() => useCanvas.getState().openStoryboard(el.id)}
              className="ui-btn ui-btn-secondary w-full"
            >
              编辑分镜表（{shotsOf(el).length} 个镜头）
            </button>
          </div>
        ),
      },
    },
  ],
  [
    SEQUENCE_TYPE,
    {
      open: (id) => useCanvas.getState().openSequence(id),
      editor: {
        panel: ({ el, ups }) => (
          <div className="px-4 pt-4">
            <button
              type="button"
              onClick={() => useCanvas.getState().openSequence(el.id)}
              className="ui-btn ui-btn-secondary w-full"
            >
              编辑序列（{ups.get('clips')?.length ?? 0} 段镜头）
            </button>
          </div>
        ),
      },
    },
  ],
  [
    ANIMATIC_TYPE,
    {
      open: (id) => useCanvas.getState().openSequence(id),
      editor: {
        panel: ({ el }) => (
          <div className="px-4 pt-4">
            <button
              type="button"
              onClick={() => useCanvas.getState().openSequence(el.id)}
              className="ui-btn ui-btn-secondary w-full"
            >
              编辑节奏样片
            </button>
          </div>
        ),
      },
    },
  ],
  [
    STAGE_TYPE,
    {
      open: (id) => useCanvas.getState().openStage(id),
      editor: {
        size: { width: STAGE_EDITOR_W, height: STAGE_EDITOR_H },
        panel: ({ el }) => (
          <div className="flex flex-col gap-2 px-4 pt-4">
            <button
              type="button"
              onClick={() => useCanvas.getState().openStage(el.id)}
              className="ui-btn ui-btn-secondary w-full"
            >
              打开 3D 构图
            </button>
            <p className="ui-help">
              {stageSnapshotsOf(el.params).length
                ? `已截 ${stageSnapshotsOf(el.params).length} 张，下游用当前采用的那张；改场景后要重新截图才会更新`
                : '摆好人物和机位后截图，把「构图」连到图片节点的参考图'}
            </p>
          </div>
        ),
      },
      // 构图截图是空间参考，不应把灰模当作普通成图去重绘、切宫格或直接生成视频
      result: { reference: true },
    },
  ],
  [MOTION_TYPE, { open: (id) => useCanvas.getState().openMotion(id) }],
  [
    SHOT_ANALYSIS_TYPE,
    {
      editor: {
        panel: ({ el }) => (
          <div className="px-4 pt-4">
            <button
              type="button"
              className="ui-btn ui-btn-secondary w-full"
              onClick={() => useCanvas.getState().openShotAnalysis(el.id)}
            >
              打开拉片清单
            </button>
          </div>
        ),
      },
      // 锁定 / 只读的拉片节点没有生成器：结果条上给同一个入口
      result: {
        lockedEntry: (el) => (
          <button
            type="button"
            className="ui-btn ui-btn-secondary"
            onClick={() => useCanvas.getState().openShotAnalysis(el.id)}
          >
            查看拉片清单
          </button>
        ),
      },
    },
  ],
  [
    'plein/character',
    {
      editor: {
        panel: ({ engine, el, canvasId }) =>
          canvasId ? <ProfileSummary engine={engine} el={el} /> : null,
      },
    },
  ],
  [
    'plein/scene',
    {
      menu: {
        label: '场景准备',
        onClick: (id) => useCanvas.getState().openScenePrep(id),
      },
    },
  ],
  [AI_SCENE_TYPE, AI_ANALYSIS_EDITOR],
  [AI_SUMMARY_TYPE, AI_ANALYSIS_EDITOR],
])

/** 按节点类型取登记；未登记的节点走各分发处的缺省行为 */
export const nodeRegistration = (nodeType: string | undefined): NodeRegistration | undefined =>
  nodeType ? REGISTRY.get(nodeType) : undefined

/** 结果条对这类节点的定制：锁定入口与「结果是空间参考」标记；非节点元素没有 */
export function resultOf(el: CanvasElement | undefined): {
  lockedEntry?: (el: CanvasElement) => ReactNode
  reference: boolean
} {
  const registration = el?.kind === 'node' ? nodeRegistration(el.nodeType) : undefined
  return {
    lockedEntry: registration?.result?.lockedEntry,
    reference: !!registration?.result?.reference,
  }
}

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
