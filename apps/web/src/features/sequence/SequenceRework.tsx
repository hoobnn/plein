/* oxlint-disable jsx-a11y/media-has-caption -- Raw generated footage has no editorial caption track yet. */
import type { Engine } from '@plein/canvas-core'
import { sequenceInstancesOf, type CanvasElement } from '@plein/doc'
import type { ArrangedClip } from '@plein/nodes'
import { useEffect, useRef, useState } from 'react'
import { assetUrls } from '../../api/client'
import { findNode } from '../../canvas/nodes'
import { loadAssetMeta } from '../../stores/assetMeta'
import { useCanvas } from '../../stores/canvas'
import { useCatalog } from '../../stores/catalog'
import { Modal, ModalHeader } from '../../ui/Modal'
import { Select } from '../../ui/Select'
import { GeneratorPanel } from '../generator/Generator'
import { useStale } from '../runs/stale'
import {
  applyReworkCandidate,
  createReworkDraft,
  currentReworkSource,
  inspectReworkSource,
  reworkSourcePin,
} from './rework'
import {
  clearReworkSession,
  readReworkSession,
  writeReworkSession,
  type ReworkSession,
  type ReworkSound,
} from './reworkSessions'

type ReworkSource = { source: CanvasElement; port: string }

/** Generate in an independent canvas draft, then explicitly adopt into this one editorial use. */
export function SequenceRework({
  engine,
  sequenceId,
  row,
  writable,
}: {
  engine: Engine
  sequenceId: string
  row: ArrangedClip
  writable(): boolean
}) {
  const canvasId = useCanvas((s) => s.canvasId)
  const catalog = useCatalog((s) => s.catalog)
  const [open, setOpen] = useState(false)
  const [session, setSession] = useState<ReworkSession | null>(null)
  const [remembered, setRemembered] = useState<ReworkSession | undefined>(undefined)
  const [draftId, setDraftId] = useState<string | null>(null)
  const [port, setPort] = useState('')
  const [expected, setExpected] = useState('')
  const [original, setOriginal] = useState('')
  const [candidateId, setCandidateId] = useState('')
  const [sound, setSound] = useState<ReworkSound>('')
  const [identityChanged, setIdentityChanged] = useState(false)
  const [sourcePinChanged, setSourcePinChanged] = useState(false)
  const [staleInstance, setStaleInstance] = useState(false)
  const [sessionNotice, setSessionNotice] = useState('')
  const [sessionPersisted, setSessionPersisted] = useState(true)
  const [pendingLeave, setPendingLeave] = useState<(() => void) | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const operation = useRef(0)
  const instanceId = row.clipInstanceId
  useEffect(() => {
    if (!canvasId || !instanceId) {
      setRemembered(undefined)
      return
    }
    setRemembered(readReworkSession(canvasId, sequenceId, instanceId))
  }, [canvasId, sequenceId, instanceId])
  useEffect(
    () => () => {
      operation.current++
    },
    [],
  )
  const sessionAtRisk = !!session && !sessionPersisted
  // 本机存不下会话时刷新或关标签会丢续接关系；至少在浏览器离开前提醒一次。
  useEffect(() => {
    if (!sessionAtRisk) return
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [sessionAtRisk])
  const sourceState = inspectReworkSource(engine.doc, row, canvasId)
  const local = 'problem' in sourceState ? undefined : sourceState
  const sourceNode = local && findNode(catalog, local.source.nodeType)
  const allowed = sourceNode?.capability === 'video.generate'
  const stale = useStale((s) => (draftId ? s.nodes.get(draftId) : undefined))
  const draft = draftId ? engine.doc.get(draftId) : undefined
  const node = draft && findNode(catalog, draft.nodeType)
  const candidates =
    draft?.results?.filter((r) => r.port === port && r.value.type === 'video') ?? []
  const chosen = candidates.find((r) => r.id === candidateId)
  const available = session ?? remembered
  const resumable =
    !!available && engine.doc.has(available.draftId) && !engine.doc.get(available.draftId)?.locked
  const raw = sequenceInstancesOf(engine.doc.get(sequenceId)!).find(
    (c) => c.clipInstanceId === row.clipInstanceId,
  )
  const close = () => {
    operation.current++
    setBusy(false)
    setOpen(false)
  }
  /** 关闭弹窗本身还会保留内存会话；本机没存下时先确认，避免用户以为刷新也能续接。 */
  const leave = (action: () => void) => {
    if (sessionAtRisk) {
      setPendingLeave(() => action)
      return
    }
    action()
  }
  const requestClose = () => leave(close)
  const cancelPendingApply = () => {
    operation.current++
    setBusy(false)
    setError('')
  }
  const remember = (next: ReworkSession) => {
    setSessionPersisted(writeReworkSession(next))
    setSession(next)
    setRemembered(next)
  }
  const patchSession = (patch: Partial<ReworkSession>) => {
    if (!session) return
    remember({ ...session, ...patch, savedAt: Date.now() })
  }
  const openNew = (fresh: ReworkSource, rawRow: NonNullable<typeof raw>) => {
    if (!canvasId || !row.clipInstanceId) return
    const pin = reworkSourcePin(row, fresh.source, fresh.port)
    if (!pin) {
      useCanvas.getState().notify('无法确认片段当前采用的视频候选，请重新核对后再返工。')
      return
    }
    const id = createReworkDraft(engine.doc, fresh.source)
    if (!id) return
    const next: ReworkSession = {
      canvasId,
      sequenceId,
      clipInstanceId: row.clipInstanceId,
      sourceId: fresh.source.id,
      port: fresh.port,
      sourceResultId: pin.resultId,
      sourceRunId: pin.runId,
      sourceAssetId: pin.assetId,
      draftId: id,
      expected: JSON.stringify(rawRow),
      candidateId: '',
      sound: rawRow.sound === 'legacy' ? '' : rawRow.sound,
      savedAt: Date.now(),
    }
    remember(next)
    setDraftId(id)
    setPort(fresh.port)
    setExpected(next.expected)
    setOriginal(row.clip.assetId)
    setCandidateId('')
    setSound(next.sound)
    setIdentityChanged(false)
    setSourcePinChanged(false)
    setStaleInstance(false)
    setSessionNotice('')
    setError('')
    setOpen(true)
  }
  /** 恢复旧关系，只打开已有草稿；不新建草稿，也不会重新提交生成。 */
  const openSaved = (
    saved: ReworkSession,
    fresh: ReworkSource,
    rawRow: NonNullable<typeof raw>,
  ) => {
    const savedDraft = engine.doc.get(saved.draftId)
    if (!savedDraft || savedDraft.kind !== 'node' || savedDraft.locked) return false
    const sourceMatches =
      saved.sourceId === fresh.source.id &&
      saved.port === fresh.port &&
      savedDraft.nodeType === fresh.source.nodeType
    const currentPin = reworkSourcePin(row, fresh.source, fresh.port)
    const sourcePinMatches =
      !!currentPin &&
      saved.sourceResultId === currentPin.resultId &&
      saved.sourceRunId === currentPin.runId &&
      saved.sourceAssetId === currentPin.assetId
    const instanceMatches = saved.expected === JSON.stringify(rawRow)
    const savedCandidate = (savedDraft.results ?? []).find(
      (result) =>
        result.id === saved.candidateId &&
        result.port === saved.port &&
        result.value.type === 'video',
    )
    const savedSound: ReworkSound =
      rawRow.sound === 'legacy'
        ? saved.sound === 'native' || saved.sound === 'voice' || saved.sound === 'mix'
          ? saved.sound
          : ''
        : rawRow.sound
    setSession(saved)
    setRemembered(saved)
    // 内存会话可能因 quota 一直没写进本机；只有存储里确实还是这份会话才算可刷新续接。
    const stored =
      canvasId && row.clipInstanceId
        ? readReworkSession(canvasId, sequenceId, row.clipInstanceId)
        : undefined
    setSessionPersisted(
      !!stored &&
        stored.draftId === saved.draftId &&
        stored.candidateId === saved.candidateId &&
        stored.sound === saved.sound &&
        stored.sourceResultId === saved.sourceResultId &&
        stored.sourceRunId === saved.sourceRunId &&
        stored.sourceAssetId === saved.sourceAssetId &&
        stored.expected === saved.expected,
    )
    setDraftId(saved.draftId)
    setPort(saved.port)
    setExpected(saved.expected)
    setOriginal(row.clip.assetId)
    setCandidateId(savedCandidate?.id ?? '')
    setSound(savedSound)
    setIdentityChanged(!sourceMatches)
    setSourcePinChanged(sourceMatches && !sourcePinMatches)
    setStaleInstance(sourceMatches && sourcePinMatches && !instanceMatches)
    setSessionNotice(
      !sourceMatches
        ? '这份返工草稿来自之前的来源片段，当前片段已变化，不能直接替换。请另起版本，或回画布查看旧草稿。'
        : !sourcePinMatches
          ? '当前片段采用的来源视频已与开始返工时不同。旧草稿不会直接替换，请先核对当前来源，确认继续或另起版本。'
          : !instanceMatches
            ? '此剪辑实例在上次返工后已变化。旧草稿不会自动替换；先核对最新修剪与声音，确认后继续，或另起版本。'
            : '',
    )
    setError('')
    setOpen(true)
    return true
  }
  const start = (resume: boolean) => {
    // 另起版本或重新打开都显式取消仍在等待媒体探测的旧替换。
    operation.current++
    setBusy(false)
    setError('')
    if (!writable() || !raw) {
      useCanvas.getState().notify('当前序列不可编辑或实例已变化，请重新核对。')
      return
    }
    const fresh = inspectReworkSource(engine.doc, row, canvasId)
    if ('problem' in fresh) {
      useCanvas.getState().notify(fresh.problem!)
      return
    }
    if (findNode(catalog, fresh.source.nodeType)?.capability !== 'video.generate') {
      useCanvas.getState().notify('来源不是可编辑的视频生成节点，请明确选择其他生成来源。')
      return
    }
    if (resume) {
      const saved =
        (session && session.clipInstanceId === row.clipInstanceId ? session : undefined) ??
        (canvasId && row.clipInstanceId
          ? readReworkSession(canvasId, sequenceId, row.clipInstanceId)
          : undefined)
      if (saved) {
        const savedDraft = engine.doc.get(saved.draftId)
        if (savedDraft && savedDraft.kind === 'node' && !savedDraft.locked) {
          if (openSaved(saved, fresh, raw)) return
        }
        if (canvasId && row.clipInstanceId)
          clearReworkSession(canvasId, sequenceId, row.clipInstanceId)
        setSession(null)
        setRemembered(undefined)
        useCanvas
          .getState()
          .notify(
            savedDraft
              ? '上次返工草稿已锁定，已新建返工草稿。'
              : '上次返工草稿已删除，已新建返工草稿。',
          )
      }
    }
    openNew(fresh, raw)
  }
  const confirmSourceChange = () => {
    if (!session || !local || identityChanged) return
    const pin = reworkSourcePin(row, local.source, local.port)
    if (!pin) {
      setError('无法确认当前采用的来源视频，请重新打开片段核对。')
      return
    }
    const next = {
      ...session,
      sourceResultId: pin.resultId,
      sourceRunId: pin.runId,
      sourceAssetId: pin.assetId,
      savedAt: Date.now(),
    }
    remember(next)
    setSourcePinChanged(false)
    const instanceMatches = !!raw && next.expected === JSON.stringify(raw)
    setStaleInstance(!instanceMatches)
    setSessionNotice(
      instanceMatches
        ? ''
        : '此剪辑实例在上次返工后已变化。旧草稿不会自动替换；先核对最新修剪与声音，确认后继续，或另起版本。',
    )
    setError('')
  }
  const confirmInstanceChange = () => {
    if (!session || !raw || identityChanged || sourcePinChanged) return
    const next = { ...session, expected: JSON.stringify(raw), savedAt: Date.now() }
    remember(next)
    setExpected(next.expected)
    setStaleInstance(false)
    setSessionNotice('')
    setError('')
  }
  /** 按当前真实 Y.Doc 再核来源 tuple、文件与活跃草稿；每次 await 前后都要过一遍。 */
  const ensureCurrentSource = () => {
    if (!session || !canvasId || !row.clipInstanceId) return '返工会话已失效，请重新核对。'
    const current = currentReworkSource(engine.doc, sequenceId, row.clipInstanceId, canvasId)
    if ('problem' in current) return current.problem
    if (current.source.id !== session.sourceId || current.port !== session.port) {
      setIdentityChanged(true)
      return '来源片段已变化，不能直接替换；请核对后另起版本。'
    }
    if (
      current.pin.resultId !== session.sourceResultId ||
      current.pin.runId !== session.sourceRunId ||
      current.pin.assetId !== session.sourceAssetId
    ) {
      setSourcePinChanged(true)
      return '当前采用的来源视频已变化，请先核对后再替换。'
    }
    if (!draft || session.draftId !== draft.id) return '返工会话已切换，请重新核对。'
    const activeDraft = engine.doc.get(draft.id)
    if (!activeDraft || activeDraft.kind !== 'node' || activeDraft.locked)
      return '返工草稿已删除或锁定，请重新打开核对。'
    return undefined
  }
  const apply = async () => {
    if (
      !writable() ||
      !draft ||
      !chosen ||
      chosen.value.type !== 'video' ||
      !canvasId ||
      !sound ||
      !row.clipInstanceId ||
      identityChanged ||
      sourcePinChanged ||
      staleInstance
    )
      return
    const serial = ++operation.current
    const expectedResult = JSON.stringify(chosen)
    setBusy(true)
    setError('')
    try {
      const before = ensureCurrentSource()
      if (before) throw new Error(before)
      const meta = await loadAssetMeta(chosen.value.assetId)
      if (operation.current !== serial) return
      if (!writable()) throw new Error('当前不可编辑，未替换素材')
      // 探测媒体期间同一来源可能换了采用视频，raw 实例 JSON 却不变；按实时文档再核一次。
      const after = ensureCurrentSource()
      if (after) throw new Error(after)
      if (meta.kind !== 'video' || !meta.duration)
        throw new Error('读不到候选的实际视频时长，请重试')
      const saved = applyReworkCandidate(engine.doc, {
        canvasId,
        sequenceId,
        instanceId: row.clipInstanceId,
        expected,
        draftId: draft.id,
        port,
        resultId: chosen.id,
        expectedResult,
        duration: meta.duration,
        sound,
        legacyAudio: { dialogue: row.dialogue?.source, sfx: row.sfx?.source },
      })
      if (!saved)
        throw new Error(
          '实例或候选已变化，或新素材短于保留的入出点。请重新打开核对；需要时先调整修剪范围。',
        )
      clearReworkSession(canvasId, sequenceId, row.clipInstanceId)
      setSession(null)
      setRemembered(undefined)
      useCanvas
        .getState()
        .notify('已仅替换此剪辑实例；请复核修剪、声音和字幕。原片段与返工候选保留。')
      close()
    } catch (cause) {
      if (operation.current === serial) setError((cause as Error).message)
    } finally {
      if (operation.current === serial) setBusy(false)
    }
  }
  if (!row.clipInstanceId) return null
  return (
    <section className="seq-section space-y-2 text-xs" aria-label="剪辑内返工">
      <h3 className="ui-section-title">剪辑内返工</h3>
      {allowed ? (
        <>
          <p>复制来源的当前输入为独立草稿，生成新候选后仅替换本实例。</p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="ui-btn ui-btn-secondary ui-btn-xs"
              disabled={!writable()}
              onClick={() => start(true)}
            >
              {resumable ? '继续上次返工草稿' : '修改并生成候选'}
            </button>
            {resumable && (
              <button
                type="button"
                className="ui-btn ui-btn-secondary ui-btn-xs"
                disabled={!writable()}
                onClick={() => start(false)}
              >
                另起版本
              </button>
            )}
          </div>
        </>
      ) : (
        <p>
          {'problem' in sourceState
            ? sourceState.problem
            : '来源不是可编辑的视频生成节点，请先创建视频生成节点，再明确替换本实例固定素材。'}
        </p>
      )}
      {draftId && <p>返工草稿保留在画布上，可继续上次会话或重新定位查看生成任务与历史。</p>}
      {sessionAtRisk && (
        <p role="status" className="text-warning">
          本机存储不可用，刷新或离开后无法续接这份返工会话；草稿本身仍在画布上，请保持窗口打开并先完成替换。
        </p>
      )}
      {open && (
        <Modal label="剪辑片段返工" top isolateKeys onClose={requestClose} size="lg">
          <ModalHeader title="剪辑片段返工" onClose={requestClose} />
          <div className="overflow-auto p-4 space-y-4">
            <p className="text-sm">
              当前使用来源节点现在的输入，并非历史候选的输入快照。修改和生成只作用于独立草稿；生成整段视频，费用按所选平台计算。点击下方替换才改变剪辑。
            </p>
            <p className="text-xs">
              {sessionAtRisk
                ? '本机存储不可用，关闭或刷新后无法续接这次返工会话；草稿和任务仍在画布上，但需要重新定位。'
                : '关闭窗口或刷新后仍会继续这份草稿与任务；不会自动重新请求生成，也不会重复扣费。'}
            </p>
            <button
              type="button"
              className="ui-btn ui-btn-quiet ui-btn-xs"
              onClick={() =>
                leave(() => {
                  if (draftId && engine.doc.has(draftId)) {
                    engine.selection.set([draftId])
                    engine.zoomToFit([draftId])
                    useCanvas.getState().openSequence(null)
                  }
                })
              }
            >
              回画布定位返工草稿
            </button>
            {draft && !draft.locked && node && writable() ? (
              <div
                className="flex h-110 min-h-0 flex-col overflow-hidden rounded-xl border border-line"
                aria-label="返工生成输入"
              >
                <GeneratorPanel
                  key={draft.id}
                  engine={engine}
                  el={draft}
                  node={node}
                  catalog={catalog}
                />
              </div>
            ) : (
              <p role="status">草稿已删除或当前不可编辑，请关闭后重新打开。</p>
            )}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <p>原片段</p>
                {/* Raw generated footage has no caption track before editorial replacement. */}
                {/* oxlint-disable-next-line jsx-a11y/media-has-caption */}
                <video
                  className="w-full"
                  src={assetUrls.original(original)}
                  controls
                  preload="metadata"
                />
              </div>
              <div>
                <p>待替换候选</p>
                {chosen?.value.type === 'video' ? (
                  <video
                    key={chosen.id}
                    className="w-full"
                    src={assetUrls.original(chosen.value.assetId)}
                    controls
                    preload="metadata"
                  />
                ) : (
                  <p>生成完成后选择候选，先预览再替换。</p>
                )}
              </div>
            </div>
            {stale && (
              <p role="status" className="text-sm">
                返工输入或上游参考已变化，已有候选不代表当前设置。请先重新生成，或预览核对后明确选择要保留的候选。
              </p>
            )}
            {sessionNotice && (
              <p role="status" className="text-sm text-warning">
                {sessionNotice}
              </p>
            )}
            <div className="block text-sm">
              返工视频候选
              <Select
                className="ui-input w-full"
                aria-label="返工视频候选"
                value={candidateId}
                options={[
                  { value: '', label: '选择具体候选' },
                  ...candidates.map((r, i) => ({
                    value: r.id,
                    label: `候选 ${i + 1} · ${r.id}`,
                  })),
                ]}
                onChange={(value) => {
                  cancelPendingApply()
                  setCandidateId(value)
                  patchSession({ candidateId: value })
                }}
              />
            </div>
            {raw?.sound === 'legacy' && (
              <div className="block text-sm">
                固定后声音路线
                <Select
                  className="ui-input w-full"
                  aria-label="返工固定声音路线"
                  value={sound}
                  options={[
                    { value: '', label: '请选择声音路线' },
                    { value: 'native', label: '原生声音' },
                    { value: 'voice', label: '独立配音' },
                    { value: 'mix', label: '原生声音与配音混合' },
                  ]}
                  onChange={(value) => {
                    cancelPendingApply()
                    setSound(value as ReworkSound)
                    patchSession({ sound: value as ReworkSound })
                  }}
                />
              </div>
            )}
            <p className="text-xs">
              保留本实例的入出点、变速、对白、音效和字幕设置；替换后字幕需要重新核对。其他实例与来源节点采用项保持原样。
            </p>
            {sourcePinChanged && !identityChanged && (
              <button
                type="button"
                className="ui-btn ui-btn-secondary"
                disabled={!writable()}
                onClick={confirmSourceChange}
              >
                我已核对当前采用的来源视频，继续此草稿
              </button>
            )}
            {staleInstance && !identityChanged && !sourcePinChanged && (
              <button
                type="button"
                className="ui-btn ui-btn-secondary"
                disabled={!writable()}
                onClick={confirmInstanceChange}
              >
                我已核对最新剪辑设置，继续此草稿
              </button>
            )}
            {error && (
              <p role="alert" className="text-sm">
                {error}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="ui-btn ui-btn-primary"
                disabled={
                  !chosen ||
                  !sound ||
                  busy ||
                  !writable() ||
                  !draft ||
                  draft.locked ||
                  identityChanged ||
                  sourcePinChanged ||
                  staleInstance
                }
                onClick={() => void apply()}
              >
                {busy ? '核对实际文件…' : '仅替换此剪辑实例'}
              </button>
              <button
                type="button"
                className="ui-btn ui-btn-secondary"
                disabled={!writable()}
                onClick={() => start(false)}
              >
                另起版本
              </button>
            </div>
          </div>
        </Modal>
      )}
      {pendingLeave && (
        <Modal
          label="返工草稿未保存"
          onClose={() => setPendingLeave(null)}
          top
          isolateKeys
          size="sm"
        >
          <ModalHeader title="返工会话未保存到本机" onClose={() => setPendingLeave(null)} />
          <div className="space-y-3 p-4 text-sm">
            <p>本机存储不可用，关闭或离开后无法继续同一返工草稿与任务；草稿本身仍在画布上。</p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="ui-btn ui-btn-primary"
                onClick={() => setPendingLeave(null)}
              >
                继续编辑
              </button>
              <button
                type="button"
                className="ui-btn ui-btn-secondary"
                onClick={() => {
                  const action = pendingLeave
                  setPendingLeave(null)
                  action?.()
                }}
              >
                仍然离开
              </button>
            </div>
          </div>
        </Modal>
      )}
    </section>
  )
}
