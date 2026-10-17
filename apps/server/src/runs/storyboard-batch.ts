import { createHash, randomUUID } from 'node:crypto'
import {
  activeShotNodes,
  expandedNodes,
  planDiffs,
  shotsOf,
  type ShotSource,
} from '@plein/capabilities'
import { createDoc, currentResult, type CanvasElement, type PleinDoc } from '@plein/doc'
import { FlowGraph, stableStringify, topoLayers } from '@plein/flow'
import { STORYBOARD_TYPE } from '@plein/nodes'
import {
  type BatchDependency,
  type GroupRunStarted,
  type PreparedInput,
  type StoryboardBatchPlan,
  type StoryboardBatchRequest,
  type StoryboardBatchRow,
} from '@plein/protocol'
import * as Y from 'yjs'
import { NodeRunError } from '../plugins/host'
import { batchSourceKey, type JobExpect } from './batch'
import { mentionEdges } from './mentions'
import { type NodeRuns, runGraph } from './runs'

const TTL = 10 * 60_000
const digest = (value: unknown) => createHash('sha256').update(stableStringify(value)).digest('hex')
const sourceOf = (el: CanvasElement) => el.params?.source as ShotSource | undefined
const revision = (doc: PleinDoc) =>
  digest(
    [...doc.elements()]
      .map((el) => ({
        id: el.id,
        source: batchSourceKey(doc, el),
        results: el.results?.map((r) => ({ id: r.id, port: r.port, value: r.value })),
        adopted: el.adopted,
        running: el.run?.status === 'queued' || el.run?.status === 'running',
      }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  )

interface StoredPlan {
  ownerId: string
  canvasId: string
  signature: string
  plan: StoryboardBatchPlan
}
interface BuiltPlan {
  plan: Omit<StoryboardBatchPlan, 'token' | 'expiresAt'>
  signature: string
  revision: string
  items: Array<{ nodeId: string; input: PreparedInput; expect: JobExpect }>
}

/** 只读预检，确认时重算；批准输入先持久化，再交给既有任务调度器。 */
export class StoryboardBatches {
  private plans = new Map<string, StoredPlan>()
  constructor(private runs: NodeRuns) {}

  async preview(
    canvasId: string,
    sourceId: string,
    ownerId: string,
    request: StoryboardBatchRequest,
  ) {
    const built = await this.build(canvasId, sourceId, ownerId, request)
    return this.remember(canvasId, ownerId, built)
  }

  async commit(
    canvasId: string,
    sourceId: string,
    ownerId: string,
    token: string,
  ): Promise<{ started: GroupRunStarted } | { changed: StoryboardBatchPlan }> {
    const stored = this.plans.get(token)
    if (
      !stored ||
      stored.ownerId !== ownerId ||
      stored.canvasId !== canvasId ||
      stored.plan.sourceId !== sourceId ||
      stored.plan.expiresAt <= Date.now()
    )
      throw new NodeRunError('invalid_input', '清单已过期或服务已重启，请重新检查')
    const built = await this.build(canvasId, sourceId, ownerId, stored.plan.request)
    // 同一令牌并发确认只能成功一次；重算期间它可能已被另一个请求消费。
    if (this.plans.get(token) !== stored)
      throw new NodeRunError('busy', '这份清单已经提交，请检查原任务')
    this.plans.delete(token)
    if (
      built.signature !== stored.signature ||
      !this.runs.rooms.withDoc(canvasId, (doc) => revision(doc) === built.revision)
    )
      return { changed: this.remember(canvasId, ownerId, built) }
    return { started: this.runs.runReviewedBatch(canvasId, sourceId, ownerId, built.items) }
  }

  private remember(canvasId: string, ownerId: string, built: BuiltPlan): StoryboardBatchPlan {
    for (const [token, stored] of this.plans)
      if (stored.plan.expiresAt <= Date.now()) this.plans.delete(token)
    while (this.plans.size >= 128) this.plans.delete(this.plans.keys().next().value!)
    const plan = { ...built.plan, token: randomUUID(), expiresAt: Date.now() + TTL }
    this.plans.set(plan.token, { ownerId, canvasId, signature: built.signature, plan })
    return plan
  }

  private async build(
    canvasId: string,
    sourceId: string,
    ownerId: string,
    body: StoryboardBatchRequest,
  ): Promise<BuiltPlan> {
    const lease = this.runs.rooms.acquire(canvasId)
    const live = createDoc(lease.room.doc)
    const snapshot = new Y.Doc()
    Y.applyUpdate(snapshot, Y.encodeStateAsUpdate(live.ydoc))
    const doc = createDoc(snapshot)
    const before = revision(live)
    try {
      const board = doc.get(sourceId)
      if (board?.nodeType !== STORYBOARD_TYPE) throw new NodeRunError('not_found', '分镜表不存在')
      const request = { ...body, shotIds: [...new Set(body.shotIds)] }
      const shots = new Map(shotsOf(board).map((shot) => [shot.id, shot]))
      if (request.shotIds.some((id) => !shots.has(id)))
        throw new NodeRunError('invalid_input', '镜头计划已变化，请重新选择镜头')
      const groups = expandedNodes(doc, sourceId)
      const changes = planDiffs(doc, sourceId)
      const rows: StoryboardBatchRow[] = []
      const direct = new Set<string>()
      const add = (el: CanvasElement, shotId?: string, prerequisite = false) => {
        if (rows.some((row) => row.nodeId === el.id)) return
        const shot = shotId ? shots.get(shotId) : undefined
        rows.push({
          key: el.id,
          nodeId: el.id,
          ...(shot ? { shotId, shotNo: shot.no } : {}),
          name: el.name ?? el.nodeType ?? '节点',
          prerequisite,
          action: 'run',
          reason: '',
          calls: 0,
        })
      }
      for (const shotId of request.shotIds) {
        const shot = shots.get(shotId)!
        const nodes = activeShotNodes(shot, groups.get(shotId) ?? []).filter(
          (el) => sourceOf(el)?.role === request.role,
        )
        if (!nodes.length) {
          const empty =
            (request.role === 'speech' && !shot.dialogue.some((line) => line.line.trim())) ||
            (request.role === 'sfx' && !shot.sfx.trim())
          rows.push({
            key: `${shotId}/${request.role}`,
            shotId,
            shotNo: shot.no,
            name: `镜头 ${shot.no}`,
            prerequisite: false,
            action: empty ? 'skip' : 'blocked',
            reason: empty
              ? request.role === 'speech'
                ? '没有台词'
                : '没有音效描述'
              : '还没展开成节点',
            calls: 0,
          })
        }
        for (const node of nodes) {
          direct.add(node.id)
          add(node, shotId)
        }
      }
      // 图片批次保留既有资产准备行为，所有隐式准备项目先列出来。
      if (request.role === 'image') {
        const mentions = new FlowGraph(mentionEdges(doc))
        const edges = new FlowGraph(doc.edges())
        for (const id of direct) {
          if (request.reuseExisting && currentResult(doc.get(id)!)) continue
          for (const card of mentions.upstream(id))
            for (const up of edges.ancestors(card)) {
              const node = doc.get(up)
              if (node && this.runs.isJobNode(node)) add(node, undefined, true)
            }
        }
      }
      if (rows.length > 500) throw new NodeRunError('invalid_input', '清单超过 500 项，请分批执行')
      const latest = new Map(
        this.runs
          .latestForNodes(
            canvasId,
            rows.flatMap((r) => (r.nodeId ? [r.nodeId] : [])),
          )
          .jobs.map((job) => [job.nodeId, job]),
      )
      const signal = new AbortController().signal
      for (const row of rows) {
        if (!row.nodeId) continue
        const el = doc.get(row.nodeId)!
        const job = latest.get(el.id)
        const recovery = job?.recovery
        if (
          this.runs.isRunning(canvasId, el.id) ||
          el.run?.status === 'running' ||
          el.run?.status === 'queued'
        ) {
          row.action = 'blocked'
          row.reason = '已有任务正在运行'
          continue
        }
        if (
          recovery &&
          !recovery.dismissed &&
          ['submit_unknown', 'remote_pending', 'fetch_failed'].includes(recovery.state)
        ) {
          row.action = 'blocked'
          row.reason = '请先在审核视图核查或取回原任务'
          continue
        }
        if (direct.has(el.id) && request.reuseExisting && currentResult(el)) {
          row.action = 'reuse'
          row.reason = '沿用当前采用结果，不生成新候选'
          continue
        }
        if (
          row.shotId &&
          (changes.get(row.shotId) ?? []).some(
            (change) => change.el.id === el.id && change.diffs.some((diff) => diff.stale),
          )
        ) {
          row.action = 'blocked'
          row.reason = '分镜修改尚未同步，请先查看差异'
          continue
        }
        const inspection = await this.runs.inspect(doc, el, ownerId, signal)
        row.input = inspection.input
        if (row.prerequisite && this.runs.resultMatches(el, inspection)) {
          row.action = 'reuse'
          row.reason = '资产准备结果有效，可直接沿用'
        }
      }
      const graph = runGraph(doc)
      const order = topoLayers(
        graph.dependencies(rows.flatMap((r) => (r.nodeId ? [r.nodeId] : []))),
      )
      for (const id of order.cycle) {
        const row = rows.find((r) => r.nodeId === id)!
        row.action = 'blocked'
        row.reason = '依赖形成循环，请先修复连线'
      }
      for (const id of order.layers.flat()) {
        const row = rows.find((r) => r.nodeId === id)!
        if (row.action !== 'run') continue
        const input = row.input!
        const changing = [...graph.ancestors(id)].filter((up) =>
          rows.some((r) => r.nodeId === up && r.action === 'run'),
        )
        const hardAncestors = [...new FlowGraph(doc.edges()).ancestors(id)]
        const hardBlocked = hardAncestors.some((up) =>
          rows.some((r) => r.nodeId === up && r.action === 'blocked'),
        )
        const onlyAwaiting = input.blocked.every(
          (issue) =>
            (['required_no_image', 'required_failed'].includes(issue.code) &&
              !!issue.elementId &&
              [issue.elementId, ...graph.ancestors(issue.elementId)].some((up) =>
                changing.includes(up),
              )) ||
            (issue.code === 'prepare_failed' &&
              /没有结果|没有可用|还没有|上游/.test(issue.message) &&
              hardAncestors.some((up) => changing.includes(up)) &&
              hardAncestors.every((up) => {
                const node = doc.get(up)
                return (
                  !node ||
                  !this.runs.isJobNode(node) ||
                  !!currentResult(node) ||
                  changing.includes(up)
                )
              })),
        )
        if (
          hardBlocked ||
          (input.status !== 'ready' && !(changing.length && input.model && onlyAwaiting))
        ) {
          row.action = 'blocked'
          row.reason = hardBlocked
            ? '上游有阻塞项，先修复后重新检查'
            : input.blocked.map((i) => i.message).join('；') || '输入尚未就绪'
          continue
        }
        row.deferred = changing.length > 0
        row.reason = row.deferred
          ? '先准备所列资产，再复核最终输入并生成'
          : '按这份实际输入生成新候选'
        const count = Number(doc.get(id)?.params?.count ?? 1)
        row.calls =
          doc.get(id)?.nodeType === 'plein/video' && Number.isInteger(count) && count > 0
            ? count
            : 1
        const price = this.runs.priceOf(input.model)
        if (price) row.price = { ...price, amount: price.amount * row.calls }
      }
      // 不为全部沿用或被阻塞的目标偷偷生成资产准备项。
      for (const row of rows) {
        if (!row.prerequisite || row.action !== 'run') continue
        const needed = rows.some(
          (target) =>
            !target.prerequisite &&
            target.action === 'run' &&
            target.nodeId &&
            graph.ancestors(target.nodeId).has(row.nodeId!),
        )
        if (!needed) {
          row.action = 'skip'
          row.calls = 0
          row.reason = '没有就绪目标需要此项，本次不生成'
        }
      }
      const running = rows.filter((row) => row.action === 'run')
      const items = running.map((row) => {
        const el = doc.get(row.nodeId!)!
        const upstream = [...graph.ancestors(el.id)]
        const deps: BatchDependency[] = [el.id, ...upstream].flatMap((id) => {
          const node = doc.get(id)
          if (!node) return []
          const result = currentResult(node)
          return [
            {
              nodeId: id,
              ...(result ? { resultId: result.id } : {}),
              sourceKey: batchSourceKey(doc, node),
            },
          ]
        })
        return {
          nodeId: el.id,
          input: row.input!,
          expect: {
            ...(!row.deferred && row.input?.inputHash ? { inputHash: row.input.inputHash } : {}),
            planHash: this.runs.planKey(el),
            deps,
          },
        }
      })
      const prices = new Map<string, number>()
      for (const row of running)
        if (row.price)
          prices.set(row.price.currency, (prices.get(row.price.currency) ?? 0) + row.price.amount)
      const plan = {
        sourceId,
        request,
        rows,
        summary: {
          run: running.length,
          reuse: rows.filter((r) => r.action === 'reuse').length,
          blocked: rows.filter((r) => r.action === 'blocked').length,
          skip: rows.filter((r) => r.action === 'skip').length,
          calls: running.reduce((n, r) => n + r.calls, 0),
          prices: [...prices].map(([currency, amount]) => ({ currency, amount })),
          unknownCalls: running.filter((r) => !r.price).reduce((n, r) => n + r.calls, 0),
        },
      }
      if (revision(live) !== before)
        throw new NodeRunError('busy', '清单准备期间内容或任务已变化，请重新检查')
      const signature = digest({
        request,
        rows: rows.map(({ input, ...row }) => ({
          ...row,
          inputHash: input?.inputHash,
          model: input?.model,
        })),
        items: items.map((item) => item.expect),
      })
      return { plan, signature, revision: before, items }
    } finally {
      doc.destroy()
      snapshot.destroy()
      live.destroy()
      lease.release()
    }
  }
}
