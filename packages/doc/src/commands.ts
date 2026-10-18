import { generateNKeysBetween } from 'fractional-indexing'
import * as Y from 'yjs'
import { type ElementMap, type PleinDoc, SYSTEM_ORIGIN } from './doc'
import { newId } from './ids'
import { inputEdges } from './inputs'
import { creativeReviewKey, isCreativeReview } from './review-types'
import {
  type CanvasElement,
  CONTAINER_KINDS,
  type Edge,
  type ElementKind,
  type ElementPatch,
  type NewElement,
  type NodeResult,
  type NodeRun,
  type Port,
  type PortAddress,
  type PortType,
  type Ports,
  type Rect,
} from './types'

/**
 * 命令式写入 API。每个命令是一个带 doc.origin（默认 LOCAL_ORIGIN）的事务，
 * 撤销按命令（及 captureTimeout 内的连续命令）为一步。
 */

export class ReadOnlyDocError extends Error {
  constructor() {
    super('文档版本高于当前客户端，只能只读打开')
  }
}

function write<T>(doc: PleinDoc, fn: () => T): T {
  if (doc.readOnly) throw new ReadOnlyDocError()
  let out!: T
  doc.ydoc.transact(() => {
    out = fn()
  }, doc.origin)
  return out
}

const PATCH_KEYS = [
  'x',
  'y',
  'w',
  'h',
  'rotation',
  'locked',
  'name',
  'color',
  'assetId',
  'ports',
  'nodeType',
  'nodeVersion',
  'deliveries',
] as const satisfies ReadonlyArray<keyof ElementPatch>

const MIN_SIZE = 1

/** 只写真正变化的字段，减少同步量和无意义的撤销步骤 */
function applyPatch(m: ElementMap, patch: ElementPatch) {
  for (const key of PATCH_KEYS) {
    if (!(key in patch)) continue
    let v = patch[key]
    if ((key === 'w' || key === 'h') && typeof v === 'number') v = Math.max(MIN_SIZE, v)
    if (v === undefined) {
      if (m.has(key)) m.delete(key)
    } else if (m.get(key) !== v) {
      m.set(key, v)
    }
  }
}

function topZ(doc: PleinDoc, parentId: string | null, count: number) {
  const siblings = doc.children(parentId)
  const max = siblings.at(-1)?.z ?? null
  return generateNKeysBetween(max, null, count)
}

function validParent(doc: PleinDoc, parentId: string | null | undefined): string | null {
  if (!parentId) return null
  const p = doc.get(parentId)
  return p && CONTAINER_KINDS.has(p.kind) ? parentId : null
}

// ── 元素 ──────────────────────────────────────────────

export function createElements(doc: PleinDoc, inputs: NewElement[]): string[] {
  return write(doc, () => {
    // 同一父元素下按输入顺序叠在最上面
    const zByParent = new Map<string | null, string[]>()
    const parents = inputs.map((input) => validParent(doc, input.parentId))
    for (const p of new Set(parents)) {
      zByParent.set(p, topZ(doc, p, parents.filter((q) => q === p).length))
    }
    return inputs.map((input, i) => {
      const id = input.id ?? newId('el')
      const parentId = parents[i]!
      // 先挂进文档再写字段：未挂载的 Y 类型不能读取
      const m = new Y.Map<unknown>()
      doc.elementMaps.set(id, m)
      m.set('kind', input.kind)
      m.set('rotation', input.rotation ?? 0)
      m.set('z', zByParent.get(parentId)!.shift()!)
      m.set('parentId', parentId)
      m.set('locked', input.locked ?? false)
      applyPatch(m, {
        x: input.x,
        y: input.y,
        w: input.w,
        h: input.h,
        name: input.name,
        color: input.color,
        assetId: input.assetId,
        ports: input.ports,
        nodeType: input.nodeType,
        nodeVersion: input.nodeVersion,
        deliveries: input.deliveries,
      })
      if (input.text !== undefined || input.kind === 'markdown') {
        m.set('text', new Y.Text(input.text ?? ''))
      }
      if (input.params !== undefined || input.kind === 'node') {
        m.set('params', new Y.Map(Object.entries(input.params ?? {})))
      }
      if (input.results?.length) m.set('results', input.results)
      if (input.adopted !== undefined) m.set('adopted', input.adopted)
      if (input.reviews?.length)
        m.set(
          'reviews',
          new Y.Map(
            input.reviews.filter(isCreativeReview).map((r) => [creativeReviewKey(r.target), r]),
          ),
        )
      return id
    })
  })
}

