import { createHash } from 'node:crypto'
import { expandedNodes, type ShotSource, shotsOf } from '@plein/capabilities'
import { type CanvasElement, createDoc, type PleinDoc, setParams, SYSTEM_ORIGIN } from '@plein/doc'
import { SEQUENCE_TYPE } from '@plein/nodes'
import {
  type ApplyEditPlan,
  type EditBinding,
  type EditEstimate,
  type EditKeep,
  type EditPlan,
  type EditStage,
  type EditStep,
  type EditTarget,
  estimateSteps,
  type ImpactNode,
  pickedTargets,
  stepsFor,
} from '@plein/protocol'
import * as Y from 'yjs'
import { z } from 'zod'
import { newId } from '../ids'
import { NodeRunError, type PluginHost } from '../plugins/host'
import type { DB } from '../storage/db'
import { ImpactAnalyzer } from './impact'
import { type NodeRuns, runGraph } from './runs'

/**
 * 修改方案：智能体（内置、本机 CLI、对外 MCP 同一份）改已有镜头前先出方案，用户按范围批准后才执行。
 *
 * - 方案在画布的副本上套用文字改动，用影响分析（W2）算出要重做的节点，用实际输入（W1）给出改完后的参考；
 *   不写画布、不调用平台。
 * - 方案绑定目标与要运行的节点在提出时的参数哈希和实际输入哈希，批准时重新检查，变了就不执行。
 * - 执行只写方案里的文字，再把方案里的节点交给「查看影响」同一套按勾选运行（runImpact）；
 *   只改文字时不碰运行队列，付费调用为零。
 */

/** 方案在内存里保留多久；过期后要重新提出 */
const PLAN_TTL_MS = 60 * 60_000

export interface ProposeEdit {
  summary: string
  /** 每个目标节点要改的参数（按键合并，同 update_element） */
  edits: Array<{ id: string; params: Record<string, unknown> }>
}

/** 执行时写文档、登记运行的方式：智能体会话用自己的 origin，撤销按它归属 */
export interface EditPlanIO {
  assertOpen?(): void
  write<T>(fn: (doc: PleinDoc) => T): T
  onGroup?(groupId: string): void
}

interface Stored {
  plan: EditPlan
  ownerId: string
  /** 只含真正变化的键 */
  edits: Map<string, Record<string, unknown>>
  expires: number
  /** 正在复核或执行：复核要等一会儿，期间同一方案的第二次批准直接拒绝，免得执行两次 */
  applying?: boolean
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

/** 节点参数的哈希：方案绑定的文档版本 */
const paramsHash = (el: CanvasElement) =>
  createHash('sha256')
    .update(JSON.stringify(el.params ?? {}))
    .digest('hex')
    .slice(0, 32)

const stageOf = (capability: string | undefined): EditStage =>
  capability?.startsWith('image.')
    ? 'image'
    : capability?.startsWith('video.')
      ? 'video'
      : capability === 'audio.speech'
        ? 'speech'
        : 'other'

const emptyEstimate = (): EditEstimate => estimateSteps([])

export class EditPlans {
  private plans = new Map<string, Stored>()
  private impact: ImpactAnalyzer

  constructor(
    db: DB,
    private runs: NodeRuns,
    private host: PluginHost,
  ) {
    this.impact = new ImpactAnalyzer(db, runs)
  }

  get(id: string, ownerId: string): EditPlan | undefined {
    const s = this.stored(id, ownerId)
    return s?.plan
  }

  /** 用户没采用 / 确认单作废：只改等待中的方案 */
  settle(id: string, ownerId: string, status: 'denied' | 'expired') {
    const s = this.stored(id, ownerId)
    if (s?.plan.status === 'pending') s.plan = { ...s.plan, status }
  }

