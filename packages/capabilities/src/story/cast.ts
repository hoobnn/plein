import {
  connect,
  createElement,
  currentResult,
  type NewElement,
  nodeSize,
  parseAspect,
  setParams,
  type PleinDoc,
} from '@plein/doc'
import {
  CAST_NODE_TYPES,
  type CastEntry,
  hasVoice,
  parseCast,
  speakerTraits,
  voiceOf,
} from '@plein/nodes'
import { parseModelRef, type VoicePreset } from '@plein/plugin-sdk'
import { mentionElements, type NodeFactory } from './nodes'

/** 节点当前采用的文本结果；不是文本节点或还没跑过时为空 */
export function castOf(doc: PleinDoc, id: string): CastEntry[] {
  const el = doc.get(id)
  const value = el && currentResult(el, 'text')?.value
  return value?.type === 'text' ? parseCast(value.text) : []
}

export interface CastResult {
  /** 新建的设定卡 */
  created: string[]
  /** 给新角色卡配的定妆图节点：只建不跑，批量出分镜图时先跑 @ 到的那些 */
  portraits: string[]
  /** 按性别、年龄配上音色的角色卡 */
  voiced: string[]
  /** 原来设定为空、这次补上的卡 */
  filled: string[]
  /** 已经写了设定的同名卡：不覆盖用户写的 */
  kept: string[]
  /** 画布上有重名、或同名的是别的类型：指不明，不动 */
  ambiguous: string[]
}

const COLUMN_GAP = 40
const ROW_GAP = 24
const PORTRAIT_GAP = 40

/**
 * 新角色卡配的定妆图：三视图定妆照，设定原样写进提示词。
 * 不在提示词里 @ 卡片自己：卡片的参考图就是这张图的结果，@ 了等于自己引用自己。
 * 场景、道具卡不配：展开分镜时镜头只 @ 出场角色，场景图出了也进不了镜头。
 */
const PORTRAIT_PROMPT =
  '的定妆参考图：正面、侧面、背面三视图，全身站姿，同一角色同一服装，纯白背景，平光，角色设计稿风格，线条清晰'
const PORTRAIT_ASPECT = '16:9'

/**
 * 按抽取结果建设定卡：同名卡已存在时只给空设定补上，写过的不覆盖；
 * 新卡按角色 / 场景 / 道具分列，放在来源节点所在分组的右侧。整个操作是一步撤销。
 */
