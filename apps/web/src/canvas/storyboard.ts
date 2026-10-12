import type { Engine } from '@plein/canvas-core'
import {
  type CanvasElement,
  connect,
  createElement,
  currentResult,
  LOCAL_ORIGIN,
  type NewElement,
  setParams,
  updateElement,
} from '@plein/doc'
import {
  diffPlan,
  matchLines,
  type PlanContext,
  type PlanDiff,
  planParams,
  planVersion,
  SEQUENCE_TYPE,
  type SequenceClip,
  type Shot,
  type ShotPlan,
  type ShotRole,
  syncPlan,
  type SyncMode,
  type VoiceRef,
  voiceOf,
} from '@plein/nodes'
import type { Catalog } from '@plein/protocol'
import { findNode, mentionElements, nodeElement } from './nodes'
import { runNode } from './runner'

/** 展开出来的节点记下来源，重新展开、批量运行、同步都按它找 */
export interface ShotSource {
  storyboard: string
  shot: string
  role: ShotRole
  /**
   * 配音节点上次对上的台词在 dialogue 里的序号。只作兜底：
   * 表格增删台词后按内容重新对应（见 matchLines），同步时回写新序号
   */
  line?: number
  /** 展开时的分镜版本与写进节点的参数快照：表格改动后据此算差异 */
  plan?: ShotPlan
  /** 分镜行被删除：节点和产物保留，只是不再跟随计划更新 */
  detached?: boolean
}

const sourceOf = (el: CanvasElement) => el.params?.source as ShotSource | undefined

export function shotsOf(el: CanvasElement | undefined): Shot[] {
  const list = el?.params?.shots
  return Array.isArray(list) ? (list as Shot[]) : []
}

/** 某个分镜表已展开的节点，按镜头 id 分组 */
export function expandedNodes(engine: Engine, boardId: string) {
  const out = new Map<string, CanvasElement[]>()
  for (const el of engine.doc.elements()) {
    const src = sourceOf(el)
    if (el.kind !== 'node' || src?.storyboard !== boardId) continue
    out.set(src.shot, [...(out.get(src.shot) ?? []), el])
  }
  return out
}

const PAD = 24
const HEAD = 40
const GAP = 80
const ROW_GAP = 16
const FRAME_GAP = 48

/* ---------------- 计划：版本、快照、差异、同步 ---------------- */

/** 由分镜推导节点参数要用的外部输入：出场角色的 @ 引用和角色卡上的音色 */
interface PlanEnv {
  /** 当前分镜表的版本 */
  version: string
  mentions(shot: Shot): string
  /** 连平台一起取，换了配音模型才判断得出音色能不能用 */
  voice(character: string): VoiceRef
}

const planEnv = (engine: Engine, boardId: string): PlanEnv => {
  const targets = mentionElements(engine)
  // 重名的角色卡不猜：分镜里只写了名字，指不出是哪一个，跳过并告诉用户，
  // 好过悄悄把另一张卡的设定和参考图送进模型
  const single = (name: string) =>
    targets.get(name)?.length === 1 ? targets.get(name)![0] : undefined
  return {
    version: planVersion(shotsOf(engine.doc.get(boardId))),
    mentions: (shot) =>
      shot.characters
        .filter((c) => single(c))
        .map((c) => `@${c}`)
        .join(' '),
    voice: (character) => voiceOf(single(character)?.params),
  }
}

/** 这次要展开的镜头里，哪些角色名在画布上指不明（重名） */
export function ambiguousCharacters(engine: Engine, boardId: string, shotIds: string[]): string[] {
  const targets = mentionElements(engine)
  const out = new Set<string>()
  for (const shot of shotsOf(engine.doc.get(boardId)).filter((s) => shotIds.includes(s.id)))
    for (const name of shot.characters) if ((targets.get(name)?.length ?? 0) > 1) out.add(name)
  return [...out]
}

/** 节点在计划管的那几个参数上的现值 */
const actualOf = (el: CanvasElement): Record<string, unknown> => ({
  prompt: el.params?.prompt,
  duration: el.params?.duration,
  text: el.params?.text,
  voice: el.params?.voice,
})

/**
 * 一个镜头里各配音节点现在对应哪一句台词；台词被删了的为 undefined。
 * 老节点没记序号，按创建顺序兜底；台词以计划快照为准，没有快照才看节点现值。
 */