  /** 提出方案：只读，在画布副本上套用改动做分析 */
  async propose(
    canvasId: string,
    ownerId: string,
    input: ProposeEdit,
    revise?: { id: string; revised: number },
  ): Promise<EditPlan> {
    this.sweep()
    const lease = this.runs.rooms.acquire(canvasId)
    const doc = createDoc(lease.room.doc, { origin: SYSTEM_ORIGIN })
    const copy = new Y.Doc()
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(lease.room.doc))
    const sim = createDoc(copy, { origin: SYSTEM_ORIGIN })
    try {
      const signal = new AbortController().signal
      const edits = this.validate(doc, input.edits)
      for (const [id, params] of edits) setParams(sim, id, params)

      const shotOf = (el: CanvasElement): ImpactNode['shot'] => {
        const src = el.params?.source as ShotSource | undefined
        if (!src || src.detached) return undefined
        const no = shotsOf(doc.get(src.storyboard)).find((s) => s.id === src.shot)?.no
        return { storyboard: src.storyboard, id: src.shot, role: src.role, ...(no ? { no } : {}) }
      }
      const bind = async (el: CanvasElement) => {
        const now = await this.runs.inspect(canvasId, doc, el, ownerId, signal)
        const binding: EditBinding = { version: paramsHash(el) }
        if (now.input.inputHash) binding.inputHash = now.input.inputHash
        return { binding, input: now.input }
      }

      const targets: EditTarget[] = []
      for (const [id, params] of edits) {
        const el = doc.get(id)!
        const after = await this.runs.inspect(canvasId, sim, sim.get(id)!, ownerId, signal)
        const { binding } = await bind(el)
        const shot = shotOf(el)
        targets.push({
          nodeId: id,
          name: el.name ?? this.titleOf(el),
          nodeType: el.nodeType ?? '',
          ...(shot ? { shot } : {}),
          changes: Object.entries(params).map(([key, value]) => ({
            key,
            label: this.runs.paramTitle(el.nodeType ?? '', key),
            before: el.params?.[key],
            after: value,
          })),
          refs: after.input.refs,
          issues: [...after.input.blocked, ...after.input.notices],
          ...binding,
        })
      }

      // 改动波及的节点：目标自己和它们的下游（含 @ 引用），记下每个节点因为哪些目标受影响
      const graph = runGraph(sim)
      const reach = new Map<string, Set<string>>()
      for (const id of edits.keys())
        for (const d of [id, ...graph.descendants(id)]) {
          const set = reach.get(d) ?? new Set<string>()
          set.add(id)
          reach.set(d, set)
        }

      const report = await this.impact.analyzeDoc(sim, canvasId, ownerId)
      const steps: EditStep[] = []
      const keep: EditKeep[] = []
      const listed = new Set<string>()
      const keepOf = (el: CanvasElement, reason: string) => {
        const shot = shotOf(el)
        keep.push({
          nodeId: el.id,
          name: el.name ?? this.titleOf(el),
          ...(shot ? { shot } : {}),
          reason,
        })
        listed.add(el.id)
      }
      for (const n of report.nodes) {
        const from = reach.get(n.nodeId)
        const el = doc.get(n.nodeId)
        if (!from || !el) continue
        if (n.kept) {
          keepOf(el, '之前确认过保留这个结果')
          continue
        }
        if (n.impact === 'related') {
          keepOf(el, n.causes[0]?.label ?? '不受这次修改影响')
          continue
        }
        const { binding, input } = await bind(el)
        // 没有模型的是本地加工（如序列导出），不算进方案
        if (!input.model) {
          keepOf(
            el,
            el.nodeType === SEQUENCE_TYPE
              ? '序列不在方案里重新导出，换了镜头后在「查看影响」里检查入出点'
              : '本地加工，不在方案里',
          )
          continue
        }
        const stage = stageOf(input.capability)
        steps.push({
          nodeId: n.nodeId,
          name: n.name,
          ...(n.shot ? { shot: n.shot } : {}),
          stage,
          scope: stage === 'image' ? 'images' : 'full',
          targets: [...from],
          causes: n.causes,
          ...(n.cached ? { cached: true } : {}),
          ...(n.price ? { price: n.price } : {}),
          ...binding,
        })
        listed.add(n.nodeId)
      }
      // 还没有结果的目标：批准后第一次生成
      for (const id of edits.keys()) {
        const el = doc.get(id)!
        if (listed.has(id) || !this.runs.isJobNode(el) || el.results?.length) continue
        const { binding, input } = await bind(el)
        if (!input.model) continue
        const stage = stageOf(input.capability)
        const price = this.runs.priceOf(input.model)
        const shot = shotOf(el)
        steps.push({
          nodeId: id,
          name: el.name ?? this.titleOf(el),
          ...(shot ? { shot } : {}),
          stage,
          scope: stage === 'image' ? 'images' : 'full',
          targets: [id],
          causes: [{ kind: 'unknown', label: '还没生成过' }],
          ...(price ? { price } : {}),
          ...binding,
        })
        listed.add(id)
      }
      // 同一镜头里不受影响的节点：明确列为保留
      const shots = new Map<string, Set<string>>()
      for (const s of [...targets, ...steps])
        if (s.shot)
          shots.set(s.shot.storyboard, (shots.get(s.shot.storyboard) ?? new Set()).add(s.shot.id))
      for (const [board, ids] of shots) {
        const byShot = expandedNodes(doc, board)
        for (const shotId of ids)
          for (const el of byShot.get(shotId) ?? []) {
            if (listed.has(el.id) || edits.has(el.id) || !el.results?.length) continue
            keepOf(el, '同一镜头里不受这次修改影响，保留当前结果')
          }
      }
      let untouched = 0
      for (const el of doc.elements())
        if (
          this.runs.isJobNode(el) &&
          el.results?.length &&
          !listed.has(el.id) &&
          !edits.has(el.id)
        )
          untouched++

      const plan: EditPlan = {
        id: revise?.id ?? newId('epl'),
        canvasId,
        summary: input.summary,
        targets,
        steps,
        keep,
        untouched,
        estimate: {
          text: emptyEstimate(),
          images: estimateSteps(steps.filter((st) => st.scope === 'images')),
          full: estimateSteps(steps),
        },
        status: 'pending',
        ...(revise ? { revised: revise.revised } : {}),
        createdAt: Date.now(),
      }
      this.plans.set(plan.id, { plan, ownerId, edits, expires: Date.now() + PLAN_TTL_MS })
      return plan
    } finally {
      sim.destroy()
      copy.destroy()
      doc.destroy()
      lease.release()
    }
  }

