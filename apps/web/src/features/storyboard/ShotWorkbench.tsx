import { resolveShotAsset } from '@plein/capabilities'
import type { Engine } from '@plein/canvas-core'
import {
  adoptResult,
  continuityDependents,
  continuityOf,
  currentContinuityObservations,
  currentShotPlan,
  getCreativeReview,
  currentResult,
  readSourceSlice,
  sourceMapOf,
  sourceSnapshotState,
  type CanvasElement,
  type NodeResult,
  type SourceSnapshot,
  type SourceUnit,
  type StateField,
} from '@plein/doc'
import {
  findMentions,
  hasVoice,
  pickVoice,
  voiceOf,
  type Mention,
  type MentionTarget,
  type Shot,
  type ShotRole,
  type VoiceRef,
} from '@plein/nodes'
import type { InputRef, PreparedInput } from '@plein/protocol'
import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, assetUrls } from '../../api/client'
import { useDocVersion } from '../../canvas/hooks'
import { mentionTargets, upstreams } from '../../canvas/nodes'
import { useCanvas } from '../../stores/canvas'
import { useCatalog } from '../../stores/catalog'
import { useSession } from '../../stores/session'
import { Modal, ModalHeader } from '../../ui/Modal'
import { Icon } from '../../ui/icons'
import { useStale } from '../runs/stale'
import { describeRecovery } from '../runs/recovery'
import { submittedMedia } from '../generator/submittedMedia'
import { BatchChecklist } from './BatchChecklist'
import { CreativeReviewForm, reviewLabels } from './CreativeReviewForm'
import { expandedNodes, shotsOf, type ShotSource } from './model'
import { reviewNodesForShot, shotReviewStatus } from './reviewModel'
import { ShotControls } from './ShotControls'
import { ShotContinuityReview } from './ShotContinuityReview'
import { ShotPlanForm } from './ShotStatePanel'
import { ShotSegmentReferences } from './ShotSegmentReferences'
import { StoryboardSync } from './StoryboardSync'
import {
  certaintyLabels,
  observationEvidenceLabel,
  stateLabels,
  stateValueText,
} from './continuityModel'
import {
  applyWorkbenchDraft,
  WORKBENCH_FIELDS,
  workbenchDownstream,
  workbenchDraft,
  type WorkbenchDraft,
} from './shotWorkbenchModel'