export function createElement(doc: PleinDoc, input: NewElement): string {
  return createElements(doc, [input])[0]!
}

export function updateElement(doc: PleinDoc, id: string, patch: ElementPatch) {
  updateElements(doc, [{ id, ...patch }])
}

/** 批量更新，例如拖拽或缩放松手后一次写入所有元素的几何 */
export function updateElements(doc: PleinDoc, patches: Array<{ id: string } & ElementPatch>) {
  write(doc, () => {
    for (const { id, ...patch } of patches) {
      const m = doc.mutable(id)
      if (m) applyPatch(m, patch)
    }
  })
}

/** 素材元素按内容自适应尺寸。系统写入，不进撤销栈；尺寸没变时不写 */
export function fitElementSize(doc: PleinDoc, id: string, w: number, h: number) {
  const el = doc.get(id)
  if (doc.readOnly || !el || (Math.abs(el.w - w) < 1 && Math.abs(el.h - h) < 1)) return
  doc.ydoc.transact(() => {
    const m = doc.mutable(id)
    if (m) applyPatch(m, { w, h })
  }, SYSTEM_ORIGIN)
}

/** 只保留“祖先不在集合里”的元素：父元素一动，子元素随之移动 */
export function topLevel(doc: PleinDoc, ids: Iterable<string>): string[] {
  const set = new Set(ids)
  return [...set].filter((id) => doc.has(id) && !doc.ancestors(id).some((a) => set.has(a.id)))
}

export function moveElements(doc: PleinDoc, ids: Iterable<string>, dx: number, dy: number) {
  if (dx === 0 && dy === 0) return
  const patches = topLevel(doc, ids)
    .map((id) => doc.get(id)!)
    .filter((el) => !el.locked)
    .map((el) => ({ id: el.id, x: el.x + dx, y: el.y + dy }))
  updateElements(doc, patches)
}

/** 删除元素及其所有后代，并在同一事务里删掉相关的边 */
export function deleteElements(doc: PleinDoc, ids: Iterable<string>) {
  write(doc, () => {
    const doomed = new Set<string>()
    for (const id of ids) {
      if (!doc.elementMaps.has(id)) continue
      doomed.add(id)
      for (const d of doc.descendants(id)) doomed.add(d.id)
    }
    for (const [edgeId, e] of doc.edgeMap) {
      if (doomed.has(e.from[0]) || doomed.has(e.to[0])) doc.edgeMap.delete(edgeId)
    }
    for (const id of doomed) doc.elementMaps.delete(id)
  })
}

/**
 * 修改父元素，保持世界坐标不变。父元素必须是容器类型；
 * 会造成成环的元素被跳过。返回实际改动的 id。
 */
export function setParent(doc: PleinDoc, ids: Iterable<string>, parentId: string | null): string[] {
  const target = parentId === null ? null : doc.get(parentId)
  if (parentId !== null && (!target || !CONTAINER_KINDS.has(target.kind))) return []
  const origin = parentId === null ? { x: 0, y: 0 } : doc.worldRect(parentId)!
  const blocked = new Set(
    parentId === null ? [] : [parentId, ...doc.ancestors(parentId).map((a) => a.id)],
  )

  return write(doc, () => {
    const moved = topLevel(doc, ids).filter((id) => !blocked.has(id))
    const zs = topZ(doc, parentId, moved.length)
    for (const id of moved) {
      const el = doc.get(id)!
      const world = doc.worldRect(id)!
      const m = doc.mutable(id)!
      m.set('parentId', parentId)
      m.set('x', world.x - origin.x)
      m.set('y', world.y - origin.y)
      if (doc.effectiveParent(el) !== parentId) m.set('z', zs.shift()!)
    }
    return moved
  })
}

