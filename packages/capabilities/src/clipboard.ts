import {
  type CanvasElement,
  type ClipboardData,
  type Edge,
  connect,
  exportElements,
  importElements,
  type ImportOptions,
  type PleinDoc,
  setParams,
  setText,
  isVideoSegment,
} from '@plein/doc'
import { boundReferenceTokens, referenceBindings, remapReferenceParams } from '@plein/plugin-sdk'
import { referenceAlias } from './reference-alias'
import {
  findMentions,
  mentionName,
  type MentionTarget,
  profileOf,
  sortMentionTargets,
  isAiAnalysisType,
  ASSET_NODE_TYPES,
  AiSceneRequest,
  AiSummaryRequest,
  AiDraftOrigin,
} from '@plein/nodes'

const KEY = 'plein/mentions'
const EXTERNAL_EDGES_KEY = 'plein/reference-external-edges'
/** 复制来源的画布 id；旧剪贴板没有这一项，按同画布兼容处理。 */
const SOURCE_CANVAS_KEY = 'plein/reference-source-canvas'
/** 跨画布粘贴时，未随复制带入的来源改写成这个不存在的地址，避免挂到目标画布同 id 元素上。 */
const EXTERNAL_ID = 'plein/external:'
const externalId = (canvasId: string, id: string) =>
  `${EXTERNAL_ID}${encodeURIComponent(canvasId)}:${id}`
const MEDIA_KINDS = new Set(['image', 'video', 'audio'])

function externalReferenceEdges(doc: PleinDoc, data: ClipboardData): Edge[] {
  const copied = new Set(data.elements.map((el) => el.id))
  return [...doc.edges()].filter((edge) => {
    if (copied.has(edge.from[0]) || !copied.has(edge.to[0]) || edge.to[1] !== 'references')
      return false
    const source = doc.get(edge.from[0])
    const target = doc.get(edge.to[0])
    return (
      !!source &&
      MEDIA_KINDS.has(source.kind) &&
      target?.kind === 'node' &&
      ASSET_NODE_TYPES.has(target.nodeType ?? '')
    )
  })
}

function readExternalReferenceEdges(value: unknown): Edge[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((edge) => {
    if (!edge || typeof edge !== 'object') return []
    const { id, from, to, order } = edge as Partial<Edge>
    const address = (value: unknown): value is [string, string] =>
      Array.isArray(value) && value.length === 2 && value.every((part) => typeof part === 'string')
    if (typeof id !== 'string' || !address(from) || !address(to)) return []
    return [{ id, from: [...from], to: [...to], ...(typeof order === 'string' ? { order } : {}) }]
  })
}

function restoreExternalReferenceEdges(
  doc: PleinDoc,
  edges: Edge[],
  ids: ReadonlyMap<string, string>,
) {
  for (const edge of edges) {
    const target = ids.get(edge.to[0])
    const source = doc.get(edge.from[0])
    const targetElement = target ? doc.get(target) : undefined
    if (
      !target ||
      !source ||
      !MEDIA_KINDS.has(source.kind) ||
      targetElement?.kind !== 'node' ||
      !ASSET_NODE_TYPES.has(targetElement.nodeType ?? '') ||
      edge.to[1] !== 'references' ||
      ids.has(edge.from[0])
    )
      continue
    const restored = connect(doc, edge.from, [target, edge.to[1]])
    if (restored && edge.order) doc.edgeMap.set(restored.id, { ...restored, order: edge.order })
  }
}

interface CopiedTarget extends MentionTarget {
  /** 复制时记下媒体种类，跨画布外部引用可沿用正确的引用类型。 */
  type?: 'image' | 'video' | 'audio'
}

function targets(elements: Iterable<CanvasElement>): CopiedTarget[] {
  return [...elements].flatMap((el) => {
    const name = mentionName(el)
    if (!name) return []
    const type =
      el.kind === 'image' || el.kind === 'video' || el.kind === 'audio'
        ? el.kind
        : ASSET_NODE_TYPES.has(el.nodeType ?? '')
          ? ('image' as const)
          : undefined
    return [
      {
        id: el.id,
        name,
        ...(type ? { type } : {}),
        ...(el.nodeType === 'plein/character' ? { profile: profileOf(el.params?.profile) } : {}),
      },
    ]
  })
}

interface TextEdit {
  start: number
  end: number
  value: string
}

