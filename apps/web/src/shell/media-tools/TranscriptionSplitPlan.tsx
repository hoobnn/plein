import type { Engine } from '@plein/canvas-core'
import {
  currentResult,
  elementMedia,
  primaryResult,
  type CanvasElement,
  type NodeResult,
} from '@plein/doc'
import { useEffect, useRef, useState } from 'react'
import { api } from '../../api/client'
import { useDocVersion } from '../../canvas/hooks'
import type { MediaTarget } from '../../canvas/media'
import { findNode } from '../../canvas/nodes'
import { deriveNode } from '../../canvas/presets'
import { useCanvas } from '../../stores/canvas'
import { useCatalog } from '../../stores/catalog'
import { Select } from '../../ui/Select'
import { useClosing } from '../../ui/Presence'
import { transcriptionSourceMatches, transcriptionSplitPlan } from '../audioSegments'

interface Candidate {
  nodeId: string
  name: string
  result: NodeResult
  element: ReturnType<Engine['doc']['mutable']>
  signature: string
}
function signature(node: CanvasElement | undefined) {
  const result = node && currentResult(node, 'segments')
  return node?.nodeType === 'plein/transcribe' && result?.value.type === 'json'
    ? JSON.stringify([node.id, node.adopted, result.id, result.runId, result.value])
    : null
}
function audioSignature(node: CanvasElement | undefined) {
  const result = node?.kind === 'node' ? primaryResult(node) : undefined
  return JSON.stringify([
    node?.kind,
    node?.assetId,
    node?.adopted,
    result?.id,
    result?.runId,
    result?.value,
  ])
}