/** 同级内置顶，保持选中元素之间的相对顺序 */
export function bringToFront(doc: PleinDoc, ids: Iterable<string>) {
  reorder(doc, ids, 'front')
}

export function sendToBack(doc: PleinDoc, ids: Iterable<string>) {
  reorder(doc, ids, 'back')
}

function reorder(doc: PleinDoc, ids: Iterable<string>, where: 'front' | 'back') {
  const byParent = new Map<string | null, CanvasElement[]>()
  for (const id of new Set(ids)) {
    const el = doc.get(id)
    if (!el) continue
    const p = doc.effectiveParent(el)
    const list = byParent.get(p)
    if (list) list.push(el)
    else byParent.set(p, [el])
  }
  write(doc, () => {
    for (const [parentId, els] of byParent) {
      const picked = new Set(els.map((e) => e.id))
      const others = doc.children(parentId).filter((e) => !picked.has(e.id))
      els.sort((a, b) => (a.z < b.z ? -1 : a.z > b.z ? 1 : 0))
      const zs =
        where === 'front'
          ? generateNKeysBetween(others.at(-1)?.z ?? null, null, els.length)
          : generateNKeysBetween(null, others[0]?.z ?? null, els.length)
      els.forEach((el, i) => {
        doc.mutable(el.id)!.set('z', zs[i]!)
      })
    }
  })
}

// ── 参数与文本 ────────────────────────────────────────

export function setParams(doc: PleinDoc, id: string, params: Record<string, unknown>) {
  write(doc, () => {
    const m = doc.mutable(id)
    if (!m) return
    let p = m.get('params')
    if (!(p instanceof Y.Map)) {
      p = new Y.Map<unknown>()
      m.set('params', p)
    }
    const pm = p as Y.Map<unknown>
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined) pm.delete(k)
      else pm.set(k, v)
    }
  })
}

export function setParam(doc: PleinDoc, id: string, key: string, value: unknown) {
  setParams(doc, id, { [key]: value })
}

/** 整体替换文本；编辑器应直接绑定 doc.getText(id) 做增量编辑 */
export function setText(doc: PleinDoc, id: string, text: string) {
  write(doc, () => {
    const m = doc.mutable(id)
    if (!m) return
    let t = m.get('text')
    if (!(t instanceof Y.Text)) {
      t = new Y.Text()
      m.set('text', t)
    }
    const yt = t as Y.Text
    if (yt.toString() === text) return
    yt.delete(0, yt.length)
    yt.insert(0, text)
  })
}

// ── 节点结果 ──────────────────────────────────────────

/** 每个节点最多保留的结果数，超出时丢弃最旧的 */
export const MAX_RESULTS = 48

/** 采用某个结果（可撤销）；resultId=null 沿用旧约定，清除显式选择并回到最新结果。 */
export function adoptResult(doc: PleinDoc, id: string, resultId: string | null) {
  write(doc, () => {
    const m = doc.mutable(id)
    if (!m) return
    if (resultId === null) m.delete('adopted')
    else if (m.get('adopted') !== resultId) m.set('adopted', resultId)
  })
}

/**
 * 写入运行状态（服务端或本地运行器调用）。系统写入，不进撤销栈。
 * run 为 null 时清除。
 */
export function writeRun(doc: PleinDoc, id: string, run: NodeRun | null) {
  doc.ydoc.transact(() => {
    const m = doc.mutable(id)
    if (!m) return
    if (run) m.set('run', run)
    else m.delete('run')
  }, SYSTEM_ORIGIN)
}

/**
 * 追加一次运行的结果（插到最前），并采用其中第一个。系统写入，不进撤销栈。
 * adopt 为 false 时只进候选历史、当前结果不变（晚返回、输入已经改过的结果待用户采用）
 */
