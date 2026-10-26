import type { Engine } from '@plein/canvas-core'
import {
  type CanvasElement,
  connect,
  currentResult,
  elementMedia,
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
export function outputPort(
  el: CanvasElement,
  type: Port['type'],
  assetId?: string,
): Port | undefined {
  return elementPorts(el)?.outputs.find((p) => {
    if (p.type !== type) return false
    if (!assetId) return true
    if (el.kind !== 'node') return elementMedia(el)?.assetId === assetId
    const value = currentResult(el, p.id)?.value
    return value?.type === type && 'assetId' in value && value.assetId === assetId
  })
}

/** 源元素右侧找一块 w×h 的空地（左上角坐标），与智能体放置新元素是同一套规则 */
export function freeSpotRight(engine: Engine, source: string, w: number, h: number) {
  // 场景索引按帧更新，同帧的新建或移动可能尚未收录；落点必须读取当前文档。
  return spotRightOf(engine.doc, source, w, h)
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
    sourceAssetId?: string
    name?: string
    params?: Record<string, unknown>
  } = {},
): string | null {
  const source = engine.doc.get(sourceId)
  const node = findNode(catalog, nodeType)
  if (engine.doc.readOnly || !source || source.locked || !node) return null
  const input = opts.inputPort
    ? node.inputs.find((p) => p.id === opts.inputPort)
    : node.inputs.find((p) => p.type !== 'text')
  const out = input && outputPort(source, input.type, opts.sourceAssetId)
  if (opts.sourceAssetId && !out) return null
  // 先按最终画幅计算占位，避免套预设后才扩高而压到邻居。
  const pk = promptKey(node)
  const base = nodeElement(node, {
    ...node.defaults,
    ...opts.params,
    ...(opts.preset ? presetParams(node, opts.preset) : {}),
    ...(opts.preset && pk ? { [pk]: opts.preset.template } : {}),
  })
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
      },
      at,
    )
    if (out && input) connect(engine.doc, [sourceId, out.id], [id, input.id])
  }, engine.doc.origin)
  engine.doc.undo.stopCapturing()
  focusGenerator(engine, id)
  return id
}