/** 只重写已明确指向的引用；保留档案后缀和未消歧的原文。 */
function mentionEdits(
  text: string,
  source: MentionTarget[],
  destination: MentionTarget[],
  ids?: ReadonlyMap<string, string>,
  crossCanvas = false,
): TextEdit[] {
  const ordered = sortMentionTargets(destination)
  const edits: TextEdit[] = []
  for (const m of findMentions(text, source)) {
    if (!m.id) continue
    // 跨画布时，没随复制带入的来源不能凭目标画布里的同 id 元素认领：保留可读原名，
    // 由中立化后的持久绑定给出失效提示。
    if (crossCanvas && ids && !ids.has(m.id)) continue
    const target = ordered.find((t) => t.id === (ids?.get(m.id!) ?? m.id))
    const peers = ordered.filter((t) => t.name === (target?.name ?? m.name))
    // 未随卡片复制的外部依赖，不能悄悄借用目标画布的同名素材。
    // #0 始终无法命中；后续再添同名卡片也不会使它误恢复。
    if (!target && (!ids || peers.length === 0)) continue
    const token = target
      ? `@${target.name}${peers.length > 1 ? `#${peers.findIndex((t) => t.id === target.id) + 1}` : ''}`
      : `@${m.name}#0`
    const end =
      m.start +
      1 +
      m.name.length +
      (text.slice(m.start + 1 + m.name.length).match(/^#\d{1,3}/)?.[0].length ?? 0)
    edits.push({ start: m.start, end, value: token })
  }
  return edits
}

/**
 * 名称绑定里的引用：生成节点、无名默认素材不在 @ 菜单的目标集合里，
 * 复制后改名只能靠绑定身份找到原文位置。与普通 @ 同位置时不重复改。
 */
function boundEdits(
  doc: PleinDoc,
  text: string,
  params: Record<string, unknown>,
  ids?: ReadonlyMap<string, string>,
): TextEdit[] {
  const bindings = referenceBindings(params)
  const edits: TextEdit[] = []
  for (const token of boundReferenceTokens(text, params)) {
    // 旧编号有独立的身份协议，不按名称重排。
    if (
      /^(image|video|audio)[1-9]\d*$/.test(token.name) &&
      !Object.keys(params).some((key) =>
        key.startsWith(`referenceNameBinding:${encodeURIComponent(token.name)}:`),
      )
    )
      continue
    const binding = bindings[token.name]
    if (!binding?.source) continue
    const alias = referenceAlias(doc, {
      source: ids?.get(binding.source) ?? binding.source,
      sourcePort: binding.sourcePort,
    })
    if (!alias || alias === token.name) continue
    // 原文里已经写了手工 #序号（如 @林夏#002）时整段换成新别名，不留下双层后缀。
    const suffix = text.slice(token.end).match(/^#\d{1,3}/)?.[0].length ?? 0
    edits.push({ start: token.start, end: token.end + suffix, value: `@${alias}` })
  }
  return edits
}

function applyTextEdits(text: string, edits: TextEdit[]) {
  let out = ''
  let last = 0
  for (const edit of edits.sort((a, b) => a.start - b.start)) {
    if (edit.start < last) continue
    out += text.slice(last, edit.start) + edit.value
    last = edit.end
  }
  return out + text.slice(last)
}

/**
 * 合并两类改写：绑定身份优先。普通 @ 改写要排除所有被持久绑定覆盖的区间——
 * 不只是「这次要改名」的绑定：冲突、悬空、别名不变的绑定都算，身份不明就原样保留，
 * 不能让普通 @ 候选把冲突的正文悄悄换成单一来源。
 */
function rewriteText(
  doc: PleinDoc,
  text: string,
  params: Record<string, unknown> | undefined,
  source: MentionTarget[],
  destination: MentionTarget[],
  ids?: ReadonlyMap<string, string>,
  crossCanvas = false,
) {
  const bound = params ? boundEdits(doc, text, params, ids) : []
  const protectedRanges = params
    ? boundReferenceTokens(text, params).map((token) => ({ start: token.start, end: token.end }))
    : []
  const mentions = mentionEdits(text, source, destination, ids, crossCanvas).filter(
    (edit) => !protectedRanges.some((range) => range.start < edit.end && range.end > edit.start),
  )
  return applyTextEdits(text, [...bound, ...mentions])
}

function rewriteValue(value: unknown, text: (s: string) => string): unknown {
  if (isVideoSegment(value)) return value
  if (typeof value === 'string') return text(value)
  if (Array.isArray(value)) return value.map((v) => rewriteValue(v, text))
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        k === 'legacySourceSettings' ||
        (k === 'inputKey' && Array.isArray((value as Record<string, unknown>).cues))
          ? v
          : rewriteValue(v, text),
      ]),
    )
  return value
}

