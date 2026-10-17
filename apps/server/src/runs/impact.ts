import { expandedNodes, planDiffs, type ShotSource, shotsOf } from '@plein/capabilities'
import {
  type CanvasElement,
  createDoc,
  currentResult,
  type PleinDoc,
  SYSTEM_ORIGIN,
} from '@plein/doc'
import {
  arrangeSequence,
  clipLength,
  clipLines,
  LINE_GAP,
  SEQUENCE_TYPE,
  type SequenceParams,
  STORYBOARD_TYPE,
} from '@plein/nodes'
import type {
  ImpactCause,
  ImpactDecision,
  ImpactNode,
  ImpactReport,
  ImpactSuggestion,
  KeepResults,
  PreparedInput,
  SequenceIssue,
} from '@plein/protocol'
import { and, eq } from 'drizzle-orm'
import { newId } from '../ids'
import { NodeRunError } from '../plugins/host'
import type { DB } from '../storage/db'
import { assets } from '../storage/schema'
import { type Inspection, type NodeRuns, runGraph } from './runs'
import type { DecisionRow, JobRow } from './store'

/**
 * 影响分析：修改之后哪些结果过期、为什么、建议怎么处理。只读，不调用付费平台。
 * 过期只表示需要审查：保留、只改配音字幕、勾选重做都由用户决定，这里不改任何结果和缓存。
 */

/** 一个有结果的运行节点在这次分析里的状态 */
interface NodeState {
  el: CanvasElement
  now: Inspection
  /** 产生当前结果的那次任务；早于任务记录的结果没有 */
  job?: JobRow
  fresh: boolean
}

const SPEECH = 'audio.speech'

/** 展开节点记下的镜头来源 */
const sourceOf = (el: CanvasElement) => el.params?.source as ShotSource | undefined

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

function parseInput(raw: string | null | undefined): PreparedInput | undefined {
  if (!raw) return undefined
  try {
    return JSON.parse(raw) as PreparedInput
  } catch {
    return undefined
  }
}

/**
 * 对比产生当前结果时冻结的实际输入与现在的，说清楚哪里变了。
 * @ 引用的参考图归到 reference，其余连线送来的值按上游元素归到 input
 */
function diffInputs(
  before: PreparedInput | undefined,
  now: PreparedInput,
  names: { element(id: string): string; param(key: string): string },
): ImpactCause[] {
  if (!before) return [{ kind: 'unknown', label: '这个结果早于输入记录，说不出具体改了什么' }]
  const out: ImpactCause[] = []
  if ((before.model?.ref ?? '') !== (now.model?.ref ?? ''))
    out.push({
      kind: 'model',
      label: `模型从「${before.model?.title ?? '自动'}」换成「${now.model?.title ?? '自动'}」`,
    })
  if ((before.prompt ?? '') !== (now.prompt ?? ''))
    out.push({ kind: 'prompt', label: now.capability === SPEECH ? '台词改了' : '提示词改了' })
  for (const key of new Set([...Object.keys(before.params), ...Object.keys(now.params)])) {
    if (sameJson(before.params[key], now.params[key])) continue
    out.push({ kind: 'params', key, label: `参数「${names.param(key)}」改了` })
  }
  const old = new Map(before.refs.map((r) => [r.elementId, r]))
  for (const r of now.refs) {
    const o = old.get(r.elementId)
    old.delete(r.elementId)
    if (!o) out.push({ kind: 'reference', key: r.elementId, label: `新引用了「${r.name}」` })
    else if (!sameJson(o.sent, r.sent))
      out.push({ kind: 'reference', key: r.elementId, label: `「${r.name}」的参考图换了` })
  }
  for (const r of old.values())
    out.push({ kind: 'reference', key: r.elementId, label: `不再引用「${r.name}」` })
  // 连线送来的值：按上游元素比较，@ 引用带来的参考图上面已经算过
  // @ 引用的参考图带的是参考图元素的来源，按资产和被引用元素两头排除
  const refIds = new Set([...before.refs, ...now.refs].map((r) => r.elementId))
  const refAssets = new Set(
    [...before.refs, ...now.refs].flatMap((r) => [...r.available, ...r.sent]),
  )
  const bySource = (input: PreparedInput) => {
    const m = new Map<string, string[]>()
    for (const [port, values] of Object.entries(input.inputs))
      for (const v of values) {
        if ((v.source && refIds.has(v.source)) || (v.assetId && refAssets.has(v.assetId))) continue
        const k = v.source ?? `port:${port}`
        m.set(k, [...(m.get(k) ?? []), v.assetId ?? v.text ?? ''])
      }
    return m
  }
  const a = bySource(before)
  const b = bySource(now)
  for (const k of new Set([...a.keys(), ...b.keys()])) {
    if (sameJson(a.get(k), b.get(k))) continue
    const port = k.startsWith('port:') ? k.slice(5) : undefined
    out.push({
      kind: 'input',
      key: port ?? k,
      label: port ? `输入「${port}」变了` : `上游「${names.element(k)}」的结果换了`,
    })
  }
  if (!sameJson(before.voice, now.voice)) out.push({ kind: 'voice', label: '音色换了' })
  if (!out.length) out.push({ kind: 'unknown', label: '输入有变化（摘要里没有记录的部分）' })
  return out
}

