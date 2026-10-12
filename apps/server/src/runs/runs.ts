import {
  addResults,
  type CanvasElement,
  createDoc,
  currentResult,
  type NodeResult,
  type PleinDoc,
  type ResultValue,
  writeRun,
} from '@plein/doc'
import type { NodeOutputs, PortValue } from '@plein/plugin-sdk'
import { NodeRunError, type PluginHost } from '../plugins/host'
import type { Rooms } from '../sync/rooms'

/** 进度写回文档的最小间隔，避免高频同步 */
const PROGRESS_INTERVAL_MS = 500

const newId = (prefix: string) =>
  `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`

export function toPortValue(v: ResultValue): PortValue {
  if (v.type === 'text' || v.type === 'json') return v
  return { type: v.type, assetId: v.assetId, kind: v.type, mime: v.mime }
}

export function toResultValue(v: PortValue): ResultValue {
  if (v.type === 'text' || v.type === 'json') return v
  return { type: v.type, assetId: v.assetId, mime: v.mime }
}

/**
 * 单节点运行：从画布文档收集上游输入，调用执行器，把状态和结果写回文档。
 * 结果通过 Yjs 同步到所有打开这张画布的客户端。
 *
 * 这是 M3 任务队列之前的最小实现：运行只在内存里，服务重启后正在跑的节点会停在
 * “运行中”，用户可以取消后重跑。任务队列落地后由它替换，接口保持不变。
 */
export class NodeRuns {
  private running = new Map<string, AbortController>()

  constructor(
    private rooms: Rooms,
    private host: PluginHost,
  ) {}

  private key(canvasId: string, nodeId: string) {
    return `${canvasId}/${nodeId}`
  }

  isRunning(canvasId: string, nodeId: string) {
    return this.running.has(this.key(canvasId, nodeId))
  }

  /** 开始运行，立即返回运行 id；校验失败直接抛 NodeRunError */
  start(canvasId: string, nodeId: string, ownerId: string): string {
    const key = this.key(canvasId, nodeId)
    if (this.running.has(key)) throw new NodeRunError('busy', '节点正在运行')
    const doc = createDoc(this.rooms.get(canvasId).doc)
    const el = doc.get(nodeId)
    if (el?.kind !== 'node' || !el.nodeType) {
      doc.destroy()
      throw new NodeRunError('not_found', '节点不存在')
    }
    const runId = newId('run')
    const ctrl = new AbortController()
    this.running.set(key, ctrl)
    writeRun(doc, nodeId, { id: runId, status: 'running', progress: 0, at: Date.now() })

    void this.execute(doc, el, runId, ownerId, ctrl.signal).finally(() => {
      this.running.delete(key)
      doc.destroy()
    })
    return runId
  }

  /** 取消；没有在跑的任务（例如服务重启过）时把残留的“运行中”标为已取消 */
  cancel(canvasId: string, nodeId: string) {
    const ctrl = this.running.get(this.key(canvasId, nodeId))
    if (ctrl) {
      ctrl.abort()
      return
    }
    const doc = createDoc(this.rooms.get(canvasId).doc)
    const run = doc.get(nodeId)?.run
    if (run && (run.status === 'running' || run.status === 'queued'))
      writeRun(doc, nodeId, { ...run, status: 'canceled', at: Date.now() })
    doc.destroy()
  }

  private async execute(
    doc: PleinDoc,
    el: CanvasElement,
    runId: string,
    ownerId: string,
    signal: AbortSignal,
  ) {
    let lastProgress = 0
    try {
      const inputs = await this.collectInputs(doc, el.id, ownerId, signal)
      const outputs = await this.host.runNode({
        type: el.nodeType!,
        version: el.nodeVersion ?? 1,
        params: el.params,
        inputs,
        ownerId,
        signal,
        onProgress: (progress, message) => {
          const now = Date.now()
          if (now - lastProgress < PROGRESS_INTERVAL_MS) return
          lastProgress = now
          writeRun(doc, el.id, { id: runId, status: 'running', progress, message, at: now })
        },
      })
      const at = Date.now()
      const results: NodeResult[] = Object.entries(outputs).flatMap(([port, values]) =>
        values.map((v) => ({ id: newId('res'), port, value: toResultValue(v), runId, at })),
      )
      addResults(doc, el.id, results)
      writeRun(doc, el.id, { id: runId, status: 'succeeded', at })
    } catch (err) {
      const canceled = signal.aborted
      writeRun(doc, el.id, {
        id: runId,
        status: canceled ? 'canceled' : 'failed',
        error: canceled ? undefined : (err as Error).message,
        at: Date.now(),
      })
    }
  }

  /**
   * 按输入端口收集上游值：节点取当前采用的结果，素材元素取资产，Markdown 取正文。
   * 上游是还没结果的纯节点（不调模型，如文本节点）时就地计算。
   * 同一端口的多个上游按画布位置从上到下、从左到右排序。
   */
  private async collectInputs(
    doc: PleinDoc,
    nodeId: string,
    ownerId: string,
    signal: AbortSignal,
  ): Promise<Record<string, PortValue[]>> {
    const edges = [...doc.edges()].filter((e) => e.to[0] === nodeId)
    const pos = (id: string) => doc.worldRect(id) ?? { x: 0, y: 0 }
    edges.sort((a, b) => {
      const pa = pos(a.from[0])
      const pb = pos(b.from[0])
      return pa.y - pb.y || pa.x - pb.x
    })
    const inputs: Record<string, PortValue[]> = {}
    for (const edge of edges) {
      const src = doc.get(edge.from[0])
      if (!src) continue
      const values = await this.upstreamValues(src, edge.from[1], ownerId, signal)
      inputs[edge.to[1]] = [...(inputs[edge.to[1]] ?? []), ...values]
    }
    return inputs
  }

  private async upstreamValues(
    src: CanvasElement,
    port: string,
    ownerId: string,
    signal: AbortSignal,
  ): Promise<PortValue[]> {
    const label = src.name ?? '上游'
    switch (src.kind) {
      case 'markdown':
        return src.text?.trim() ? [{ type: 'text', text: src.text }] : []
      case 'image':
      case 'video':
      case 'audio':
        return src.assetId ? [{ type: src.kind, assetId: src.assetId, kind: src.kind }] : []
      case 'node': {
        const r = currentResult(src, port)
        if (r) return [toPortValue(r.value)]
        const def = src.nodeType ? this.host.registry.latestNode(src.nodeType)?.def : undefined
        if (def && !def.capability) {
          const out: NodeOutputs = await this.host.runNode({
            type: src.nodeType!,
            version: src.nodeVersion ?? 1,
            params: src.params,
            ownerId,
            signal,
          })
          return out[port] ?? []
        }
        throw new NodeRunError('missing_input', `上游节点「${label}」还没有结果，请先运行它`)
      }
      default:
        return []
    }
  }
}