  /**
   * 逐项编辑：用户在卡片上改了字段的新值或去掉了某项改动，按新的改动重新检查整份方案，
   * 方案 id 不变，原来的方案作废。edits 是每个目标完整的改动（只含改动的键）
   */
  async revise(id: string, ownerId: string, edits: ProposeEdit['edits']): Promise<EditPlan> {
    const s = this.stored(id, ownerId)
    if (!s) throw new NodeRunError('not_found', '方案不存在或已经过期，请重新提出')
    if (s.plan.status !== 'pending')
      throw new NodeRunError('invalid_input', `方案${STATUS_LABEL[s.plan.status]}，不能再改`)
    if (s.applying) throw new NodeRunError('busy', '方案正在执行')
    s.applying = true
    try {
      return await this.propose(
        s.plan.canvasId,
        ownerId,
        { summary: s.plan.summary, edits },
        { id, revised: (s.plan.revised ?? 0) + 1 },
      )
    } finally {
      s.applying = false
    }
  }

  /**
   * 按范围执行方案。先检查方案绑定的对象：任何一个的参数或实际输入和提出时不同，
   * 就把方案标成 stale 返回，不写文字也不运行。only 只批准部分目标（目标节点 id 或镜头 id），
   * 这时只运行这些目标波及的节点；skip 里的步骤不运行，保留当前结果
   */
  async apply(id: string, ownerId: string, req: ApplyEditPlan, io: EditPlanIO): Promise<EditPlan> {
    const s = this.stored(id, ownerId)
    if (!s) throw new NodeRunError('not_found', '方案不存在或已经过期，请重新提出')
    if (s.plan.status !== 'pending')
      throw new NodeRunError('invalid_input', `方案${STATUS_LABEL[s.plan.status]}，请重新提出`)
    if (s.applying) throw new NodeRunError('busy', '方案正在执行')
    s.applying = true
    try {
      return await this.applyPending(s, req, io)
    } finally {
      s.applying = false
    }
  }

