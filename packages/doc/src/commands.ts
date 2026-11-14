import { generateNKeysBetween } from 'fractional-indexing'
import * as Y from 'yjs'
import { type ElementMap, type PleinDoc, SYSTEM_ORIGIN } from './doc'
import { createProductionMap } from './domain/production'
import { newAdoptionRevision, newId } from './ids'
import { inputEdges } from './inputs'
import { sequenceSnapshot, snapshotTypedDeliveries } from './sequence-snapshot'
import { materializeSequenceV1, sequenceInstancesOf } from './domain/sequence-instances'
import { isVideoSegment } from './domain/video-segment'
import { creativeReviewKey, isCreativeReview } from './domain/review-types'
import {
  fixedReferencedResultIds,
  fixedResultHolders,
  relatedOutputIds,
} from './domain/fixed-references'
import { relatedResult } from './domain/related-result'
import type { FixedResultReference } from './domain/fixed-references'
import {
  deleteResultItems,
  ensureResultsContainer,
  insertResultsFront,
  legacyResults,
  readResults,
  replaceResults,
  resultIndexes,
  resultsContainer,
  RESULTS_RECORDED_KEY,
  type ResultRemovalReceipt,
} from './results'
import { write } from './commands/write'

export { ReadOnlyDocError } from './commands/write'
export { relatedResult } from './domain/related-result'
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
 * 通用元素与边的命令式写入 API（序列实例的专属命令在 `commands/sequence.ts`）。
 * 每个命令是一个带 doc.origin（默认 LOCAL_ORIGIN）的事务，
 * 撤销按命令（及 captureTimeout 内的连续命令）为一步。
 */

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
      m.set(key, key === 'deliveries' ? snapshotTypedDeliveries(v) : v)
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
    if (inputs.length === 0) return []
    // 同一父元素下按输入顺序叠在最上面
    const parents = inputs.map((input) => validParent(doc, input.parentId))
    const zByParent = new Map<
      string | null,
      { count: number; max: string | null; keys: string[]; next: number }
    >()
    for (const parent of parents) {
      const group = zByParent.get(parent)
      if (group) group.count++
      else zByParent.set(parent, { count: 1, max: null, keys: [], next: 0 })
    }
    if (doc.size > 0) {
      for (const el of doc.elements()) {
        const group = zByParent.get(doc.effectiveParent(el))
        if (group && (group.max === null || el.z > group.max)) group.max = el.z
      }
    }
    for (const group of zByParent.values()) {
      group.keys = generateNKeysBetween(group.max, null, group.count)
    }
    return inputs.map((input, i) => {
      const id = input.id ?? newId('el')
      const parentId = parents[i]!
      const group = zByParent.get(parentId)!
      // 先挂进文档再写字段：未挂载的 Y 类型不能读取
      const m = new Y.Map<unknown>()
      doc.elementMaps.set(id, m)
      m.set('kind', input.kind)
      m.set('rotation', input.rotation ?? 0)
      m.set('z', group.keys[group.next++]!)
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
      if (isVideoSegment(input.videoSegment))
        m.set('videoSegment', sequenceSnapshot(input.videoSegment))
      if (input.text !== undefined || input.kind === 'markdown') {
        m.set('text', new Y.Text(input.text ?? ''))
      }
      if (input.params !== undefined || input.kind === 'node') {
        m.set(
          'params',
          new Y.Map(
            Object.entries(
              input.nodeType === 'plein/sequence'
                ? sequenceSnapshot(input.params ?? {})
                : (input.params ?? {}),
            ).map(([key, value]) => [
              key,
              // 动态合成的结构化编辑按条目存进嵌套 Y.Map，局部改动不会重写整份参数
              key === 'overrides' && value && typeof value === 'object' && !Array.isArray(value)
                ? new Y.Map(Object.entries(value))
                : value,
            ]),
          ),
        )
      }
      // 结果容器随节点一起建：两个客户端各自给同一个节点加候选时，
      // 容器已经存在，两边写进同一个 Y.Array，不会各造一份互相覆盖。
      if (input.kind === 'node') {
        const container = ensureResultsContainer(m)
        if (input.results?.length) {
          insertResultsFront(container, input.results)
          m.set(RESULTS_RECORDED_KEY, true)
        }
      } else if (input.results?.length) {
        const container = ensureResultsContainer(m)
        insertResultsFront(container, input.results)
        m.set(RESULTS_RECORDED_KEY, true)
      }
      if (input.adopted !== undefined) m.set('adopted', input.adopted)
      if (input.reviews?.length)
        m.set(
          'reviews',
          new Y.Map(
            input.reviews.filter(isCreativeReview).map((r) => [creativeReviewKey(r.target), r]),
          ),
        )
      if (input.nodeType === 'plein/storyboard' || input.production)
        m.set('production', createProductionMap(input.production))
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
      if (doc.elementMaps.has(id)) doomed.add(id)
    }
    if (doomed.size === 0) return
    // 一次构建有效父子关系，避免多选删除时为每个元素重新扫描整份文档。
    const children = new Map<string, string[]>()
    const elements = [...doc.elements()]
    for (const el of elements) {
      const parent = doc.effectiveParent(el)
      if (parent === null) continue
      const siblings = children.get(parent)
      if (siblings) siblings.push(el.id)
      else children.set(parent, [el.id])
    }
    for (const id of doomed) {
      for (const child of children.get(id) ?? []) doomed.add(child)
    }
    for (const [edgeId, e] of doc.edgeMap) {
      if (doomed.has(e.from[0]) || doomed.has(e.to[0])) doc.edgeMap.delete(edgeId)
    }
    clearReferenceBindings(doc, doomed, undefined, elements)
    for (const id of doomed) doc.elementMaps.delete(id)
  })
}

