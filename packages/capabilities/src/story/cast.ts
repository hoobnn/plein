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
  libraryKind,
  orderedImages,
  parseCast,
  speakerTraits,
  type VoiceRef,
  voiceOf,
} from '@plein/nodes'
import { parseModelRef, type VoicePreset } from '@plein/plugin-sdk'
import { addCardWithRefs, type CardRef, REF_COL_GAP, REF_W, refsHeight } from './library'
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
  /** 给新卡配的参考图节点（角色定妆图、场景图、道具图）：只建不跑，批量出分镜图时先跑 @ 到的那些 */
  portraits: string[]
  /** 照资产库条目建的卡（设定、参考图、音色用条目的） */
  fromLibrary: string[]
  /** 按性别、年龄配上音色的角色卡 */
  voiced: string[]
  /** 原来设定为空、这次补上的卡 */
  filled: string[]
  /** 已经写了设定的同名卡：不覆盖用户写的 */
  kept: string[]
  /** 画布上有重名、或同名的是别的类型：指不明，不动 */
  ambiguous: string[]
  /** 资产库里有好几条同名的、指不明：照常新建，没有套用 */
  libraryAmbiguous: string[]
}

const COLUMN_GAP = 40
const ROW_GAP = 24
const PORTRAIT_GAP = 40

/**
 * 新卡左边配的参考图节点：角色三视图定妆照、场景空镜、道具单品图，设定原样写进提示词。
 * 不在提示词里 @ 卡片自己：卡片的参考图就是这张图的结果，@ 了等于自己引用自己。
 * 镜头 @ 到这张卡时，调度先出这张图，再带着它出分镜图。
 */
const REFERENCE_IMAGES: Record<
  CastEntry['kind'],
  { suffix: string; prompt: string; aspect: string }
> = {
  character: {
    suffix: '定妆图',
    prompt:
      '的定妆参考图：正面、侧面、背面三视图，全身站姿，同一角色同一服装，纯白背景，平光，角色设计稿风格，线条清晰',
    aspect: '16:9',
  },
  scene: {
    suffix: '场景图',
    prompt:
      '的场景设定图：空镜，画面里不出现人物，交代空间结构、陈设、光线和氛围，电影感，竖屏构图',
    aspect: '9:16',
  },
  prop: {
    suffix: '道具图',
    prompt: '的道具设定图：单个物件居中，完整入画，纯白背景，产品摄影平光，材质和细节清晰',
    aspect: '1:1',
  },
}

/** 资产库条目里套用到设定卡上要用的部分（与 protocol 的 LibraryItem 同构，这里不依赖它） */
export interface CastLibraryItem {
  id: string
  kind: string
  name: string
  description: string
  voice: VoiceRef | null
  /** 角色档案（时期 / 服饰 / 表情），原样写进卡片 */
  profile?: unknown
  images: Array<{ slot: string; assetId: string }>
  projectId: string | null
}

export interface CastOptions {
  /** 默认配音模型（排第一的已启用模型，和执行时自动选的一致）；它声明了音色表才配音色 */
  speech?: SpeechModel
  /**
   * 资产库：抽取出的名字在资产库里有同类条目时，直接用条目的设定、参考图和音色建卡，
   * 不再配定妆图——跨项目复用同一个角色，形象一致也省一次出图
   */
  library?: {
    items: readonly CastLibraryItem[]
    /** 当前项目：同名条目优先用本项目的 */
    projectId: string | null
    /** 参考图尺寸，排版用；拿不到按方图排 */
    assetMeta?(id: string): { width?: number; height?: number } | undefined
  }
}

/**
 * 按抽取结果建设定卡：同名卡已存在时只给空设定补上，写过的不覆盖；
 * 资产库里有同名同类条目时照条目建卡（设定、参考图、音色都用条目的）；
 * 其余新卡按角色 / 场景 / 道具分列，放在来源节点所在分组的右侧，每张卡左边配一个参考图节点。
 * 整个操作是一步撤销。
 */