export function addResults(
  doc: PleinDoc,
  id: string,
  results: NodeResult[],
  opts: { adopt?: boolean } = {},
) {
  if (results.length === 0) return
  doc.ydoc.transact(() => {
    const m = doc.mutable(id)
    if (!m) return
    const old = Array.isArray(m.get('results')) ? (m.get('results') as NodeResult[]) : []
    const list = [...results, ...old]
    const chosen =
      opts.adopt === false
        ? m.get('adopted') === null
          ? undefined
          : (old.find((r) => r.id === m.get('adopted')) ?? old[0])
        : results[0]
    // 候选限额不能挤掉正在使用的结果，也不能拆散其视频 / 尾帧等关联输出。
    // 先为采用的那次运行留位置，其余按新到旧填满，最终仍按原历史顺序展示。
    const priority = new Set<string>()
    if (chosen) {
      priority.add(chosen.id)
      for (const r of list) if (r.runId === chosen.runId) priority.add(r.id)
    }
    for (const r of list) priority.add(r.id)
    const keep = new Set([...priority].slice(0, MAX_RESULTS))
    m.set(
      'results',
      list.filter((r) => keep.has(r.id)),
    )
    // 无显式采用或旧引用已无效时也钉住实际生效的结果，避免新候选抢占。
    m.set('adopted', chosen?.id ?? null)
  }, SYSTEM_ORIGIN)
}

/**
 * 当前生效的结果：显式 null 表示尚未采用；未指定时使用最新的，可按输出端口筛选。
 * 按端口取时跟随采用候选的关联组；旧结果只有跨端口唯一配对时才兼容按运行关联。
 * 候选没有对应输出时就是没有，不拿同次其他候选或更早的结果凑数。
 */
export function currentResult(el: CanvasElement, port?: string): NodeResult | undefined {
  if (el.adopted === null) return undefined
  const all = el.results ?? []
  const chosen = all.find((r) => r.id === el.adopted) ?? all[0]
  if (!chosen || port === undefined || chosen.port === port) return chosen
  const related = all.filter((r) => r.runId === chosen.runId)
  const list = related.filter((r) => r.port === port)
  if (chosen.outputGroup !== undefined) {
    const group = related.filter((r) => r.outputGroup === chosen.outputGroup)
    const outputs = group.filter((r) => r.port === port)
    return group.filter((r) => r.port === chosen.port).length === 1 && outputs.length === 1
      ? outputs[0]
      : undefined
  }
  // 旧数据没有候选关联键，多个同端口结果之间无法确认对应关系，不能猜第一条。
  return related.filter((r) => r.port === chosen.port).length === 1 &&
    list.length === 1 &&
    list[0]!.outputGroup === undefined
    ? list[0]
    : undefined
}

/** 节点展示与播放入口使用主输出；采用副输出时仍取同一候选的主输出。无端口声明时兼容旧结果。 */
export function primaryResult(el: CanvasElement): NodeResult | undefined {
  return currentResult(el, el.ports?.outputs[0]?.id)
}

/** 元素当前展示的媒体：素材元素取自身资产，节点取主输出的图片 / 视频 / 音频结果。 */
export function elementMedia(
  el: CanvasElement,
): { assetId: string; kind: 'image' | 'video' | 'audio' } | null {
  if (el.kind === 'node') {
    const v = primaryResult(el)?.value
    return v && (v.type === 'image' || v.type === 'video' || v.type === 'audio')
      ? { assetId: v.assetId, kind: v.type }
      : null
  }
  if ((el.kind === 'image' || el.kind === 'video' || el.kind === 'audio') && el.assetId)
    return { assetId: el.assetId, kind: el.kind }
  return null
}

/** 元素展示的视频：视频元素本身，或当前结果是视频的节点；其他情况为 undefined */
export function videoAssetOf(el: CanvasElement | undefined): string | undefined {
  const m = el && elementMedia(el)
  return m?.kind === 'video' ? m.assetId : undefined
}

/**
 * 把元素调成给定宽高比：长边和中心不动。已经一致（差 1px 以内）时不写。
 * 跟随媒体自身的比例，属于系统写入，不进撤销栈。
 */
export function fitAspect(doc: PleinDoc, id: string, ratio: number): boolean {
  const el = doc.get(id)
  if (!el || doc.readOnly || !(ratio > 0) || !Number.isFinite(ratio)) return false
  const long = Math.max(el.w, el.h)
  const w = Math.round(ratio >= 1 ? long : long * ratio)
  const h = Math.round(ratio >= 1 ? long / ratio : long)
  if (Math.abs(w - el.w) <= 1 && Math.abs(h - el.h) <= 1) return false
  doc.ydoc.transact(() => {
    const m = doc.mutable(id)
    if (!m) return
    m.set('x', Math.round(el.x + (el.w - w) / 2))
    m.set('y', Math.round(el.y + (el.h - h) / 2))
    m.set('w', w)
    m.set('h', h)
  }, SYSTEM_ORIGIN)
  return true
}