/** 默认建议，对应路线图的修改规则 */
function suggestOf(
  impact: ImpactNode['impact'],
  el: CanvasElement,
  state: NodeState | undefined,
  causes: ImpactCause[],
): ImpactSuggestion {
  const output = state?.now.input.capability ?? ''
  const isVideo = output.startsWith('video.')
  if (impact === 'related') return 'keep'
  if (impact === 'indirect') return isVideo ? 'keep' : 'review'
  // 只是分镜表改了、节点还没同步：先看差异
  if (causes.every((c) => c.kind === 'plan')) return 'sync'
  // 换了视频候选、改了台词之后的序列：先检查时长和入出点再导出
  if (el.nodeType === SEQUENCE_TYPE) return 'review'
  // 角色参考图换了：审查引用它的镜头图，不直接重做
  if (output.startsWith('image.') && causes.every((c) => c.kind === 'reference')) return 'review'
  return 'rerun'
}

const decisionOf = (row: DecisionRow): ImpactDecision => ({
  id: row.id,
  nodeId: row.node_id,
  resultId: row.result_id,
  inputHash: row.input_hash,
  causes: JSON.parse(row.causes) as ImpactCause[],
  ...(row.note ? { note: row.note } : {}),
  createdAt: row.created_at,
  ...(row.revoked_at ? { revokedAt: row.revoked_at } : {}),
})

/** 每个节点最近一条没撤销的保留决定 */
function activeDecisions(rows: DecisionRow[]) {
  const out = new Map<string, DecisionRow>()
  for (const d of rows) if (!d.revoked_at && !out.has(d.node_id)) out.set(d.node_id, d)
  return out
}

export class ImpactAnalyzer {
  constructor(
    private db: DB,
    private runs: NodeRuns,
  ) {}

  /** 读画布并分析；文档只读，不写结果、不改缓存 */
  async analyze(canvasId: string, ownerId: string): Promise<ImpactReport> {
    const lease = this.runs.rooms.acquire(canvasId)
    const doc = createDoc(lease.room.doc, { origin: SYSTEM_ORIGIN })
    try {
      return await this.report(doc, canvasId, ownerId)
    } finally {
      doc.destroy()
      lease.release()
    }
  }

  /** 分析调用方给的文档（如套用了修改方案的副本）；文档的生命周期由调用方负责 */
  analyzeDoc(doc: PleinDoc, canvasId: string, ownerId: string): Promise<ImpactReport> {
    return this.report(doc, canvasId, ownerId)
  }

