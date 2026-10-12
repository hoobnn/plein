import { generateKeyBetween, generateNKeysBetween } from 'fractional-indexing'
import * as Y from 'yjs'
import { type ElementMap, LOCAL_ORIGIN, type PleinDoc, SYSTEM_ORIGIN } from './doc'
import { newId } from './ids'
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
  type Ports,
  type Rect,
} from './types'

/**
 * 命令式写入 API。每个命令是一个带 LOCAL_ORIGIN 的事务，
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
  }, LOCAL_ORIGIN)
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
  'assetId',
  'ports',
  'nodeType',
  'nodeVersion',
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
        assetId: input.assetId,
        ports: input.ports,
        nodeType: input.nodeType,
        nodeVersion: input.nodeVersion,
      })
      if (input.text !== undefined || input.kind === 'markdown') {
        m.set('text', new Y.Text(input.text ?? ''))
      }
      if (input.params !== undefined || input.kind === 'node') {
        m.set('params', new Y.Map(Object.entries(input.params ?? {})))
      }
      if (input.results?.length) m.set('results', input.results)
      if (input.adopted) m.set('adopted', input.adopted)
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

/** 把元素插到同级某个元素之前或之后（拖拽排序用） */
export function placeBetween(
  doc: PleinDoc,
  id: string,
  before: string | null,
  after: string | null,
) {
  const a = before ? (doc.get(before)?.z ?? null) : null
  const b = after ? (doc.get(after)?.z ?? null) : null
  write(doc, () => {
    doc.mutable(id)?.set('z', generateKeyBetween(a, b))
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

/** 采用某个结果：卡片显示它，下游读取它（用户操作，可撤销） */
export function adoptResult(doc: PleinDoc, id: string, resultId: string | null) {
  write(doc, () => {
    const m = doc.mutable(id)
    if (!m) return
    if (resultId === null) m.delete('adopted')
    else if (m.get('adopted') !== resultId) m.set('adopted', resultId)
  })
}

/** 删除一个结果；正在采用的被删时回到最新结果 */
export function removeResult(doc: PleinDoc, id: string, resultId: string) {
  write(doc, () => {
    const m = doc.mutable(id)
    const list = m?.get('results')
    if (!m || !Array.isArray(list)) return
    m.set(
      'results',
      (list as NodeResult[]).filter((r) => r.id !== resultId),
    )
    if (m.get('adopted') === resultId) m.delete('adopted')
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

/** 追加一次运行的结果（插到最前），并采用其中第一个。系统写入，不进撤销栈 */
export function addResults(doc: PleinDoc, id: string, results: NodeResult[]) {
  if (results.length === 0) return
  doc.ydoc.transact(() => {
    const m = doc.mutable(id)
    if (!m) return
    const old = m.get('results')
    const list = [...results, ...(Array.isArray(old) ? (old as NodeResult[]) : [])]
    m.set('results', list.slice(0, MAX_RESULTS))
    m.set('adopted', results[0]!.id)
  }, SYSTEM_ORIGIN)
}

/** 当前生效的结果：采用的那个，否则最新的；可按输出端口筛选 */
export function currentResult(el: CanvasElement, port?: string): NodeResult | undefined {
  const list = (el.results ?? []).filter((r) => port === undefined || r.port === port)
  return list.find((r) => r.id === el.adopted) ?? list[0]
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

// ── 连线 ──────────────────────────────────────────────

function findPort(el: CanvasElement | undefined, portId: string, side: 'inputs' | 'outputs') {
  return el ? elementPorts(el)?.[side].find((p) => p.id === portId) : undefined
}

/**
 * 连接输出端口到输入端口。单输入端口只接一条边，已有连线会被替换；
 * 可多连的端口（multiple）保留已有连线。自连、端口不存在或重复连线时返回 null。
 */
export function connect(doc: PleinDoc, from: PortAddress, to: PortAddress): Edge | null {
  if (from[0] === to[0]) return null
  if (!findPort(doc.get(from[0]), from[1], 'outputs')) return null
  const target = findPort(doc.get(to[0]), to[1], 'inputs')
  if (!target) return null
  return write(doc, () => {
    for (const [id, e] of doc.edgeMap) {
      if (e.to[0] !== to[0] || e.to[1] !== to[1]) continue
      if (e.from[0] === from[0] && e.from[1] === from[1]) return null
      if (!target.multiple) doc.edgeMap.delete(id)
    }
    const edge: Edge = { id: newId('edge'), from: [...from], to: [...to] }
    doc.edgeMap.set(edge.id, edge)
    return edge
  })
}

export function removeEdges(doc: PleinDoc, ids: Iterable<string>) {
  write(doc, () => {
    for (const id of ids) doc.edgeMap.delete(id)
  })
}

/** 清理并发删除留下的悬空边（读取时已忽略，这里真正删掉） */
export function pruneDanglingEdges(doc: PleinDoc) {
  const dangling = [...doc.edgeMap.entries()]
    .filter(([, e]) => !doc.has(e.from[0]) || !doc.has(e.to[0]))
    .map(([id]) => id)
  if (dangling.length === 0) return
  doc.ydoc.transact(() => {
    for (const id of dangling) doc.edgeMap.delete(id)
  })
}
