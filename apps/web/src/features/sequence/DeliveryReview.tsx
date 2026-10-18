import type { Engine } from '@plein/canvas-core'
import {
  currentResult,
  editDelivery,
  type CanvasElement,
  type DeliveryNote,
  type DeliveryRecord,
} from '@plein/doc'
import { useEffect, useRef, useState } from 'react'
import { assetUrls } from '../../api/client'
import { AssetDownloadButton } from '../../shell/AssetDownloadButton'
import { useCanvas } from '../../stores/canvas'
import { CreativeReviewForm } from '../storyboard/CreativeReviewForm'

const timecode = (s: number) =>
  `${Math.floor(s / 60)
    .toString()
    .padStart(2, '0')}:${(s % 60).toFixed(1).padStart(4, '0')}`

const recordIdentity = (record: DeliveryRecord) =>
  JSON.stringify([
    record.id,
    record.resultId,
    record.runId,
    record.assetId,
    record.kind,
    record.version,
    record.createdAt,
    record.width,
    record.height,
    record.duration,
    record.boardId,
    record.sources,
  ])
const noteIdentity = (note: DeliveryNote) =>
  JSON.stringify([note.id, note.time, note.text, note.source, note.shotId])
const NO_RECORDS: DeliveryRecord[] = []

/** 回看真实导出的资产；编辑预览与交付确认分开。 */
export function DeliveryReview({ engine, node }: { engine: Engine; node: CanvasElement }) {
  const records = node.deliveries ?? NO_RECORDS
  const [selected, setSelected] = useState<string | undefined>(records[0]?.id)
  const record = records.find((r) => r.id === selected) ?? records[0]
  const active = useRef(record?.id)
  active.current = record?.id
  const video = useRef<HTMLVideoElement>(null)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const text = record ? (drafts[record.id] ?? '') : ''
  const [error, setError] = useState('')
  const canvasId = useCanvas((s) => s.canvasId)
  useEffect(() => {
    if (!records.length || records.some((r) => r.id === selected)) return
    setSelected(records[0]!.id)
    if (selected) setError('原交付版本已移除，已显示最新版本；原版本草稿仍保留在本次会话中')
  }, [records, selected])
  if (!record) return <p className="ui-help p-4">导出成功后，这里回看实际 MP4 并记录交付意见。</p>
  const unresolved = record.notes.filter((n) => !n.resolved).length
  const readTarget = (writable = false) => {
    const state = useCanvas.getState()
    if (
      state.engine !== engine ||
      state.canvasId !== canvasId ||
      state.sequence !== node.id ||
      active.current !== record.id
    )
      return null
    const current = engine.doc.get(node.id)
    const latest = current?.deliveries?.find((r) => r.id === record.id)
    if (!current || current.nodeType !== node.nodeType || !latest) {
      setError('交付来源或版本已移除，本次操作未执行')
      return null
    }
    if (recordIdentity(latest) !== recordIdentity(record)) {
      setError('版本内容已变化，本次操作未执行；请核对当前实际 MP4 后重试')
      return null
    }
    if (writable && engine.doc.readOnly) {
      setError('画布已变为只读，本次操作未执行；意见草稿已保留')
      return null
    }
    return latest
  }
  const save = (
    change: (latest: DeliveryRecord) => Parameters<typeof editDelivery>[3] | string | null,
  ) => {
    const latest = readTarget(true)
    if (!latest) return false
    const patch = change(latest)
    if (typeof patch === 'string') {
      setError(patch)
      return false
    }
    if (patch && !editDelivery(engine.doc, node.id, record.id, patch)) {
      setError('意见未保存，请重新打开当前版本检查')
      return false
    }
    engine.doc.flush()
    setError('')
    return true
  }
  const readNote = (expected: DeliveryNote) => {
    const latest = readTarget()
    if (!latest) return null
    const note = latest.notes.find((n) => n.id === expected.id)
    if (!note || noteIdentity(note) !== noteIdentity(expected)) {
      setError('意见已变化或移除，本次操作未执行；请核对更新内容后重试')
      return null
    }
    return note
  }
  const editNote = (expected: DeliveryNote, resolved?: boolean) => {
    save((latest) => {
      const note = latest.notes.find((n) => n.id === expected.id)
      if (!note || noteIdentity(note) !== noteIdentity(expected))
        return '意见已变化或移除，本次操作未执行；请核对更新内容后重试'
      if (resolved !== undefined && note.resolved === resolved) return null
      return {
        notes:
          resolved === undefined
            ? latest.notes.filter((n) => n.id !== note.id)
            : latest.notes.map((n) => (n.id === note.id ? { ...n, resolved } : n)),
      }
    })
  }
  const add = () => {
    if (!text.trim()) return
    const time = Math.max(0, Math.min(record.duration || Infinity, video.current?.currentTime ?? 0))
    // 片尾暂停仍属于最后一帧；中间切点继续使用左闭右开，关联下一镜。
    const at = time === record.duration ? Math.max(0, time - 0.001) : time
    const source = record.sources.find((s) => at >= s.start && at < s.end)
    const saved = save((latest) => ({
      notes: [
        ...latest.notes,
        {
          id: crypto.randomUUID(),
          time,
          text: text.trim(),
          resolved: false,
          source: source?.source,
          shotId: source?.shotId,
        },
      ],
    }))
    if (saved)
      setDrafts((current) =>
        current[record.id] === text ? { ...current, [record.id]: '' } : current,
      )
  }
  const locate = (source: string | undefined) => {
    if (!source || !engine.doc.has(source)) {
      setError('此镜头节点已不在画布中，可按保留的镜头编号核对历史版本')
      return
    }
    useCanvas.getState().openSequence(null)
    engine.selection.set([source])
    engine.zoomToFit([source])
    if (engine.doc.get(source)?.nodeType === 'plein/storyboard')
      useCanvas.getState().openStoryboard(source)
  }
  return (
    <div
      className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-4 lg:flex-row"
      aria-label="成片回看与交付"
    >
      <div className="min-w-0 flex-none lg:flex-1">
        {/* oxlint-disable-next-line jsx-a11y/media-has-caption -- 实际导出的字幕已烧录在画面内 */}
        <video
          key={record.id}
          ref={video}
          src={assetUrls.original(record.assetId)}
          controls
          className="max-h-[65vh] w-full bg-black"
          aria-label="实际导出 MP4"
        />
        <p className="mt-2 text-xs text-ink-subtle">
          实际导出 · {record.kind === 'animatic' ? '样片 / 草稿' : '成片'} · {record.version} ·{' '}
          {record.width} × {record.height} ·{' '}
          {record.duration ? `${record.duration.toFixed(1)} 秒` : '时长未知'} ·{' '}
          {new Date(record.createdAt).toLocaleString()}
          <br />
          产物 {record.assetId.slice(0, 12)} · 结果 {record.resultId}
        </p>
        <div className="mt-3">
          {currentResult(node)?.id === record.resultId && (
            <CreativeReviewForm doc={engine.doc} node={node} />
          )}
        </div>
      </div>
      <aside className="w-full shrink-0 space-y-3 lg:w-80">
        <label className="block text-xs">
          交付版本
          <select
            aria-label="交付版本"
            className="ui-input mt-1 w-full"
            value={record.id}
            onChange={(e) => {
              setSelected(e.target.value)
              active.current = e.target.value
              setError('')
            }}
          >
            {records.map((r) => (
              <option key={r.id} value={r.id}>
                {r.version} · {r.kind === 'animatic' ? '样片草稿' : '成片'} ·{' '}
                {new Date(r.createdAt).toLocaleTimeString()}
              </option>
            ))}
          </select>
        </label>
        <p className="text-sm">
          {record.confirmedAt ? '已人工确认此版本' : '待人工确认'} · {unresolved} 条未解决意见
        </p>
        <AssetDownloadButton
          engine={engine}
          assetId={record.assetId}
          name={`${node.name ?? '成片'}-${record.version}.mp4`}
          label="下载此版 MP4"
        />
        <textarea
          aria-label="成片时间码意见"
          className="ui-input min-h-20 w-full"
          placeholder="在当前播放时间记录具体意见"
          maxLength={4000}
          value={text}
          onChange={(e) => {
            const value = e.target.value
            setDrafts((current) => ({ ...current, [record.id]: value }))
          }}
          disabled={engine.doc.readOnly}
        />
        <button
          type="button"
          className="ui-btn ui-btn-secondary"
          disabled={!text.trim() || engine.doc.readOnly}
          onClick={add}
        >
          在当前时间添加意见
        </button>
        {record.notes.map((note) => (
          <div className="space-y-1 rounded border border-line p-2 text-xs" key={note.id}>
            <button
              type="button"
              className="underline"
              onClick={() => {
                const latest = readNote(note)
                if (latest && video.current) {
                  video.current.currentTime = latest.time
                  setError('')
                }
              }}
            >
              {timecode(note.time)}
            </button>
            <p className="whitespace-pre-wrap break-words">{note.text}</p>
            <div className="flex gap-2">
              <label>
                <input
                  type="checkbox"
                  checked={note.resolved}
                  disabled={engine.doc.readOnly}
                  onChange={(e) => editNote(note, e.target.checked)}
                />{' '}
                已解决
              </label>
              {note.source && (
                <button
                  type="button"
                  className="underline"
                  onClick={() => {
                    const latest = readNote(note)
                    if (latest) locate(latest.source)
                  }}
                >
                  定位镜头返工
                </button>
              )}
              <button
                type="button"
                className="text-ink-subtle"
                disabled={engine.doc.readOnly}
                onClick={() => editNote(note)}
              >
                删除
              </button>
            </div>
          </div>
        ))}
        <button
          type="button"
          className="ui-btn ui-btn-primary"
          disabled={unresolved > 0 || engine.doc.readOnly}
          onClick={() => {
            const confirm = !record.confirmedAt
            save((latest) => {
              if (confirm && latest.notes.some((note) => !note.resolved))
                return '有未解决意见，不能确认交付'
              return !!latest.confirmedAt === confirm ? null : { confirm }
            })
          }}
        >
          {record.confirmedAt
            ? '撤回此版确认'
            : record.kind === 'animatic'
              ? '确认此版草稿已审阅'
              : '确认此版本可交付'}
        </button>
        <p className="ui-help">
          确认只绑定这份实际 MP4。重新导出创建新版本，不继承旧确认；新增或修改意见会撤回确认。
        </p>
        {error && (
          <p role="alert" className="text-xs text-danger">
            {error}
          </p>
        )}
      </aside>
    </div>
  )
}
