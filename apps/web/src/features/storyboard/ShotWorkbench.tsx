import { resolveShotAsset } from '@plein/capabilities'
import type { Engine } from '@plein/canvas-core'
import {
  continuityDependents,
  continuityOf,
  creativeReviewTarget,
  getCreativeReview,
  currentResult,
  relatedResult,
  sameCreativeReviewTarget,
  type CreativeReviewTarget,
  type NodeResult,
} from '@plein/doc'
import { hasVoice, voiceOf, type ShotRole, type VoiceRef } from '@plein/nodes'
import { useQuery } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, assetUrls } from '../../api/client'
import { useDocVersion } from '../../canvas/hooks'
import { mentionTargets, upstreams } from '../../canvas/nodes'
import { useCanvas } from '../../stores/canvas'
import { useCatalog } from '../../stores/catalog'
import { useSession } from '../../stores/session'
import { Modal, ModalHeader } from '../../ui/Modal'
import { Select } from '../../ui/Select'
import { Icon } from '../../ui/icons'
import { useStale } from '../runs/stale'
import { BatchChecklist } from './BatchChecklist'
import { reviewLabels } from './CreativeReviewForm'
import type { ContinuityNoteView } from './ContinuityNoteForm'
import { adoptedContinuityText } from './reviewTags'
import { expandedNodes, shotsOf, type ShotSource } from './model'
import { reviewNodesForShot, shotReviewStatus } from './reviewModel'
import { ShotControls } from './ShotControls'
import { ShotContinuityReview } from './ShotContinuityReview'
import { ShotPlanForm } from './ShotStatePanel'
import { ShotSegmentReferences } from './ShotSegmentReferences'
import { StoryboardSync } from './StoryboardSync'
import {
  applyWorkbenchDraft,
  WORKBENCH_FIELDS,
  workbenchDownstream,
  workbenchDraft,
  type WorkbenchDraft,
} from './shotWorkbenchModel'
import { useWindowKeyDown } from '../../ui/useWindowKeyDown'
import { CandidateInspection } from './CandidateInspection'
import { ObservationSummary } from './ObservationSummary'
import { ShotComparison } from './ShotComparison'
import { ShotSummary } from './ShotSummary'
import { SourceQuotes } from './SourceQuotes'
import { roles } from './shotWorkbench.utils'

const labels = {
  description: '画面描述',
  imagePrompt: '分镜图提示词',
  motionPrompt: '视频运动提示词',
  lighting: '光影',
}
const engineKeys = new WeakMap<Engine, number>()
let nextEngineKey = 0
function engineKey(engine: Engine) {
  if (!engineKeys.has(engine)) engineKeys.set(engine, ++nextEngineKey)
  return engineKeys.get(engine)!
}

/** 候选结果 → 验收目标；只有图片 / 视频结果可挂意见。 */
function continuityTargetOf(result: NodeResult | undefined): CreativeReviewTarget | undefined {
  const value = result?.value
  return result && value && (value.type === 'video' || value.type === 'image')
    ? { kind: value.type, assetId: value.assetId, resultId: result.id }
    : undefined
}

export function ShotWorkbench() {
  const engine = useCanvas((s) => s.engine),
    canvasId = useCanvas((s) => s.canvasId),
    target = useCanvas((s) => s.shotWorkbench)
  if (!engine || !canvasId || !target) return null
  return (
    <WorkbenchSession
      key={`${engineKey(engine)}:${canvasId}:${target.boardId}`}
      engine={engine}
      canvasId={canvasId}
      {...target}
    />
  )
}

function WorkbenchSession(props: {
  engine: Engine
  canvasId: string
  boardId: string
  shotId: string
}) {
  // 切镜保留尚未保存的字段；离开本次工作台后不跨项目复用草稿。
  const drafts = useRef(new Map<string, WorkbenchDraft>())
  return <Workbench key={props.shotId} {...props} drafts={drafts.current} />
}

