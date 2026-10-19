import type { Engine } from '@plein/canvas-core'
import type {
  StoryboardBatchPlan,
  StoryboardBatchRequest,
  StoryboardBatchRow,
} from '@plein/protocol'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, api } from '../../api/client'
import { useCanvas } from '../../stores/canvas'
import { Modal, ModalHeader } from '../../ui/Modal'

const actions = { run: '本次生成', reuse: '沿用', blocked: '阻塞', skip: '跳过' }
const roles = { image: '分镜图', video: '视频', speech: '配音', sfx: '音效' }

export function BatchChecklist({
  engine,
  canvasId,
  boardId,
  request,
  onClose,
  onLocate,
  onStarted,
}: {
  engine: Engine
  canvasId: string
  boardId: string
  request: StoryboardBatchRequest
  onClose(): void
  onLocate(row: StoryboardBatchRow): void
  onStarted(total: number): void
}) {
  const [plan, setPlan] = useState<StoryboardBatchPlan | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [stale, setStale] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const sync = useCanvas((s) => s.sync)
  const online = sync === 'connected'
  const version = useRef(0)
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
  const requestKey = JSON.stringify(request)
  const load = useCallback(async () => {
    const mine = ++version.current
    setLoading(true)
    setStale(true)
    setError(null)
    if (useCanvas.getState().sync !== 'connected') {
      setLoading(false)
      return
    }
    try {
      const next = await api.storyboardBatchPreview(
        canvasId,
        boardId,
        JSON.parse(requestKey) as StoryboardBatchRequest,
      )
      if (mine !== version.current) return
      setPlan(next)
      setStale(false)
    } catch (cause) {
      if (mine === version.current) setError((cause as Error).message)
    } finally {
      if (mine === version.current) setLoading(false)
    }
  }, [canvasId, boardId, requestKey])
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
    setBusy(true)
    setError(null)
    try {
      const started = await api.storyboardBatchCommit(canvasId, boardId, plan.token)
      onStarted(started.total)
    } catch (cause) {
      const changed =
        cause instanceof ApiError && cause.code === 'input_changed'
          ? (cause.body as { plan?: StoryboardBatchPlan })?.plan
          : null
      if (changed) {
        setPlan(changed)
        setStale(false)
      } else setStale(true)
      setError((cause as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const summary = plan?.summary
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
        {summary && (
          <p aria-label="清单汇总" className="mb-4 text-sm">
            生成 {summary.run} 项 · 沿用 {summary.reuse} 项 · 阻塞 {summary.blocked} 项 · 跳过{' '}
            {summary.skip} 项{' · '}预计 {summary.calls} 次模型调用（不含自动重试）
            {summary.prices.map((price) => (
              <span key={price.currency}>
                {' '}
                · 配置估算 {price.amount.toFixed(2)} {price.currency}
              </span>
            ))}
            {summary.unknownCalls > 0 && <span> · {summary.unknownCalls} 次价格未知</span>}
          </p>
        )}
        <table className="w-full text-left text-sm" aria-label="本次批量项目">
          <thead>
            <tr className="border-b border-line text-ink-muted">
              <th className="p-2">项目</th>
              <th className="p-2">处理</th>
              <th className="p-2">原因与实际输入</th>
              <th className="p-2">修复</th>
            </tr>
          </thead>
          <tbody>
            {plan?.rows.map((row) => (
              <tr key={row.key} className="border-b border-line align-top">
                <td className="p-2">
                  <p>{row.name}</p>
                  <p className="text-xs text-ink-subtle">
                    {row.prerequisite ? '资产准备' : row.shotNo ? `镜头 ${row.shotNo}` : ''}
                  </p>
                </td>
                <td className="whitespace-nowrap p-2">
                  {actions[row.action]}
                  {row.calls > 0 && <p className="text-xs text-ink-muted">预计 {row.calls} 次</p>}
                </td>
                <td className="max-w-120 p-2">
                  <p>{row.reason}</p>
                  {row.input && (
                    <details className="mt-1 text-xs text-ink-muted">
                      <summary className="cursor-pointer">
                        查看实际输入{row.deferred ? '（资产准备后复核）' : ''}
                      </summary>
                      <p>{row.input.model?.title ?? '尚未选模型'}</p>
                      <p className="mt-1 whitespace-pre-wrap break-words">
                        {row.input.prompt ?? ''}
                      </p>
                      {row.input.notices.map((notice) => (
                        <p key={`${notice.code}/${notice.elementId ?? ''}/${notice.message}`}>
                          {notice.message}
                        </p>
                      ))}
                    </details>
                  )}
                </td>
                <td className="p-2">
                  <button
                    type="button"
                    className="ui-btn ui-btn-quiet ui-btn-xs"
                    disabled={busy}
                    onClick={() => onLocate(row)}
                  >
                    定位
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
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