/** 只映射声明为元素引用的字段；描述、台词等自由文字不能按 id 替换。 */
function remapParams(params: Record<string, unknown>, ids: ReadonlyMap<string, string>) {
  const ref = (v: unknown) => (typeof v === 'string' ? (ids.get(v) ?? v) : v)
  const bindings = (v: unknown): unknown => {
    if (isVideoSegment(v)) return v
    if (Array.isArray(v)) return v.map(bindings)
    if (!v || typeof v !== 'object') return v
    return Object.fromEntries(
      Object.entries(v).map(([k, value]) => [
        k,
        k === 'elementId' || k === 'storyboard' ? ref(value) : bindings(value),
      ]),
    )
  }
  const next = remapReferenceParams(bindings(params) as Record<string, unknown>, ids)
  if (Array.isArray(next.clips))
    next.clips = next.clips.map((clip) => {
      if (!clip || typeof clip !== 'object') return clip
      return Object.fromEntries(
        Object.entries(clip).map(([k, v]) => [
          k,
          ['source', 'dialogue', 'sfx'].includes(k)
            ? ref(v)
            : k === 'more' && Array.isArray(v)
              ? v.map(ref)
              : v,
        ]),
      )
    })
  return next
}

function patch(
  doc: PleinDoc,
  el: CanvasElement,
  source: MentionTarget[],
  destination: MentionTarget[],
  ids?: ReadonlyMap<string, string>,
  crossCanvas = false,
) {
  const text = (value: string) =>
    rewriteText(doc, value, el.params, source, destination, ids, crossCanvas)
  if (el.nodeType === 'plein/delivery-check') return
  // doc's typed copier already remaps instance/edge/audio/scope IDs and the key.
  // Rendered subtitle text and fixed generation origins are literal evidence, not @ prompts.
  if (el.nodeType === 'plein/sequence' && el.params?.instanceVersion === 2) return
  if (
    (isAiAnalysisType(el.nodeType) &&
      (AiSceneRequest.safeParse(el.params?.request).success ||
        AiSummaryRequest.safeParse(el.params?.request).success)) ||
    (el.kind === 'markdown' && AiDraftOrigin.safeParse(el.params?.aiDraftOrigin).success)
  )
    return
  if (el.params) {
    const rewritten = rewriteValue(el.params, text) as Record<string, unknown>
    const next = ids ? remapParams(rewritten, ids) : rewritten
    if (JSON.stringify(next) !== JSON.stringify(el.params)) {
      // setParams 是合并写入：改名后不再存在的旧绑定键必须显式置空，否则会留在参数里
      // 和新键一起被读成同名冲突。
      const patch: Record<string, unknown> = { ...next }
      for (const key of Object.keys(el.params)) if (!(key in next)) patch[key] = undefined
      setParams(doc, el.id, patch)
    }
  }
  if (typeof el.text === 'string') {
    const next = text(el.text)
    if (next !== el.text) setText(doc, el.id, next)
  }
}

/** 绑定值里记录的输出口；旧绑定没有。 */
function bindingPort(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const port = (value as { sourcePort?: unknown }).sourcePort
  return typeof port === 'string' ? port : undefined
}

