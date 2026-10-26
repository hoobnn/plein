import {
  type CanvasElement,
  type ClipboardData,
  exportElements,
  importElements,
  type ImportOptions,
  type PleinDoc,
  setParams,
  setText,
  isVideoSegment,
} from '@plein/doc'
import {
  findMentions,
  mentionName,
  type MentionTarget,
  profileOf,
  sortMentionTargets,
  isAiAnalysisType,
  AiSceneRequest,
  AiSummaryRequest,
  AiDraftOrigin,
} from '@plein/nodes'

const KEY = 'plein/mentions'

function targets(elements: Iterable<CanvasElement>): MentionTarget[] {
  return [...elements].flatMap((el) => {
    const name = mentionName(el)
    return name
      ? [
          {
            id: el.id,
            name,
            ...(el.nodeType === 'plein/character'
              ? { profile: profileOf(el.params?.profile) }
              : {}),
          },
        ]
      : []
  })
}

/** 只重写已明确指向的引用；保留档案后缀和未消歧的原文。 */
function rewrite(
  text: string,
  source: MentionTarget[],
  destination: MentionTarget[],
  ids?: ReadonlyMap<string, string>,
) {
  const ordered = sortMentionTargets(destination)
  let out = ''
  let last = 0
  for (const m of findMentions(text, source)) {
    if (!m.id) continue
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
    out += text.slice(last, m.start) + token
    last = end
  }
  return out + text.slice(last)
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
  const next = bindings(params) as Record<string, unknown>
  if (Array.isArray(next.requiredRefs)) next.requiredRefs = next.requiredRefs.map(ref)
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
  text: (s: string) => string,
  ids?: ReadonlyMap<string, string>,
) {
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
    if (JSON.stringify(next) !== JSON.stringify(el.params)) setParams(doc, el.id, next)
  }
  if (typeof el.text === 'string') {
    const next = text(el.text)
    if (next !== el.text) setText(doc, el.id, next)
  }
}

export const referenceClipboard = {
  copy(doc: PleinDoc, ids: Iterable<string>): ClipboardData {
    return {
      ...exportElements(doc, ids),
      extensions: { [KEY]: targets(doc.elements()).map(({ id, name }) => ({ id, name })) },
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
        ? raw.map((t) => ({ id: t.id as string, name: t.name as string }))
        : targets(data.elements)
    const roots = importElements(doc, data, {
      ...opts,
      onImport(ids) {
        const destination = targets(doc.elements())
        for (const el of before) patch(doc, el, (s) => rewrite(s, existing, destination))
        for (const el of data.elements) {
          const imported = doc.get(ids.get(el.id)!)
          if (imported) {
            // 必需参考、分镜资产绑定、序列 source 等参数内的元素 id 也随副本映射。
            patch(doc, imported, (s) => rewrite(s, source, destination, ids), ids)
          }
        }
        opts.onImport?.(ids)
      },
    })
    doc.undo.stopCapturing()
    return roots
  },
}