function linesOf(list: CanvasElement[], shot: Shot) {
  const speech = list.filter((el) => sourceOf(el)?.role === 'speech')
  return matchLines(
    speech.map((el, i) => {
      const src = sourceOf(el)!
      return {
        id: el.id,
        line: src.line ?? i,
        text: String(src.plan?.params.text ?? el.params?.text ?? ''),
      }
    }),
    shot.dialogue,
  )
}

/** 配音节点的台词删了时为 undefined：节点留着，但没有计划可比，不再参与同步 */
const lineFor = (el: CanvasElement, lines: Map<string, number | undefined>) =>
  sourceOf(el)?.role === 'speech' ? lines.get(el.id) : 0

const contextOf = (el: CanvasElement, env: PlanEnv, shot: Shot, line: number): PlanContext => {
  const src = sourceOf(el)!
  return {
    plan: src.plan,
    version: env.version,
    wanted: planParams(shot, src.role, {
      mentions: env.mentions(shot),
      line,
      voice: env.voice(shot.dialogue[line]?.character ?? ''),
    }),
    actual: actualOf(el),
  }
}

/** 一个已展开节点与当前分镜的差异 */
export interface ShotNodeDiff {
  el: CanvasElement
  role: ShotRole
  line?: number
  /** 节点来源里记录的展开版本 */
  version: string
  diffs: PlanDiff[]
}

/**
 * 分镜表里所有与已展开节点有出入的地方，按镜头 id 分组。
 * 只列真正有差异的字段：计划改过的（stale）和用户在节点上手改的（overridden）。
 */
export function planDiffs(engine: Engine, boardId: string): Map<string, ShotNodeDiff[]> {
  const shots = new Map(shotsOf(engine.doc.get(boardId)).map((s) => [s.id, s]))
  const env = planEnv(engine, boardId)
  const out = new Map<string, ShotNodeDiff[]>()
  for (const [shotId, list] of expandedNodes(engine, boardId)) {
    const shot = shots.get(shotId)
    // 镜头行删了：节点和产物还在，但没有计划可比，差异面板不再提它
    if (!shot) continue
    const lines = linesOf(list, shot)
    for (const el of list) {
      const src = sourceOf(el)
      const line = lineFor(el, lines)
      if (!src || src.detached || line === undefined) continue
      const diffs = diffPlan(src.role, contextOf(el, env, shot, line)).filter(
        (d) => d.stale || d.overridden,
      )
      if (!diffs.length) continue
      out.set(shotId, [
        ...(out.get(shotId) ?? []),
        {
          el,
          role: src.role,
          line: src.role === 'speech' ? line : undefined,
          version: src.plan?.version ?? '',
          diffs,
        },
      ])
    }
  }
  return out
}

export interface SyncResult {
  /** 参数被改动的节点数 */
  nodes: number
  /** 实际写入的字段数 */
  fields: number
  /** 按用户选择保留下来的手改字段数 */
  kept: number
}

/**
 * 把分镜同步到已展开的节点。表格改动后不会自动调用，只有用户点了才写。
 * 只写计划管的那几个参数，节点自己的模型、种子不动；下游也不会回写分镜表。
 */
export function syncExpanded(
  engine: Engine,
  boardId: string,
  shotIds: string[],
  mode: SyncMode,
): SyncResult {
  const shots = new Map(shotsOf(engine.doc.get(boardId)).map((s) => [s.id, s]))
  const env = planEnv(engine, boardId)
  let nodes = 0
  let fields = 0
  let kept = 0
  for (const [shotId, list] of expandedNodes(engine, boardId)) {
    const shot = shots.get(shotId)
    if (!shot || !shotIds.includes(shotId)) continue
    const lines = linesOf(list, shot)
    for (const el of list) {
      const src = sourceOf(el)
      const line = lineFor(el, lines)
      if (!src || src.detached || line === undefined) continue
      const ctx = contextOf(el, env, shot, line)
      kept += diffPlan(src.role, ctx).filter((d) => d.overridden).length
      const sync = syncPlan(src.role, mode, ctx)
      const patch = Object.keys(sync.params)
      // 台词增删后对应到了新位置：序号一并回写，下次兜底才不会错
      const moved = src.role === 'speech' && src.line !== line
      const settled = JSON.stringify(sync.plan) !== JSON.stringify(src.plan ?? null)
      if (!patch.length && !settled && !moved) continue
      const next = { ...src, plan: sync.plan, ...(src.role === 'speech' ? { line } : {}) }
      setParams(engine.doc, el.id, { ...sync.params, source: next })
      if (patch.length) {
        nodes++
        fields += patch.length
      }
    }
  }
  engine.doc.flush()
  return { nodes, fields, kept }
}

