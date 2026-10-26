import type { Engine } from '@plein/canvas-core'
import { adoptResult, setParams } from '@plein/doc'
import {
  SHOT_ANALYSIS_TYPE,
  ShotAnalysisManifest,
  shotAnalysisNode,
  shotAnalysisRanges,
} from '@plein/nodes'
import { useEffect, useId, useRef, useState } from 'react'
import { api, assetUrls } from '../../api/client'
import { useDocVersion } from '../../canvas/hooks'
import { formatTimecode } from '../../canvas/media'
import { useCanvas } from '../../stores/canvas'
import { EmptyState } from '../../ui/EmptyState'
import { Modal, ModalHeader } from '../../ui/Modal'
import { Select } from '../../ui/Select'
import { cancelNode, runNode } from '../runs/run'
import {
  analysisInputAssetId,
  analysisManifest,
  parseAnalysisCuts,
  placeAnalysisAssets,
} from './model'

export function ShotAnalysisPanel({
  engine,
  id,
  onClose,
}: {
  engine: Engine
  id: string
  onClose(): void
}) {
  useDocVersion(engine.doc)
  const el = engine.doc.get(id)
  const [selected, setSelected] = useState<string>()
  const [error, setError] = useState<string>()
  const [starting, setStarting] = useState(false)
  const startingRef = useRef(false)
  const mounted = useRef(true)
  const viewEpoch = useRef(0)
  const busy = starting || el?.run?.status === 'running' || el?.run?.status === 'queued'
  const readOnly = engine.doc.readOnly || el?.locked === true
  const report = analysisManifest(engine.doc, id, selected)
  const candidates =
    el?.results?.filter(
      (result) =>
        result.port === 'analysis' &&
        result.value.type === 'json' &&
        ShotAnalysisManifest.safeParse(result.value.value).success,
    ) ?? []
  useEffect(() => {
    if (el?.nodeType !== SHOT_ANALYSIS_TYPE) onClose()
  }, [el?.nodeType, onClose])
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const start = async (patch?: Record<string, unknown>) => {
    if (startingRef.current || readOnly || busy) return
    startingRef.current = true
    setStarting(true)
    setError(undefined)
    const epoch = viewEpoch.current
    try {
      if (
        useCanvas.getState().engine !== engine ||
        useCanvas.getState().shotAnalysis !== id ||
        engine.doc.readOnly ||
        engine.doc.get(id)?.nodeType !== SHOT_ANALYSIS_TYPE
      )
        throw new Error('目标已变化，未开始拉片')
      if (patch) {
        engine.doc.undo.stopCapturing()
        setParams(engine.doc, id, patch)
        engine.doc.undo.stopCapturing()
      }
      const canvasId = useCanvas.getState().canvasId
      if (!canvasId) throw new Error('演示画布不能运行节点，请在首页新建画布')
      const expectedParams = JSON.stringify(
        shotAnalysisNode.params.parse(engine.doc.get(id)?.params),
      )
      const expectedSource = analysisInputAssetId(engine.doc, id)
      let inputHash: string | undefined
      // Wait briefly for the document update to reach the server, then bind this request to it.
      for (let attempt = 0; attempt < 4; attempt++) {
        const preview = await api.nodeInput(canvasId, id)
        const context = useCanvas.getState()
        if (
          !mounted.current ||
          epoch !== viewEpoch.current ||
          context.engine !== engine ||
          context.canvasId !== canvasId ||
          context.shotAnalysis !== id ||
          engine.doc.readOnly ||
          engine.doc.get(id)?.locked ||
          JSON.stringify(shotAnalysisNode.params.parse(engine.doc.get(id)?.params)) !==
            expectedParams ||
          analysisInputAssetId(engine.doc, id) !== expectedSource
        )
          throw new Error('画布或输入已变化，未开始拉片')
        if (
          preview.status === 'ready' &&
          preview.inputHash &&
          JSON.stringify(shotAnalysisNode.params.parse(preview.params)) === expectedParams &&
          preview.inputs.video?.length === 1 &&
          preview.inputs.video[0]?.assetId === expectedSource
        ) {
          inputHash = preview.inputHash
          break
        }
        if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 50))
      }
      if (!inputHash) throw new Error('拉片输入尚未同步或不可用，请检查原视频后重试')
      const runId = await runNode(id, { expect: inputHash })
      if (
        runId &&
        mounted.current &&
        useCanvas.getState().engine === engine &&
        useCanvas.getState().shotAnalysis === id &&
        epoch === viewEpoch.current
      )
        setSelected(undefined)
    } catch (error) {
      setError((error as Error).message)
    } finally {
      startingRef.current = false
      setStarting(false)
    }
  }
  return (
    <Modal label="本地拉片" onClose={onClose} isolateKeys className="max-w-6xl">
      <ModalHeader
        title="本地拉片"
        meta={
          report
            ? `${report.manifest.scenes.length} 个镜头 · ${formatTimecode(report.manifest.duration)}`
            : '在本机检测，不调用模型'
        }
        onClose={onClose}
      >
        {busy ? (
          <button
            type="button"
            className="ui-btn ui-btn-secondary"
            disabled={readOnly}
            onClick={() => void cancelNode(id)}
          >
            取消处理
          </button>
        ) : (
          <button
            type="button"
            className="ui-btn ui-btn-secondary"
            disabled={readOnly}
            onClick={() => void start({ cutPlan: undefined, clips: false, audio: false })}
          >
            重新检测切点
          </button>
        )}
      </ModalHeader>
      <div className="min-h-0 overflow-y-auto p-4 sm:p-6">
        <p className="ui-help mb-3">
          视频最长 10 分钟、最长边 4096 像素、512 MiB；最多 100
          个镜头。切点依据画面差异，可以手动调整。片段为 30 fps 重编码，每段至少 1/30
          秒，时长误差最多一帧；原音轨包含对白、音乐和环境声。
        </p>
        {readOnly && (
          <p className="ui-help mb-3">当前只读：可以查看已有清单，不能编辑、处理或放入画布。</p>
        )}
        {busy && (
          <p role="status" className="ui-help mb-3">
            {el?.run?.message ??
              '正在本机处理，关闭面板后任务继续；服务重启会从冻结输入重新执行本地阶段。'}
          </p>
        )}
        {(error || el?.run?.error) && (
          <p role="alert" className="ui-help mb-3 text-danger">
            {error ?? el?.run?.error}
          </p>
        )}
        {candidates.length > 0 && (
          <div className="mb-4 flex items-center gap-3">
            <Select
              aria-label="拉片清单版本"
              value={report?.result.id ?? selected ?? ''}
              options={candidates.map((result, index) => ({
                value: result.id,
                label: `清单 ${index + 1} · ${new Date(result.at).toLocaleString()}`,
              }))}
              onChange={(value) => {
                viewEpoch.current++
                setSelected(value)
              }}
            />
            {report && (
              <button
                type="button"
                className="ui-btn ui-btn-secondary"
                disabled={readOnly || busy}
                onClick={() => adoptResult(engine.doc, id, report.result.id)}
              >
                采用此清单
              </button>
            )}
          </div>
        )}
        {report ? (
          <button
            type="button"
            className="ui-btn ui-btn-secondary mb-4"
            onClick={() =>
              useCanvas
                .getState()
                .openAiAnalysis({ kind: 'local', nodeId: id, resultId: report.result.id })
            }
          >
            可选 AI 分析与分镜草稿（默认关闭）
          </button>
        ) : null}
        {report ? (
          <Report
            key={report.result.id}
            engine={engine}
            id={id}
            report={report}
            busy={busy}
            readOnly={readOnly}
            onRun={start}
          />
        ) : (
          <EmptyState
            title={selected ? '这份拉片清单已移除或无法读取' : '还没有拉片结果'}
            hint="连入一段本地视频，点击检测。关键帧、视频片段和原音轨都会保存为新素材。"
            action={
              !busy && (
                <button
                  type="button"
                  className="ui-btn ui-btn-primary"
                  disabled={readOnly}
                  onClick={() => void start()}
                >
                  检测切点
                </button>
              )
            }
          />
        )}
      </div>
    </Modal>
  )
}