/** 复制后按目标画布的同名顺序重写名称绑定键，并同步旧的嵌套绑定别名。 */
function syncBindingAliases(doc: PleinDoc) {
  for (const el of doc.elements()) {
    if (!el.params) continue
    if (el.nodeType === 'plein/delivery-check') continue
    if (el.nodeType === 'plein/sequence' && el.params.instanceVersion === 2) continue
    if (
      (isAiAnalysisType(el.nodeType) &&
        (AiSceneRequest.safeParse(el.params.request).success ||
          AiSummaryRequest.safeParse(el.params.request).success)) ||
      (el.kind === 'markdown' && AiDraftOrigin.safeParse(el.params.aiDraftOrigin).success)
    )
      continue
    const patch: Record<string, unknown> = {}
    // 先按旧别名汇总这个元素里现有的全部提案：同一个别名有多条提案（来源不同）就是
    // 冲突态，粘贴、改名都不能把它私自解成一个来源，否则正文会悄悄指到另一份素材。
    const proposals = new Map<string, Array<{ key: string; source: string; next?: string }>>()
    for (const key of Object.keys(el.params)) {
      if (!key.startsWith('referenceNameBinding:')) continue
      const body = key.slice('referenceNameBinding:'.length)
      const separator = body.lastIndexOf(':')
      if (separator < 0) continue
      let alias: string
      try {
        alias = decodeURIComponent(body.slice(0, separator))
      } catch {
        continue
      }
      const source = body.slice(separator + 1)
      const list = proposals.get(alias) ?? []
      list.push({
        key,
        source,
        next: referenceAlias(doc, { source, sourcePort: bindingPort(el.params?.[key]) }),
      })
      proposals.set(alias, list)
    }
    const renames = new Map<string, string>()
    for (const [alias, entries] of proposals) {
      if (entries.length !== 1) continue
      const entry = entries[0]!
      // 来源已被删除时保留原提案（并由预览标为失效/冲突），不要只搬走能算出的那一条。
      if (!entry.next || entry.next === alias || !doc.has(entry.source)) continue
      renames.set(alias, entry.next)
      const body = entry.key.slice('referenceNameBinding:'.length)
      const separator = body.lastIndexOf(':')
      patch[entry.key] = undefined
      patch[`referenceNameBinding:${encodeURIComponent(entry.next)}:${body.slice(separator + 1)}`] =
        el.params[entry.key]
    }
    const nested = el.params.referenceBindings
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      let changed = false
      const entries = Object.entries(nested as Record<string, unknown>).map(([alias, value]) => {
        const next = renames.get(alias)
        if (!next) return [alias, value] as const
        changed = true
        return [next, value] as const
      })
      if (changed) patch.referenceBindings = Object.fromEntries(entries)
    }
    if (Object.keys(patch).length) setParams(doc, el.id, patch)
  }
}

/** 跨画布粘贴：未随复制带入的来源改为不存在的地址，保留可读原名与失效提示。 */
function neutralizeCrossCanvas(
  doc: PleinDoc,
  el: CanvasElement,
  copied: ReadonlyMap<string, string>,
  canvasId: string,
  copiedTargets: CopiedTarget[],
) {
  const params = el.params
  if (!params) return
  const internal = (id: string) => copied.has(id) || [...copied.values()].includes(id)
  const sentinel = (id: string) => externalId(canvasId, id)
  const remapValue = (value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value
    const source = (value as { source?: unknown }).source
    if (typeof source !== 'string' || internal(source)) return value
    return { ...value, source: sentinel(source) }
  }
  const patch: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(params)) {
    if (key === 'referenceBindings') continue
    const named = key.startsWith('referenceNameBinding:')
    const legacy = key.startsWith('referenceBinding:')
    if (!named && !legacy && !/^(image|video|audio)[1-9]\d*(?::|$)/.test(key)) continue
    const parts = key.split(':')
    const at = named ? parts.length - 1 : legacy ? 2 : 1
    const source = parts[at]
    const mapped = remapValue(value)
    if (source && !internal(source)) {
      parts[at] = sentinel(source)
      patch[key] = undefined
      patch[parts.join(':')] = mapped
    } else if (mapped !== value) patch[key] = mapped
  }
  const nested = params.referenceBindings
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    let changed = false
    const entries = Object.entries(nested as Record<string, unknown>).map(([alias, value]) => {
      const mapped = remapValue(value)
      if (mapped !== value) changed = true
      return [alias, mapped] as const
    })
    if (changed) patch.referenceBindings = Object.fromEntries(entries)
  }
  // 必需参考与选图设置也里带上元素 id，同样不能靠同 id 挂到目标素材上。
  const required = params.requiredRefs
  if (Array.isArray(required)) {
    const next = required.map((id) => (typeof id === 'string' && !internal(id) ? sentinel(id) : id))
    if (next.some((value, index) => value !== required[index])) patch.requiredRefs = next
  }
  const picks = params.referenceImagePicks
  if (picks && typeof picks === 'object' && !Array.isArray(picks)) {
    const keys = Object.keys(picks)
    const entries = Object.entries(picks as Record<string, unknown>).map(([id, value]) => [
      internal(id) ? id : sentinel(id),
      value,
    ])
    if (entries.some(([id], index) => id !== keys[index]))
      patch.referenceImagePicks = Object.fromEntries(entries)
  }
  // 普通 @ 引用没有持久绑定：补一条指向不存在来源的绑定，正文保留原名，
  // 目标画布之后出现同名卡片也不会把它误绑过去。
  const kinds = new Map(copiedTargets.map((target) => [target.id, target.type]))
  const names = new Set<string>()
  for (const key of Object.keys(params)) {
    if (!key.startsWith('referenceNameBinding:')) continue
    try {
      names.add(decodeURIComponent(key.slice('referenceNameBinding:'.length, key.lastIndexOf(':'))))
    } catch {
      // 损坏的编码不影响其他绑定。
    }
  }
  for (const value of Object.values(params)) {
    if (typeof value !== 'string' || !value.includes('@')) continue
    for (const mention of findMentions(value, copiedTargets)) {
      if (!mention.id || internal(mention.id)) continue
      const suffix =
        value.slice(mention.start + 1 + mention.name.length).match(/^#\d{1,3}/)?.[0] ?? ''
      const name = `${mention.name}${suffix}`
      if (names.has(name)) continue
      names.add(name)
      patch[`referenceNameBinding:${encodeURIComponent(name)}:${sentinel(mention.id)}`] = {
        type: kinds.get(mention.id) ?? 'image',
        assetId: '',
        source: sentinel(mention.id),
      }
    }
  }
  if (Object.keys(patch).length) setParams(doc, el.id, patch)
}

