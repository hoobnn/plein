import { activeShotNodes, expandedNodes, shotsOf, type ShotSource } from '@plein/capabilities'
import { currentResult, getCreativeReview, type CanvasElement, type PleinDoc } from '@plein/doc'
import { matchLines, planVersion, SEQUENCE_TYPE, STORYBOARD_TYPE, type Shot } from '@plein/nodes'

export type GuideStepId = 'brief' | 'storyboard' | 'trial' | 'review' | 'batch' | 'delivery'
export type GuideState = 'todo' | 'ready' | 'working' | 'done' | 'attention' | 'skipped'
export interface GuideTarget {
  kind: 'text' | 'generator' | 'storyboard' | 'review' | 'sequence'
  nodeId: string
  resultId?: string
}
export interface GuideStep {
  id: GuideStepId
  title: string
  state: GuideState
  detail: string
  target?: GuideTarget
}
export interface GuideOptions {
  boardId?: string
  trialShotId?: string
  sequenceId?: string
  /** 本机明确确认过的精确分镜计划；非执行结果或隐式阅读记录。 */
  reviewedPlan?: string
  reviewedPlans?: Readonly<Record<string, string>>
  staleIds?: ReadonlySet<string>
}
export interface GuideFacts {
  boards: Array<{ id: string; name: string }>
  board?: CanvasElement
  shots: Shot[]
  trialShot?: Shot
  sequences: Array<{ id: string; name: string }>
  sequence?: CanvasElement
  planSignature?: string
  steps: GuideStep[]
  next?: GuideStepId
}

const ANIMATIC = 'plein/animatic'
const busy = (el: CanvasElement) => el.run?.status === 'running' || el.run?.status === 'queued'
const resultType = (role: ShotSource['role']) =>
  role === 'speech' || role === 'sfx' ? 'audio' : role
const sourceOf = (el: CanvasElement) => el.params?.source as ShotSource | undefined

/** 只沿当前分镜的输入图找文字，不把其他剧本或游离文字当成已填写的梗概。 */
function briefSources(doc: PleinDoc, boardId: string) {
  const seen = new Set<string>([boardId]),
    queue = [boardId],
    out: CanvasElement[] = []
  const edges = [...doc.edges()]
  while (queue.length) {
    const target = queue.shift()!
    for (const edge of edges) {
      if (edge.to[0] !== target || seen.has(edge.from[0])) continue
      const el = doc.get(edge.from[0])
      if (!el) continue
      seen.add(el.id)
      if (el.kind === 'markdown' || el.nodeType === 'plein/text' || el.nodeType === 'plein/llm') {
        out.push(el)
        queue.push(el.id)
      }
    }
  }
  return out
}
const hasText = (el: CanvasElement) => {
  const value = currentResult(el)?.value
  return !!(
    el.text?.trim() ||
    String(el.params?.text ?? '').trim() ||
    (value?.type === 'text' && value.text.trim())
  )
}

const planSignatureOf = (shots: Shot[]) =>
  `${planVersion(shots)}:${JSON.stringify(shots, (_key, value: unknown) => {
    if (value && typeof value === 'object' && !Array.isArray(value))
      return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
    return value
  })}`

interface ShotProgress {
  complete: boolean
  ambiguous: boolean
  nodes: CanvasElement[]
  missing?: CanvasElement
  running: boolean
  approved: boolean
  needsChanges: boolean
  stale: boolean
}

function shotProgress(
  shot: Shot,
  list: CanvasElement[],
  staleIds: ReadonlySet<string>,
): ShotProgress {
  const speeches = list.filter((el) => sourceOf(el)?.role === 'speech')
  const lines = matchLines(
    speeches.map((el, i) => ({
      id: el.id,
      dialogueId: sourceOf(el)?.dialogueId,
      line: sourceOf(el)?.line ?? i,
      text: String(sourceOf(el)?.plan?.params.text ?? el.params?.text ?? ''),
    })),
    shot.dialogue,
  )
  const nodes: CanvasElement[] = []
  let complete = true,
    ambiguous = false
  const require = (role: ShotSource['role'], line?: number) => {
    const matches = list.filter((el) => {
      const source = sourceOf(el)
      return source?.role === role && (role !== 'speech' || lines.get(el.id) === line)
    })
    if (matches.length !== 1) {
      complete = false
      ambiguous ||= matches.length > 1
      return
    }
    const el = matches[0]!
    nodes.push(el)
    if (currentResult(el)?.value.type !== resultType(role)) complete = false
  }
  require('image')
  require('video')
  shot.dialogue.forEach((line, i) => {
    if (line.line.trim()) require('speech', i)
  })
  if (shot.sfx.trim()) require('sfx')
  return {
    complete,
    ambiguous,
    nodes,
    missing: nodes.find((el) => currentResult(el)?.value.type !== resultType(sourceOf(el)!.role)),
    running: nodes.some(busy),
    approved: complete && nodes.every((el) => getCreativeReview(el)?.status === 'usable'),
    needsChanges: nodes.some((el) => getCreativeReview(el)?.status === 'changes'),
    stale: nodes.some((el) => staleIds.has(el.id)),
  }
}