function Report({
  engine,
  id,
  report,
  busy,
  readOnly,
  onRun,
}: {
  engine: Engine
  id: string
  report: NonNullable<ReturnType<typeof analysisManifest>>
  busy: boolean
  readOnly: boolean
  onRun(patch: Record<string, unknown>): Promise<void>
}) {
  const { manifest, result } = report
  const [cuts, setCuts] = useState(
    manifest.scenes
      .slice(1)
      .map((scene) => Number(scene.start.toFixed(6)))
      .join(', '),
  )
  const [clips, setClips] = useState(false)
  const [audio, setAudio] = useState(false)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string>()
  const base = useRef(JSON.stringify(engine.doc.get(id)?.params))
  const root = useRef<HTMLDivElement>(null)
  const cutsId = useId()
  useEffect(() => {
    const media = [...(root.current?.querySelectorAll('video') ?? [])]
    return () => {
      for (const video of media) {
        video.pause()
        video.removeAttribute('src')
        video.load()
      }
    }
  }, [])
  const disabled = readOnly || busy
  const selectedIds = manifest.scenes
    .filter((scene) => picked.has(scene.id))
    .map((scene) => scene.id)
  const run = async () => {
    setError(undefined)
    try {
      if (useCanvas.getState().engine !== engine || useCanvas.getState().shotAnalysis !== id)
        throw new Error('画布已切换，请重新打开清单')
      if (JSON.stringify(engine.doc.get(id)?.params) !== base.current)
        throw new Error('拉片设置已变化，请重新载入切点后再处理')
      if (analysisInputAssetId(engine.doc, id) !== manifest.source.assetId)
        throw new Error('原视频已变化，请重新检测切点')
      const points = parseAnalysisCuts(cuts, manifest.duration)
      if (
        clips &&
        shotAnalysisRanges(manifest.duration, points).some(
          (range) => range.end - range.start < 1 / 30 - 0.000000001,
        )
      )
        throw new Error('提取视频片段时，每段必须至少 1/30 秒；更短区间可只提取关键帧')
      const pending = onRun({
        cutPlan: { sourceAssetId: manifest.source.assetId, points },
        clips,
        audio,
      })
      base.current = JSON.stringify(engine.doc.get(id)?.params)
      await pending
    } catch (error) {
      setError((error as Error).message)
    }
  }
  const place = (kind: 'frames' | 'clips' | 'audio') => {
    setError(undefined)
    try {
      if (useCanvas.getState().engine !== engine || useCanvas.getState().shotAnalysis !== id)
        throw new Error('画布已切换，请重新打开清单')
      const ids = placeAnalysisAssets(engine.doc, id, result.id, selectedIds, kind)
      engine.selection.set(ids)
      useCanvas.getState().notify(`已放入 ${ids.length} 份素材，可一次撤销`)
    } catch (error) {
      setError((error as Error).message)
    }
  }
  return (
    <div ref={root}>
      <div className="mb-4 rounded-xl border border-line p-4">
        <label className="mb-2 block text-sm" htmlFor={cutsId}>
          切点（秒数或时间码，逗号分隔；留空表示整段）
        </label>
        <textarea
          id={cutsId}
          className="ui-input min-h-16 w-full"
          value={cuts}
          disabled={disabled}
          onChange={(event) => setCuts(event.target.value)}
        />
        <div className="mt-3 flex flex-wrap items-center gap-4 text-sm">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={clips}
              disabled={disabled}
              onChange={(event) => setClips(event.target.checked)}
            />
            提取视频片段
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={audio}
              disabled={disabled}
              onChange={(event) => setAudio(event.target.checked)}
            />
            提取原音轨
          </label>
          <button
            type="button"
            className="ui-btn ui-btn-primary"
            disabled={disabled}
            onClick={() => void run()}
          >
            按这些切点处理
          </button>
          <button
            type="button"
            className="ui-btn ui-btn-quiet"
            disabled={disabled}
            onClick={() => {
              setCuts(
                manifest.scenes
                  .slice(1)
                  .map((scene) => Number(scene.start.toFixed(6)))
                  .join(', '),
              )
              base.current = JSON.stringify(engine.doc.get(id)?.params)
              setError(undefined)
            }}
          >
            重新载入切点
          </button>
        </div>
      </div>
      {error && (
        <p role="alert" className="ui-help mb-3 text-danger">
          {error}
        </p>
      )}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="ui-btn ui-btn-secondary"
          onClick={() => setPicked(new Set(manifest.scenes.map((scene) => scene.id)))}
        >
          全选镜头
        </button>
        <button type="button" className="ui-btn ui-btn-quiet" onClick={() => setPicked(new Set())}>
          清空选择
        </button>
        <button
          type="button"
          className="ui-btn ui-btn-secondary"
          disabled={disabled || !selectedIds.length}
          onClick={() => place('frames')}
        >
          放入关键帧
        </button>
        <button
          type="button"
          className="ui-btn ui-btn-secondary"
          disabled={
            disabled ||
            !selectedIds.some((scene) => manifest.scenes.find((item) => item.id === scene)?.clip)
          }
          onClick={() => place('clips')}
        >
          放入视频片段
        </button>
        {manifest.audio && (
          <button
            type="button"
            className="ui-btn ui-btn-secondary"
            disabled={disabled}
            onClick={() => place('audio')}
          >
            放入原音轨
          </button>
        )}
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {manifest.scenes.map((scene, index) => (
          <section key={scene.id} className="overflow-hidden rounded-xl border border-line">
            <label className="flex items-center gap-2 p-3 text-sm">
              <input
                type="checkbox"
                aria-label={`选择镜头 ${index + 1}`}
                checked={picked.has(scene.id)}
                onChange={(event) =>
                  setPicked((previous) => {
                    const next = new Set(previous)
                    if (event.target.checked) next.add(scene.id)
                    else next.delete(scene.id)
                    return next
                  })
                }
              />
              镜头 {index + 1} · {formatTimecode(scene.start)} — {formatTimecode(scene.end)}
            </label>
            <img
              className="aspect-video w-full bg-surface-2 object-contain"
              loading="lazy"
              src={assetUrls.original(scene.frame.assetId)}
              alt={`镜头 ${index + 1} 关键帧`}
            />
            <div className="p-3 text-xs text-ink-muted">
              采样请求 {scene.frame.at.toFixed(3)} 秒
              {scene.frame.actualAt !== undefined &&
                ` · 实际帧 ${scene.frame.actualAt.toFixed(3)} 秒`}
            </div>
            {scene.clip && (
              <video
                className="aspect-video w-full bg-surface-2"
                controls
                muted
                playsInline
                preload="none"
                src={assetUrls.original(scene.clip.assetId)}
                aria-label={`镜头 ${index + 1} 片段`}
              />
            )}
          </section>
        ))}
      </div>
      <div className="mt-4 space-y-1">
        {manifest.notes.map((note) => (
          <p key={note} className="ui-help">
            {note}
          </p>
        ))}
      </div>
    </div>
  )
}