  /**
   * 保留过期结果：记下当时的输入哈希、采用的结果和过期原因。
   * 不改缓存键，整组运行照样认为它过期；输入在用户看过之后又变了就不记，返回变了的节点
   */
  async keep(
    canvasId: string,
    ownerId: string,
    body: KeepResults,
  ): Promise<{ decisions: ImpactDecision[] } | { changed: string[] }> {
    const lease = this.runs.rooms.acquire(canvasId)
    const doc = createDoc(lease.room.doc, { origin: SYSTEM_ORIGIN })
    try {
      const signal = new AbortController().signal
      const rows: DecisionRow[] = []
      const changed: string[] = []
      for (const { nodeId, inputHash } of body.nodes) {
        const el = doc.get(nodeId)
        const cur = el && currentResult(el)
        if (!el || !cur || !this.runs.isJobNode(el))
          throw new NodeRunError('not_found', '节点不存在或还没有结果')
        const state = await this.state(doc, el, ownerId, signal)
        if (state.now.input.inputHash !== inputHash) {
          changed.push(nodeId)
          continue
        }
        rows.push({
          id: newId('kpd'),
          owner_id: ownerId,
          canvas_id: canvasId,
          node_id: nodeId,
          result_id: cur.id,
          input_hash: inputHash,
          causes: JSON.stringify(state.fresh ? [] : this.causes(doc, state)),
          note: body.note ?? null,
          created_at: Date.now(),
          revoked_at: null,
        })
      }
      if (changed.length) return { changed }
      for (const r of rows) this.runs.store.insertDecision(r)
      return { decisions: rows.map(decisionOf) }
    } finally {
      doc.destroy()
      lease.release()
    }
  }

  private async state(
    doc: PleinDoc,
    el: CanvasElement,
    ownerId: string,
    signal: AbortSignal,
  ): Promise<NodeState> {
    const now = await this.runs.inspect(doc, el, ownerId, signal)
    const r = currentResult(el)
    const job = r ? this.runs.store.get(r.runId) : undefined
    return { el, now, job, fresh: this.runs.resultMatches(el, now) }
  }

  private causes(doc: PleinDoc, s: NodeState): ImpactCause[] {
    return diffInputs(parseInput(s.job?.input), s.now.input, {
      element: (id) => doc.get(id)?.name ?? '上游',
      param: (key) => this.runs.paramTitle(s.el.nodeType ?? '', key),
    })
  }

