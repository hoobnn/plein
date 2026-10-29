import {
  activeShotNodes,
  expandedNodes,
  linkedShotSequences,
  shotSegmentMapping,
  shotsOf,
  type ShotSource,
} from '@plein/capabilities'
import {
  currentResult,
  currentProductionConfirmation,
  productionContentSnapshot,
  getCreativeReview,
  type CanvasElement,
  type PleinDoc,
} from '@plein/doc'
import { matchLines, SEQUENCE_TYPE, STORYBOARD_TYPE, type Shot } from '@plein/nodes'

export type GuideStepId = 'brief' | 'storyboard' | 'trial' | 'review' | 'batch' | 'delivery'
export type GuideState = 'todo' | 'ready' | 'working' | 'done' | 'attention' | 'skipped'
export type GuideTargetKind =
  | 'text'
  | 'generator'
  | 'storyboard'
  | 'review'
  | 'sequence'
  | 'workbench'
  | 'animatic'
  | 'shot-select'
  | 'sequence-select'
export interface GuideTarget {
  kind: GuideTargetKind
  nodeId: string
  resultId?: string
  clipInstanceId?: string
  /** 代表镜头工作台的镜头 */
  shotId?: string
}
/** 试做一步里的固定子步骤；只按已有事实判断完成与否。 */
export type TrialSubstepId = 'shot' | 'input' | 'generate' | 'review' | 'sample'
export interface TrialSubstep {
  id: TrialSubstepId
  title: string
  state: GuideState
  detail: string
  target?: GuideTarget
}
/** 当前步骤唯一的主操作：直接去做这一步该做的事。 */
export interface GuidePrimary {
  label: string
  target: GuideTarget
}
export interface GuideStep {
  id: GuideStepId
  title: string
  state: GuideState
  detail: string
  target?: GuideTarget
  primary?: GuidePrimary
  substeps?: TrialSubstep[]
}
export interface GuideOptions {
  canvasId?: string
  boardId?: string
  trialShotId?: string
  sequenceId?: string
  staleIds?: ReadonlySet<string>
  keptIds?: ReadonlySet<string>
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
      record.historical !== true &&
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
  const sequences = linkedShotSequences(doc, mediaNodes)
  if (options.canvasId && shots[0]) {
    const mapped = shotSegmentMapping(doc, {
      canvasId: options.canvasId,
      boardId: board.id,
      shotId: shots[0].id,
    })
    for (const id of mapped.sequenceIds) {
      const sequence = doc.get(id)
      if (sequence && !sequences.some((entry) => entry.id === id)) sequences.push(sequence)
    }
  }
  // 尚未展开的单分镜模板保留空序列入口；展开后只接受当前镜头的有效连线。
  if (!sequences.length && boards.length === 1 && expanded.size === 0) {
    const all = elements.filter((el) => el.nodeType === SEQUENCE_TYPE)
    if (
      all.length === 1 &&
      ![...doc.edges()].some((edge) => {
        const upstream = doc.get(edge.from[0])
        return edge.to[0] === all[0]!.id && !!upstream && !!sourceOf(upstream)?.storyboard
      })
    )
      sequences.push(all[0]!)
  }
  const sequenceId = board.production?.selection?.sequenceId ?? options.sequenceId
  const trialShotId = board.production?.selection?.trialShotId ?? options.trialShotId
  const sequence = sequenceId
    ? sequences.find((el) => el.id === sequenceId)
    : sequences.length === 1
      ? sequences[0]
      : undefined
  // 多镜必须由用户明确选定；只有单镜才自动成为代表镜头。
  const explicitTrial = trialShotId ? shots.find((shot) => shot.id === trialShotId) : undefined
  const trialShot = shots.length === 1 ? shots[0] : explicitTrial
  const trialMapping =
    options.canvasId && trialShot && sequence
      ? shotSegmentMapping(doc, {
          canvasId: options.canvasId,
          boardId: board.id,
          shotId: trialShot.id,
          sequenceId: sequence.id,
        })
      : undefined
  const mappedInstances = !trialMapping?.problem ? (trialMapping?.instances ?? []) : []
  const fixedTrial = mappedInstances.filter((row) => row.segment)
  // 只有整镜全部是固定段才跳过生成；固定段与 Live 混用时仍按 Live 节点判断。
  const allFixed = mappedInstances.length > 0 && fixedTrial.length === mappedInstances.length
  const fixedTrialTarget: GuideTarget | undefined =
    fixedTrial[0] && sequence
      ? { kind: 'sequence', nodeId: sequence.id, clipInstanceId: fixedTrial[0].clipInstanceId }
      : undefined
  const trialMissing = !!trialShotId && !explicitTrial && shots.length !== 1
  const staleIds = options.staleIds ?? new Set<string>()
  const keptIds = options.keptIds ?? new Set<string>()
  const progress = shots.map((shot) => ({
    shot,
    value: shotProgress(shot, groups.get(shot.id) ?? [], staleIds),
  }))
  const sample = progress.find((entry) => entry.shot.id === trialShot?.id)?.value
  const brief = briefSources(doc, board.id)
  const briefTarget =
    brief.find((el) => el.kind === 'markdown' || el.nodeType === 'plein/text') ?? brief[0]
  const allRowsValid =
    Array.isArray(board.params?.shots) && shots.length === board.params.shots.length
  const planSignature = allRowsValid ? productionContentSnapshot(board) : undefined
  const reviewSignature = !!board.production?.confirmations.length
  const reviewedPlan =
    !!planSignature &&
    !!options.canvasId &&
    !!currentProductionConfirmation(board, options.canvasId)
  const boardTarget: GuideTarget = { kind: 'storyboard', nodeId: board.id }
  const workbenchTarget: GuideTarget | undefined =
    trialShot && !trialMissing
      ? { kind: 'workbench', nodeId: board.id, shotId: trialShot.id }
      : undefined
  const trialTarget: GuideTarget | undefined = trialMissing
    ? undefined
    : allFixed
      ? fixedTrialTarget
      : sample?.missing
        ? { kind: 'generator', nodeId: sample.missing.id }
        : (workbenchTarget ?? boardTarget)
  const animaticTarget: GuideTarget = { kind: 'animatic', nodeId: board.id }
  const shotSelectTarget: GuideTarget | undefined =
    shots.length > 1 || trialMissing ? { kind: 'shot-select', nodeId: board.id } : undefined
  const reviewNode =
    sample?.nodes.find(
      (el) =>
        currentResult(el) && (getCreativeReview(el)?.status !== 'usable' || staleIds.has(el.id)),
    ) ?? sample?.nodes.find((el) => currentResult(el)?.value.type === 'video')
  const reviewResult = reviewNode && currentResult(reviewNode)
  const reviewTarget: GuideTarget | undefined = allFixed
    ? fixedTrialTarget
    : reviewNode && reviewResult
      ? { kind: 'review', nodeId: reviewNode.id, resultId: reviewResult.id }
      : undefined
  const generated = progress.filter((entry) => entry.value.complete).length
  const allGenerated = shots.length > 0 && generated === shots.length
  const deliveryStale = sequence && staleIds.has(sequence.id)
  const confirmed = deliveryConfirmed(sequence) && !deliveryStale
  const animation = elements.find(
    (el) => el.nodeType === ANIMATIC && el.params?.boardId === board.id,
  )
  // 核对输入没有人工记录，只区分待检查与可核对，永不判为完成。
  const staleInput = sample?.nodes.find((el) => staleIds.has(el.id))
  const keptInput = sample?.nodes.find((el) => keptIds.has(el.id))
  const inputTarget = staleInput ?? keptInput
  const trialSubsteps: TrialSubstep[] = [
    {
      id: 'shot',
      title: '选代表镜头',
      state: trialMissing ? 'attention' : !shots.length ? 'todo' : trialShot ? 'done' : 'todo',
      detail: trialMissing
        ? shots.length
          ? '原试做镜头已移除，请重新选择'
          : '原试做镜头已移除，先到分镜表补充镜头'
        : !shots.length
          ? '还没有镜头，先到分镜表补充'
          : trialShot
            ? `当前试做镜头：镜头 ${trialShot.no} · ${trialShot.description || '未填写画面'}`
            : '顶部选择要试做的一镜',
      target: shots.length ? (shotSelectTarget ?? boardTarget) : boardTarget,
    },
    {
      id: 'input',
      title: '核对实际送入模型的输入',
      state: inputTarget ? 'attention' : 'ready',
      detail: staleInput
        ? '输入已变化，先核对再继续'
        : keptInput
          ? '已保留旧输入的结果，先核对是否仍适用'
          : !shots.length
            ? '先到分镜表补充镜头'
            : !trialShot
              ? '先选定代表镜头，再核对输入'
              : '对照提示词、参考图与实际参数',
      target: inputTarget
        ? { kind: 'generator', nodeId: inputTarget.id }
        : (workbenchTarget ?? fixedTrialTarget),
    },
    {
      id: 'generate',
      title: '生成并采用候选',
      state: allFixed
        ? 'skipped'
        : sample?.ambiguous
          ? 'attention'
          : sample?.complete
            ? 'done'
            : sample?.running
              ? 'working'
              : 'todo',
      detail: allFixed
        ? '本镜是固定段，无需重新生成'
        : sample?.ambiguous
          ? '本镜有重复生成节点，请先在分镜表检查'
          : sample?.complete
            ? '画面、视频与所需声音均已采用'
            : sample?.running
              ? '正在生成'
              : '按所需阶段生成并采用候选',
      target: allFixed ? fixedTrialTarget : workbenchTarget,
    },
    {
      id: 'review',
      title: '人工审阅',
      state: allFixed
        ? 'ready'
        : sample?.needsChanges
          ? 'attention'
          : sample?.approved
            ? 'done'
            : sample?.complete
              ? 'ready'
              : 'todo',
      detail: allFixed
        ? '到序列审看固定段用于当前叙事的效果'
        : sample?.needsChanges
          ? '有采用项被标记为需修改'
          : sample?.approved
            ? '当前采用项均已人工确认可用'
            : sample?.complete
              ? '逐项试听、看片并标记可用'
              : '先生成并采用候选再审阅',
      target: allFixed ? fixedTrialTarget : (reviewTarget ?? workbenchTarget),
    },
    {
      id: 'sample',
      title: '做样片',
      state: !shots.length ? 'todo' : animation ? 'done' : 'ready',
      detail: !shots.length
        ? '先到分镜表补充镜头'
        : animation
          ? '已有样片草稿'
          : '用低成本样片先看节奏',
      target: shots.length ? animaticTarget : boardTarget,
    },
  ]
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
      primary: {
        label: briefTarget?.kind === 'markdown' ? '打开梗概文字' : '打开生成节点',
        target: briefTarget
          ? { kind: briefTarget.kind === 'markdown' ? 'text' : 'generator', nodeId: briefTarget.id }
          : { kind: 'generator', nodeId: board.id },
      },
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
        ? `${shots.length} 镜已有当前范围的人工核对；修改计划会重新待审`
        : shots.length
          ? reviewSignature
            ? '分镜计划或确认范围已变化，请重新核对'
            : `逐行核对 ${shots.length} 镜后，在此明确确认`
          : '尚无分镜，先填写或生成分镜表',
      target: boardTarget,
      primary: { label: '打开分镜表', target: boardTarget },
    },
    {
      id: 'trial',
      title: '试做一镜',
      state: trialMissing
        ? 'attention'
        : allFixed
          ? 'ready'
          : sample?.complete
            ? 'done'
            : sample?.running
              ? 'working'
              : sample?.ambiguous
                ? 'attention'
                : shots.length
                  ? 'ready'
                  : 'todo',
      detail: trialMissing
        ? shots.length
          ? '原试做镜头已移除，请重新选择'
          : '原试做镜头已移除，先到分镜表补充镜头'
        : allFixed
          ? `本镜已映射 ${fixedTrial.length} 个固定段，请先审看当前叙事与声音；实际文件由清单核验`
          : sample?.complete
            ? `镜头 ${trialShot!.no} 的画面、视频及所需声音已有采用结果`
            : sample?.ambiguous
              ? '试做镜头有重复生成节点，请在分镜表检查'
              : shots.length > 1 && !trialShot
                ? '先选定要试做的一镜，再生成候选'
                : animation
                  ? '已有低成本样片计划；也可先只做选定的一镜'
                  : '先展开并只试做选定镜头，避免整批试错',
      target: trialTarget,
      primary: trialMissing
        ? shots.length
          ? { label: '重新选择试做镜头', target: shotSelectTarget! }
          : { label: '打开分镜表补充镜头', target: boardTarget }
        : shots.length > 1 && !trialShot
          ? { label: '选择代表镜头', target: shotSelectTarget! }
          : allFixed && fixedTrialTarget
            ? { label: '打开成片序列', target: fixedTrialTarget }
            : workbenchTarget
              ? { label: '打开代表镜头工作台', target: workbenchTarget }
              : { label: '打开分镜表补充镜头', target: boardTarget },
      substeps: trialSubsteps,
    },
    {
      id: 'review',
      title: '审核样片',
      state:
        trialMissing || sample?.stale || sample?.needsChanges
          ? 'attention'
          : allFixed
            ? 'ready'
            : sample?.approved
              ? 'done'
              : sample?.complete
                ? 'ready'
                : 'todo',
      detail: trialMissing
        ? '先重新选择要审核的试做镜头'
        : allFixed
          ? '请在序列审看固定段用于当前叙事的效果；原出处的人工结论不继承到本镜'
          : sample?.stale
            ? '试做镜头输入已变化，请先查看下游影响'
            : sample?.needsChanges
              ? '当前采用项有人工作出的需修改结论'
              : sample?.approved
                ? '试做镜头当前采用的画面与声音均已人工确认可用'
                : shots.length > 1 && !trialShot
                  ? '先选定代表镜头，再审核试做结果'
                  : '逐项试听、看片并标记可用；生成完成不代表审核通过',
      target: allFixed
        ? fixedTrialTarget
        : !trialMissing && reviewNode && reviewResult
          ? { kind: 'review', nodeId: reviewNode.id, resultId: reviewResult.id }
          : trialMissing
            ? undefined
            : boardTarget,
      primary:
        allFixed && fixedTrialTarget
          ? { label: '打开成片序列', target: fixedTrialTarget }
          : reviewNode && reviewResult
            ? {
                label: '打开候选审阅',
                target: { kind: 'review', nodeId: reviewNode.id, resultId: reviewResult.id },
              }
            : workbenchTarget
              ? { label: '打开代表镜头工作台', target: workbenchTarget }
              : { label: '打开分镜表选择代表镜头', target: boardTarget },
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
      detail: `${generated}/${shots.length} 镜已有完整节点采用项；固定段复用由清单另行核验，在分镜表明确选择要运行的阶段`,
      target: boardTarget,
      primary: { label: '打开分镜表批量生成', target: boardTarget },
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
          : sequenceId && !sequence && !sequences.length
            ? '原交付序列已移除或不再关联，请先检查当前镜头连线'
            : sequences.length && !sequence
              ? sequenceId
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
      primary: sequence
        ? { label: '打开成片序列', target: { kind: 'sequence', nodeId: sequence.id } }
        : sequences.length
          ? {
              label: '选择成片序列',
              target: { kind: 'sequence-select', nodeId: board.id },
            }
          : { label: '打开分镜表连接序列', target: boardTarget },
    },
  ]
  result.next = result.steps.find((step) => step.state !== 'done' && step.state !== 'skipped')?.id
  return result
}
