import type { Engine } from '@plein/canvas-core'
import { currentResult, inputEdges, type CanvasElement, type PleinDoc } from '@plein/doc'
import { ASSET_NODE_TYPES, findMentions, sortMentionTargets } from '@plein/nodes'
import { boundReferenceTokens, referenceBindings } from '@plein/plugin-sdk'
import { mentionTargets } from '../../canvas/nodes'

/** 引用绑定在正文里的遮蔽方式：服务端只把这些位置换成素材编号，不再当普通 @ 解析 */
type MaskMode = 'all' | 'external' | 'none'

/** 一段会被服务端消费的文本，以及它的绑定参数和遮蔽方式 */
interface TextSource {
  text: string
  params: Record<string, unknown>
  mode: MaskMode
}

export interface PreviewKeyOptions {
  /**
   * 这个节点是否按「参考模式」发送素材：图片生成，或多模态参考模式的视频。
   * 参考模式下所有绑定 token 都由绑定解析（不再当普通 @），其它能力只遮蔽外部失效绑定。
   * 缺省按核心节点类型判断；插件节点请由调用方传入。
   */
  referenceMode?: boolean
}

/**
 * 会影响这个节点实际输入的文档状态摘要。
 *
 * 只收进本节点、实际消费到的上游（已生成的上游到它的结果为止，不展开未提交的草稿），
 * 以及提示词里真正生效的 @（含它们的参数和连入的定妆图）：
 * 移动节点、改无关节点、任务进度这类文档更新不改变摘要，实际输入预览就不必重取。
 * 采用、结果身份、输入顺序、参数、音色、模型、@ 点名与同名歧义都算在内。
 *
 * 绑定的 token 与服务端一致地遮蔽：跨画布失效绑定（目标画布有同名素材）不当普通 @ 解析，
 * 因此改同名素材不会误刷新；绑定本身的身份（参数）和它指向的本画布来源仍参与摘要。
 */
export function previewInputKey(
  engine: Engine,
  nodeId: string,
  options: PreviewKeyOptions = {},
): string {
  const { doc } = engine
  const parts: unknown[] = []
  const visited = new Set<string>()
  const sources: TextSource[] = []
  /** 绑定指向本画布来源时，来源本身也是依赖（换采用/换素材都要重取预览） */
  const boundSources = new Map<string, { source: string; port?: string }>()
  const consumer = doc.get(nodeId)
  const referenceMode = options.referenceMode ?? defaultReferenceMode(consumer)
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
    // 只有本节点自己的参数在这里收集；上游文本随连线一起处理（绑定参数要合并）
    if (el === consumer) sources.push(...ownTextSources(el, referenceMode))
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
      const params = source ? mergedParams(source, el) : {}
      const mode = textMaskMode(referenceMode)
      if (current?.text) sources.push({ text: current.text, params, mode })
      // 上游这个输出口已经有结果时，服务端直接用那份结果，不读它的参数和上游：
      // 在这里截断，编辑它还没运行的草稿不会让下游预览失效。换采用会换结果 id，仍会发现。
      if (current) continue
      if (source) for (const text of textValues(source)) sources.push({ text, params, mode })
      queue.push(edge.from[0])
    }
  }
  // @ 引用按名字解析：只有被提示词命中、且没有被绑定遮蔽的目标才让预览失效
  const targets = sortMentionTargets(
    mentionTargets(engine).filter((target) => target.id !== nodeId),
  )
  const referenced = new Set<string>()
  for (const source of sources) {
    const masked = maskedTokenStarts(doc, source)
    for (const token of masked) {
      const binding = referenceBindings(source.params)[token.name]
      const id = binding?.source
      if (id && doc.has(id) && id !== nodeId)
        boundSources.set(`${id}:${binding.sourcePort ?? ''}`, {
          source: id,
          ...(binding.sourcePort ? { port: binding.sourcePort } : {}),
        })
    }
    for (const mention of findMentions(source.text, targets)) {
      // 服务端遮的是整段绑定（名字里可能再带一个 @），区间内的 @ 都不算普通引用
      if (masked.some((token) => mention.start >= token.start && mention.start < token.end))
        continue
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
    parts.push({ reference: id, ...referenceSourceParts(doc, el) })
  }
  for (const { source, port } of boundSources.values()) {
    const el = doc.get(source)
    parts.push({
      bindingSource: source,
      ...(port ? { port } : {}),
      ...(el ? referenceSourceParts(doc, el, port) : { missing: true }),
    })
  }
  return JSON.stringify(parts)
}