  private async report(doc: PleinDoc, canvasId: string, ownerId: string): Promise<ImpactReport> {
    const signal = new AbortController().signal
    const states = new Map<string, NodeState>()
    for (const el of doc.elements()) {
      if (!this.runs.isJobNode(el) || !el.results?.length) continue
      if (this.runs.isRunning(canvasId, el.id)) continue
      states.set(el.id, await this.state(doc, el, ownerId, signal))
    }

    const nodes = new Map<string, ImpactNode>()
    const shotOf = (el: CanvasElement): ImpactNode['shot'] => {
      const src = sourceOf(el)
      if (!src || src.detached) return undefined
      const no = shotsOf(doc.get(src.storyboard)).find((s) => s.id === src.shot)?.no
      return { storyboard: src.storyboard, id: src.shot, role: src.role, ...(no ? { no } : {}) }
    }
    const add = (el: CanvasElement, impact: ImpactNode['impact'], causes: ImpactCause[]) => {
      const prev = nodes.get(el.id)
      if (prev) {
        prev.causes.push(...causes)
        return prev
      }
      const state = states.get(el.id)
      const cur = currentResult(el)
      const value = cur?.value
      const node: ImpactNode = {
        nodeId: el.id,
        name: el.name ?? state?.now.input.nodeType ?? el.nodeType ?? '节点',
        nodeType: el.nodeType ?? '',
        impact,
        causes: [...causes],
        suggest: 'rerun',
        ...(cur
          ? {
              current: {
                resultId: cur.id,
                type: value!.type,
                ...('assetId' in value! ? { assetId: value.assetId } : {}),
              },
            }
          : {}),
      }
      const shot = shotOf(el)
      if (shot) node.shot = shot
      nodes.set(el.id, node)
      return node
    }

    // 直接受影响：结果不是按现在的输入生成的
    for (const s of states.values()) if (!s.fresh) add(s.el, 'direct', this.causes(doc, s))

    // 分镜表改了、还没同步到展开节点的字段（只算计划改的，节点上手改过的不算）
    const plan: ImpactReport['plan'] = []
    for (const board of doc.elements()) {
      if (board.nodeType !== STORYBOARD_TYPE) continue
      const shots = new Map(shotsOf(board).map((s) => [s.id, s]))
      for (const [shotId, list] of planDiffs(doc, board.id)) {
        let fields = 0
        for (const d of list) {
          const stale = d.diffs.filter((f) => f.stale && !f.overridden)
          if (!stale.length) continue
          fields += stale.length
          add(
            d.el,
            'direct',
            stale.map((f) => ({
              kind: 'plan',
              key: f.key,
              label: `分镜表的「${PLAN_LABEL[f.key] ?? f.key}」改了，节点还没同步`,
            })),
          )
        }
        if (fields)
          plan.push({ storyboard: board.id, shot: shotId, no: shots.get(shotId)?.no ?? 0, fields })
      }
    }

    // 间接受影响：直接受影响节点的下游里已有结果的
    const graph = runGraph(doc)
    for (const id of [...nodes.keys()]) {
      for (const d of graph.descendants(id)) {
        if (nodes.has(d) || !states.has(d)) continue
        add(states.get(d)!.el, 'indirect', [
          { kind: 'input', key: id, label: `上游「${nodes.get(id)!.name}」要重做` },
        ])
      }
    }

    // 台词改了：同一镜头的画面列出来，重不重做由用户选
    for (const n of [...nodes.values()]) {
      if (n.impact !== 'direct' || n.shot?.role !== 'speech') continue
      if (!n.causes.some((c) => c.kind === 'prompt' || (c.kind === 'plan' && c.key === 'text')))
        continue
      for (const el of expandedNodes(doc, n.shot.storyboard).get(n.shot.id) ?? []) {
        const role = sourceOf(el)?.role
        if ((role === 'image' || role === 'video') && !nodes.has(el.id) && states.has(el.id))
          add(el, 'related', [{ kind: 'prompt', label: '台词改了，画面是否重做由你决定' }])
      }
    }

    const decisions = this.runs.store.decisions(canvasId)
    const active = activeDecisions(decisions)
    for (const n of nodes.values()) {
      const state = states.get(n.nodeId)
      n.suggest = suggestOf(n.impact, state?.el ?? doc.get(n.nodeId)!, state, n.causes)
      if (!state) continue
      n.inputHash = state.now.input.inputHash
      if (n.impact === 'direct' && !state.fresh) {
        const hit = this.runs.cachedCandidate(state.el, state.now)
        if (hit) n.cached = { resultId: hit }
      }
      const d = active.get(n.nodeId)
      if (d && d.result_id === n.current?.resultId && d.input_hash === state.now.input.inputHash)
        n.kept = decisionOf(d)
      const price = this.runs.priceOf(state.now.input.model)
      if (price) n.price = price
    }

    const list = [...nodes.values()].sort(byShot)
    return {
      nodes: list,
      plan: plan.sort((a, b) => a.no - b.no),
      sequence: await this.sequenceIssues(doc, ownerId, states, nodes),
      summary: summarize(list),
      decisions: decisions.slice(0, 20).map(decisionOf),
    }
  }