export function TranscriptionSplitPlan({
  engine,
  target,
  duration,
  onPlan,
  onDraftCreated,
}: {
  engine: Engine
  target: MediaTarget
  duration?: number
  onPlan(text: string): void
  onDraftCreated?(): void
}) {
  useDocVersion(engine.doc)
  const canvasId = useCanvas((state) => state.canvasId)
  const closing = useClosing()
  const live = useRef({ binding: '', closing })
  const maps = useRef(new WeakMap<object, number>())
  const mapCounter = useRef(0)
  const identity = (value: object | undefined) => {
    if (!value) return 0
    let result = maps.current.get(value)
    if (result === undefined) {
      result = ++mapCounter.current
      maps.current.set(value, result)
    }
    return result
  }
  const candidates: Candidate[] = []
  for (const node of engine.doc.elements()) {
    const stamp = signature(node)
    if (!stamp) continue
    const result = currentResult(node, 'segments')!
    if (result.runId)
      candidates.push({
        nodeId: node.id,
        name: node.name || '语音识别',
        result,
        element: engine.doc.mutable(node.id),
        signature: stamp,
      })
  }
  const sourceMap = engine.doc.mutable(target.elId)
  const sourceStamp = audioSignature(engine.doc.get(target.elId))
  const sourceKey = JSON.stringify([
    canvasId,
    target.elId,
    target.assetId,
    identity(sourceMap),
    sourceStamp,
  ])
  const binding = JSON.stringify([
    sourceKey,
    candidates.map((candidate) => [identity(candidate.element), candidate.signature]),
  ])
  live.current = { binding, closing }
  const [loaded, setLoaded] = useState<{
    binding: string
    candidates: Candidate[]
    skipped: number
  } | null>(null)
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  const sourceCurrent = () => {
    const state = useCanvas.getState()
    const node = engine.doc.get(target.elId)
    return (
      state.engine === engine &&
      state.canvasId === canvasId &&
      target.kind === 'audio' &&
      !!node &&
      !live.current.closing &&
      engine.doc.mutable(target.elId) === sourceMap &&
      audioSignature(node) === sourceStamp &&
      elementMedia(node)?.kind === 'audio' &&
      elementMedia(node!)?.assetId === target.assetId
    )
  }
  const writable = () =>
    sourceCurrent() && !engine.doc.readOnly && !engine.doc.get(target.elId)?.locked
  const candidateCurrent = (candidate: Candidate) =>
    engine.doc.mutable(candidate.nodeId) === candidate.element &&
    signature(engine.doc.get(candidate.nodeId)) === candidate.signature
  useEffect(() => {
    let alive = true
    const current = () => alive && live.current.binding === binding && sourceCurrent()
    setLoaded(null)
    setSelected('')
    setError(null)
    if (!canvasId || !current()) {
      setLoading(false)
      return
    }
    setLoading(true)
    const matches: Candidate[] = []
    let next = 0
    let skipped = 0
    const worker = async () => {
      while (next < candidates.length && current()) {
        const candidate = candidates[next++]!
        try {
          const job = await api.canvasJob(canvasId, candidate.result.runId)
          if (!current()) return
          if (
            candidateCurrent(candidate) &&
            transcriptionSourceMatches(
              job,
              candidate.nodeId,
              candidate.result.runId,
              target.assetId,
            )
          )
            matches.push(candidate)
          else skipped++
        } catch {
          if (current()) skipped++
        }
      }
    }
    void Promise.all(Array.from({ length: Math.min(4, candidates.length) }, worker)).then(() => {
      if (!current()) return
      const ordered = candidates.filter((candidate) => matches.includes(candidate))
      setLoaded({ binding, candidates: ordered, skipped })
      setSelected(ordered[0]?.nodeId ?? '')
      setLoading(false)
    })
    return () => {
      alive = false
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- binding包含源Map和当前采用候选的完整身份；无关画布操作不重新读取历史
  }, [engine, binding, retry, closing])
  const verified = loaded?.binding === binding ? loaded.candidates.filter(candidateCurrent) : []
  const chosen = verified.find((candidate) => candidate.nodeId === selected) ?? verified[0]
  let plan: ReturnType<typeof transcriptionSplitPlan> | undefined
  let issue: string | undefined
  if (chosen?.result.value.type === 'json') {
    try {
      plan = transcriptionSplitPlan(chosen.result.value.value, duration)
    } catch (cause) {
      issue = (cause as Error).message
    }
  }
  const create = () => {
    if (!writable()) return setError('音频或编辑权限已变化，请重新选择素材')
    const catalog = useCatalog.getState().catalog
    if (!findNode(catalog, 'plein/transcribe')) return setError('当前没有语音识别工具')
    const id = deriveNode(engine, catalog, target.elId, 'plein/transcribe', {
      inputPort: 'audio',
      sourceAssetId: target.assetId,
      name: `${engine.doc.get(target.elId)?.name || '音频'} · 语音识别`,
    })
    if (id) onDraftCreated?.()
    else setError('音频已变化，无法创建语音识别草稿')
  }
  return (
    <section
      aria-label="识别分句切分计划"
      className="flex flex-col gap-2 rounded-xl border border-line bg-surface-2 p-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-medium">按语音分句准备区间</h4>
        <button
          type="button"
          className="ui-btn ui-btn-secondary ui-btn-xs"
          disabled={!writable()}
          onClick={create}
        >
          创建语音识别草稿
        </button>
      </div>
      <p className="ui-help">
        使用当前音频已采用的识别时间戳，导入后可手动编辑；创建草稿不自动识别或切分。
      </p>
      {loading ? (
        <p role="status" className="ui-help">
          正在核验识别结果的源音频…
        </p>
      ) : verified.length ? (
        <>
          <Select
            aria-label="已核验的识别结果"
            value={chosen!.nodeId}
            options={verified.map((candidate) => ({
              value: candidate.nodeId,
              label: `${candidate.name} · ${candidate.result.id.slice(-8)}`,
            }))}
            onChange={setSelected}
          />
          <p className="ui-help">
            {plan ? `${plan.segments.length} 个原始分句` : '已核验音频来源'}
          </p>
          {plan && (
            <details className="text-xs">
              <summary className="cursor-pointer">查看全部分句</summary>
              <ol className="ui-scrollbar mt-2 flex max-h-36 flex-col gap-1 overflow-y-auto">
                {plan.segments.map((segment) => (
                  <li key={`${segment.start}:${segment.end}`}>
                    <span className="tabular-nums">
                      {segment.start}–{segment.end} 秒
                    </span>{' '}
                    · {segment.text}
                  </li>
                ))}
              </ol>
            </details>
          )}
          {plan?.issue && (
            <p role="status" className="ui-help">
              {plan.issue}
            </p>
          )}
          {issue && (
            <p role="status" className="text-xs text-danger">
              {issue}
            </p>
          )}
          {plan && (
            <button
              type="button"
              className="ui-btn ui-btn-secondary ui-btn-sm self-start"
              disabled={!writable()}
              onClick={() => {
                if (live.current.binding !== binding || !writable() || !candidateCurrent(chosen!))
                  return setError('音频或已采用识别结果已变化，请重新核验')
                onPlan(plan!.text)
              }}
            >
              使用识别区间{plan.issue ? '（需编辑）' : ''}
            </button>
          )}
        </>
      ) : (
        <p role="status" className="ui-help">
          没有可核验为当前音频的已采用识别结果。
          {loaded?.skipped ? '来源无法确认的结果不会用于切分。' : ''}
        </p>
      )}
      <button
        type="button"
        className="ui-btn ui-btn-quiet ui-btn-xs self-start"
        disabled={loading || !sourceCurrent()}
        onClick={() => setRetry((value) => value + 1)}
      >
        重新读取识别结果
      </button>
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
    </section>
  )
}
