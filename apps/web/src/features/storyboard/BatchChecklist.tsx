import type { Engine } from '@plein/canvas-core'
import { shotSegmentMapping } from '@plein/capabilities'
import type {
  StoryboardBatchPlan,
  StoryboardBatchRequest,
  StoryboardBatchRow,
} from '@plein/protocol'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, api } from '../../api/client'
import { useCanvas } from '../../stores/canvas'
import { Modal, ModalHeader } from '../../ui/Modal'
import { BatchPlanDetails } from './BatchPlanDetails'

const roles = { image: '分镜图', video: '视频', speech: '配音', sfx: '音效' }

export function BatchChecklist({
  engine,
  canvasId,
  boardId,
  request,
  onClose,
  onLocate,
  onStarted,
  isCurrent,
}: {
  engine: Engine
  canvasId: string
  boardId: string
  request: StoryboardBatchRequest
  onClose(): void
  onLocate(row: StoryboardBatchRow): void
  onStarted(total: number): void
  isCurrent?(): boolean
}) {
  const [plan, setPlan] = useState<StoryboardBatchPlan | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [stale, setStale] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sequenceId, setSequenceId] = useState(request.sequenceId ?? '')
  const sync = useCanvas((s) => s.sync)
  const online = sync === 'connected'
  const version = useRef(0)
  const planVersion = useRef(-1)
  const invalidate = useCallback(() => {
    version.current++
  }, [])
  useEffect(() => {
    if (online) return
    // 同步中断后不能继续信任旧预检，连同断线前尚未返回的请求一起作废。
    invalidate()
    setStale(true)
    setLoading(false)
  }, [online, invalidate])
  const requestKey = JSON.stringify({ ...request, sequenceId: sequenceId || undefined })
  const load = useCallback(async () => {
    const mine = ++version.current
    setLoading(true)
    setStale(true)
    setError(null)
    if (useCanvas.getState().sync !== 'connected' || isCurrent?.() === false) {
      setLoading(false)
      return
    }
    try {
      const next = await api.storyboardBatchPreview(
        canvasId,
        boardId,
        JSON.parse(requestKey) as StoryboardBatchRequest,
      )
      if (mine !== version.current || isCurrent?.() === false) return
      planVersion.current = mine
      setPlan(next)
      setStale(false)
    } catch (cause) {
      if (mine === version.current) setError((cause as Error).message)
    } finally {
      if (mine === version.current) setLoading(false)
    }
  }, [canvasId, boardId, requestKey, isCurrent])
  useEffect(() => {
    const off = engine.doc.subscribe(() => {
      invalidate()
      setStale(true)
      setLoading(false)
    })
    void load()
    return () => {
      invalidate()
      off()
    }
  }, [engine, load, invalidate])

  const commit = async () => {
    if (!plan || busy || stale || loading || !online) return
    const current = useCanvas.getState()
    if (
      current.engine !== engine ||
      current.canvasId !== canvasId ||
      current.sync !== 'connected' ||
      engine.doc.readOnly
    )
      return setError('画布、同步或编辑权限已变化，请重新打开清单')
    if (planVersion.current !== version.current) {
      setStale(true)
      return setError('清单范围或内容已变化，请重新检查')
    }
    if (isCurrent?.() === false) return setError('工作台目标或权限已变化，请重新打开清单')
    const mine = version.current
    setBusy(true)
    setError(null)
    try {
      const started = await api.storyboardBatchCommit(canvasId, boardId, plan.token)
      if (isCurrent?.() !== false) onStarted(started.total)
    } catch (cause) {
      const changed =
        cause instanceof ApiError && cause.code === 'input_changed'
          ? (cause.body as { plan?: StoryboardBatchPlan })?.plan
          : null
      if (changed && mine === version.current && isCurrent?.() !== false) {
        planVersion.current = mine
        setPlan(changed)
        setStale(false)
      } else setStale(true)
      setError((cause as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const summary = plan?.summary
  const locateMapping = (row: StoryboardBatchRow, clipInstanceId: string) => {
    const state = useCanvas.getState()
    if (
      !row.mapping ||
      !row.shotId ||
      state.engine !== engine ||
      state.canvasId !== canvasId ||
      isCurrent?.() === false
    )
      return
    const mapping = shotSegmentMapping(engine.doc, {
      canvasId,
      boardId,
      shotId: row.shotId,
      sequenceId: row.mapping.sequenceId,
    })
    if (
      mapping.problem ||
      !mapping.instances.some((instance) => instance.clipInstanceId === clipInstanceId) ||
      planVersion.current !== version.current
    )
      return setError('清单映射已变化，请重新检查')
    onClose()
    engine.selection.set([row.mapping.sequenceId])
    engine.zoomToFit([row.mapping.sequenceId])
    state.openSequence(row.mapping.sequenceId, clipInstanceId)
  }
  return (
    <Modal
      label="批量生成清单"
      onClose={() => {
        if (!busy) onClose()
      }}
      isolateKeys
      className="max-w-280"
    >
      <ModalHeader
        title={`${roles[request.role]}生成清单`}
        closeDisabled={busy}
        onClose={() => {
          if (!busy) onClose()
        }}
      >
        <button
          type="button"
          className="ui-btn ui-btn-secondary"
          disabled={loading || busy || !online}
          onClick={() => void load()}
        >
          {loading ? '正在检查…' : '重新检查清单'}
        </button>
      </ModalHeader>
      <div className="ui-scrollbar min-h-0 overflow-auto p-5">
        <p className="mb-3 text-sm text-ink-muted">
          {request.reuseExisting
            ? '补齐未完成项，沿用已有采用结果。'
            : '为所选镜头创建新候选，旧候选保留。'}
          资产准备也列在下方；阻塞和跳过项本次不会提交。
        </p>
        {!!plan?.scope?.sequenceIds.length && (
          <label className="mb-3 block text-sm">
            本次序列范围{' '}
            <select
              aria-label="批量清单序列范围"
              className="ui-input"
              value={sequenceId}
              disabled={busy || loading}
              onChange={(event) => {
                invalidate()
                setStale(true)
                setPlan(null)
                setSequenceId(event.target.value)
              }}
            >
              <option value="">唯一关联时确定；多个序列需选择</option>
              {[...new Set([...plan.scope.sequenceIds, ...(sequenceId ? [sequenceId] : [])])].map(
                (id) => (
                  <option key={id} value={id}>
                    {engine.doc.get(id)?.name ?? id} · {id}
                  </option>
                ),
              )}
            </select>
          </label>
        )}
        {!online && (
          <p role="status" className="mb-3 text-sm text-danger">
            当前未连接服务，恢复连接并重新检查后才能提交。
          </p>
        )}
        {error && (
          <p role="alert" className="mb-3 text-sm text-danger">
            {error}
          </p>
        )}
        {stale && !loading && (
          <p role="status" className="mb-3 text-sm text-danger">
            内容或任务已变化，请重新检查清单。
          </p>
        )}
        {plan && (
          <BatchPlanDetails
            plan={plan}
            busy={busy}
            onLocate={onLocate}
            onLocateMapping={locateMapping}
          />
        )}
        {!plan && loading && (
          <p className="py-6 text-sm text-ink-muted">正在准备实际输入，不会调用生成平台…</p>
        )}
      </div>
      <footer className="flex items-center justify-end gap-3 border-t border-line p-4">
        <button type="button" className="ui-btn ui-btn-secondary" disabled={busy} onClick={onClose}>
          取消
        </button>
        <button
          type="button"
          className="ui-btn ui-btn-primary"
          disabled={!summary?.run || loading || stale || busy || !online}
          onClick={() => void commit()}
        >
          {busy ? '正在确认…' : '确认并开始生成'}
        </button>
      </footer>
    </Modal>
  )
}
