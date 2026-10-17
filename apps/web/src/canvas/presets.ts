import type { Engine } from '@plein/canvas-core'
import {
  type CanvasElement,
  connect,
  elementPorts,
  type Port,
  setParams,
  spotRightOf,
} from '@plein/doc'
import type { Catalog } from '@plein/protocol'
import {
  applyAspect,
  aspectKey,
  fieldsOf,
  findNode,
  type NodeInfo,
  nodeElement,
  placeElement,
  promptKey,
} from './nodes'

type PromptPreset = Catalog['prompts'][number]

/** 只保留节点声明里有的参数 */
function presetParams(node: NodeInfo, preset: PromptPreset) {
  const keys = new Set(fieldsOf(node).map(([k]) => k))
  return Object.fromEntries(Object.entries(preset.params ?? {}).filter(([k]) => keys.has(k)))
}

/** 选中节点并聚焦生成器的提示词（面板在选中后的下一帧才挂载） */
export function focusGenerator(engine: Engine, id: string) {
  engine.selection.set([id])
  requestAnimationFrame(() =>
    window.dispatchEvent(new CustomEvent('plein:focus-generator', { detail: id })),
  )
}

/** 把预设套到节点上：写入提示词模板和参数，画幅变了卡片跟着变形 */
export function applyPresetToNode(
  engine: Engine,
  catalog: Catalog | null,
  id: string,
  preset: PromptPreset,
) {
  const el = engine.doc.get(id)
  const node = findNode(catalog, el?.nodeType)
  if (!el || !node) return
  const pk = promptKey(node)
  const params = presetParams(node, preset)
  setParams(engine.doc, id, { ...params, ...(pk ? { [pk]: preset.template } : {}) })
  const ak = aspectKey(node)
  if (ak && params[ak] !== undefined) applyAspect(engine, id, params[ak])
  focusGenerator(engine, id)
}

/** 元素当前能往下游提供的输出端口（图片、视频……） */
export function outputPort(el: CanvasElement, type: Port['type']): Port | undefined {
  return elementPorts(el)?.outputs.find((p) => p.type === type)
}

/** 源元素右侧找一块 w×h 的空地（左上角坐标），与智能体放置新元素是同一套规则 */
export function freeSpotRight(engine: Engine, source: string, w: number, h: number) {
  return spotRightOf(engine.doc, source, w, h, (r) => engine.scene.query(r))
}

/**
 * 从一个有结果的元素派生下游节点：
 * 在右侧新建 nodeType 节点，把 source 的输出连到它第一个能接的输入，
 * 套上预设（可选）后选中并聚焦生成器，用户确认提示词再生成。
 */
export function deriveNode(
  engine: Engine,
  catalog: Catalog | null,
  sourceId: string,
  nodeType: string,
  opts: {
    preset?: PromptPreset
    inputPort?: string
    name?: string
    params?: Record<string, unknown>
  } = {},
): string | null {
  const source = engine.scene.get(sourceId)
  const node = findNode(catalog, nodeType)
  if (!source || !node) return null
  const input = opts.inputPort
    ? node.inputs.find((p) => p.id === opts.inputPort)
    : node.inputs.find((p) => p.type !== 'text')
  const out = input && outputPort(source, input.type)
  const base = nodeElement(node)
  const spot = freeSpotRight(engine, sourceId, base.w, base.h)
  // placeElement 以中心定位
  const at = { x: spot.x + base.w / 2, y: spot.y + base.h / 2 }
  let id = ''
  engine.doc.undo.stopCapturing()
  engine.doc.ydoc.transact(() => {
    id = placeElement(
      engine,
      {
        ...base,
        name: opts.name ?? opts.preset?.title ?? base.name,
        params: { ...base.params, ...opts.params },
      },
      at,
    )
    if (out && input) connect(engine.doc, [sourceId, out.id], [id, input.id])
    if (opts.preset) applyPresetToNode(engine, catalog, id, opts.preset)
  }, engine.doc.origin)
  engine.doc.undo.stopCapturing()
  if (!opts.preset) focusGenerator(engine, id)
  return id
}
