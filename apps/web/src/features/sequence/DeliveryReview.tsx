import type { Engine } from '@plein/canvas-core'
import { currentResult, editDelivery, type CanvasElement, type DeliveryNote } from '@plein/doc'
import { useEffect, useRef, useState } from 'react'
import { assetUrls } from '../../api/client'
import { downloadAsset } from '../../canvas/grid'
import { useCanvas } from '../../stores/canvas'
import { CreativeReviewForm } from '../storyboard/CreativeReviewForm'

const timecode = (s: number) =>
  `${Math.floor(s / 60)
    .toString()
    .padStart(2, '0')}:${(s % 60).toFixed(1).padStart(4, '0')}`

/** 回看真实导出的资产；编辑预览与交付确认分开。 */
export function DeliveryReview({ engine, node }: { engine: Engine; node: CanvasElement }) {
  const records = node.deliveries ?? []
  const [selected, setSelected] = useState<string>()
  const record = records.find((r) => r.id === selected) ?? records[0]
  const video = useRef<HTMLVideoElement>(null)
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  const newest = records[0]?.id
  useEffect(() => {
    setSelected(undefined)
    setText('')
    setError('')
  }, [newest])
  if (!record) return <p className="ui-help p-4">导出成功后，这里回看实际 MP4 并记录交付意见。</p>
  const unresolved = record.notes.filter((n) => !n.resolved).length
  const save = (notes: DeliveryNote[]) => {
    if (!editDelivery(engine.doc, node.id, record.id, { notes }))
      setError('意见未保存，请重新打开当前版本检查')
    else {
      engine.doc.flush()
      setError('')
    }
  }
  const add = () => {
    if (!text.trim()) return
    const time = Math.max(0, Math.min(record.duration || Infinity, video.current?.currentTime ?? 0))
    // 片尾暂停仍属于最后一帧；中间切点继续使用左闭右开，关联下一镜。
    const at = time === record.duration ? Math.max(0, time - 0.001) : time
    const source = record.sources.find((s) => at >= s.start && at < s.end)
    save([
      ...record.notes,
      {
        id: crypto.randomUUID(),
        time,
        text: text.trim(),
        resolved: false,
        source: source?.source,
        shotId: source?.shotId,
      },
    ])
    setText('')
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
    <div className="flex min-h-0 flex-1 gap-4 overflow-auto p-4" aria-label="成片回看与交付">
      <div className="min-w-0 flex-1">
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
      <aside className="w-80 shrink-0 space-y-3">
        <label className="block text-xs">
          交付版本
          <select
            aria-label="交付版本"
            className="ui-input mt-1 w-full"
            value={record.id}
            onChange={(e) => {
              setSelected(e.target.value)
              setText('')
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
        <button
          type="button"
          className="ui-btn ui-btn-quiet"
          onClick={() =>
            downloadAsset(record.assetId, `${node.name ?? '成片'}-${record.version}.mp4`)
          }
        >
          下载此版 MP4
        </button>
        <textarea
          aria-label="成片时间码意见"
          className="ui-input min-h-20 w-full"
          placeholder="在当前播放时间记录具体意见"
          maxLength={4000}
          value={text}
          onChange={(e) => setText(e.target.value)}
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
                if (video.current) video.current.currentTime = note.time
              }}
            >
              {timecode(note.time)}
            </button>
            <p className="whitespace-pre-wrap">{note.text}</p>
            <div className="flex gap-2">
              <label>
                <input
                  type="checkbox"
                  checked={note.resolved}
                  disabled={engine.doc.readOnly}
                  onChange={(e) =>
                    save(
                      record.notes.map((n) =>
                        n.id === note.id ? { ...n, resolved: e.target.checked } : n,
                      ),
                    )
                  }
                />{' '}
                已解决
              </label>
              {note.source && (
                <button type="button" className="underline" onClick={() => locate(note.source)}>
                  定位镜头返工
                </button>
              )}
              <button
                type="button"
                className="text-ink-subtle"
                disabled={engine.doc.readOnly}
                onClick={() => save(record.notes.filter((n) => n.id !== note.id))}
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
            if (!editDelivery(engine.doc, node.id, record.id, { confirm: !record.confirmedAt }))
              setError('有未解决意见，不能确认交付')
            engine.doc.flush()
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