export function applyCast(
  doc: PleinDoc,
  make: NodeFactory,
  sourceId: string,
  entries: CastEntry[],
  options: CastOptions = {},
): CastResult {
  const result: CastResult = {
    created: [],
    portraits: [],
    fromLibrary: [],
    voiced: [],
    filled: [],
    kept: [],
    ambiguous: [],
    libraryAmbiguous: [],
  }
  const anchor = doc.ancestors(sourceId).at(-1)?.id ?? sourceId
  const rect = doc.worldRect(anchor)
  if (!rect) return result
  const byName = mentionElements(doc)
  const image = make('plein/image')
  const refSize = (kind: CastEntry['kind']) =>
    image ? nodeSize('image', parseAspect(REFERENCE_IMAGES[kind].aspect)) : undefined
  const pickVoice = voicePicker(doc, options.speech)
  const fromLibrary = libraryMatcher(options.library, result)

  // 先定下每张卡怎么建，各列左边留多宽：新卡放参考图节点，套用资产库的放条目里的参考图
  const plans = entries.map((entry) => {
    const type = CAST_NODE_TYPES[entry.kind]
    const same = byName.get(entry.name) ?? []
    if (same.length > 1 || (same.length === 1 && same[0]!.nodeType !== type))
      return { entry, type, skip: 'ambiguous' as const }
    if (same[0]) return { entry, type, existing: same[0] }
    const item = fromLibrary(entry)
    const refs = item ? libraryRefs(item, options.library?.assetMeta) : []
    return { entry, type, item, refs }
  })
  const leads = new Map<string, number>()
  for (const p of plans) {
    if (p.skip || p.existing) continue
    const lead = p.item
      ? p.refs!.length
        ? REF_W + REF_COL_GAP
        : 0
      : image
        ? refSize(p.entry.kind)!.w + PORTRAIT_GAP
        : 0
    leads.set(p.type, Math.max(leads.get(p.type) ?? 0, lead))
  }

  const columns = new Map<string, { x: number; y: number }>()
  let nextX = rect.x + rect.w + 120
  doc.ydoc.transact(() => {
    for (const plan of plans) {
      const { entry, type } = plan
      if (plan.skip) {
        result.ambiguous.push(entry.name)
        continue
      }
      const existing = plan.existing
      if (existing) {
        if (String(existing.params?.description ?? '').trim()) result.kept.push(entry.name)
        else {
          setParams(doc, existing.id, { description: entry.description })
          result.filled.push(entry.name)
        }
        if (entry.kind === 'character' && !hasVoice(voiceOf(existing.params))) {
          const voice = pickVoice(entry)
          if (voice) {
            setParams(doc, existing.id, { voice })
            result.voiced.push(entry.name)
          }
        }
        continue
      }
      const base = make(type)
      if (!base) continue
      const lead = leads.get(type) ?? 0
      let col = columns.get(type)
      if (!col) {
        col = { x: nextX, y: rect.y }
        columns.set(type, col)
        nextX += lead + base.w + COLUMN_GAP
      }
      const item = plan.item
      const description = item?.description.trim() || entry.description
      const owned = item?.voice && hasVoice(item.voice) ? item.voice : undefined
      const voice =
        entry.kind === 'character' ? (owned ?? pickVoice({ ...entry, description })) : undefined
      const card = {
        ...base,
        name: entry.name,
        params: {
          ...base.params,
          description,
          ...(voice ? { voice } : {}),
          ...(item?.profile ? { profile: item.profile } : {}),
          ...(item ? { libraryId: item.id } : {}),
        },
      }
      let id: string
      let rowH = base.h
      if (item) {
        // 参考图一列以卡片竖直居中，比卡片高时把卡片往下挪，不压住上一行
        const refsH = refsHeight(plan.refs!)
        const top = Math.max(0, (refsH - base.h) / 2)
        id = addCardWithRefs(doc, card, { x: col.x + lead, y: col.y + top }, plan.refs!).id
        rowH = Math.max(base.h, refsH)
        result.fromLibrary.push(entry.name)
      } else {
        id = createElement(doc, {
          ...card,
          x: Math.round(col.x + lead),
          y: Math.round(col.y),
        } as NewElement)
        const size = refSize(entry.kind)
        if (image && size) {
          // 卡片左边是参考图节点：图的结果连进卡片的参考图
          const spec = REFERENCE_IMAGES[entry.kind]
          const ref = createElement(doc, {
            ...image,
            ...size,
            name: `${entry.name} · ${spec.suffix}`,
            x: Math.round(col.x + lead - PORTRAIT_GAP - size.w),
            y: Math.round(col.y),
            params: {
              ...image.params,
              prompt: `${entry.name}${spec.prompt}\n\n${entry.description}`,
              count: 1,
              aspectRatio: spec.aspect,
            },
          } as NewElement)
          connect(doc, [ref, 'images'], [id, 'references'])
          result.portraits.push(ref)
          rowH = Math.max(rowH, size.h)
        }
      }
      if (voice && !owned) result.voiced.push(entry.name)
      col.y += rowH + ROW_GAP
      byName.set(entry.name, [doc.get(id)!])
      result.created.push(id)
    }
  }, doc.origin)
  doc.flush()
  return result
}

/**
 * 抽取出的名字对应哪条资产库条目：同类同名、本项目的优先；
 * 本项目没有、全部里只有一条时用它，有好几条指不明时不套用，记到 libraryAmbiguous 里
 */
function libraryMatcher(library: CastOptions['library'], result: CastResult) {
  return (entry: CastEntry) => {
    const same = (library?.items ?? []).filter(
      (i) => i.kind === entry.kind && i.name === entry.name,
    )
    if (same.length === 0) return undefined
    const own = same.filter((i) => i.projectId && i.projectId === library?.projectId)
    const pick =
      own.length === 1 ? own[0] : own.length === 0 && same.length === 1 ? same[0] : undefined
    if (!pick) result.libraryAmbiguous.push(entry.name)
    return pick
  }
}

/** 条目的参考图按槽位顺序排好，带上尺寸 */
function libraryRefs(
  item: CastLibraryItem,
  meta: ((id: string) => { width?: number; height?: number } | undefined) | undefined,
): CardRef[] {
  const kind = libraryKind(item.kind)
  if (!kind) return []
  return orderedImages(kind, item.images).map((i) => {
    const m = meta?.(i.assetId)
    return {
      kind: 'image' as const,
      assetId: i.assetId,
      name: `${item.name} · 参考图`,
      width: m?.width,
      height: m?.height,
    }
  })
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
      `新建 ${r.created.length} 张设定卡${r.portraits.length ? `，配好 ${r.portraits.length} 个定妆图 / 场景图 / 道具图节点（批量出分镜图时先出它们）` : ''}`,
    r.fromLibrary.length && `${r.fromLibrary.join('、')} 用了资产库里的设定和参考图`,
    r.voiced.length && `给 ${r.voiced.join('、')} 配好音色`,
    r.filled.length && `补上 ${r.filled.join('、')} 的设定`,
    r.kept.length && `${r.kept.join('、')} 已有设定，没有覆盖`,
    r.ambiguous.length && `${r.ambiguous.join('、')} 在画布上重名，没有动`,
    r.libraryAmbiguous.length &&
      `资产库里有多个「${r.libraryAmbiguous.join('」「')}」，没有自动套用，可以从资产库手动放`,
  ].filter(Boolean)
  return parts.length ? parts.join('；') : '抽取结果里没有可用的角色或场景'
}