  /**
   * 序列检查：换了视频候选（来源素材和上次导出时不同）或镜头、台词受影响的那几段，
   * 还没导出过的序列查全部。原入出点保留不动，只把越界、对白溢出、转场放不下和手写字幕提示出来
   */
  private async sequenceIssues(
    doc: PleinDoc,
    ownerId: string,
    states: Map<string, NodeState>,
    affected: Map<string, ImpactNode>,
  ): Promise<SequenceIssue[]> {
    const out: SequenceIssue[] = []
    const duration = (assetId: string) =>
      this.db
        .select({ duration: assets.duration })
        .from(assets)
        .where(and(eq(assets.owner_id, ownerId), eq(assets.id, assetId)))
        .get()?.duration ?? undefined
    const signal = new AbortController().signal
    for (const el of doc.elements()) {
      if (el.nodeType !== SEQUENCE_TYPE || !this.runs.isJobNode(el)) continue
      const seqId = el.id
      const s = states.get(seqId) ?? (await this.state(doc, el, ownerId, signal))
      const params = s.now.params as SequenceParams
      const arranged = arrangeSequence(params, s.now.inputs)
      // 上次导出时每段用的素材：和现在不同说明换了候选
      const before = new Map(
        (parseInput(s.job?.input)?.inputs.clips ?? []).map((v) => [v.source, v.assetId]),
      )
      const lengths = arranged.map((c) => {
        const d = duration(c.clip.assetId)
        return d === undefined ? undefined : clipLength(c, d)
      })
      arranged.forEach((c, i) => {
        if (!c.source) return
        const lines = clipLines(c)
        const swapped = !s.job || before.get(c.source) !== c.clip.assetId
        const touched = [c.source, ...lines.map((l) => l.source)].some(
          (id) => id !== undefined && affected.has(id),
        )
        if (!swapped && !touched) return
        const shotId = sourceOf(doc.get(c.source) ?? ({} as CanvasElement))?.shot
        const issue = (kind: SequenceIssue['kind'], message: string) =>
          out.push({
            sequenceId: seqId,
            source: c.source!,
            ...(shotId ? { shotId } : {}),
            kind,
            message,
          })
        const d = duration(c.clip.assetId)
        const len = lengths[i]
        if (d !== undefined) {
          if (c.in >= d - 0.04)
            issue('out_of_range', `入点 ${sec(c.in)}超出素材时长 ${sec(d)}，这段会是空的`)
          else if (c.out !== undefined && c.out > d + 0.04)
            issue('out_of_range', `出点 ${sec(c.out)}超出素材时长 ${sec(d)}，只播到素材结尾`)
        }
        if (len !== undefined && lines.length) {
          const spoken = lines.map((l) => duration(l.assetId))
          if (spoken.every((v) => v !== undefined)) {
            const total =
              c.lineDelay + spoken.reduce((t, v) => t + v!, 0) + LINE_GAP * (lines.length - 1)
            if (total > len + 0.05)
              issue(
                'dialogue_overflow',
                `对白约 ${sec(total)}，比这段镜头的 ${sec(len)}长，会延续到下一段或被截掉`,
              )
          }
        }
        const name = c.transition ?? params.transition
        const prev = lengths[i - 1]
        if (i > 0 && name !== '无' && len !== undefined && prev !== undefined) {
          const want = c.transitionDuration ?? params.transitionDuration
          const room = name === '淡入淡出' ? Math.min(prev, len) : Math.min(prev, len) / 2
          if (want > room + 0.01)
            issue('transition', `转场 ${sec(want)}超过这里可用的长度，会缩短到 ${sec(room)}`)
        }
        const spokenChanged = lines.some(
          (l) => l.source && affected.get(l.source)?.impact === 'direct',
        )
        if (c.subtitle?.trim() && spokenChanged)
          issue('subtitle', '这段字幕是手写的，台词改了不会跟着变')
      })
    }
    return out
  }
}

const PLAN_LABEL: Record<string, string> = {
  prompt: '提示词',
  duration: '时长',
  text: '台词',
  voice: '音色',
}

const sec = (v: number) => `${Number(v.toFixed(1))} 秒`

/** 按镜号、角色排：同一镜头的节点挨在一起，不属于镜头的在后面 */
function byShot(a: ImpactNode, b: ImpactNode) {
  const order = { image: 0, video: 1, speech: 2 }
  const na = a.shot?.no ?? Number.POSITIVE_INFINITY
  const nb = b.shot?.no ?? Number.POSITIVE_INFINITY
  if (na !== nb) return na - nb
  return (a.shot ? order[a.shot.role] : 3) - (b.shot ? order[b.shot.role] : 3)
}

/** 按建议重做时的数量与费用；已保留的不算待执行 */
function summarize(nodes: ImpactNode[]): ImpactReport['summary'] {
  const cost: ImpactReport['summary']['cost'] = { amount: 0, unknown: 0 }
  let cached = 0
  let pending = 0
  for (const n of nodes) {
    if (n.suggest !== 'rerun' || n.kept) continue
    if (n.cached) {
      cached++
      continue
    }
    pending++
    if (n.price && (!cost.currency || cost.currency === n.price.currency)) {
      cost.amount += n.price.amount
      cost.currency = n.price.currency
    } else cost.unknown++
  }
  return {
    direct: nodes.filter((n) => n.impact === 'direct').length,
    indirect: nodes.filter((n) => n.impact === 'indirect').length,
    cached,
    pending,
    kept: nodes.filter((n) => n.kept).length,
    cost,
  }
}