function Workbench({
  engine,
  canvasId,
  boardId,
  shotId,
  drafts,
}: {
  engine: Engine
  canvasId: string
  boardId: string
  shotId: string
  drafts: Map<string, WorkbenchDraft>
}) {
  const version = useDocVersion(engine.doc)
  const catalog = useCatalog((s) => s.catalog)
  const currentShotButton = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const button = currentShotButton.current
    const strip = button?.parentElement
    if (button && strip)
      strip.scrollLeft =
        button.offsetLeft - strip.offsetLeft - strip.clientWidth / 2 + button.clientWidth / 2
  }, [shotId])
  const principal = useSession((s) => s.info?.principal)
  const staleNodes = useStale((s) => s.nodes)
  const [boardMap] = useState(() => engine.doc.elementMaps.get(boardId))
  const [draft, updateDraft] = useState(
    () => drafts.get(shotId) ?? workbenchDraft(engine.doc, boardId, shotId),
  )
  const setDraft = (next: WorkbenchDraft | undefined) => {
    if (next) drafts.set(shotId, next)
    else drafts.delete(shotId)
    updateDraft(next)
  }
  const [selectedNode, setSelectedNode] = useState('')
  const [child, setChild] = useState<'controls' | 'sync' | 'pair' | null>(null)
  const [batch, setBatch] = useState<{ role: ShotRole; reuseExisting: boolean } | null>(null)
  const [sequenceId, setSequenceId] = useState(
    () => engine.doc.get(boardId)?.production?.target?.sequenceId ?? '',
  )
  const [error, setError] = useState('')
  const active = useCallback(() => {
    const state = useCanvas.getState(),
      target = state.shotWorkbench
    return (
      state.engine === engine &&
      state.canvasId === canvasId &&
      target?.boardId === boardId &&
      target.shotId === shotId &&
      !engine.doc.ydoc.isDestroyed &&
      engine.doc.elementMaps.get(boardId) === boardMap &&
      engine.doc.get(boardId)?.nodeType === 'plein/storyboard' &&
      !!workbenchDraft(engine.doc, boardId, shotId)
    )
  }, [engine, canvasId, boardId, shotId, boardMap])
  const writable = useCallback(() => {
    const actor = useSession.getState().info?.principal
    return active() && !engine.doc.readOnly && !!actor && actor.role !== 'viewer'
  }, [active, engine])
  const canWrite = !!principal && principal.role !== 'viewer' && writable()
  const close = () => {
    const state = useCanvas.getState()
    if (
      state.engine === engine &&
      state.shotWorkbench?.boardId === boardId &&
      state.shotWorkbench.shotId === shotId
    )
      state.openShotWorkbench(null)
  }
  const shots = shotsOf(engine.doc.get(boardId)),
    shot = shots.find((s) => s.id === shotId)
  const groups = expandedNodes(engine, boardId),
    nodes = shot ? reviewNodesForShot(shot, groups.get(shotId) ?? []) : []
  const imageNode = nodes.find((n) => (n.params?.source as ShotSource)?.role === 'image')
  const videoNode = nodes.find((n) => (n.params?.source as ShotSource)?.role === 'video')
  const imageReady = imageNode && currentResult(imageNode)?.value.type === 'image'
  const videoReady = videoNode && currentResult(videoNode)?.value.type === 'video'
  // 本镜的下一步：已有采用视频就先处理候选（采用 / 审阅），文生视频等没有分镜图也不阻塞在补图上
  const nextRole = videoReady
    ? undefined
    : videoNode
      ? imageNode && !imageReady
        ? ('image' as const)
        : ('video' as const)
      : imageReady
        ? ('video' as const)
        : ('image' as const)
  const node =
    (selectedNode ? nodes.find((n) => n.id === selectedNode) : undefined) ??
    (videoReady ? videoNode : imageReady ? (videoNode ?? imageNode) : (imageNode ?? nodes[0]))
  // 摘要与送入状态以分镜图阶段为准（无分镜图节点时看视频节点）；角色 / 场景参考图从这里送入模型（按当前输入预览）
  const statusNode = imageNode ?? videoNode
  const statusRole: 'image' | 'video' = statusNode === videoNode && !imageNode ? 'video' : 'image'
  const assetInput = useQuery({
    queryKey: ['shot-asset-input', canvasId, boardId, shotId, statusNode?.id, version],
    enabled: !!statusNode && active(),
    retry: false,
    gcTime: 0,
    queryFn: async () => {
      const value = await api.nodeInput(canvasId, statusNode!.id)
      if (!active() || value.nodeId !== statusNode!.id || !engine.doc.has(statusNode!.id))
        throw new Error('阶段已变化')
      return value
    },
  })
  // 候选区在默认查看的候选上是否已有主操作；对照区只在没有时才升为主按钮，保持全屏一个主动作。
  // 查看的候选状态提升到父层，切历史候选时对照区能同步回退为次要按钮
  const [viewing, setViewing] = useState<{ nodeId: string; candidateId: string } | null>(null)
  const viewedCandidateId = viewing && node && viewing.nodeId === node.id ? viewing.candidateId : ''
  const inspected = node
    ? viewedCandidateId
      ? node.results?.find((r) => r.id === viewedCandidateId)
      : (currentResult(node) ?? node.results?.[0])
    : undefined
  const inspectedAdopted = !!(
    node &&
    inspected &&
    currentResult(node, inspected.port)?.id === inspected.id
  )
  const inspectedValue = inspected?.value
  const inspectedReview =
    node && inspectedValue && 'assetId' in inspectedValue
      ? node.reviews?.find(
          (review) =>
            review.target.resultId === inspected!.id &&
            review.target.assetId === inspectedValue.assetId &&
            review.target.kind === inspectedValue.type,
        )
      : undefined
  const candidatePrimary =
    !node ||
    !inspected ||
    (!!nextRole && (!inspected || inspectedAdopted)) ||
    !inspectedAdopted ||
    (inspectedAdopted && !nextRole && inspectedReview?.status !== 'usable')
  const currentDraft = workbenchDraft(engine.doc, boardId, shotId)
  // 摘要档案项的来源：有生成节点时读所展示阶段的实际提示词（未同步就是空，如实显示），
  // 否则按生成计划回退（分镜图用 imagePrompt，缺则 description）
  const summaryPrompt = statusNode
    ? {
        text: typeof statusNode.params?.prompt === 'string' ? statusNode.params.prompt : '',
        source: statusRole === 'image' ? '按分镜图阶段' : '按视频阶段',
      }
    : {
        text:
          [shot?.imagePrompt, shot?.description].find(
            (text) => typeof text === 'string' && text.trim(),
          ) ?? '',
        source: '按镜头计划推导',
      }
  // oxlint-disable react-hooks/exhaustive-deps -- version 变化即文档变化，重扫全画布提及目标
  const mentionTargetList = useMemo(() => mentionTargets(engine), [engine, version])
  // oxlint-enable react-hooks/exhaustive-deps
  // 配音节点显式指定的音色优先于角色卡沿用（服务端同一规则）。
  // 展开出的配音节点没有 prompt：按 source.dialogueId 找到台词，
  // 再按台词 speaker 绑定（缺省用出场绑定）映射到角色；同一角色多句不一致时单独提示
  const speechVoices = useMemo(() => {
    const map = new Map<string, VoiceRef[]>()
    if (!shot) return map
    for (const node of groups.get(shotId) ?? []) {
      const source = node.params?.source as ShotSource | undefined
      if (source?.role !== 'speech' || source.detached || !source.dialogueId) continue
      const voice = voiceOf(node.params)
      if (!hasVoice(voice)) continue
      const line = shot.dialogue.find((d) => d.id === source.dialogueId)
      if (!line) continue
      const asset = resolveShotAsset(
        engine.doc,
        line.character,
        line.speaker ?? shot.assetBindings?.[line.character],
      )
      if (!asset) continue
      const list = map.get(asset.id) ?? []
      if (!list.some((v) => v.provider === voice.provider && v.voiceId === voice.voiceId))
        list.push(voice)
      map.set(asset.id, list)
    }
    return map
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- version 变化即文档变化
  }, [engine, shot, shotId, groups, version])
  const changed = draft?.source !== currentDraft?.source
  const downstream = workbenchDownstream(
    engine.doc,
    nodes.map((n) => n.id),
  )
  const dependents = continuityDependents(
    continuityOf(engine.doc, boardId),
    shotId,
    new Set(shots.map((s) => s.id)),
  )
  const previous = shots[shots.findIndex((s) => s.id === shotId) - 1]
  const video = nodes.find((n) => (n.params?.source as ShotSource)?.role === 'video')
  const beforeVideo =
    previous &&
    (groups.get(previous.id) ?? []).find((n) => (n.params?.source as ShotSource)?.role === 'video')
  const currentIndex = shots.findIndex((item) => item.id === shotId)
  const references = node ? [...upstreams(engine, node.id, catalog).values()].flat() : []
  // 衔接意见记在本镜已采用候选上（有视频候选用视频，否则用镜头图）；
  // 查看其他候选时表单只读，展示该候选自己的意见
  const continuityNode = [
    { node: videoNode, type: 'video' as const },
    { node: imageNode, type: 'image' as const },
  ].find(
    ({ node, type }) => !!node && (node.results ?? []).some((r) => r.value.type === type),
  )?.node
  const continuityAdoptedTarget = continuityNode ? creativeReviewTarget(continuityNode) : undefined
  const continuityAdoptedReview = continuityNode
    ? getCreativeReview(continuityNode, continuityAdoptedTarget)
    : undefined
  const continuityAdoptedResult = continuityNode ? currentResult(continuityNode) : undefined
  const continuityViewedRaw =
    continuityNode && viewing?.nodeId === continuityNode.id
      ? continuityNode.results?.find((r) => r.id === viewing.candidateId)
      : undefined
  // 没有采用项且未指定候选时不默认挑待选，提示先采用
  const continuityViewed = continuityViewedRaw ?? continuityAdoptedResult
  // 视频节点查看尾帧等非视频结果时，复用同组关联规则找所属视频候选，唯一匹配才映射；
  // 同次运行多组或旧数据无法唯一配对时不猜，表单只读并说明
  const continuityPrimaryType =
    continuityNode === videoNode ? ('video' as const) : ('image' as const)
  const continuityPrimaryPort = continuityNode?.ports?.outputs[0]?.id
  const continuityViewedPrimary = !continuityViewed
    ? undefined
    : continuityViewed.value.type === continuityPrimaryType
      ? continuityViewed
      : continuityPrimaryPort
        ? relatedResult(continuityNode?.results ?? [], continuityViewed, continuityPrimaryPort)
        : undefined
  const continuityTailUnmapped =
    !!continuityViewed &&
    continuityViewed.value.type !== continuityPrimaryType &&
    !continuityViewedPrimary
  // 查看的阶段节点与衔接目标不同，且该节点上有候选可看时才视为不一致：只读并引导切回。
  // 展示节点没有候选的默认状态不算，表单可写并用一行标明写入目标
  const continuityStageDiff = !!continuityNode && !!node && node.id !== continuityNode.id
  const continuityStageHasCandidates = !!node && !!(node.results ?? []).length
  const continuityStageMismatch = continuityStageDiff && continuityStageHasCandidates
  const continuityTargetName = continuityNode === videoNode ? '视频' : '镜头图'
  const continuityStageHint = `衔接意见记在${continuityTargetName}候选上`
  const continuityNeedAdopt = !!continuityNode && !continuityAdoptedTarget && !continuityViewedRaw
  const continuityViewedTarget = continuityTargetOf(continuityViewedPrimary)
  const continuityViewingAdopted = sameCreativeReviewTarget(
    continuityViewedTarget,
    continuityAdoptedTarget,
  )
  const continuity = {
    node: continuityNode,
    view: {
      target: continuityAdoptedTarget,
      targetReview: continuityAdoptedReview,
      viewingAdopted: continuityViewingAdopted,
      viewedTarget: continuityViewingAdopted ? undefined : continuityViewedTarget,
      viewedReview: continuityViewingAdopted
        ? undefined
        : getCreativeReview(continuityNode, continuityViewedTarget),
      adoptedOpinion: continuityViewingAdopted
        ? undefined
        : adoptedContinuityText(continuityAdoptedReview),
      needAdopt: continuityNeedAdopt,
      unmappedTail: continuityTailUnmapped,
      targetStageLabel:
        continuityStageDiff && !continuityStageMismatch && !continuityNeedAdopt
          ? `记在${continuityTargetName}候选上`
          : undefined,
      stageMismatch: continuityStageMismatch
        ? {
            hint: continuityStageHint,
            switchLabel: `切到${continuityTargetName}阶段`,
          }
        : undefined,
    } satisfies ContinuityNoteView,
  }
  const changeShot = (id: string) => {
    if (!active() || id === shotId || !shots.some((item) => item.id === id)) return
    if (draft) drafts.set(shotId, draft)
    useCanvas.getState().openShotWorkbench({ boardId, shotId: id })
  }
  useWindowKeyDown((event) => {
    if (
      event.defaultPrevented ||
      !event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      child ||
      batch
    )
      return
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    // 有其他弹窗盖在工作台上时不抢按键（如验收弹窗、生成清单）
    const layers = document.querySelectorAll<HTMLElement>('[data-plein-modal-layer]')
    const top = [...layers].reduce<HTMLElement | undefined>(
      (acc, el) =>
        !acc || Number(el.dataset.pleinModalLayer) >= Number(acc.dataset.pleinModalLayer)
          ? el
          : acc,
      undefined,
    )
    if (top && top !== document.querySelector('[aria-label="镜头工作台"]')) return
    const target = event.target
    if (
      target instanceof Element &&
      target.closest('input, textarea, select, [contenteditable="true"]')
    )
      return
    // 首/末镜也不让浏览器把 Alt+方向键当历史前进后退
    event.preventDefault()
    const next = shots[currentIndex + (event.key === 'ArrowLeft' ? -1 : 1)]
    if (next) changeShot(next.id)
  })
  const original = draft ? (JSON.parse(draft.source) as Record<string, unknown>) : undefined
  const dirty =
    !!draft &&
    WORKBENCH_FIELDS.some(
      (field) =>
        draft.values[field] !== (typeof original?.[field] === 'string' ? original[field] : ''),
    )
  const locate = (id: string, sequence = false) => {
    if (!active() || !engine.doc.has(id)) return
    close()
    engine.selection.set([id])
    engine.zoomToFit([id])
    if (sequence) useCanvas.getState().openSequence(id)
  }
  return (
    <>
      <Modal label="镜头工作台" onClose={close} isolateKeys className="plein-shot-workspace">
        <ModalHeader
          title={`镜头工作台 · 镜头 ${shot?.no ?? '已删除'}`}
          onClose={close}
          meta={
            <span className="text-xs text-ink-subtle">
              {engine.doc.get(boardId)?.name ?? '分镜制作'}
            </span>
          }
        >
          <button
            type="button"
            className="ui-btn ui-btn-secondary"
            disabled={!active()}
            onClick={() => {
              if (active()) useCanvas.getState().openStoryboard(boardId)
            }}
          >
            返回分镜表
          </button>
          <button
            type="button"
            className="ui-btn ui-btn-secondary"
            disabled={!active()}
            onClick={() => locate(boardId)}
          >
            定位分镜
          </button>
        </ModalHeader>
        <div className="plein-shot-workspace-body" data-testid="shot-workbench">
          {!shot || !currentDraft ? (
            <p role="alert">镜头已删除或身份重复，请返回分镜核对。</p>
          ) : (
            <>
              <div className="plein-shot-workspace-context flex flex-wrap gap-3 items-center text-sm">
                <div>
                  当前镜头{' '}
                  <Select
                    aria-label="工作台镜头"
                    className="ui-input"
                    value={shotId}
                    options={shots.map((s) => ({
                      value: s.id,
                      label: `镜头 ${s.no} · ${s.description.slice(0, 40)}`,
                    }))}
                    onChange={changeShot}
                  />
                </div>
                <span className="text-xs text-ink-muted">
                  {shot.shotSize} · {shot.duration} 秒
                </span>
                <span className="text-xs text-ink-muted">
                  创作验收：{reviewLabels[shotReviewStatus(nodes, shot)]}
                </span>
                {dirty && (
                  <span role="status" className="text-xs text-warning">
                    本镜有未保存字段，切镜时保留，关闭工作台后丢弃。
                  </span>
                )}
                {!canWrite && <span role="status">当前只读，可查看已有依据与候选。</span>}
              </div>
              {error && (
                <p role="alert" className="text-danger">
                  {error}
                </p>
              )}
              <div className="plein-shot-workspace-columns">
                <section aria-label="当前镜头计划" className="plein-shot-workspace-plan space-y-3">
                  <div className="space-y-3">
                    <div>
                      <p className="text-xs text-ink-subtle">脚本与提示词</p>
                      <h3 className="font-medium">当前镜头计划</h3>
                    </div>
                    {changed && (
                      <p role="status" className="text-warning">
                        镜头内容已有新版本，当前草稿保留，请重新载入后再保存。
                      </p>
                    )}
                    {draft &&
                      WORKBENCH_FIELDS.map((field) => (
                        <label key={field} className="block text-sm">
                          {labels[field]}
                          <textarea
                            aria-label={`工作台${labels[field]}`}
                            className="ui-input w-full text-base"
                            rows={3}
                            disabled={!canWrite}
                            value={draft.values[field]}
                            onChange={(e) =>
                              setDraft({
                                ...draft,
                                values: { ...draft.values, [field]: e.target.value },
                              })
                            }
                          />
                        </label>
                      ))}
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        className="ui-btn ui-btn-secondary"
                        disabled={!canWrite || changed || !draft}
                        onClick={() => {
                          if (
                            !writable() ||
                            !draft ||
                            !applyWorkbenchDraft(engine.doc, boardId, draft)
                          )
                            return setError('目标、字段或权限已变化，草稿未写入')
                          setDraft(workbenchDraft(engine.doc, boardId, shotId))
                          setError('')
                        }}
                      >
                        保存本镜字段
                      </button>
                      <button
                        type="button"
                        className="ui-btn ui-btn-secondary"
                        onClick={() => {
                          if (active()) setDraft(workbenchDraft(engine.doc, boardId, shotId))
                        }}
                      >
                        重新载入本镜
                      </button>
                      <button
                        type="button"
                        className="ui-btn ui-btn-secondary"
                        disabled={!canWrite}
                        onClick={() => setChild('controls')}
                      >
                        镜头控制
                      </button>
                      <button
                        type="button"
                        className="ui-btn ui-btn-secondary"
                        disabled={!canWrite}
                        onClick={() => setChild('sync')}
                      >
                        核对本镜计划差异
                      </button>
                    </div>
                  </div>
                  <ShotSummary
                    engine={engine}
                    shot={shot}
                    promptText={summaryPrompt.text}
                    promptSource={summaryPrompt.source}
                    targets={mentionTargetList}
                    speechVoices={speechVoices}
                    input={assetInput}
                    onLocate={locate}
                    onChoose={() => useCanvas.getState().openStoryboard(boardId)}
                  />
                  <details>
                    <summary>固定原文与本镜映射</summary>
                    <SourceQuotes
                      engine={engine}
                      boardId={boardId}
                      shotId={shotId}
                      onLocateSource={(id) => locate(id)}
                    />
                  </details>
                  <details>
                    <summary>本镜当前与历史观察</summary>
                    <ObservationSummary
                      engine={engine}
                      canvasId={canvasId}
                      boardId={boardId}
                      shotId={shotId}
                    />
                  </details>
                  <details>
                    <summary>镜头目的与起止状态</summary>
                    <ShotPlanForm
                      engine={engine}
                      canvasId={canvasId}
                      boardId={boardId}
                      shotId={shotId}
                      isCurrent={writable}
                    />
                  </details>
                </section>
                <section
                  aria-label="本镜候选与执行依据"
                  className="plein-shot-workspace-preview space-y-3"
                >
                  <ShotComparison
                    engine={engine}
                    canvasId={canvasId}
                    boardId={boardId}
                    previous={previous}
                    shot={shot}
                    groups={groups}
                    onReview={() => setChild('pair')}
                    candidatePrimary={candidatePrimary}
                    canReview={
                      !!beforeVideo &&
                      !!video &&
                      currentResult(beforeVideo)?.value.type === 'video' &&
                      currentResult(video)?.value.type === 'video'
                    }
                    continuity={continuity}
                    writable={writable}
                    onSwitchStage={() => {
                      if (continuityNode) setSelectedNode(continuityNode.id)
                    }}
                  />
                  <div className="space-y-3">
                    <div>
                      <p className="text-xs text-ink-subtle">预览与审片</p>
                      <h3 className="font-medium">候选</h3>
                    </div>
                    {!node ? (
                      <div className="plein-shot-preview-empty" role="status">
                        <Icon name="video" size={24} />
                        <p>从此镜的镜头图开始</p>
                      </div>
                    ) : (
                      <CandidateInspection
                        key={node.id}
                        engine={engine}
                        boardId={boardId}
                        shotId={shotId}
                        canvasId={canvasId}
                        node={node}
                        active={active}
                        writable={writable}
                        stale={staleNodes.has(node.id)}
                        onLocate={() => locate(node.id)}
                        generationRole={nextRole}
                        selected={viewedCandidateId}
                        onSelect={(candidateId) => setViewing({ nodeId: node.id, candidateId })}
                        sharedInput={statusNode?.id === node.id ? assetInput : undefined}
                        onGenerate={(role) => {
                          if (writable()) setBatch({ role, reuseExisting: false })
                        }}
                      />
                    )}
                    {!node && (
                      <button
                        type="button"
                        className="ui-btn ui-btn-primary"
                        disabled={!canWrite}
                        onClick={() => {
                          if (writable()) setBatch({ role: 'image', reuseExisting: false })
                        }}
                      >
                        生成镜头图
                      </button>
                    )}
                    {!!nodes.length && (
                      <details>
                        <summary>阶段节点 · {nodes.length} 个</summary>
                        <div className="block text-sm">
                          阶段节点{' '}
                          <Select
                            aria-label="工作台阶段节点"
                            className="ui-input w-full"
                            value={node?.id ?? selectedNode}
                            options={[
                              { value: '', label: '请选择阶段' },
                              ...nodes.map((n) => ({
                                value: n.id,
                                label: `${roles[(n.params?.source as ShotSource)?.role] ?? '节点'} · ${n.name ?? n.id}`,
                              })),
                            ]}
                            onChange={setSelectedNode}
                          />
                        </div>
                      </details>
                    )}
                    <details>
                      <summary>更多生成选项</summary>
                      <div className="flex flex-wrap gap-2">
                        {(['image', 'video', 'speech', 'sfx'] as const).map((role) => (
                          <button
                            key={role}
                            type="button"
                            className="ui-btn ui-btn-secondary"
                            disabled={!canWrite}
                            onClick={() => {
                              if (writable()) setBatch({ role, reuseExisting: false })
                            }}
                          >
                            本镜{roles[role]}生成清单
                          </button>
                        ))}
                        <button
                          type="button"
                          className="ui-btn ui-btn-secondary"
                          disabled={!canWrite}
                          onClick={() => {
                            if (writable()) setBatch({ role: 'video', reuseExisting: true })
                          }}
                        >
                          本镜视频缺项清单
                        </button>
                      </div>
                    </details>
                    <details>
                      <summary>本镜序列映射</summary>
                      <ShotSegmentReferences
                        engine={engine}
                        canvasId={canvasId}
                        boardId={boardId}
                        shotId={shotId}
                        sequenceId={sequenceId || undefined}
                        onSelectSequence={setSequenceId}
                        isCurrent={active}
                      />
                    </details>
                  </div>
                  <details className="text-sm" aria-label="本镜参考资产">
                    <summary>上游引用 · {references.length} 项</summary>
                    <h3 className="font-medium">本镜参考</h3>
                    {shot.characters.map((name) => (
                      <span key={name} className="plein-shot-subject">
                        {name}
                      </span>
                    ))}
                    <h4 className="mt-4 text-xs font-medium">当前阶段上游</h4>
                    {references.length ? (
                      references.map((ref) => (
                        <button
                          key={ref.edgeId}
                          type="button"
                          className="plein-shot-reference"
                          onClick={() => locate(ref.source.id)}
                        >
                          <Icon
                            name={
                              ref.value?.type === 'image'
                                ? 'image'
                                : ref.value?.type === 'video'
                                  ? 'video'
                                  : ref.value?.type === 'audio'
                                    ? 'audio'
                                    : 'doc'
                            }
                          />
                          <span className="min-w-0">
                            <span className="block truncate text-sm">
                              {ref.source.name ?? '未命名素材'}
                            </span>
                            <span className="block text-xs text-ink-subtle">
                              {ref.value ? '定位来源' : '等待上游素材'}
                            </span>
                          </span>
                        </button>
                      ))
                    ) : (
                      <p className="text-xs text-ink-subtle">暂无上游引用。</p>
                    )}
                    {!!shot.dialogue.length && (
                      <details className="mt-4 text-xs">
                        <summary>本镜对白 · {shot.dialogue.length} 句</summary>
                        <div className="space-y-2 pt-2">
                          {shot.dialogue.map((line) => (
                            <p key={line.id}>
                              <span className="font-medium">{line.character}</span>：{line.line}
                            </p>
                          ))}
                        </div>
                      </details>
                    )}
                  </details>
                </section>
              </div>
              <details className="plein-shot-workspace-impact text-sm" aria-label="本镜下游影响">
                <summary>
                  下游影响 · {downstream.length} 个节点 · {dependents.length} 项引用
                </summary>
                {!!downstream.length && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {downstream.map((id) => (
                      <button
                        type="button"
                        className="ui-btn ui-btn-secondary ui-btn-xs"
                        key={id}
                        onClick={() =>
                          locate(id, engine.doc.get(id)?.nodeType === 'plein/sequence')
                        }
                      >
                        {engine.doc.get(id)?.name ?? id}
                      </button>
                    ))}
                  </div>
                )}
                {dependents.map((ref) => (
                  <p
                    key={JSON.stringify([
                      ref.toPlanRevisionId,
                      ref.planRevisionId,
                      ref.subjectId,
                      ref.fields,
                    ])}
                  >
                    镜头 {shots.find((s) => s.id === ref.toShotId)?.no ?? ref.toShotId} 引用{' '}
                    {ref.fields.join('、')}：{ref.status}
                  </p>
                ))}
              </details>
            </>
          )}
        </div>
        {shot && currentDraft && (
          <nav className="plein-shot-strip" aria-label="镜头导航">
            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                className="ui-btn ui-btn-secondary ui-icon-btn"
                aria-label="上一镜"
                title="上一镜（Alt+←）"
                disabled={currentIndex <= 0}
                onClick={() => changeShot(shots[currentIndex - 1]!.id)}
              >
                <Icon name="chevronLeft" />
              </button>
              <span className="text-xs text-ink-muted tabular-nums">
                {currentIndex + 1} / {shots.length}
              </span>
              <button
                type="button"
                className="ui-btn ui-btn-secondary ui-icon-btn"
                aria-label="下一镜"
                title="下一镜（Alt+→）"
                disabled={currentIndex < 0 || currentIndex >= shots.length - 1}
                onClick={() => changeShot(shots[currentIndex + 1]!.id)}
              >
                <Icon name="chevronRight" />
              </button>
            </div>
            <div className="plein-shot-strip-items">
              {shots.map((item) => {
                const shotNodes = reviewNodesForShot(item, groups.get(item.id) ?? [])
                const mediaNode = shotNodes.find(
                  (n) => (n.params?.source as ShotSource)?.role === 'image',
                )
                const image = mediaNode && currentResult(mediaNode)?.value
                return (
                  <button
                    key={item.id}
                    type="button"
                    className="plein-shot-strip-item"
                    aria-label={`切换到镜头 ${item.no}`}
                    aria-current={item.id === shotId ? 'step' : undefined}
                    title={item.description || `镜头 ${item.no}`}
                    onClick={() => changeShot(item.id)}
                    ref={item.id === shotId ? currentShotButton : undefined}
                  >
                    <span className="plein-shot-strip-cover">
                      {image?.type === 'image' ? (
                        <img loading="lazy" src={assetUrls.original(image.assetId)} alt="" />
                      ) : (
                        <Icon name="video" />
                      )}
                    </span>
                    <span className="min-w-0">
                      <span className="block text-xs font-medium">
                        镜头 {item.no} · {item.duration}s
                      </span>
                      <span className="block truncate text-xs text-ink-subtle">
                        {item.description || '待填写画面描述'}
                      </span>
                    </span>
                  </button>
                )
              })}
            </div>
          </nav>
        )}
      </Modal>
      {child === 'controls' && (
        <ShotControls
          engine={engine}
          canvasId={canvasId}
          boardId={boardId}
          shotId={shotId}
          isCurrent={writable}
          onClose={() => setChild(null)}
        />
      )}
      {child === 'sync' && (
        <StoryboardSync
          engine={engine}
          boardId={boardId}
          shotIds={[shotId]}
          isCurrent={writable}
          onClose={() => setChild(null)}
        />
      )}
      {child === 'pair' && previous && shot && beforeVideo && video && (
        <ShotContinuityReview
          engine={engine}
          canvasId={canvasId}
          boardId={boardId}
          before={{ shot: previous, node: beforeVideo }}
          after={{ shot, node: video }}
          isCurrent={writable}
          onClose={() => setChild(null)}
        />
      )}
      {batch && (
        <BatchChecklist
          engine={engine}
          canvasId={canvasId}
          boardId={boardId}
          request={{
            shotIds: [shotId],
            role: batch.role,
            reuseExisting: batch.reuseExisting,
            sequenceId: sequenceId || undefined,
          }}
          isCurrent={writable}
          onClose={() => setBatch(null)}
          onLocate={(row) => {
            if (row.nodeId) locate(row.nodeId)
          }}
          onStarted={(total) => {
            if (active()) {
              setBatch(null)
              useCanvas.getState().notify(`已提交本镜清单 ${total} 项，旧候选保留`)
            }
          }}
        />
      )}
    </>
  )
}