/**
 * 连线或来源元素消失时，同步清掉指向它的名称 / 旧编号绑定；正文仍保留，预览会标为断链。
 * match 用于只清被操作的那个输出口：同源其他输出口的绑定必须保留。
 */
function clearReferenceBindings(
  doc: PleinDoc,
  sources: ReadonlySet<string>,
  targetId?: string,
  elements: Iterable<CanvasElement> = doc.elements(),
  match?: (source: string, key: string, value: unknown) => boolean,
) {
  const clears = (key: string, value: unknown) => {
    const source = referenceBindingSource(key, value)
    if (!source || !sources.has(source)) return false
    return !match || match(source, key, value)
  }
  for (const el of elements) {
    if (targetId && el.id !== targetId) continue
    const params = el.params
    if (!params) continue
    const patch: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(params)) {
      if (key === 'referenceBindings') continue
      if (clears(key, value)) patch[key] = undefined
    }
    const nested = params.referenceBindings
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      const entries = Object.entries(nested as Record<string, unknown>)
      const kept = entries.filter(([key, value]) => !clears(key, value))
      if (kept.length !== entries.length) patch.referenceBindings = Object.fromEntries(kept)
    }
    if (Object.keys(patch).length) setParams(doc, el.id, patch)
  }
}

function referenceBindingSource(key: string, value: unknown): string | undefined {
  const named = key.startsWith('referenceNameBinding:')
  const legacy = key.startsWith('referenceBinding:')
  const numbered = /^(image|video|audio)[1-9]\d*(?::|$)/.test(key)
  if (!named && !legacy && !numbered) return undefined
  if (value && typeof value === 'object' && 'source' in value && typeof value.source === 'string')
    return value.source
  if (named) {
    const body = key.slice('referenceNameBinding:'.length)
    return body.slice(body.lastIndexOf(':') + 1) || undefined
  }
  if (key.startsWith('referenceBinding:'))
    return key.slice('referenceBinding:'.length).split(':')[1] || undefined
  return undefined
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
      else if (m.get('nodeType') === 'plein/sequence') pm.set(k, sequenceSnapshot(v))
      // 动态合成的结构化编辑按条目存进嵌套 Y.Map，局部改动不会重写整份参数
      else if (k === 'overrides' && v && typeof v === 'object' && !Array.isArray(v)) {
        const old = pm.get(k)
        if (old instanceof Y.Map) {
          const entries = v as Record<string, unknown>
          for (const key of [...old.keys()]) if (!(key in entries)) old.delete(key)
          for (const [key, value] of Object.entries(entries))
            if (old.get(key) !== value) old.set(key, value)
        } else pm.set(k, new Y.Map(Object.entries(v)))
      } else pm.set(k, v)
    }
  })
}

export function setParam(doc: PleinDoc, id: string, key: string, value: unknown) {
  setParams(doc, id, { [key]: value })
}