const labels = {
  description: '画面描述',
  imagePrompt: '分镜图提示词',
  motionPrompt: '视频运动提示词',
  lighting: '光影',
}
const roles: Record<ShotRole, string> = {
  image: '分镜图',
  video: '视频',
  speech: '配音',
  sfx: '音效',
}
const engineKeys = new WeakMap<Engine, number>()
let nextEngineKey = 0
let nextInspectionRead = 0
function engineKey(engine: Engine) {
  if (!engineKeys.has(engine)) engineKeys.set(engine, ++nextEngineKey)
  return engineKeys.get(engine)!
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
    () => engine.doc.get(boardId)?.production?.selection?.sequenceId ?? '',
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
  const changeShot = (id: string) => {
    if (!active() || id === shotId || !shots.some((item) => item.id === id)) return
    if (draft) drafts.set(shotId, draft)
    useCanvas.getState().openShotWorkbench({ boardId, shotId: id })
  }
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
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
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
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
                <label>
                  当前镜头{' '}
                  <select
                    aria-label="工作台镜头"
                    className="ui-input"
                    value={shotId}
                    onChange={(e) => changeShot(e.target.value)}
                  >
                    {shots.map((s) => (
                      <option key={s.id} value={s.id}>
                        镜头 {s.no} · {s.description.slice(0, 40)}
                      </option>
                    ))}
                  </select>
                </label>
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
              <div className="flex-1 overflow-auto">
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
                />
                <div className="flex flex-col gap-2">
                  <details className="p-4" aria-label="本镜参考资产">
                    <summary>上游引用 · {references.length} 项</summary>
                    <h3 className="font-medium">本镜参考</h3>
                    <p className="text-xs text-ink-subtle">出场设定</p>
                    {shot.characters.length ? (
                      shot.characters.map((name) => (
                        <span key={name} className="plein-shot-subject">
                          {name}
                        </span>
                      ))
                    ) : (
                      <p className="text-xs text-ink-subtle">尚未指定出场资产</p>
                    )}
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
                      <p className="text-xs text-ink-subtle">
                        暂无上游引用，选择阶段后可查看来源。
                      </p>
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
                  <details aria-label="当前镜头计划" className="p-4 space-y-3">
                    <summary>镜头计划</summary>
                    <div>
                      <p className="text-xs text-ink-subtle">脚本与提示词</p>
                      <h3 className="font-medium">当前镜头计划</h3>
                    </div>
                    <p className="text-xs text-ink-subtle">
                      保存镜头计划后，可核对并同步到生成节点。
                    </p>
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
                            className="ui-input w-full"
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
                  </details>
                  <section aria-label="本镜候选与执行依据" className="p-4 space-y-3">
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
                        <label className="block text-sm">
                          阶段节点{' '}
                          <select
                            aria-label="工作台阶段节点"
                            className="ui-input w-full"
                            value={node?.id ?? selectedNode}
                            onChange={(e) => setSelectedNode(e.target.value)}
                          >
                            <option value="">请选择阶段</option>
                            {nodes.map((n) => (
                              <option key={n.id} value={n.id}>
                                {roles[(n.params?.source as ShotSource)?.role] ?? '节点'} ·{' '}
                                {n.name ?? n.id}
                              </option>
                            ))}
                          </select>
                        </label>
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
                  </section>
                </div>
                <details className="p-4 text-sm" aria-label="本镜下游影响">
                  <summary>
                    下游影响 · {downstream.length} 个节点 · {dependents.length} 项引用
                  </summary>
                  {!!downstream.length && (
                    <div className="flex w-full flex-wrap gap-2">
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
              </div>
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

function ShotSummary({
  engine,
  shot,
  promptText,
  promptSource,
  targets,
  speechVoices,
  input,
  onLocate,
  onChoose,
}: {
  engine: Engine
  shot: Shot
  /** 所展示阶段的实际提示词，或无节点时按回退规则推导的结果 */
  promptText: string
  promptSource: string
  targets: MentionTarget[]
  speechVoices: ReadonlyMap<string, VoiceRef[]>
  input: UseQueryResult<PreparedInput>
  onLocate(id: string): void
  onChoose(): void
}) {
  const mentions = useMemo(() => findMentions(promptText, targets), [promptText, targets])
  return (
    <section className="p-4 space-y-2" aria-label="本镜用到的">
      <h3 className="font-medium">本镜用到的</h3>
      <p className="text-xs text-ink-subtle">档案项{promptSource}</p>
      {!shot.characters.length && <p className="text-xs">尚未指定出场资产</p>}
      <div className="flex flex-wrap gap-2">
        {shot.characters.map((name) => {
          const asset = resolveShotAsset(engine.doc, name, shot.assetBindings?.[name])
          if (!asset)
            return (
              <button
                type="button"
                className="ui-btn ui-btn-secondary"
                key={name}
                title="按名字或绑定无法唯一确定资产卡，去分镜表重新选择"
                onClick={onChoose}
              >
                {name} · 需要选择资产
              </button>
            )
          const matches = mentions.filter((m) => m.id === asset.id)
          // 同名未消歧或 #序号 越界时生成会被阻断，摘要不装作没看见
          const broken = mentions.some((m) => m.id === undefined && m.ids.includes(asset.id))
          // 档案项一致性与场景视角一起判断；一致的多处引用取第一个展示，不再误报也不丢设置
          const pickKey = (m: Mention) =>
            JSON.stringify([
              m.pick?.period?.id,
              m.pick?.outfit?.id,
              m.pick?.expression?.id,
              m.pick?.voiceState?.id,
              m.sceneView?.id,
            ])
          const consistent =
            matches.length > 1 &&
            new Set(matches.map(pickKey)).size === 1 &&
            matches.every(
              (m) =>
                m.profileMiss === undefined && !m.profileConflict && m.sceneViewMiss === undefined,
            )
          const match = matches.length === 1 || consistent ? matches[0] : undefined
          // 提示词写法对不上唯一档案项 / 视角时不猜，让用户去选
          const unclear =
            broken ||
            (matches.length > 1 && !consistent) ||
            (match !== undefined &&
              (match.profileMiss !== undefined ||
                !!match.profileConflict ||
                match.sceneViewMiss !== undefined))
          let hint: string | undefined
          if (broken) hint = '同名卡不止一张，提示词里没写清用哪张；在分镜表或镜头计划里加 #序号'
          else if (matches.length > 1) hint = '提示词里多处引用了此资产，请核对写法'
          else if (match?.profileMiss !== undefined)
            hint = `档案里没有「${match.profileMiss}」，点开卡片重新选择`
          else if (match?.profileConflict) hint = match.profileConflict
          else if (match?.sceneViewMiss !== undefined)
            hint = `场景没有「/${match.sceneViewMiss}」视角，点开卡片重新选择`
          const pick = match?.pick ?? {}
          const voice = pickVoice(pick, voiceOf(asset.params))
          const data = input.data && input.data.status !== 'unprepared' ? input.data : undefined
          const refs = data?.refs.filter((ref) => ref.elementId === asset.id)
          const sentImages = data
            ? submittedMedia(data).filter((item) => item.type === 'image')
            : []
          const hasSent =
            !!refs?.some((ref) => ref.sent.length) ||
            sentImages.some((item) => item.source === asset.id)
          // 没有可用图才是仅文字设定；有图没送是另一回事，原因收进 title
          const onlyText = !!refs?.length && !hasSent && refs.every((ref) => !ref.available.length)
          const notSent = !hasSent && !onlyText && !!refs?.some((ref) => !ref.sent.length)
          const reasonText = (ref: InputRef) => {
            if (ref.selected?.length === 0) return '已选择仅文字，不送参考图'
            if (ref.reason === 'failed') return '参考图生成失败，只附文字设定'
            if (ref.reason === 'no_image') return '还没有可用的参考图，只附文字设定'
            if (ref.reason === 'unsupported') return '当前模式不送参考图，只附文字设定'
            if (ref.reason === 'over_limit') return '超过模型的参考图上限，只附文字设定'
            if (ref.reason === 'selection_missing') return '所选参考图已失效'
            return '参考图没有送入'
          }
          const review = getCreativeReview(asset)
          // 配音节点显式指定的音色优先于角色卡沿用；同一角色多句不一致时单独提示
          const speechVoicesFor = speechVoices.get(asset.id) ?? []
          const voicePart =
            speechVoicesFor.length > 1
              ? '多句音色不同'
              : speechVoicesFor.length === 1
                ? '配音另指定'
                : (pick.voiceState?.name ?? (hasVoice(voice) ? '默认' : '未选'))
          const voiceText = `时期：${pick.period?.name ?? '默认'} · 服装：${pick.outfit?.name ?? '默认'} · 表情：${pick.expression?.name ?? '默认'} · 音色：${voicePart}`
          const speechTitle =
            speechVoicesFor.length > 1
              ? `各句配音音色：${speechVoicesFor.map((v) => v.voiceId).join('、')}`
              : speechVoicesFor.length === 1
                ? `配音节点指定了音色 ${speechVoicesFor[0]!.voiceId}`
                : undefined
          return (
            <button
              type="button"
              className="plein-shot-subject text-left"
              key={name}
              title={speechTitle ?? hint}
              onClick={broken ? onChoose : () => onLocate(asset.id)}
            >
              <span className="block font-medium">{name} · 调整资产</span>
              {asset.nodeType === 'plein/character' && (
                <span
                  className={unclear && !speechVoicesFor.length ? 'block text-warning' : 'block'}
                >
                  {broken ? '提示词引用不唯一' : unclear ? '档案项需要选择' : voiceText}
                </span>
              )}
              {asset.nodeType === 'plein/scene' && (
                <span className="block">
                  视角：
                  {broken
                    ? '引用不唯一'
                    : unclear
                      ? '需要选择'
                      : (match?.sceneView?.name ?? '默认')}
                  {match?.sceneView?.images[0] && (
                    <img
                      className="mt-1 h-20 w-32 object-contain"
                      src={assetUrls.original(match.sceneView.images[0])}
                      alt="场景视角截图"
                    />
                  )}
                </span>
              )}
              {hasSent && (
                <span
                  className="block text-ink-subtle"
                  title="按当前输入预览；已采用候选实际送入的素材以其生成依据为准"
                >
                  参考图将送入模型
                </span>
              )}
              {!hasSent && notSent && (
                <span
                  className="block text-ink-subtle"
                  title={refs!
                    .filter((ref) => !ref.sent.length)
                    .map(reasonText)
                    .join('；')}
                >
                  参考图将不送入
                </span>
              )}
              {!hasSent && !notSent && onlyText && (
                <span className="block text-ink-subtle">仅文字设定</span>
              )}
              {review?.status === 'usable' && (
                <span className="block text-ink-subtle">已人工认可</span>
              )}
            </button>
          )
        })}
      </div>
    </section>
  )
}

function ShotComparison({
  engine,
  canvasId,
  boardId,
  previous,
  shot,
  groups,
  onReview,
  canReview,
  candidatePrimary,
}: {
  engine: Engine
  canvasId: string
  boardId: string
  previous: Shot | undefined
  shot: Shot
  groups: Map<string, CanvasElement[]>
  onReview(): void
  canReview: boolean
  candidatePrimary: boolean
}) {
  const record = continuityOf(engine.doc, boardId)
  const side = (item: Shot | undefined, phase: 'start' | 'end') => {
    if (!item) return <p>没有上一镜</p>
    const currents = currentContinuityObservations(engine.doc, { canvasId, boardId }, item.id)
    const observation = currents.find(
      (o) => o.phase === phase && o.evidence.kind === 'frame' && o.evidence.position === phase,
    )
    const video = (groups.get(item.id) ?? []).find(
      (n) => (n.params?.source as ShotSource)?.role === 'video',
    )
    const tail =
      phase === 'end' && video && currentResult(video)?.value.type === 'video'
        ? currentResult(video, 'lastFrame')?.value
        : undefined
    const frame =
      tail?.type === 'image'
        ? tail.assetId
        : observation?.evidence.kind === 'frame' && observation.evidence.position === phase
          ? observation.evidence.frameAssetId
          : undefined
    const imageNode = (groups.get(item.id) ?? []).find(
      (n) => (n.params?.source as ShotSource)?.role === 'image',
    )
    const image = imageNode && currentResult(imageNode)?.value
    const imageId = frame ?? (image?.type === 'image' ? image.assetId : undefined)
    const frameLabel =
      tail?.type === 'image' || observation?.target.kind === 'video'
        ? phase === 'end'
          ? '视频末帧'
          : '视频首帧'
        : '候选观察画面'
    const plan = currentShotPlan(record, item.id)
    const states = plan.plan?.content[phase]
    // 观察绑定在具体候选上；其余失效（计划、主体、历史迁移）也一律提醒重新审阅
    const phaseCurrents = currents.filter((o) => o.phase === phase)
    const outdated =
      !phaseCurrents.length &&
      record.observations.some(
        (o) =>
          o.shotId === item.id &&
          o.phase === phase &&
          !o.historical &&
          o.scope.canvasId === canvasId &&
          !currents.some((c) => c.id === o.id),
      )
    return (
      <div className="space-y-1">
        <p className="font-medium">
          镜头 {item.no} · {phase === 'end' ? '结束' : '开始'}
        </p>
        {imageId ? (
          <img
            src={assetUrls.original(imageId)}
            alt={frame ? frameLabel : '分镜图'}
            className="h-36 w-full rounded bg-black object-contain"
          />
        ) : (
          <p>画面未知</p>
        )}
        <p className="text-xs">{frame ? frameLabel : imageId ? '来源：分镜图' : ''}</p>
        {plan.state === 'conflict' ? (
          <p>计划版本冲突，请核对</p>
        ) : states && Object.keys(states).length ? (
          Object.entries(states).map(([id, fields]) => (
            <p key={id} className="text-xs">
              {record.subjects.find((subject) => subject.id === id)?.label ?? id} ·{' '}
              {Object.entries(fields)
                .map(
                  ([field, value]) =>
                    `${stateLabels[field as StateField]}：${stateValueText(field as StateField, value, record.subjects)}`,
                )
                .join(' · ')}
            </p>
          ))
        ) : (
          <p className="text-xs">状态未知</p>
        )}
        {phaseCurrents.length ? (
          <p className="text-xs text-success">已记录 {phaseCurrents.length} 条衔接观察</p>
        ) : outdated ? (
          <p className="text-xs text-warning">旧观察已失效，请重新审阅</p>
        ) : null}
      </div>
    )
  }
  return (
    <section className="p-4 space-y-2" aria-label="上一镜结束到本镜开始">
      <h3 className="font-medium">上一镜结束 → 本镜开始</h3>
      <div className="grid grid-cols-2 gap-3">
        {side(previous, 'end')}
        {side(shot, 'start')}
      </div>
      <button
        type="button"
        className={`ui-btn ${canReview && !candidatePrimary ? 'ui-btn-primary' : 'ui-btn-secondary'}`}
        disabled={!canReview}
        title={
          canReview
            ? '意见记录在本镜当前视频候选上，换候选后需重新审阅'
            : '相邻两镜都有已采用的视频后，可循环回看切点并记录衔接意见'
        }
        onClick={onReview}
      >
        记录衔接意见
      </button>
    </section>
  )
}

function SourceQuotes({
  engine,
  boardId,
  shotId,
  onLocateSource,
}: {
  engine: Engine
  boardId: string
  shotId: string
  onLocateSource(id: string): void
}) {
  const record = sourceMapOf(engine.doc, boardId),
    links = record.links.filter((l) => l.shotId === shotId)
  return (
    <div className="space-y-2 p-2 text-xs">
      {!links.length && <p>本镜尚无固定原文映射；此处不推断剧情已读或内容已确认。</p>}
      {links.map((link) => {
        const unit = record.units.find((u) => u.id === link.unitId),
          source = unit && record.snapshots.find((s) => s.id === unit.snapshotId)
        const entry = source && record.sources.find((s) => s.id === source.sourceId)
        const status = source && sourceSnapshotState(engine.doc, boardId, source)
        const statusLabels = {
          current: '来源与固定版一致',
          changed: '当前来源已修改，仍显示固定旧版',
          missing: '来源已删除，仅保留历史',
          external: '外部历史来源，未绑定',
          disconnected: '来源已断开，保留历史',
        }
        return (
          <div key={link.id}>
            {source && unit ? (
              <>
                <p>
                  {source.name} · 固定版 {source.id.slice(-8)} · [{unit.start},{unit.end})
                </p>
                <p>
                  {status && statusLabels[status]} ·{' '}
                  {{ retain: '保留', compress: '压缩', merge: '合并' }[link.treatment]}
                </p>
                <details>
                  <summary>捕获时的原出处</summary>
                  <p className="break-all">
                    画布 {source.originAtCapture.canvasId} · 元素 {source.originAtCapture.elementId}{' '}
                    · 端口 {source.originAtCapture.port} · 结果{' '}
                    {source.originAtCapture.resultId ?? '直接文本'}
                  </p>
                </details>
                {entry?.binding && (status === 'current' || status === 'changed') && (
                  <button
                    type="button"
                    className="ui-btn ui-btn-secondary ui-btn-xs"
                    onClick={() => {
                      const now = sourceMapOf(engine.doc, boardId).sources.find(
                        (s) => s.id === entry.id,
                      )
                      const nodeId = now?.binding?.elementId
                      const state = sourceSnapshotState(engine.doc, boardId, source)
                      if (
                        nodeId &&
                        nodeId === entry.binding?.elementId &&
                        now?.binding?.port === entry.binding.port &&
                        (state === 'current' || state === 'changed') &&
                        engine.doc.has(nodeId)
                      )
                        onLocateSource(nodeId)
                    }}
                  >
                    定位当前绑定来源
                  </button>
                )}
                <UnitQuote key={`${source.id}:${unit.id}`} source={source} unit={unit} />
              </>
            ) : (
              <p>历史映射来源缺失，不以当前文字替代。</p>
            )}
          </div>
        )
      })}
    </div>
  )
}

function ObservationSummary({
  engine,
  canvasId,
  boardId,
  shotId,
}: {
  engine: Engine
  canvasId: string
  boardId: string
  shotId: string
}) {
  const record = continuityOf(engine.doc, boardId),
    current = currentContinuityObservations(engine.doc, { canvasId, boardId }, shotId)
  const history = record.observations.filter(
    (o) => o.shotId === shotId && !current.some((c) => c.id === o.id),
  )
  const lines = (states: (typeof current)[number]['states']) =>
    Object.entries(states).flatMap(([id, fields]) =>
      Object.entries(fields).map(([field, value]) => {
        if (!value) return `${stateLabels[field as StateField]}：未检查`
        let detail = value.note ?? ''
        if (value.certainty !== 'unknown') {
          const actual = value.value
          detail =
            typeof actual === 'string'
              ? actual
              : `${record.subjects.find((s) => s.id === actual.subjectId)?.label ?? '历史角色'} · ${{ right: '右手', left: '左手', both: '双手' }[actual.hand]}`
        }
        return `${record.subjects.find((s) => s.id === id)?.label ?? '历史主体'} · ${stateLabels[field as StateField]}：${certaintyLabels[value.certainty]} ${detail}`
      }),
    )
  return (
    <div className="space-y-2 p-2 text-xs">
      <p>观察独立于计划和创作验收；静帧只说明所见范围。</p>
      {!current.length && <p>当前候选尚无独立观察，保持未检查。</p>}
      {current.map((o) => (
        <div key={o.id}>
          <p>
            {o.phase === 'start' ? '起始' : '结束'} · {observationEvidenceLabel(o.evidence)}
          </p>
          {lines(o.states).map((text) => (
            <p key={text}>{text}</p>
          ))}
        </div>
      ))}
      {!!history.length && (
        <details>
          <summary>历史观察（{history.length}），不作为当前候选结论</summary>
          {history.map((o) => (
            <p key={o.id}>
              {o.target.resultId?.slice(-10) ?? o.target.assetId.slice(0, 12)} ·{' '}
              {observationEvidenceLabel(o.evidence)}
            </p>
          ))}
        </details>
      )}
    </div>
  )
}

function UnitQuote({ source, unit }: { source: SourceSnapshot; unit: SourceUnit }) {
  const [offset, setOffset] = useState(unit.start)
  const page = readSourceSlice(source, offset, Math.min(8000, unit.end - offset))
  return (
    <div>
      <p className="whitespace-pre-wrap break-words">{page.text}</p>
      <p>
        显示原文 [{page.offset},{Math.min(page.end, unit.end)})，本映射至 {unit.end}
      </p>
      <button
        type="button"
        className="ui-btn ui-btn-secondary ui-btn-xs"
        disabled={offset <= unit.start}
        onClick={() => setOffset(Math.max(unit.start, offset - 8000))}
      >
        上一段原文
      </button>
      <button
        type="button"
        className="ui-btn ui-btn-secondary ui-btn-xs"
        disabled={page.end >= unit.end}
        onClick={() => setOffset(page.end)}
      >
        下一段原文
      </button>
    </div>
  )
}

function CandidateInspection({
  engine,
  boardId,
  shotId,
  canvasId,
  node,
  active,
  writable,
  stale,
  onLocate,
  generationRole,
  selected,
  onSelect,
  sharedInput,
  onGenerate,
}: {
  engine: Engine
  boardId: string
  shotId: string
  canvasId: string
  node: CanvasElement
  active(): boolean
  writable(): boolean
  stale: boolean
  onLocate(): void
  generationRole?: 'image' | 'video'
  /** 当前查看的候选 id（受控于工作台，切历史候选时对照区同步回退主按钮） */
  selected: string
  onSelect(candidateId: string): void
  /** 摘要已取过的同一节点输入，避免重复请求；查看其他节点时为空 */
  sharedInput?: UseQueryResult<PreparedInput>
  onGenerate(role: ShotRole): void
}) {
  const reviewContainer = useRef<HTMLDivElement>(null)
  const version = useDocVersion(engine.doc),
    catalog = useCatalog((s) => s.catalog)
  const [element] = useState(() => engine.doc.elementMaps.get(node.id))
  const identity = (n: CanvasElement) => {
    const source = n.params?.source as ShotSource | undefined
    return JSON.stringify([
      source?.storyboard,
      source?.shot,
      source?.role,
      source?.dialogueId,
      source?.line,
      source?.detached,
    ])
  }
  const [sourceIdentity] = useState(() => identity(node))
  const [readEpoch] = useState(() => ++nextInspectionRead)
  const [error, setError] = useState('')
  const adoptedResult = currentResult(node)
  const candidate = selected
    ? node.results?.find((r) => r.id === selected)
    : (adoptedResult ?? node.results?.[0])
  const binding = JSON.stringify([node.id, candidate?.id, candidate?.runId, candidate?.value])
  const validNode = () => {
    const now = engine.doc.get(node.id),
      source = now?.params?.source as ShotSource | undefined
    const shot = shotsOf(engine.doc.get(boardId)).find((s) => s.id === shotId)
    return (
      active() &&
      engine.doc.elementMaps.get(node.id) === element &&
      !!now &&
      source?.storyboard === boardId &&
      source.shot === shotId &&
      identity(now) === sourceIdentity &&
      !!shot &&
      reviewNodesForShot(shot, [now]).length === 1
    )
  }
  const old = useQuery({
    queryKey: ['workbench-job', canvasId, binding],
    enabled: !!candidate?.runId && validNode(),
    retry: false,
    queryFn: async () => {
      const job = await api.canvasJob(canvasId, candidate!.runId)
      if (
        !validNode() ||
        job.nodeId !== node.id ||
        job.id !== candidate!.runId ||
        job.input?.nodeId !== node.id
      )
        throw new Error('没有与此候选匹配的生成依据')
      return job
    },
  })
  // 摘要已取过同一节点的输入时直接复用，不再重复请求
  const ownInput = useQuery({
    queryKey: ['workbench-input', canvasId, boardId, shotId, node.id, readEpoch, version],
    enabled: validNode() && !sharedInput,
    retry: false,
    gcTime: 0,
    queryFn: async () => {
      const input = await api.nodeInput(canvasId, node.id)
      if (!validNode() || input.nodeId !== node.id) throw new Error('阶段身份已变化')
      return input
    },
  })
  const current = sharedInput ?? ownInput
  const jobs = useQuery({
    queryKey: ['workbench-latest', canvasId, node.id, readEpoch],
    enabled: validNode(),
    queryFn: async () => {
      const result = await api.canvasNodeJobs(canvasId, [node.id])
      if (!validNode()) throw new Error('阶段身份已变化')
      return result
    },
    refetchInterval: 1500,
  })
  const latest = jobs.data?.jobs.find((j) => j.nodeId === node.id),
    recovery = latest && describeRecovery(latest)
  const refs = [...upstreams(engine, node.id, catalog).values()].flat()
  const adopted = candidate && currentResult(node, candidate.port)?.id === candidate.id
  const historyReview =
    candidate &&
    node.reviews?.find(
      (review) =>
        review.target.resultId === candidate.id &&
        'assetId' in candidate.value &&
        review.target.assetId === candidate.value.assetId &&
        review.target.kind === candidate.value.type,
    )
  return (
    <>
      {!validNode() && <p role="alert">阶段身份已变化，请重新选择阶段或打开工作台。</p>}
      {(stale || latest) && (
        <p className="text-xs">
          {stale ? '输入已变化，采用的旧候选需重新核对。' : ''}
          {latest && `任务 ${latest.status} · 尝试 ${latest.attempts}`}
        </p>
      )}
      <label className="block text-sm">
        查看候选{' '}
        <select
          aria-label="工作台候选"
          className="ui-input w-full"
          value={candidate?.id ?? selected}
          onChange={(e) => onSelect(e.target.value)}
        >
          <option value="">{adoptedResult ? '当前采用候选' : '尚未采用'}</option>
          {(node.results ?? []).map((r) => (
            <option key={r.id} value={r.id}>
              {adoptedResult
                ? currentResult(node, r.port)?.id === r.id
                  ? '已采用'
                  : '历史'
                : '待采用'}{' '}
              · {r.id.slice(-10)} · {r.port}
            </option>
          ))}
        </select>
      </label>
      {candidate ? (
        <CandidateMedia key={binding} result={candidate} />
      ) : (
        <div className="plein-shot-preview-empty">
          <Icon name="video" size={24} />
          <p>尚无候选或原候选已移除。</p>
          <p className="text-xs text-ink-subtle">先完善脚本，再从本镜生成清单开始。</p>
        </div>
      )}
      {error && (
        <p role="alert" className="text-danger">
          {error}
        </p>
      )}
      {candidate && !adopted && (
        <>
          <p className="text-xs">
            {adoptedResult ? '历史预览，当前采用项保持不变。' : '尚未采用，此为待选候选。'}
            原验收：
            {historyReview ? reviewLabels[historyReview.status] : '未记录'}
          </p>
          <button
            type="button"
            className="ui-btn ui-btn-primary"
            disabled={!writable() || !validNode()}
            onClick={() => {
              const now = engine.doc.get(node.id)?.results?.find((r) => r.id === candidate.id)
              if (!writable() || !validNode() || JSON.stringify(now) !== JSON.stringify(candidate))
                return setError('候选或目标已变化，未采用')
              adoptResult(engine.doc, node.id, candidate.id)
              setError('')
            }}
          >
            采用候选
          </button>
        </>
      )}
      {generationRole && (!candidate || adopted) && (
        <button
          type="button"
          className="ui-btn ui-btn-primary"
          disabled={!writable() || !validNode()}
          onClick={() => onGenerate(generationRole)}
        >
          {generationRole === 'image' ? '生成镜头图' : '生成视频'}
        </button>
      )}
      {adopted && candidate && !generationRole && historyReview?.status === 'changes' && (
        <button
          type="button"
          className="ui-btn ui-btn-primary"
          disabled={!writable() || !validNode()}
          onClick={() => {
            const role = (node.params?.source as ShotSource | undefined)?.role
            if (writable()) onGenerate(role ?? 'video')
          }}
        >
          重新生成{roles[(node.params?.source as ShotSource | undefined)?.role ?? 'video']}
        </button>
      )}
      {adopted &&
        candidate &&
        !generationRole &&
        historyReview?.status !== 'changes' &&
        (!historyReview || historyReview.status === 'pending') && (
          <button
            type="button"
            className="ui-btn ui-btn-primary"
            disabled={!writable() || !validNode()}
            onClick={() => {
              const details = reviewContainer.current?.querySelector('details')
              if (details) {
                details.open = true
                details.querySelector('textarea')?.focus()
              }
            }}
          >
            审阅
          </button>
        )}
      {adopted && candidate && (
        <div ref={reviewContainer}>
          <CreativeReviewForm
            doc={engine.doc}
            node={node}
            port={candidate.port}
            stale={stale}
            isCurrent={() => validNode() && writable()}
          />
        </div>
      )}
      {refs.length > 0 && (
        <details>
          <summary>当前引用与实际送入</summary>
          {refs.map((u) => (
            <p key={u.edgeId} className="text-xs break-all">
              {u.source.name ?? u.source.id} · {u.value?.type ?? '未就绪'}
              {'assetId' in (u.value ?? {}) ? ` · ${(u.value as { assetId: string }).assetId}` : ''}
            </p>
          ))}
        </details>
      )}
      <details className="plein-shot-input-evidence">
        <summary>生成依据与输入对照</summary>
        <div className="grid gap-2 md:grid-cols-2" aria-label="旧候选与当前输入对照">
          <section>
            <h4 className="text-sm font-medium">此候选生成时实际输入</h4>
            {!candidate?.runId ? (
              <p className="text-xs">未记录生成任务，不能用当前参数补填。</p>
            ) : old.isPending ? (
              <p>读取旧依据…</p>
            ) : old.isError || !old.data?.input ? (
              <p className="text-xs">旧依据未记录或不可读取；不以当前输入替代。</p>
            ) : (
              <InputDetails input={old.data.input} />
            )}
          </section>
          <section>
            <h4 className="text-sm font-medium">当前节点实际输入</h4>
            {current.isPending ? (
              <p>核对当前输入…</p>
            ) : current.isError ? (
              <p>当前输入暂不可读取。</p>
            ) : (
              current.data && <InputDetails input={current.data} />
            )}
          </section>
        </div>
      </details>
      {recovery && latest && (
        <div role="status" className="rounded border border-line p-2 text-xs">
          <p>{recovery.title}</p>
          {recovery.detail && <p>{recovery.detail}</p>}
          <button
            type="button"
            className="ui-btn ui-btn-secondary"
            onClick={() => {
              if (validNode()) {
                onLocate()
                useCanvas.getState().toggleTasks(true)
              }
            }}
          >
            定位原节点与任务恢复
          </button>
        </div>
      )}
      <button
        type="button"
        className="ui-btn ui-btn-secondary"
        onClick={() => {
          if (validNode()) onLocate()
          else setError('阶段身份已变化，未定位旧目标')
        }}
      >
        定位此阶段画布节点
      </button>
    </>
  )
}

function CandidateMedia({ result }: { result: NodeResult }) {
  const media = useRef<HTMLMediaElement>(null)
  useEffect(() => {
    const element = media.current
    return () => {
      if (element) {
        element.pause()
        element.removeAttribute('src')
        element.load()
      }
    }
  }, [])
  const value = result.value
  if (value.type === 'image')
    return (
      <img
        loading="lazy"
        className="plein-shot-preview-media"
        src={assetUrls.original(value.assetId)}
        alt="当前查看的具体候选"
      />
    )
  if (value.type === 'video')
    return (
      // oxlint-disable-next-line jsx-a11y/media-has-caption -- 审看原始候选，没有凭空创建字幕轨
      <video
        ref={(el) => {
          media.current = el
        }}
        controls
        playsInline
        preload="metadata"
        className="plein-shot-preview-media"
        src={assetUrls.original(value.assetId)}
        aria-label="工作台候选视频"
      />
    )
  if (value.type === 'audio')
    return (
      // oxlint-disable-next-line jsx-a11y/media-has-caption -- 审听原始候选，没有凭空创建字幕轨
      <audio
        ref={(el) => {
          media.current = el
        }}
        controls
        preload="metadata"
        src={assetUrls.original(value.assetId)}
        aria-label="工作台候选声音"
      />
    )
  return (
    <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words text-xs">
      {value.type === 'text'
        ? value.text
        : JSON.stringify(value.type === 'json' ? value.value : value, null, 2)}
    </pre>
  )
}

function InputDetails({ input }: { input: PreparedInput }) {
  return (
    <div className="space-y-1 text-xs">
      <p>
        {input.model?.title ?? input.model?.ref ?? '模型未设置或未记录'} · {input.status}
      </p>
      <p className="whitespace-pre-wrap break-words">{input.prompt ?? '提示词未记录'}</p>
      <p>参考 {input.refs.length} 项 · 费用以执行清单为准</p>
      <details>
        <summary>生效参数、送入值与依据版本</summary>
        <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-all">
          {JSON.stringify(
            {
              v: input.v,
              inputHash: input.inputHash,
              params: input.params,
              inputs: input.inputs,
              refs: input.refs,
            },
            null,
            2,
          )}
        </pre>
      </details>
      {[
        ...new Map(
          [...input.blocked, ...input.notices].map((n) => [JSON.stringify(n), n] as const),
        ).entries(),
      ].map(([key, n]) => (
        <p key={key}>{n.message}</p>
      ))}
    </div>
  )
}