/** 生成历史里的一项：哪个节点的哪个媒体结果 */
export interface HistoryEntry {
  elementId: string
  result: NodeResult & { value: Extract<NodeResult['value'], { assetId: string }> }
  /** 是否是该输出端口当前生效的结果 */
  adopted: boolean
}

/** 各输出端口当前生效的结果；同一候选的主输出和副输出可同时生效。 */
export function adoptedResultIds(el: CanvasElement): Set<string> {
  const ids = new Set<string>()
  for (const port of new Set(el.results?.map((r) => r.port))) {
    const result = currentResult(el, port)
    if (result) ids.add(result.id)
  }
  return ids
}

/** 全画布节点的图片 / 视频 / 音频结果，按生成时间新到旧（同一时间按节点内顺序） */
export function resultHistory(doc: PleinDoc): HistoryEntry[] {
  const out: HistoryEntry[] = []
  for (const el of doc.elements()) {
    if (el.kind !== 'node' || !el.results?.length) continue
    const current = adoptedResultIds(el)
    for (const r of el.results) {
      if (r.value.type === 'text' || r.value.type === 'json') continue
      out.push({
        elementId: el.id,
        result: r as HistoryEntry['result'],
        adopted: current.has(r.id),
      })
    }
  }
  return out.sort((a, b) => b.result.at - a.result.at)
}

// ── 端口 ──────────────────────────────────────────────

/** 素材元素自带的输出端口：图片、视频、音频、Markdown 可以直接连到节点上 */
const IMPLICIT_OUTPUTS: Partial<Record<ElementKind, Port>> = {
  image: { id: 'image', label: '图片', type: 'image' },
  video: { id: 'video', label: '视频', type: 'video' },
  audio: { id: 'audio', label: '音频', type: 'audio' },
  markdown: { id: 'text', label: '文本', type: 'text' },
}

/** 元素的端口：节点用声明里的端口，素材元素用隐式输出端口 */
export function elementPorts(el: CanvasElement): Ports | undefined {
  if (el.ports) return el.ports
  const out = IMPLICIT_OUTPUTS[el.kind]
  if (out && (el.kind === 'markdown' || el.assetId)) return { inputs: [], outputs: [out] }
  return undefined
}

// ── 打组 ──────────────────────────────────────────────

/**
 * 用一个 Frame 包住元素（⌘G）：Frame 建在这些元素的公共父元素里，留出边距。
 * 返回 Frame id；没有可打组的元素时返回 null。
 */
export function groupElements(
  doc: PleinDoc,
  ids: Iterable<string>,
  opts: { padding?: number; name?: string } = {},
): string | null {
  const tops = topLevel(doc, ids)
  if (tops.length === 0) return null
  const pad = opts.padding ?? 32
  const rects = tops.map((id) => doc.worldRect(id)).filter((r): r is Rect => !!r)
  const x0 = Math.min(...rects.map((r) => r.x)) - pad
  const y0 = Math.min(...rects.map((r) => r.y)) - pad
  const x1 = Math.max(...rects.map((r) => r.x + r.w)) + pad
  const y1 = Math.max(...rects.map((r) => r.y + r.h)) + pad
  const parents = new Set(tops.map((id) => doc.effectiveParent(doc.get(id)!)))
  const parentId = parents.size === 1 ? [...parents][0]! : null
  const origin = parentId ? doc.worldRect(parentId)! : { x: 0, y: 0 }
  return write(doc, () => {
    const frame = createElement(doc, {
      kind: 'frame',
      name: opts.name ?? '分组',
      parentId,
      x: Math.round(x0 - origin.x),
      y: Math.round(y0 - origin.y),
      w: Math.round(x1 - x0),
      h: Math.round(y1 - y0),
    })
    setParent(doc, tops, frame)
    return frame
  })
}