function deliveryConfirmed(sequence: CanvasElement | undefined) {
  const result = sequence && currentResult(sequence)
  if (!result || result.value.type !== 'video') return false
  const assetId = result.value.assetId
  const records = sequence.deliveries
  if (!Array.isArray(records)) return false
  return records.some((raw: unknown) => {
    if (!raw || typeof raw !== 'object') return false
    const record = raw as Record<string, unknown>
    return (
      record.kind === 'film' &&
      record.resultId === result.id &&
      record.assetId === assetId &&
      typeof record.confirmedAt === 'number' &&
      Number.isFinite(record.confirmedAt) &&
      Array.isArray(record.notes) &&
      record.notes.every(
        (note: unknown) =>
          !!note && typeof note === 'object' && (note as { resolved?: unknown }).resolved === true,
      )
    )
  })
}

/**
 * 事实推导不写文档、不调用平台、不发请求；运行成功只表示已有产物。
 * 多分镜、多关联序列都要求用户选择，已删除的旧选择不会串到另一条创作线。
 */
export function creationGuideFacts(doc: PleinDoc, options: GuideOptions = {}): GuideFacts {
  const elements = [...doc.elements()]
  const boards = elements.filter((el) => el.kind === 'node' && el.nodeType === STORYBOARD_TYPE)
  const board = options.boardId
    ? boards.find((el) => el.id === options.boardId)
    : boards.length === 1
      ? boards[0]
      : undefined
  const result: GuideFacts = {
    boards: boards.map((el) => ({ id: el.id, name: el.name ?? '分镜' })),
    board,
    shots: [],
    sequences: [],
    steps: [],
  }
  if (!board) return result
  const shots = shotsOf(board)
  const activeIds = new Set(shots.map((shot) => shot.id))
  const expanded = expandedNodes(doc, board.id)
  const groups = new Map(
    [...expanded]
      .filter(([id]) => activeIds.has(id))
      .map(([id, list]) => [
        id,
        activeShotNodes(
          shots.find((shot) => shot.id === id)!,
          list,
        ),
      ]),
  )
  const mediaNodes = [...groups.values()].flat()
  const nodeIds = new Set(mediaNodes.map((el) => el.id))
  const linked = new Set(
    [...doc.edges()].filter((edge) => nodeIds.has(edge.from[0])).map((edge) => edge.to[0]),
  )
  const sequences = elements.filter((el) => el.nodeType === SEQUENCE_TYPE && linked.has(el.id))
  // 无展开连线的单分镜模板，可定位唯一成片序列；多分镜时只接受明确连线。
  if (!sequences.length && boards.length === 1) {
    const all = elements.filter((el) => el.nodeType === SEQUENCE_TYPE)
    if (all.length === 1) sequences.push(all[0]!)
  }
  const sequence = options.sequenceId
    ? sequences.find((el) => el.id === options.sequenceId)
    : sequences.length === 1
      ? sequences[0]
      : undefined
  const trialShot = shots.find((shot) => shot.id === options.trialShotId) ?? shots[0]
  const staleIds = options.staleIds ?? new Set<string>()
  const progress = shots.map((shot) => ({
    shot,
    value: shotProgress(shot, groups.get(shot.id) ?? [], staleIds),
  }))
  const sample = progress.find((entry) => entry.shot.id === trialShot?.id)?.value
  const brief = briefSources(doc, board.id)
  const briefTarget =
    brief.find((el) => el.kind === 'markdown' || el.nodeType === 'plein/text') ?? brief[0]
  const planSignature = planSignatureOf(shots)
  const reviewSignature = options.reviewedPlan ?? options.reviewedPlans?.[board.id]
  const reviewedPlan = shots.length > 0 && reviewSignature === planSignature
  const boardTarget: GuideTarget = { kind: 'storyboard', nodeId: board.id }
  const trialTarget: GuideTarget = sample?.missing
    ? { kind: 'generator', nodeId: sample.missing.id }
    : boardTarget
  const reviewNode =
    sample?.nodes.find(
      (el) =>
        currentResult(el) && (getCreativeReview(el)?.status !== 'usable' || staleIds.has(el.id)),
    ) ?? sample?.nodes.find((el) => currentResult(el)?.value.type === 'video')
  const reviewResult = reviewNode && currentResult(reviewNode)
  const generated = progress.filter((entry) => entry.value.complete).length
  const allGenerated = shots.length > 0 && generated === shots.length
  const deliveryStale = sequence && staleIds.has(sequence.id)
  const confirmed = deliveryConfirmed(sequence) && !deliveryStale
  const animation = elements.find(
    (el) => el.nodeType === ANIMATIC && el.params?.boardId === board.id,
  )
  result.shots = shots
  result.trialShot = trialShot
  result.sequence = sequence
  result.planSignature = planSignature
  result.sequences = sequences.map((el) => ({ id: el.id, name: el.name ?? '成片序列' }))
  result.steps = [
    {
      id: 'brief',
      title: '填写梗概',
      state: brief.some(hasText) ? 'done' : shots.length ? 'skipped' : 'ready',
      detail: brief.some(hasText)
        ? '已有连接到这份分镜的文字，仍可随时修改'
        : shots.length
          ? '已直接提供分镜，可跳过或补写梗概'
          : '先写创意或剧本；生成仍使用原有按钮',
      target: briefTarget
        ? { kind: briefTarget.kind === 'markdown' ? 'text' : 'generator', nodeId: briefTarget.id }
        : { kind: 'generator', nodeId: board.id },
    },
    {
      id: 'storyboard',
      title: '审核分镜',
      state: reviewedPlan
        ? 'done'
        : shots.length
          ? reviewSignature
            ? 'attention'
            : 'ready'
          : 'todo',
      detail: reviewedPlan
        ? `${shots.length} 镜已在本机人工核对；修改计划会重新待审`
        : shots.length
          ? reviewSignature
            ? '分镜计划已变化，请重新核对'
            : `逐行核对 ${shots.length} 镜后，在此明确确认`
          : '尚无分镜，先填写或生成分镜表',
      target: boardTarget,
    },
    {
      id: 'trial',
      title: '试做一镜',
      state: sample?.complete
        ? 'done'
        : sample?.running
          ? 'working'
          : sample?.ambiguous
            ? 'attention'
            : shots.length
              ? 'ready'
              : 'todo',
      detail: sample?.complete
        ? `镜头 ${trialShot!.no} 的画面、视频及所需声音已有采用结果`
        : sample?.ambiguous
          ? '试做镜头有重复生成节点，请在分镜表检查'
          : animation
            ? '已有低成本样片计划；也可先只做选定的一镜'
            : '先展开并只试做选定镜头，避免整批试错',
      target: trialTarget,
    },
    {
      id: 'review',
      title: '审核样片',
      state:
        sample?.stale || sample?.needsChanges
          ? 'attention'
          : sample?.approved
            ? 'done'
            : sample?.complete
              ? 'ready'
              : 'todo',
      detail: sample?.stale
        ? '试做镜头输入已变化，请先查看下游影响'
        : sample?.needsChanges
          ? '当前采用项有人工作出的需修改结论'
          : sample?.approved
            ? '试做镜头当前采用的画面与声音均已人工确认可用'
            : '逐项试听、看片并标记可用；生成完成不代表审核通过',
      target:
        reviewNode && reviewResult
          ? { kind: 'review', nodeId: reviewNode.id, resultId: reviewResult.id }
          : boardTarget,
    },
    {
      id: 'batch',
      title: '批量生成',
      state: allGenerated
        ? 'done'
        : progress.some((entry) => entry.value.running)
          ? 'working'
          : shots.length
            ? 'ready'
            : 'todo',
      detail: `${generated}/${shots.length} 镜已有完整采用项；在分镜表明确选择要运行的阶段`,
      target: boardTarget,
    },
    {
      id: 'delivery',
      title: '交付',
      state: deliveryStale
        ? 'attention'
        : confirmed
          ? 'done'
          : sequence && currentResult(sequence)?.value.type === 'video'
            ? 'ready'
            : 'todo',
      detail: deliveryStale
        ? '序列输入已有变化，先检查当前成片是否仍适合交付'
        : confirmed
          ? '当前成片版本已人工确认，修改意见均已处理'
          : sequences.length && !sequence
            ? options.sequenceId
              ? '原交付序列已移除或不再关联，请重新选择'
              : '先选择这份分镜要交付的成片序列'
            : sequence
              ? '打开序列检查成片、修改意见与当前版本的交付确认'
              : '展开镜头并连接成片序列后，可在序列中导出交付',
      target: sequence
        ? { kind: 'sequence', nodeId: sequence.id }
        : sequences.length
          ? undefined
          : boardTarget,
    },
  ]
  result.next = result.steps.find((step) => step.state !== 'done' && step.state !== 'skipped')?.id
  return result
}