/** 节点是否按参考模式发送素材：图片生成，或多模态参考模式的视频；生成器与审片共用 */
export function referenceModeOf(
  capability: string | undefined,
  params: Record<string, unknown> | undefined,
) {
  return (
    capability === 'image.generate' ||
    (capability === 'video.generate' && params?.mode === 'reference')
  )
}

/** 缺省判断由节点能力给出；没有目录信息时按核心节点类型兜底 */
function defaultReferenceMode(el: CanvasElement | undefined) {
  if (!el) return false
  return referenceModeOf(
    el.nodeType === 'plein/image'
      ? 'image.generate'
      : el.nodeType === 'plein/video'
        ? 'video.generate'
        : undefined,
    el.params,
  )
}

function textMaskMode(referenceMode: boolean): MaskMode {
  return referenceMode ? 'all' : 'external'
}

/** 节点自身被消费的文本：参考模式下只有 prompt 按全部绑定遮蔽，其它参数不遮 */
function ownTextSources(el: CanvasElement, referenceMode: boolean | null): TextSource[] {
  const out: TextSource[] = []
  for (const [key, value] of Object.entries(el.params ?? {})) {
    if (typeof value !== 'string' || !value.includes('@')) continue
    // null 表示这是上游元素而不是本次运行的发图节点：按非参考模式处理
    const mode: MaskMode =
      referenceMode === null
        ? 'none'
        : key === 'prompt'
          ? textMaskMode(referenceMode)
          : referenceMode
            ? 'none'
            : 'external'
    out.push({ text: value, params: el.params ?? {}, mode })
  }
  if (typeof el.text === 'string' && el.text.includes('@'))
    out.push({ text: el.text, params: el.params ?? {}, mode: referenceMode ? 'all' : 'external' })
  return out
}

/**
 * 服务端会在这些位置换掉绑定 token，不再当普通 @ 解析：
 * 参考模式遮全部绑定；其它能力只遮「绑定来源不在本画布」的失效/跨画布绑定。
 */
function maskedTokenStarts(doc: { has(id: string): boolean }, source: TextSource) {
  if (source.mode === 'none') return []
  const bindings = referenceBindings(source.params)
  return boundReferenceTokens(source.text, source.params).filter((token) =>
    source.mode === 'all'
      ? true
      : !!bindings[token.name]?.source && !doc.has(bindings[token.name]!.source!),
  )
}

function mergedParams(el: CanvasElement, consumer: CanvasElement): Record<string, unknown> {
  return { ...el.params, ...consumer.params }
}

/**
 * 被引用/被绑定的来源：真正消费结果的生成节点只记当前结果；
 * 角色/场景等资产卡即使文档里有结果，服务端仍读档案、音色和连入的参考图，必须展开。
 */
function referenceSourceParts(doc: PleinDoc, el: CanvasElement, port?: string) {
  const card = el.kind === 'node' && !!el.nodeType && ASSET_NODE_TYPES.has(el.nodeType)
  const current = card ? null : resultKey(el, port)
  if (current) return { current }
  return {
    source: elementKey(el),
    run: runStateKey(el),
    edges: inputEdges(doc, el.id).map((edge) => {
      const from = doc.get(edge.from[0])
      const fromCurrent = from ? resultKey(from, edge.from[1]) : null
      return {
        ref: edge.id,
        from: [edge.from[0], edge.from[1]],
        current: fromCurrent,
        // 已生成的定妆图：服务端只用当前结果，未运行的草稿不算依赖；
        // 还没有结果时才需要它的参数与最新失败状态（会改变引用提示/阻断）
        ...(fromCurrent || !from ? {} : { source: elementKey(from), run: runStateKey(from) }),
      }
    }),
  }
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

/**
 * 没有结果时上游的最新失败状态：失败原因会改变服务端的提示/阻断。
 * 排队、运行中、进度百分比都不影响「还没有结果」这条语义，不参与摘要。
 */
function runStateKey(el: CanvasElement) {
  const run = el.run
  if (!run || run.status !== 'failed') return null
  return { error: run.error ?? null, errorCode: run.errorCode ?? null }
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