/**
 * 分镜行被删：把它的展开节点标记为脱离计划。节点、连线和产物一律留着，
 * 只是不再跟随计划更新；标记和删行在同一次撤销里，按 Ctrl+Z 即可恢复。
 * 不在这里 flush：可能和外层的删行事务一起提交，由调用方决定何时 flush。
 */
export function detachShot(engine: Engine, boardId: string, shotId: string): number {
  let n = 0
  for (const el of expandedNodes(engine, boardId).get(shotId) ?? []) {
    const src = sourceOf(el)
    if (!src || src.detached) continue
    setParams(engine.doc, el.id, { source: { ...src, detached: true } })
    n++
  }
  return n
}

/* ---------------- 展开 ---------------- */

export interface ExpandResult {
  /** 新建或补齐过的 Frame */
  frames: string[]
  /** 新建的节点数 */
  created: number
  /** 已展开过、这次补了节点的镜头数 */
  updated: number
  /** 没动的镜头数 */
  skipped: number
  /** 画布上有重名资产卡、没敢自动引用的角色名；用户需要先改名或写清是哪一个 */
  ambiguous: string[]
  /** 接入序列的结果：画布上只有一个序列才自动接，没有或有多个时不动 */
  sequence: SequenceLink
}

export type SequenceLink = 'linked' | 'none' | 'ambiguous'

/**
 * 展开的镜头接到画布上唯一的序列：视频进「镜头」，首句配音进「对白」，
 * 并把对应关系写进序列参数——不写的话序列按顺序配对白，没有台词的镜头会让后面的对白错位。
 * 已经接过的不重复连，用户在序列里改过的设置不动（只给原先没有对白的镜头补上）。
 */
function linkSequence(
  doc: Engine['doc'],
  shots: Array<{ video: string; speech?: string }>,
): SequenceLink {
  const seqs = [...doc.elements()].filter((e) => e.kind === 'node' && e.nodeType === SEQUENCE_TYPE)
  if (seqs.length !== 1) return seqs.length ? 'ambiguous' : 'none'
  const seq = seqs[0]!
  if (shots.length === 0) return 'linked'
  const into = [...doc.edges()].filter((e) => e.to[0] === seq.id)
  const has = (from: string, port: string) =>
    into.some((e) => e.from[0] === from && e.to[1] === port)
  const clips = [...((seq.params?.clips as SequenceClip[] | undefined) ?? [])]
  for (const s of shots) {
    if (!has(s.video, 'clips')) connect(doc, [s.video, 'video'], [seq.id, 'clips'])
    if (s.speech && !has(s.speech, 'dialogue'))
      connect(doc, [s.speech, 'audio'], [seq.id, 'dialogue'])
    const at = clips.findIndex((c) => c.source === s.video)
    if (at < 0) clips.push({ source: s.video, in: 0, dialogue: s.speech ?? '' })
    else if (s.speech && !clips[at]!.dialogue) clips[at] = { ...clips[at]!, dialogue: s.speech }
  }
  setParams(doc, seq.id, { clips })
  return 'linked'
}

export interface ExpandOptions {
  /**
   * new：只展开没展开过的镜头（默认）。
   * update：已展开的镜头也过一遍，但只补缺的角色和新增的台词，
   * 已有节点的参数一个都不动，手改不会丢。
   */
  mode?: 'new' | 'update'
}

/**
 * 把镜头展开成节点：每个镜头一个 Frame，里面是 分镜图 → 视频，每句台词一个配音节点。
 * 出场角色有同名资产卡时在提示词里 @ 它，配音节点直接用角色卡的音色。
 * 每个新节点都记下当时的分镜版本与参数快照（source.plan），表格改动后据此算差异。
 * 整个展开是一步撤销。返回新建 / 补齐的 Frame 与计数。
 */