export const referenceClipboard = {
  copy(doc: PleinDoc, ids: Iterable<string>, opts: { canvasId?: string } = {}): ClipboardData {
    const exported = exportElements(doc, ids)
    const copied = targets(doc.elements())
    return {
      ...exported,
      extensions: {
        [KEY]: copied.map(({ id, name, type }) => ({ id, name, ...(type ? { type } : {}) })),
        [EXTERNAL_EDGES_KEY]: externalReferenceEdges(doc, exported),
        ...(opts.canvasId ? { [SOURCE_CANVAS_KEY]: opts.canvasId } : {}),
      },
    }
  },
  paste(doc: PleinDoc, data: ClipboardData, opts: ImportOptions = {}): string[] {
    doc.undo.stopCapturing()
    const before = [...doc.elements()]
    const existing = targets(before)
    const raw = data.extensions?.[KEY]
    // 系统剪贴板来自外部：只接受解析器需要的基本字段，档案后缀保留原文。
    const source =
      Array.isArray(raw) &&
      raw.every((t) => t && typeof t.id === 'string' && typeof t.name === 'string')
        ? raw.map((t) => ({
            id: t.id as string,
            name: t.name as string,
            ...(t.type === 'image' || t.type === 'video' || t.type === 'audio'
              ? { type: t.type }
              : {}),
          }))
        : targets(data.elements)
    const recordedCanvas = data.extensions?.[SOURCE_CANVAS_KEY]
    const sourceCanvasId = typeof recordedCanvas === 'string' ? recordedCanvas : undefined
    // 只有两边都确知且不同才算跨画布；没有元数据的老剪贴板沿用既有兼容行为。
    const crossCanvas = !!sourceCanvasId && !!opts.canvasId && sourceCanvasId !== opts.canvasId
    const externalEdges = readExternalReferenceEdges(data.extensions?.[EXTERNAL_EDGES_KEY])
    const roots = importElements(doc, data, {
      ...opts,
      onImport(ids) {
        const destination = targets(doc.elements())
        for (const el of before) patch(doc, el, existing, destination)
        for (const el of data.elements) {
          const imported = doc.get(ids.get(el.id)!)
          if (imported) {
            // 必需参考、分镜资产绑定、序列 source 等参数内的元素 id 也随副本映射。
            patch(doc, imported, source, destination, ids, crossCanvas)
            if (crossCanvas && sourceCanvasId)
              neutralizeCrossCanvas(doc, imported, ids, sourceCanvasId, source)
          }
        }
        // 跨画布时未复制的外部素材可能和目标画布元素同 id，不能按 id 补回参考入边。
        if (!crossCanvas) restoreExternalReferenceEdges(doc, externalEdges, ids)
        // 复制会新增同名卡片：正文已按新序号改写，名称绑定键也要一起改成同一个别名。
        syncBindingAliases(doc)
        opts.onImport?.(ids)
      },
    })
    doc.undo.stopCapturing()
    return roots
  },
}
