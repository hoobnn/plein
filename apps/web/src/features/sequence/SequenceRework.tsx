/* oxlint-disable jsx-a11y/media-has-caption -- Raw generated footage has no editorial caption track yet. */
import type { Engine } from '@plein/canvas-core'
import { sequenceInstancesOf } from '@plein/doc'
import type { ArrangedClip } from '@plein/nodes'
import { useEffect, useRef, useState } from 'react'
import { assetUrls } from '../../api/client'
import { findNode } from '../../canvas/nodes'
import { loadAssetMeta } from '../../stores/assetMeta'
import { useCanvas } from '../../stores/canvas'
import { useCatalog } from '../../stores/catalog'
import { Modal, ModalHeader } from '../../ui/Modal'
import { GeneratorPanel } from '../generator/Generator'
import { useStale } from '../runs/stale'
import { applyReworkCandidate, createReworkDraft, inspectReworkSource } from './rework'

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
  const [draftId, setDraftId] = useState<string | null>(null)
  const [port, setPort] = useState('')
  const [expected, setExpected] = useState('')
  const [original, setOriginal] = useState('')
  const [candidateId, setCandidateId] = useState('')
  const [sound, setSound] = useState<'native' | 'voice' | 'mix' | ''>('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const operation = useRef(0)
  useEffect(
    () => () => {
      operation.current++
    },
    [],
  )
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
  const raw = sequenceInstancesOf(engine.doc.get(sequenceId)!).find(
    (c) => c.clipInstanceId === row.clipInstanceId,
  )
  const close = () => {
    operation.current++
    setBusy(false)
    setOpen(false)
  }
  const cancelPendingApply = () => {
    operation.current++
    setBusy(false)
    setError('')
  }
  const start = () => {
    const fresh = inspectReworkSource(engine.doc, row, canvasId)
    if (!writable() || !raw) {
      useCanvas.getState().notify('当前序列不可编辑或实例已变化，请重新核对。')
      return
    }
    if ('problem' in fresh) {
      useCanvas.getState().notify(fresh.problem!)
      return
    }
    if (findNode(catalog, fresh.source.nodeType)?.capability !== 'video.generate') {
      useCanvas.getState().notify('来源不是可编辑的视频生成节点，请明确选择其他生成来源。')
      return
    }
    const id = createReworkDraft(engine.doc, fresh.source)
    if (!id) return
    setDraftId(id)
    setPort(fresh.port)
    setExpected(JSON.stringify(raw))
    setOriginal(row.clip.assetId)
    setCandidateId('')
    setSound(raw.sound === 'legacy' ? '' : raw.sound)
    setError('')
    setOpen(true)
  }
  const apply = async () => {
    if (
      !writable() ||
      !draft ||
      !chosen ||
      chosen.value.type !== 'video' ||
      !canvasId ||
      !sound ||
      !row.clipInstanceId
    )
      return
    const serial = ++operation.current
    const expectedResult = JSON.stringify(chosen)
    setBusy(true)
    setError('')
    try {
      const meta = await loadAssetMeta(chosen.value.assetId)
      if (operation.current !== serial) return
      if (!writable()) throw new Error('当前不可编辑，未替换素材')
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
          <button
            type="button"
            className="ui-btn ui-btn-secondary ui-btn-xs"
            disabled={!writable()}
            onClick={start}
          >
            修改并生成候选
          </button>
        </>
      ) : (
        <p>
          {'problem' in sourceState
            ? sourceState.problem
            : '来源不是可编辑的视频生成节点，请先创建视频生成节点，再明确替换本实例固定素材。'}
        </p>
      )}
      {draftId && <p>返工草稿保留在画布上，可继续查看生成任务与历史。</p>}
      {open && (
        <Modal label="剪辑片段返工" top isolateKeys onClose={close} className="max-w-5xl">
          <ModalHeader title="剪辑片段返工" onClose={close} />
          <div className="overflow-auto p-4 space-y-4">
            <p className="text-sm">
              当前使用来源节点现在的输入，并非历史候选的输入快照。修改和生成只作用于独立草稿；生成整段视频，费用按所选平台计算。点击下方替换才改变剪辑。
            </p>
            <p className="text-xs">
              关闭窗口保留草稿和任务。可回画布定位草稿继续处理；再次打开会创建新的返工草稿。
            </p>
            <button
              type="button"
              className="ui-btn ui-btn-quiet ui-btn-xs"
              onClick={() => {
                if (draftId && engine.doc.has(draftId)) {
                  engine.selection.set([draftId])
                  engine.zoomToFit([draftId])
                  useCanvas.getState().openSequence(null)
                }
              }}
            >
              回画布定位返工草稿
            </button>
            {draft && !draft.locked && node && writable() ? (
              <div
                className="flex h-[440px] min-h-0 flex-col overflow-hidden rounded-xl border border-line"
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
            <label className="block text-sm">
              返工视频候选
              <select
                className="ui-input w-full"
                aria-label="返工视频候选"
                value={candidateId}
                onChange={(e) => {
                  cancelPendingApply()
                  setCandidateId(e.target.value)
                }}
              >
                <option value="">选择具体候选</option>
                {candidates.map((r, i) => (
                  <option key={r.id} value={r.id}>
                    候选 {i + 1} · {r.id}
                  </option>
                ))}
              </select>
            </label>
            {raw?.sound === 'legacy' && (
              <label className="block text-sm">
                固定后声音路线
                <select
                  className="ui-input w-full"
                  aria-label="返工固定声音路线"
                  value={sound}
                  onChange={(e) => {
                    cancelPendingApply()
                    setSound(e.target.value as typeof sound)
                  }}
                >
                  <option value="">请选择声音路线</option>
                  <option value="native">原生声音</option>
                  <option value="voice">独立配音</option>
                  <option value="mix">原生声音与配音混合</option>
                </select>
              </label>
            )}
            <p className="text-xs">
              保留本实例的入出点、变速、对白、音效和字幕设置；替换后字幕需要重新核对。其他实例与来源节点采用项保持原样。
            </p>
            {error && (
              <p role="alert" className="text-sm">
                {error}
              </p>
            )}
            <button
              type="button"
              className="ui-btn ui-btn-primary"
              disabled={!chosen || !sound || busy || !writable() || !draft || draft.locked}
              onClick={() => void apply()}
            >
              {busy ? '核对实际文件…' : '仅替换此剪辑实例'}
            </button>
          </div>
        </Modal>
      )}
    </section>
  )
}