export function expandShots(
  engine: Engine,
  boardId: string,
  shotIds: string[],
  catalog: Catalog | null,
  options: ExpandOptions = {},
): ExpandResult {
  const { doc } = engine
  const board = doc.get(boardId)
  const boardRect = doc.worldRect(boardId)
  const imageInfo = findNode(catalog, 'plein/image')
  const videoInfo = findNode(catalog, 'plein/video')
  const speechInfo = findNode(catalog, 'plein/speech')
  const empty: ExpandResult = {
    frames: [],
    created: 0,
    updated: 0,
    skipped: 0,
    ambiguous: [],
    sequence: 'none',
  }
  if (!board || !boardRect || !imageInfo || !videoInfo || !speechInfo) return empty
  const done = expandedNodes(engine, boardId)
  const all = shotsOf(board)
  const picked = all.filter((s) => shotIds.includes(s.id))
  if (picked.length === 0) return empty
  const shots = options.mode === 'update' ? picked : picked.filter((s) => !done.has(s.id))
  if (shots.length === 0) return empty

  // 新 Frame 接在已展开的镜头下面，都放在分镜表右侧
  const x = boardRect.x + boardRect.w + 120
  let y = boardRect.y
  for (const list of done.values()) {
    for (const el of list) {
      const p = el.parentId ? doc.worldRect(el.parentId) : doc.worldRect(el.id)
      if (p) y = Math.max(y, p.y + p.h + FRAME_GAP)
    }
  }

  const env = planEnv(engine, boardId)
  const image = nodeElement(imageInfo)
  const video = nodeElement(videoInfo)
  const speech = nodeElement(speechInfo)
  const frames: string[] = []
  let created = 0
  let updated = 0
  let skipped = 0
  // 按表格顺序记下每个镜头的视频和首句配音，最后统一接到序列
  const linked: Array<{ video: string; speech?: string }> = []
  let sequence: SequenceLink = 'none'
  doc.ydoc.transact(() => {
    for (const shot of shots) {
      const existing = done.get(shot.id) ?? []
      const ctxBase = { mentions: env.mentions(shot) }
      const lineAt = (i: number) => ({
        ...ctxBase,
        line: i,
        voice: env.voice(shot.dialogue[i]?.character ?? ''),
      })
      // 台词序号按 shot.dialogue 的位置记，增删台词后由 matchLines 按内容重新对应
      const lines = shot.dialogue.map((d, i) => ({ ...d, i })).filter((d) => d.line.trim())
      const snapshot = (params: Record<string, unknown>): ShotPlan => ({
        version: env.version,
        params,
        keep: [],
      })
      const source = (role: ShotRole, extra: object = {}): ShotSource => ({
        storyboard: boardId,
        shot: shot.id,
        role,
        ...extra,
      })
      const add = (
        base: Omit<NewElement, 'x' | 'y'>,
        parent: string,
        at: [number, number],
        extra: object,
      ) => {
        created++
        return createElement(doc, {
          ...base,
          parentId: parent,
          x: at[0],
          y: at[1],
          params: { ...base.params, ...extra },
        } as NewElement)
      }

      if (existing.length === 0) {
        const w = PAD * 2 + image.w + GAP + video.w
        const h = HEAD + image.h + PAD + lines.length * (speech.h + ROW_GAP)
        const frame = createElement(doc, {
          kind: 'frame',
          name: `镜头 ${String(shot.no).padStart(2, '0')} · ${shot.shotSize}`,
          x: Math.round(x),
          y: Math.round(y),
          w,
          h,
        })
        frames.push(frame)
        y += h + FRAME_GAP
        const imageParams = planParams(shot, 'image', ctxBase)
        const img = add(image, frame, [PAD, HEAD], {
          source: source('image', { plan: snapshot(imageParams) }),
          ...imageParams,
        })
        const videoParams = planParams(shot, 'video', ctxBase)
        // 镜头视频用图生视频：分镜图作首帧
        const vid = add(video, frame, [PAD + image.w + GAP, HEAD], {
          source: source('video', { plan: snapshot(videoParams) }),
          ...videoParams,
          mode: 'image',
        })
        connect(doc, [img, 'images'], [vid, 'images'])
        const spoken: string[] = []
        lines.forEach((d, i) => {
          const params = planParams(shot, 'speech', lineAt(d.i))
          const id = add(
            { ...speech, name: `台词 · ${d.character || '旁白'}` },
            frame,
            [PAD, HEAD + image.h + PAD + i * (speech.h + ROW_GAP)],
            {
              source: source('speech', { line: d.i, plan: snapshot(params) }),
              ...params,
            },
          )
          spoken.push(id)
        })
        linked.push({ video: vid, speech: spoken[0] })
        continue
      }

      // 更新：只补缺的角色和新增的台词，已有节点一个参数都不动
      const frame = existing[0]!.parentId ?? undefined
      if (!frame) {
        skipped++
        continue
      }
      const before = created
      const byRole = (role: ShotRole) => existing.filter((el) => sourceOf(el)?.role === role)
      const hasVideo = byRole('video').length > 0
      const speechNodes = byRole('speech')
      // 按内容对应已有的配音节点，对不上的台词才补节点
      const spokenLines = new Set(linesOf(speechNodes, shot).values())
      const inside = [...doc.elements()].filter((e) => e.parentId === frame)
      let cursor = inside.reduce((t, e) => Math.max(t, e.y + e.h), 0) + ROW_GAP
      const grow = () => {
        const rect = doc.get(frame)
        if (rect && cursor > rect.h) updateElement(doc, frame, { h: Math.round(cursor + PAD) })
      }
      const addMissing = (base: Omit<NewElement, 'x' | 'y'>, params: object, src: ShotSource) => {
        const id = add(base, frame, [PAD, Math.round(cursor)], { source: src, ...params })
        cursor += base.h + ROW_GAP
        grow()
        return id
      }
      let imgId = byRole('image')[0]?.id
      if (!imgId) {
        const params = planParams(shot, 'image', ctxBase)
        imgId = addMissing(image, params, source('image', { plan: snapshot(params) }))
        const vid = byRole('video')[0]
        if (vid) {
          connect(doc, [imgId, 'images'], [vid.id, 'images'])
          setParams(doc, vid.id, { mode: 'image' })
        }
      }
      let vidId = byRole('video')[0]?.id
      if (!hasVideo) {
        const params = planParams(shot, 'video', ctxBase)
        const vid = addMissing(
          video,
          { ...params, mode: 'image' },
          source('video', { plan: snapshot(params) }),
        )
        // 补出来的视频也要接上分镜图，否则批量生成视频时会一直说「还没有分镜图」
        connect(doc, [imgId, 'images'], [vid, 'images'])
        vidId = vid
      }
      let firstSpeech = speechNodes[0]?.id
      lines.forEach((d) => {
        if (spokenLines.has(d.i)) return
        const params = planParams(shot, 'speech', lineAt(d.i))
        const id = addMissing(
          { ...speech, name: `台词 · ${d.character || '旁白'}` },
          params,
          source('speech', { line: d.i, plan: snapshot(params) }),
        )
        firstSpeech ??= id
      })
      if (vidId) linked.push({ video: vidId, speech: firstSpeech })
      if (created > before) updated++
      else skipped++
    }
    sequence = linkSequence(doc, linked)
  }, LOCAL_ORIGIN)
  doc.flush()
  return {
    frames,
    created,
    updated,
    skipped,
    ambiguous: ambiguousCharacters(engine, boardId, shotIds),
    sequence,
  }
}