/**
 * 解组：子元素移到 Frame 的父元素里（世界坐标不变），再删掉 Frame。返回原子元素 id。
 * 连到 Frame 本身的连线随之删除，子元素之间的连线保留。
 */
export function ungroupElements(doc: PleinDoc, frameId: string): string[] {
  const frame = doc.get(frameId)
  if (frame?.kind !== 'frame') return []
  const parentId = doc.effectiveParent(frame)
  return write(doc, () => {
    const kids = doc.children(frameId).map((el) => el.id)
    setParent(doc, kids, parentId)
    deleteElements(doc, [frameId])
    return kids
  })
}

// ── 连线 ──────────────────────────────────────────────

/** 端口类型能否相连：类型相同，或任一端是 any（通配） */
export function portsCompatible(a: PortType, b: PortType) {
  return a === 'any' || b === 'any' || a === b
}

function findPort(el: CanvasElement | undefined, portId: string, side: 'inputs' | 'outputs') {
  return el ? elementPorts(el)?.[side].find((p) => p.id === portId) : undefined
}

/**
 * 连接输出端口到输入端口。单输入端口只接一条边，已有连线会被替换；
 * 可多连的端口（multiple）保留已有连线。自连、端口不存在、类型不兼容或重复连线时返回 null。
 * 协作合并进来的旧边不经过这里，读取侧仍要容忍类型不符的边。
 */
export function connect(doc: PleinDoc, from: PortAddress, to: PortAddress): Edge | null {
  if (from[0] === to[0]) return null
  const source = findPort(doc.get(from[0]), from[1], 'outputs')
  if (!source) return null
  const target = findPort(doc.get(to[0]), to[1], 'inputs')
  if (!target || !portsCompatible(source.type, target.type)) return null
  return write(doc, () => {
    for (const [id, e] of doc.edgeMap) {
      if (e.to[0] !== to[0] || e.to[1] !== to[1]) continue
      if (e.from[0] === from[0] && e.from[1] === from[1]) return null
      if (!target.multiple) doc.edgeMap.delete(id)
    }
    const previous = inputEdges(doc, to[0], to[1])
      .filter((e) => e.order)
      .at(-1)?.order
    const edge: Edge = {
      id: newId('edge'),
      from: [...from],
      to: [...to],
      order: generateNKeysBetween(previous ?? null, null, 1)[0]!,
    }
    doc.edgeMap.set(edge.id, edge)
    return edge
  })
}

/** 一次显式排序只影响同一输入端口，缺项/重复/多项均拒绝。 */
export function reorderInputs(doc: PleinDoc, to: PortAddress, ids: readonly string[]): boolean {
  const edges = inputEdges(doc, to[0], to[1])
  if (edges.length !== ids.length || new Set(ids).size !== ids.length) return false
  const byId = new Map(edges.map((e) => [e.id, e]))
  if (ids.some((id) => !byId.has(id))) return false
  if (edges.every((e, i) => e.id === ids[i])) return false
  return write(doc, () => {
    const keys = generateNKeysBetween(null, null, ids.length)
    ids.forEach((id, i) => doc.edgeMap.set(id, { ...byId.get(id)!, order: keys[i]! }))
    return true
  })
}

/** 替换槽位保留边 ID 与顺序；不修改旧素材元素或删除文件。 */
export function replaceInput(doc: PleinDoc, edgeId: string, from: PortAddress): boolean {
  const edge = doc.getEdge(edgeId)
  if (!edge || edge.to[0] === from[0]) return false
  const source = findPort(doc.get(from[0]), from[1], 'outputs')
  const target = findPort(doc.get(edge.to[0]), edge.to[1], 'inputs')
  if (!source || !target || !portsCompatible(source.type, target.type)) return false
  if (
    inputEdges(doc, edge.to[0], edge.to[1]).some(
      (e) => e.from[0] === from[0] && e.from[1] === from[1],
    )
  )
    return false
  return write(doc, () => {
    doc.edgeMap.set(edgeId, { ...edge, from: [...from] })
    return true
  })
}

export function removeEdges(doc: PleinDoc, ids: Iterable<string>) {
  write(doc, () => {
    for (const id of ids) doc.edgeMap.delete(id)
  })
}