  private async applyPending(s: Stored, req: ApplyEditPlan, io: EditPlanIO): Promise<EditPlan> {
    const plan = s.plan
    const ownerId = s.ownerId
    const picked = pickedTargets(plan, req.only)
    if (!picked.length) throw new NodeRunError('invalid_input', '方案里没有这些目标')
    const steps = stepsFor(plan, req.scope, req.only, req.skip)

    const changed = await this.changed(plan.canvasId, ownerId, [...picked, ...steps])
    io.assertOpen?.()
    if (changed.length) {
      s.plan = { ...plan, status: 'stale', changed }
      return s.plan
    }

    io.assertOpen?.()
    io.write((doc) => {
      for (const t of picked) setParams(doc, t.nodeId, s.edits.get(t.nodeId)!)
    })
    let groupId: string | undefined
    if (steps.length) {
      io.assertOpen?.()
      const started = this.runs.runImpact(plan.canvasId, ownerId, {
        nodes: steps.map((st) => st.nodeId),
        force: false,
      })
      groupId = started.groupId
      io.onGroup?.(groupId)
    }
    s.plan = {
      ...plan,
      status: 'applied',
      applied: {
        scope: req.scope,
        at: Date.now(),
        targets: picked.map((t) => t.nodeId),
        nodes: steps.map((st) => st.nodeId),
        ...(groupId ? { groupId } : {}),
      },
    }
    return s.plan
  }

  /** 和提出时比，参数或实际输入变了的对象 */
  private async changed(
    canvasId: string,
    ownerId: string,
    bound: Array<EditBinding & { nodeId: string }>,
  ): Promise<string[]> {
    const lease = this.runs.rooms.acquire(canvasId)
    const doc = createDoc(lease.room.doc, { origin: SYSTEM_ORIGIN })
    try {
      const signal = new AbortController().signal
      const out: string[] = []
      for (const b of bound) {
        const el = doc.get(b.nodeId)
        if (!el || paramsHash(el) !== b.version) {
          out.push(b.nodeId)
          continue
        }
        const now = await this.runs.inspect(canvasId, doc, el, ownerId, signal)
        if ((now.input.inputHash ?? '') !== (b.inputHash ?? '')) out.push(b.nodeId)
      }
      return [...new Set(out)]
    } finally {
      doc.destroy()
      lease.release()
    }
  }

  /** 目标要存在、是节点，改完的参数要能通过节点声明的校验；去掉和现在一样的键 */
  private validate(doc: PleinDoc, edits: ProposeEdit['edits']) {
    const out = new Map<string, Record<string, unknown>>()
    for (const e of edits) out.set(e.id, { ...out.get(e.id), ...e.params })
    for (const [id, params] of out) {
      const el = doc.get(id)
      if (el?.kind !== 'node' || !el.nodeType)
        throw new NodeRunError('not_found', `节点 ${id} 不存在`)
      const def = this.host.registry.latestNode(el.nodeType)?.def
      if (def) {
        const check = def.params.safeParse({ ...el.params, ...params })
        if (!check.success)
          throw new NodeRunError(
            'invalid_input',
            `「${el.name ?? id}」的参数不对：${z.prettifyError(check.error)}`,
          )
      }
      const diff = Object.fromEntries(
        Object.entries(params).filter(([k, v]) => !sameJson(el.params?.[k], v)),
      )
      if (Object.keys(diff).length) out.set(id, diff)
      else out.delete(id)
    }
    if (!out.size) throw new NodeRunError('invalid_input', '这些修改和画布上现在的内容一样')
    return out
  }

  private titleOf(el: CanvasElement) {
    return (el.nodeType && this.host.registry.latestNode(el.nodeType)?.def.title) ?? '节点'
  }

  private stored(id: string, ownerId: string) {
    const s = this.plans.get(id)
    if (!s || s.ownerId !== ownerId) return undefined
    if (s.expires < Date.now() && s.plan.status === 'pending')
      s.plan = { ...s.plan, status: 'expired' }
    return s
  }

  private sweep() {
    const now = Date.now()
    for (const [id, s] of this.plans) if (s.expires + PLAN_TTL_MS < now) this.plans.delete(id)
  }
}

const STATUS_LABEL: Record<EditPlan['status'], string> = {
  pending: '还在等批准',
  applied: '已经执行过',
  stale: '的目标已经变了',
  denied: '没有被采用',
  expired: '已经过期',
}