/* ---------------- 批量运行 ---------------- */

export interface BatchResult {
  started: number
  skipped: number
  /** 跳过原因 → 数量，把「为什么没跑」说清楚 */
  reasons: Record<string, number>
}

/**
 * 批量运行展开出来的某类节点。视频要等分镜图有结果，没有的跳过；
 * 配音没台词、正在跑的也跳过并计数。返回实际发起数和跳过原因。
 */
export function runExpanded(
  engine: Engine,
  boardId: string,
  shotIds: string[],
  role: ShotRole,
  run: (id: string) => void = (id) => void runNode(id),
): BatchResult {
  const groups = expandedNodes(engine, boardId)
  const shots = new Map(shotsOf(engine.doc.get(boardId)).map((s) => [s.id, s]))
  const reasons: Record<string, number> = {}
  let started = 0
  let skipped = 0
  const skip = (reason: string) => {
    reasons[reason] = (reasons[reason] ?? 0) + 1
    skipped++
  }
  for (const id of shotIds) {
    const nodes = (groups.get(id) ?? []).filter((el) => sourceOf(el)?.role === role)
    if (nodes.length === 0) {
      const shot = shots.get(id)
      const spoken = shot?.dialogue.some((d) => d.line.trim()) ?? false
      skip(role === 'speech' && !spoken ? '没有台词' : '还没展开成节点')
      continue
    }
    for (const el of nodes) {
      if (el.run?.status === 'running' || el.run?.status === 'queued') {
        skip('正在运行')
        continue
      }
      if (role === 'video') {
        const edge = [...engine.doc.edges()].find((e) => e.to[0] === el.id && e.to[1] === 'images')
        const up = edge && engine.doc.get(edge.from[0])
        if (!up || !currentResult(up)) {
          skip('还没有分镜图')
          continue
        }
      }
      if (role === 'speech' && !String(el.params?.text ?? '').trim()) {
        skip('没有台词')
        continue
      }
      run(el.id)
      started++
    }
  }
  return { started, skipped, reasons }
}
