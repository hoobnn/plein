import type { Engine } from '@plein/canvas-core'
import { currentResult, inputEdges, type CanvasElement } from '@plein/doc'
import { findMentions, sortMentionTargets } from '@plein/nodes'
import { mentionTargets } from '../../canvas/nodes'

/**
 * 会影响这个节点实际输入的文档状态摘要。
 *
 * 只收进本节点、实际消费到的上游（已生成的上游到它的结果为止，不展开未提交的草稿），
 * 以及提示词里真正 @ 到的目标（含它们的参数和连入的定妆图）：
 * 移动节点、改无关节点、任务进度这类文档更新不改变摘要，实际输入预览就不必重取。
 * 采用、结果身份、输入顺序、参数、音色、模型、@ 点名与同名歧义都算在内。
 *
 * @ 解析与服务端一致：先把这次运行会消费的文本（本节点参数与上游文本）拼出来，
 * 用同一套 `findMentions` 规则找出命中目标，再只遍历这些目标；全画布的目标列表本身不参与摘要，
 * 否则无关目标改名也会让预览白刷新。
 */
export function previewInputKey(engine: Engine, nodeId: string): string {
  const { doc } = engine
  const parts: unknown[] = []
  const visited = new Set<string>()
  /** 这次运行会消费的文本：本节点参数与上游送来的文本 */
  const sources: string[] = []
  const queue = [nodeId]
  while (queue.length) {
    const id = queue.shift()!
    if (visited.has(id)) continue
    visited.add(id)
    const el = doc.get(id)
    if (!el) {
      parts.push({ id, missing: true })
      continue
    }
    parts.push(elementKey(el))
    for (const text of textValues(el)) sources.push(text)
    for (const edge of inputEdges(doc, id)) {
      const source = doc.get(edge.from[0])
      const current = source ? resultKey(source, edge.from[1]) : null
      parts.push({
        edge: edge.id,
        from: [edge.from[0], edge.from[1]],
        to: edge.to[1],
        current,
        // 还没有结果时才看上游的最新失败状态（会改变服务端的阻断/提示）；进度不算
        ...(current || !source ? {} : { run: runStateKey(source) }),
      })
      if (current?.text) sources.push(current.text)
      // 上游这个输出口已经有结果时，服务端直接用那份结果，不读它的参数和上游：
      // 在这里截断，编辑它还没运行的草稿不会让下游预览失效。换采用会换结果 id，仍会发现。
      if (current) continue
      if (source) for (const text of textValues(source)) sources.push(text)
      queue.push(edge.from[0])
    }
  }
  // @ 引用按名字解析：只有被提示词命中的目标才让预览失效
  const targets = sortMentionTargets(
    mentionTargets(engine).filter((target) => target.id !== nodeId),
  )
  const referenced = new Set<string>()
  for (const text of sources) {
    for (const mention of findMentions(text, targets)) {
      parts.push({
        mention: mention.name,
        id: mention.id,
        ids: mention.ids,
        index: mention.index,
        pick: mention.pick ?? null,
        sceneView: mention.sceneView ?? null,
      })
      // 重名又没写序号时服务端不猜，这里也不把任何一个候选当成依赖
      if (mention.id) referenced.add(mention.id)
    }
  }
  for (const id of [...referenced].sort()) {
    if (visited.has(id)) continue
    visited.add(id)
    const el = doc.get(id)
    if (!el) {
      parts.push({ id, missing: true })
      continue
    }
    // 被引用的卡片：参数（音色、档案）、连入的定妆图、当前采用的输出
    parts.push(elementKey(el))
    for (const edge of inputEdges(doc, id)) {
      const source = doc.get(edge.from[0])
      const current = source ? resultKey(source, edge.from[1]) : null
      parts.push({
        ref: edge.id,
        from: [edge.from[0], edge.from[1]],
        current,
        // 已生成的定妆图：服务端只用当前结果，未运行的草稿不算依赖；
        // 还没有结果时才需要它的参数与最新失败状态（会改变引用提示/阻断）
        ...(current || !source ? {} : { source: elementKey(source), run: runStateKey(source) }),
      })
    }
  }
  return JSON.stringify(parts)
}

/** 节点自身的参数里有 @ 的文本；不含引用的参数不影响解析 */
function textValues(el: CanvasElement) {
  const out: string[] = []
  for (const value of Object.values(el.params ?? {}))
    if (typeof value === 'string' && value.includes('@')) out.push(value)
  if (typeof el.text === 'string' && el.text.includes('@')) out.push(el.text)
  return out
}

function elementKey(el: CanvasElement) {
  return {
    id: el.id,
    kind: el.kind,
    nodeType: el.nodeType,
    nodeVersion: el.nodeVersion,
    params: el.params ?? null,
    text: el.text ?? null,
    assetId: el.assetId ?? null,
    name: el.name ?? null,
    // 采用身份：同一输入下换用另一个候选会改变下游实际输入
    adopted: el.adopted === undefined ? null : el.adopted,
  }
}

/** 没有结果时上游最新状态：失败原因会改变服务端的提示/阻断，进度百分比无关 */
function runStateKey(el: CanvasElement) {
  const run = el.run
  if (!run) return null
  return { status: run.status, error: run.error ?? null, errorCode: run.errorCode ?? null }
}

function resultKey(el: CanvasElement, port?: string) {
  const result = port === undefined ? currentResult(el) : currentResult(el, port)
  if (!result) return null
  const value = result.value
  return {
    id: result.id,
    runId: result.runId,
    port: result.port,
    type: value.type,
    assetId: 'assetId' in value ? value.assetId : undefined,
    text: value.type === 'text' ? value.text : undefined,
  }
}
