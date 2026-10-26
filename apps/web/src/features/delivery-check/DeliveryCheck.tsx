import type { Engine } from '@plein/canvas-core'
import type { DeliveryRecord, CanvasElement } from '@plein/doc'
import { deliveryCheckNode, DELIVERY_CHECK_TYPE, type DeliveryCheckRequest } from '@plein/nodes'
import { useEffect, useRef, useState } from 'react'
import { api } from '../../api/client'
import { useCanvas } from '../../stores/canvas'
import { useSession } from '../../stores/session'
import { cancelNode, runNode } from '../runs/run'
import {
  createDeliveryCheck,
  deliveryCheckBoards,
  deliveryCheckRequest,
  deliveryReports,
  isCurrentDeliveryReport,
} from './model'

const states = { passed: '通过', issues: '问题', unchecked: '未检查', failed: '检查失败' }
const labels = {
  source: '实际文件',
  decode: '完整解码',
  spec: '实际规格',
  duration: '实际时长',
  audio: '预期音轨',
  subtitles: '字幕计划区间',
  black: '黑场候选',
  silence: '静音候选',
}

export function DeliveryCheck({
  engine,
  node,
  record,
}: {
  engine: Engine
  node: CanvasElement
  record: DeliveryRecord
}) {
  const canvasId = useCanvas((state) => state.canvasId)
  const principal = useSession((state) => state.info?.principal)
  const [boardId, setBoardId] = useState<string>()
  const [selected, setSelected] = useState<string>()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const mounted = useRef(true),
    busyRef = useRef(false)
  const epoch = useRef(0)
  const viewKey = JSON.stringify([canvasId, node.id, record.id])
  const latestView = useRef(viewKey)
  latestView.current = viewKey
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const writable = !engine.doc.readOnly && !!principal && principal.role !== 'viewer'
  const boards = canvasId ? deliveryCheckBoards(engine.doc, canvasId, node.id, record) : []
  let request: DeliveryCheckRequest | undefined,
    reason = ''
  try {
    if (!canvasId) throw new Error('演示画布不支持本地技术检查')
    request = deliveryCheckRequest(engine.doc, canvasId, node.id, record.id, boardId)
  } catch (failure) {
    reason = (failure as Error).message
  }
  const entries = deliveryReports(engine.doc, node.id)
  const current =
    request && entries.find((entry) => isCurrentDeliveryReport(engine.doc, request!, entry))
  const shown = selected
    ? entries.find((entry) => entry.result.id === selected)
    : (current ?? entries[0])
  const active = [...engine.doc.elements()].filter(
    (el) =>
      el.nodeType === DELIVERY_CHECK_TYPE &&
      (el.params?.request as DeliveryCheckRequest | undefined)?.scope?.sequenceId === node.id &&
      (el.run?.status === 'running' || el.run?.status === 'queued'),
  )
  const failed = [...engine.doc.elements()].filter(
    (el) =>
      el.nodeType === DELIVERY_CHECK_TYPE &&
      (el.params?.request as DeliveryCheckRequest | undefined)?.scope?.sequenceId === node.id &&
      el.run?.status === 'failed',
  )
  const readCurrent = (captured: DeliveryCheckRequest) => {
    const state = useCanvas.getState(),
      actor = useSession.getState().info?.principal
    if (
      !mounted.current ||
      latestView.current !== viewKey ||
      state.engine !== engine ||
      state.canvasId !== canvasId ||
      state.sequence !== node.id ||
      engine.doc.readOnly ||
      !actor ||
      actor.role === 'viewer'
    )
      throw new Error('画布、交付视图或权限已变化，未开始本地检查')
    const now = deliveryCheckRequest(engine.doc, canvasId!, node.id, record.id, boardId)
    if (JSON.stringify(now) !== JSON.stringify(captured))
      throw new Error('实际输出或目标版本已变化，请重新核对后检查')
    return now
  }
  const start = async () => {
    if (busyRef.current || !request) return
    busyRef.current = true
    setPending(true)
    setError('')
    const captured = request,
      attemptEpoch = ++epoch.current
    try {
      readCurrent(captured)
      const id = createDeliveryCheck(engine.doc, captured)
      let inputHash: string | undefined
      for (let attempt = 0; attempt < 4; attempt++) {
        const preview = await api.nodeInput(canvasId!, id)
        readCurrent(captured)
        if (attemptEpoch !== epoch.current) throw new Error('检查视图已变化，未执行迟到请求')
        if (
          preview.status === 'ready' &&
          preview.inputHash &&
          JSON.stringify(deliveryCheckNode.params.parse(preview.params)) ===
            JSON.stringify(deliveryCheckNode.params.parse({ request: captured }))
        ) {
          inputHash = preview.inputHash
          break
        }
        if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 50))
      }
      if (!inputHash) throw new Error('固定检查请求尚未同步，请重试')
      readCurrent(captured)
      await runNode(id, { expect: inputHash })
      if (mounted.current && attemptEpoch === epoch.current) setSelected(undefined)
    } catch (failure) {
      if (mounted.current && attemptEpoch === epoch.current) setError((failure as Error).message)
    } finally {
      busyRef.current = false
      if (mounted.current && attemptEpoch === epoch.current) setPending(false)
    }
  }
  return (
    <section
      className="space-y-2 rounded-lg border border-line p-2 text-xs"
      aria-label="成片技术检查"
      data-testid="delivery-check"
    >
      <h3 className="font-medium">成片技术检查</h3>
      <p className="text-ink-subtle">
        免费本地处理，不调用模型，不修改人工交付确认。视频可解码、音轨存在均不代表创作内容可用。
      </p>
      {boards.length > 1 && (
        <label className="ui-field">
          <span className="ui-label">检查哪份分镜目标</span>
          <select
            aria-label="技术检查分镜目标"
            className="ui-input"
            value={boardId ?? ''}
            onChange={(event) => {
              epoch.current++
              setPending(false)
              busyRef.current = false
              setBoardId(event.target.value || undefined)
              setSelected(undefined)
              setError('')
            }}
          >
            <option value="">请选择精确目标</option>
            {boards.map((board) => (
              <option key={board.id} value={board.id}>
                {board.name ?? '分镜'} · {board.id.slice(-8)}
              </option>
            ))}
          </select>
        </label>
      )}
      <p className="break-all text-2xs">
        固定输出 {record.assetId.slice(0, 12)} · {record.resultId}
        {request ? ` · 目标 ${request.goal.id}` : ''}
      </p>
      {reason && (
        <p role="status" className="text-warning">
          {reason}
        </p>
      )}
      {!writable && <p role="status">当前只读：可以查看已有报告，不能运行或取消。</p>}
      {error && (
        <p role="alert" className="text-danger">
          {error}
        </p>
      )}
      <button
        type="button"
        className="ui-btn ui-btn-secondary ui-btn-sm"
        disabled={!writable || !request || pending || active.length > 0}
        onClick={() => void start()}
      >
        {pending ? '核对固定输入…' : '执行免费本地技术检查'}
      </button>
      {active.map((item) => (
        <div key={item.id} role="status">
          <p>
            {item.run?.message ??
              '本地技术检查进行中；关闭后任务继续，目标变版后报告只保留对应历史。'}
          </p>
          <button
            type="button"
            className="ui-btn ui-btn-secondary ui-btn-sm"
            disabled={!writable}
            onClick={() => void cancelNode(item.id, item.run?.id)}
          >
            取消本地检查
          </button>
        </div>
      ))}
      {failed.slice(-1).map((item) => (
        <p key={item.id} role="status" className="text-danger">
          检查失败：{item.run?.error ?? '本次作业未完成，旧报告未替换'}
        </p>
      ))}
      {entries.length > 0 && (
        <label className="ui-field">
          <span className="ui-label">技术报告版本</span>
          <select
            aria-label="技术报告版本"
            className="ui-input"
            value={shown?.result.id ?? selected ?? ''}
            onChange={(event) => setSelected(event.target.value)}
          >
            {selected && !shown && <option value={selected}>原报告已移除</option>}
            {entries.map((entry) => (
              <option key={`${entry.node.id}:${entry.result.id}`} value={entry.result.id}>
                {new Date(entry.report.at).toLocaleString()} · {states[entry.report.status]} ·{' '}
                {entry.result.id.slice(-8)}
              </option>
            ))}
          </select>
        </label>
      )}
      {shown ? (
        <div className="space-y-2" data-testid="delivery-check-report">
          <p className="font-medium">
            {request && isCurrentDeliveryReport(engine.doc, request, shown)
              ? '当前输出与目标对应的报告'
              : '历史报告：不能作为当前输出／目标的检查结论'}{' '}
            · 技术范围{states[shown.report.status]}
          </p>
          <p className="break-all text-2xs">
            产物 {shown.report.request.source.assetId} · 结果 {shown.report.request.resultId} · 目标{' '}
            {shown.report.request.goal.id}
          </p>
          <details>
            <summary className="cursor-pointer">检查时的目标与执行依据</summary>
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all text-2xs">
              {shown.report.request.goal.snapshot}
            </pre>
            <p>
              {shown.report.engine} · 规则 v{shown.report.rules.version}
            </p>
            <pre className="whitespace-pre-wrap break-all text-2xs">
              {JSON.stringify(shown.report.rules)}
            </pre>
          </details>
          <ul className="space-y-1" aria-label="技术检查项目">
            {shown.report.checks.map((check) => (
              <li key={check.id}>
                <span className="font-medium">
                  {labels[check.id]}：{states[check.status]}
                </span>
                <p className="text-ink-subtle">{check.detail}</p>
              </li>
            ))}
          </ul>
          {(['black', 'silence'] as const).map(
            (kind) =>
              shown.report.observed[kind].length > 0 && (
                <details key={kind}>
                  <summary className="cursor-pointer">
                    {kind === 'black' ? '黑场' : '静音'}候选区间（
                    {shown.report.observed[kind].length}）
                  </summary>
                  <ul>
                    {shown.report.observed[kind].map((interval) => (
                      <li key={`${interval.start}:${interval.end}`}>
                        {interval.start.toFixed(3)}–{interval.end.toFixed(3)} 秒
                      </li>
                    ))}
                  </ul>
                </details>
              ),
          )}
          <p>
            实际解码 {shown.report.observed.decodedFrames} 帧 ·{' '}
            {shown.report.observed.duration?.toFixed(3) ?? '未知'} 秒 ·{' '}
            {shown.report.observed.width ?? '?'}×{shown.report.observed.height ?? '?'} ·{' '}
            {shown.report.observed.audioTracks} 条音轨
          </p>
          {!!shown.report.observed.audioUncovered?.length && (
            <details open>
              <summary>音频样本未覆盖区间（未检查）</summary>
              <ul>
                {shown.report.observed.audioUncovered.map((interval) => (
                  <li key={`${interval.start}:${interval.end}`}>
                    {interval.start.toFixed(3)}–{interval.end.toFixed(3)} 秒
                  </li>
                ))}
              </ul>
            </details>
          )}
          <ul aria-label="未检查的创作内容" className="text-ink-subtle">
            {shown.report.unchecked.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="text-ink-subtle">
          {selected
            ? '原报告已移除，请明确选择其他报告。'
            : '尚无技术报告。打开本面板不会执行检查。'}
        </p>
      )}
    </section>
  )
}