export function applyCast(
  doc: PleinDoc,
  make: NodeFactory,
  sourceId: string,
  entries: CastEntry[],
  /** 默认配音模型（排第一的已启用模型，和执行时自动选的一致）；它声明了音色表才配音色 */
  speech?: SpeechModel,
): CastResult {
  const result: CastResult = {
    created: [],
    portraits: [],
    voiced: [],
    filled: [],
    kept: [],
    ambiguous: [],
  }
  const anchor = doc.ancestors(sourceId).at(-1)?.id ?? sourceId
  const rect = doc.worldRect(anchor)
  if (!rect) return result
  const byName = mentionElements(doc)
  const columns = new Map<string, { x: number; y: number }>()
  let nextX = rect.x + rect.w + 120
  const image = make('plein/image')
  const pickVoice = voicePicker(doc, speech)

  doc.ydoc.transact(() => {
    for (const entry of entries) {
      const type = CAST_NODE_TYPES[entry.kind]
      const same = byName.get(entry.name) ?? []
      if (same.length > 1 || (same.length === 1 && same[0]!.nodeType !== type)) {
        result.ambiguous.push(entry.name)
        continue
      }
      const existing = same[0]
      const voice =
        entry.kind === 'character' && !hasVoice(voiceOf(existing?.params))
          ? pickVoice(entry)
          : undefined
      if (existing) {
        if (String(existing.params?.description ?? '').trim()) result.kept.push(entry.name)
        else {
          setParams(doc, existing.id, { description: entry.description })
          result.filled.push(entry.name)
        }
        if (voice) {
          setParams(doc, existing.id, { voice })
          result.voiced.push(entry.name)
        }
        continue
      }
      const base = make(type)
      if (!base) continue
      // 角色这一列每行左边是定妆图节点、右边是卡片：图的结果连进卡片的参考图
      const size =
        entry.kind === 'character' && image
          ? nodeSize('image', parseAspect(PORTRAIT_ASPECT))
          : undefined
      const lead = size ? size.w + PORTRAIT_GAP : 0
      let col = columns.get(type)
      if (!col) {
        col = { x: nextX, y: rect.y }
        columns.set(type, col)
        nextX += lead + base.w + COLUMN_GAP
      }
      const id = createElement(doc, {
        ...base,
        name: entry.name,
        x: Math.round(col.x + lead),
        y: Math.round(col.y),
        params: { ...base.params, description: entry.description, ...(voice ? { voice } : {}) },
      } as NewElement)
      if (voice) result.voiced.push(entry.name)
      let rowH = base.h
      if (image && size) {
        const portrait = createElement(doc, {
          ...image,
          ...size,
          name: `${entry.name} · 定妆图`,
          x: Math.round(col.x),
          y: Math.round(col.y),
          params: {
            ...image.params,
            prompt: `${entry.name}${PORTRAIT_PROMPT}\n\n${entry.description}`,
            count: 1,
            aspectRatio: PORTRAIT_ASPECT,
          },
        } as NewElement)
        connect(doc, [portrait, 'images'], [id, 'references'])
        result.portraits.push(portrait)
        rowH = Math.max(rowH, size.h)
      }
      col.y += rowH + ROW_GAP
      byName.set(entry.name, [doc.get(id)!])
      result.created.push(id)
    }
  }, doc.origin)
  doc.flush()
  return result
}

export interface SpeechModel {
  /** `平台:模型` */
  ref: string
  voices?: VoicePreset[]
}

/**
 * 按角色的性别、年龄从配音模型的音色表里挑音色：同类音色轮着用，
 * 画布上别的角色卡已经占用的往后排，尽量一人一个声音。看不出性别的不配。
 */
function voicePicker(doc: PleinDoc, speech: SpeechModel | undefined) {
  const provider = speech && parseModelRef(speech.ref)?.provider
  const presets = speech?.voices ?? []
  const used = new Map<string, number>()
  for (const el of doc.elements()) {
    const v = voiceOf(el.params)
    if (el.nodeType === CAST_NODE_TYPES.character && hasVoice(v))
      used.set(v.voiceId, (used.get(v.voiceId) ?? 0) + 1)
  }
  return (entry: CastEntry) => {
    if (!provider || presets.length === 0) return undefined
    const { gender, age } = speakerTraits(entry.name, entry.description)
    if (!gender) return undefined
    const same = presets.filter((p) => p.gender === gender)
    const fit = same.filter((p) => (p.age ?? 'young') === age)
    const pool = fit.length ? fit : same
    if (pool.length === 0) return undefined
    // 用得最少的排前面，同样少的按音色表顺序
    const pick = pool.reduce((a, b) => ((used.get(b.id) ?? 0) < (used.get(a.id) ?? 0) ? b : a))
    used.set(pick.id, (used.get(pick.id) ?? 0) + 1)
    return { provider, voiceId: pick.id }
  }
}

export function describeCast(r: CastResult) {
  const parts = [
    r.created.length &&
      `新建 ${r.created.length} 张设定卡${r.portraits.length ? `，配好 ${r.portraits.length} 个定妆图节点（批量出分镜图时先出它们）` : ''}`,
    r.voiced.length && `给 ${r.voiced.join('、')} 配好音色`,
    r.filled.length && `补上 ${r.filled.join('、')} 的设定`,
    r.kept.length && `${r.kept.join('、')} 已有设定，没有覆盖`,
    r.ambiguous.length && `${r.ambiguous.join('、')} 在画布上重名，没有动`,
  ].filter(Boolean)
  return parts.length ? parts.join('；') : '抽取结果里没有可用的角色或场景'
}