/** 稀疏字典按条目合并；独立编辑不会整对象覆盖，事务仍由本地撤销管理。 */
export function setParamEntry(
  doc: PleinDoc,
  id: string,
  key: string,
  entry: string,
  value: unknown,
) {
  write(doc, () => {
    const m = doc.mutable(id)
    if (!m) return
    let params = m.get('params')
    if (!(params instanceof Y.Map)) {
      params = new Y.Map<unknown>()
      m.set('params', params)
    }
    const pm = params as Y.Map<unknown>
    let dictionary = pm.get(key)
    if (!(dictionary instanceof Y.Map)) {
      const previous =
        dictionary && typeof dictionary === 'object' && !Array.isArray(dictionary)
          ? Object.entries(dictionary as Record<string, unknown>)
          : []
      dictionary = new Y.Map<unknown>(previous)
      pm.set(key, dictionary)
    }
    const map = dictionary as Y.Map<unknown>
    if (value === undefined) map.delete(entry)
    else if (map.get(entry) !== value) map.set(entry, value)
  })
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

/**
 * 删除生成历史里的结果记录（可撤销，一次调用一步）。
 * 只删文档里的记录，不删除资产文件；被删的是节点当前显式采用的结果时，
 * 节点回到「尚未采用」，不自动换成别的候选。节点或结果不存在时跳过。
 *
 * 逐条删除容器里的目标项，不整份重写数组：这样撤销只会还原被删的那几条，
 * 系统在这期间加入的候选与采用状态都留着。
 *
 * 传入 canvasId 时，正被固定剪辑精确引用的候选（及其关联输出）会被保留，
 * 需要先解除固定再删 —— 删掉就断了片段返工和文件来源。
 */
export function removeResults(
  doc: PleinDoc,
  items: ReadonlyArray<{ elementId: string; resultId: string }>,
  opts: { canvasId?: string | null } = {},
): number {
  return removeResultsWithReceipt(doc, items, opts).removed
}

/** 这次删除被固定剪辑挡下的候选 */
export interface KeptFixedResult {
  elementId: string
  resultId: string
  /** 仍在引用它的固定片段；`resultId` 可能只是那条固定视频的关联输出 */
  holders: FixedResultReference[]
}

/**
 * 删除结果，并留下「只撤销这一次删除」的凭据。
 *
 * 凭据让撤销不必依赖全局撤销栈：远端把节点整个删掉之后，栈里那一步已经
 * 失效，Yjs 会跳过它去撤更早的操作，把别的编辑撤掉。凭据记着每个来源
 * 当时的容器身份，可以先核对这一步还撤得回来。
 */
export function removeResultsWithReceipt(
  doc: PleinDoc,
  items: ReadonlyArray<{ elementId: string; resultId: string }>,
  opts: { canvasId?: string | null } = {},
): { removed: number; receipt: ResultRemovalReceipt[]; kept: KeptFixedResult[] } {
  if (doc.readOnly || items.length === 0) return { removed: 0, receipt: [], kept: [] }
  const byElement = new Map<string, Set<string>>()
  for (const { elementId, resultId } of items) {
    const ids = byElement.get(elementId)
    if (ids) ids.add(resultId)
    else byElement.set(elementId, new Set([resultId]))
  }
  // 正被固定剪辑用着的候选不能删：片段还要靠它返工，文件来源也要能核对。
  // 关联输出（视频配对的尾帧等）一同保留，否则返工时配不上对。
  // 每次删除都按当前文档重算，确认期间新固定进来的引用也会被挡下。
  const kept: KeptFixedResult[] = []
  if (opts.canvasId) {
    const elements = [...doc.elements()]
    for (const [elementId, ids] of byElement) {
      const el = doc.get(elementId)
      if (!el?.results?.length) continue
      const holders = fixedResultHolders(elements, {
        canvasId: opts.canvasId,
        nodeId: elementId,
        results: el.results,
      })
      if (!holders.size) continue
      // 先从每个固定候选展开它的完整关联输出（视频 + 配对尾帧等），再和请求集合取交集。
      // 只请求删尾帧、固定的是那条视频时也要挡下 —— 只按请求的 id 查引用会漏。
      const guard = new Map<string, FixedResultReference[]>()
      for (const [fixedId, refs] of holders) {
        for (const related of relatedOutputIds(el.results, fixedId)) {
          if (!guard.has(related)) guard.set(related, refs)
        }
      }
      const blocked = new Set<string>()
      for (const id of ids) {
        const used = guard.get(id)
        if (!used) continue
        blocked.add(id)
        kept.push({ elementId, resultId: id, holders: used })
      }
      for (const id of blocked) ids.delete(id)
      if (!ids.size) byElement.delete(elementId)
    }
  }
  if (!byElement.size) return { removed: 0, receipt: [], kept }
  // 单次调用独立成一步撤销，不与相邻的删除或编辑合并。
  doc.undo.stopCapturing()
  let outcome: { removed: number; receipt: ResultRemovalReceipt[] }
  try {
    // 旧格式节点还没有新容器时，先用系统写入把旧数据搬进新容器：
    // 容器创建不进用户的撤销栈，用户那一步撤销只还原被删的候选。
    // 根本没有这条记录的节点不建容器 —— 删不存在的东西不该留下痕迹。
    doc.ydoc.transact(() => {
      for (const [elementId, resultIds] of byElement) {
        const m = doc.elementMaps.get(elementId)
        if (!(m instanceof Y.Map)) continue
        const container = resultsContainer(m)
        const legacy = legacyResults(m)
        // 容器里有内容就看容器；容器空着就看旧端留下的候选。
        const source: NodeResult[] = container?.length
          ? (container.toArray() as NodeResult[])
          : (legacy ?? [])
        if (!source.some((r) => r.id && resultIds.has(r.id))) continue
        ensureResultsContainer(m)
      }
    }, SYSTEM_ORIGIN)
    outcome = write(doc, () => {
      let removed = 0
      const receipt: ResultRemovalReceipt[] = []
      for (const [elementId, resultIds] of byElement) {
        const m = doc.mutable(elementId)
        if (!m) continue
        const container = resultsContainer(m)
        if (!container) continue
        const indexes = resultIndexes(container, resultIds)
        if (!indexes.length) continue
        removed += deleteResultItems(container, indexes)
        // 用户明确删过：结果归新端接管，旧端迟到的候选不会再复活。
        m.set(RESULTS_RECORDED_KEY, true)
        const adopted = m.get('adopted')
        if (typeof adopted === 'string' && resultIds.has(adopted)) m.set('adopted', null)
        receipt.push({ elementId, container, resultIds: [...resultIds] })
      }
      return { removed, receipt }
    })
  } finally {
    doc.undo.stopCapturing()
  }
  // 记下这次删除在撤销栈上的位置：撤销前要核对它仍是栈顶。
  // 事务提交之后才拿得到栈项。
  const stackItem = doc.undo.undoStack.at(-1)
  for (const entry of outcome.receipt) entry.stackItem = stackItem
  return { ...outcome, kept }
}

/**
 * 只撤销一次删除。
 *
 * 走 Yjs 自己的撤销：它按相对位置还原，顺序正确，也自带 Redo ——
 * 删掉 [A,B,C,D] 里的 A、B，期间系统加入 S，撤销后是 [S,A,B,C,D]，
 * 不是按旧下标硬插出来的 [A,S,B,C,D]。
 *
 * 但 Yjs 的撤销会跳过已经失效的栈项去撤更早的操作，远端把来源节点删掉
 * 之后就会误撤别的编辑。所以先核对：
 * - 这次删除仍是撤销栈顶（有更新的本地操作就不动它）；
 * - 至少一个来源还在，而且还是当时那个容器（节点被删后重建就不算）。
 * 都不成立就如实报告「撤不回来」，不去碰全局撤销栈。
 */
export function undoResultRemoval(
  doc: PleinDoc,
  receipt: readonly ResultRemovalReceipt[],
): { undone: boolean; reason?: string } {
  if (doc.readOnly) return { undone: false, reason: '画布已变为只读，无法撤销。' }
  if (!receipt.length) return { undone: false, reason: '没有可撤销的删除记录。' }
  // 来源还在、容器还是当时那个，才撤得回来。
  // 远端把来源节点删掉之后，栈里那一步已失效：Yjs 会跳过它去撤更早的
  // 操作，把别的编辑撤掉 —— 这种情况下如实报告，不去碰全局撤销栈。
  const alive = receipt.some((entry) => {
    const m = doc.elementMaps.get(entry.elementId)
    return m instanceof Y.Map && resultsContainer(m) === entry.container
  })
  if (!alive) return { undone: false, reason: '删除的来源已不存在，这一步撤不回来了。' }
  // 还有更新的本地操作：这一步已经不是栈顶，不动它。
  const stackItem = receipt.find((entry) => entry.stackItem !== undefined)?.stackItem
  if (stackItem !== undefined && doc.undo.undoStack.at(-1) !== stackItem)
    return { undone: false, reason: '删除之后已有其他操作，请用 ⌘Z 逐步撤销。' }
  const undone = doc.undo.undo()
  if (!undone) return { undone: false, reason: '删除的来源已不存在，这一步撤不回来了。' }
  return { undone: true }
}
/**
 * 整份替换节点的结果记录（系统写入，不进撤销栈）。
 *
 * 用于导入重映射、检查点恢复这类「整份内容换掉」的场景；
 * 用户删除走 `removeResults`，逐条插删才留得住撤销引用。
 */
export function setResults(doc: PleinDoc, id: string, results: readonly NodeResult[]) {
  if (doc.readOnly) return
  doc.ydoc.transact(() => {
    const m = doc.mutable(id)
    if (!m) return
    replaceResults(m, results)
  }, SYSTEM_ORIGIN)
}

/**
 * 采用某个结果（可撤销）。
 *
 * resultId=null 沿用旧约定，清除显式选择并回到最新结果。
 *
 * 显式人工采用会同时写一个版本记号（`adoptionRevision`），记号存在撤销范围之外：
 * 撤销这次采用只还原采用项，记号仍留在文档里 —— 历史要能证明用户当时确实
 * 动过手。A → B → A 的最终采用项与最初一样，记号却不同。
 *
 * 系统写入（addResults、缓存沿用）不写记号。
 */
export function adoptResult(doc: PleinDoc, id: string, resultId: string | null) {
  write(doc, () => {
    const m = doc.mutable(id)
    if (!m) return
    if (resultId === null) m.delete('adopted')
    else if (m.get('adopted') !== resultId) m.set('adopted', resultId)
  })
}

/**
 * 显式人工采用：独立一步撤销，并写下版本记号。
 *
 * 所有人工采用入口（审片器、生成历史、任务面板、候选检视）都走这里：
 * 相邻 300ms 内的改字或另一次采用各自独立撤销，不被合并成一步。
 *
 * 记号写在同一个事务里，但存放在撤销范围之外：
 * - 撤销这次采用只还原采用项，记号留在文档里 —— 历史要能证明用户动过手；
 * - A → B → A 最终采用项与最初一样，记号却不同。
 */
export function adoptResultManually(doc: PleinDoc, id: string, resultId: string | null) {
  doc.undo.stopCapturing()
  try {
    write(doc, () => {
      const m = doc.mutable(id)
      if (!m) return
      if (resultId === null) m.delete('adopted')
      else if (m.get('adopted') !== resultId) m.set('adopted', resultId)
      // 记号所在的映射在撤销范围之外，这个事务被撤销时它不会跟着回滚。
      doc.adoptionRevisions.set(id, newAdoptionRevision())
    })
  } finally {
    doc.undo.stopCapturing()
  }
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
 *
 * 候选限额不能挤掉正在使用的结果，也不能拆散其视频 / 尾帧等关联输出，
 * 更不能挤掉固定剪辑正在引用的候选：那些片段还要靠它返工。
 */
export function addResults(
  doc: PleinDoc,
  id: string,
  results: NodeResult[],
  opts: { adopt?: boolean; canvasId?: string | null } = {},
) {
  if (results.length === 0) return
  doc.ydoc.transact(() => {
    const m = doc.mutable(id)
    if (!m) return
    // 先把旧格式的数据搬进新容器，再读旧候选：顺序反了旧候选会被新键遮掉。
    const container = ensureResultsContainer(m)
    const old = readResults(m)
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
    // 固定剪辑引用的候选连同其关联输出必须留下：裁掉就断了返工与可追溯。
    if (opts.canvasId) {
      const fixed = fixedReferencedResultIds(doc.elements(), {
        canvasId: opts.canvasId,
        nodeId: id,
        results: list,
      })
      for (const resultId of fixed) {
        keep.add(resultId)
        for (const related of relatedOutputIds(list, resultId)) keep.add(related)
      }
    }
    insertResultsFront(container, results)
    m.set(RESULTS_RECORDED_KEY, true)
    // 超出限额的部分逐条删除。新加的候选插在最前，索引要往后挪。
    const keptIds = new Set(list.filter((r) => keep.has(r.id)).map((r) => r.id))
    const drop = list
      .map((r, index) => (keptIds.has(r.id) ? -1 : index))
      .filter((index) => index >= 0)
    deleteResultItems(container, drop)
    // 无显式采用或旧引用已无效时也钉住实际生效的结果，避免新候选抢占。
    //
    // 只有显式采用值真的变了才写：重复写同一个值会覆盖掉本地删除带来的
    // 采用变更（删除已采用的候选后 adopted 变 null，系统再写一次 null
    // 会把这次变更抹平，撤销也还原不回来）。
    const adopted = chosen?.id ?? null
    if (m.get('adopted') !== adopted) m.set('adopted', adopted)
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
  return relatedResult(all, chosen, port)
}

/**
 * 删除这些结果后，节点各输出端口的当前结果是否会改变。
 * 删除显式采用项，或拆除旧数据里按运行推断的唯一配对时返回 true。
 */
export function removalChangesCurrent(el: CanvasElement, resultIds: ReadonlySet<string>): boolean {
  const all = el.results ?? []
  const removed = new Set(all.filter((r) => resultIds.has(r.id)).map((r) => r.id))
  if (removed.size === 0) return false
  const after: CanvasElement = {
    ...el,
    results: all.filter((r) => !removed.has(r.id)),
    adopted: typeof el.adopted === 'string' && removed.has(el.adopted) ? null : el.adopted,
  }
  for (const port of new Set(all.map((r) => r.port))) {
    if (currentResult(el, port)?.id !== currentResult(after, port)?.id) return true
  }
  return false
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
    const targetElement = doc.get(to[0])
    if (
      targetElement?.nodeType === 'plein/sequence' &&
      (targetElement.nodeVersion ?? 1) >= 2 &&
      to[1] === 'clips'
    ) {
      const params = targetElement.params ?? {}
      if (params.instanceVersion !== 2) {
        setParams(
          doc,
          to[0],
          materializeSequenceV1(to[0], params, [...doc.edges()], (id) => doc.has(id)),
        )
      } else if (!sequenceInstancesOf(targetElement).some((c) => c.edgeId === edge.id)) {
        setParams(doc, to[0], {
          clips: [
            ...(Array.isArray(params.clips) ? params.clips : []),
            {
              clipInstanceId: newId('clip'),
              source: from[0],
              port: from[1],
              edgeId: edge.id,
              in: 0,
              sound: 'legacy',
            },
          ],
        })
      }
    }
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
    const detached = new Map<string, Edge[]>()
    for (const id of ids) {
      const edge = doc.edgeMap.get(id)
      if (edge) {
        const target = doc.get(edge.to[0])
        const removed = detached.get(edge.to[0]) ?? []
        removed.push(edge)
        detached.set(edge.to[0], removed)
        if (target?.nodeType === 'plein/sequence' && target.params?.instanceVersion === 2)
          setParams(doc, target.id, {
            clips: (Array.isArray(target.params.clips) ? target.params.clips : []).filter(
              (c) => !c || typeof c !== 'object' || c.segment || c.edgeId !== id,
            ),
          })
      }
      doc.edgeMap.delete(id)
    }
    for (const [targetId, removed] of detached) {
      const sources = new Set(removed.map((edge) => edge.from[0]))
      // 只清被断开的那个输出口的绑定：同一来源的另一个输出口（如视频的尾帧）仍然有效。
      const remaining = inputEdges(doc, targetId)
      const match = (source: string, _key: string, value: unknown) => {
        const ports = new Set(
          removed.filter((edge) => edge.from[0] === source).map((edge) => edge.from[1]),
        )
        const remainingPorts = new Set(
          remaining.filter((edge) => edge.from[0] === source).map((edge) => edge.from[1]),
        )
        const port = bindingPortOf(value)
        if (port) return ports.has(port) && !remainingPorts.has(port)
        const type = bindingTypeOf(value)
        // 没有身份信息的旧绑定：整个来源都断开了才清。
        if (!type) return remainingPorts.size === 0
        const src = doc.get(source)
        const kind = (portId: string) => findPort(src, portId, 'outputs')?.type
        const removedKinds = new Set([...ports].map(kind))
        const remainingKinds = new Set([...remainingPorts].map(kind))
        return removedKinds.has(type) && !remainingKinds.has(type)
      }
      clearReferenceBindings(doc, sources, targetId, doc.elements(), match)
    }
  })
}

function bindingPortOf(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const port = (value as { sourcePort?: unknown }).sourcePort
  return typeof port === 'string' ? port : undefined
}

function bindingTypeOf(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const type = (value as { type?: unknown }).type
  return type === 'image' || type === 'video' || type === 'audio' ? type : undefined
}
