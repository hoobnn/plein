import {
  type ArrangedClip,
  type SequenceParams,
  type SequenceSubtitleTrack,
  sequenceNode,
  subtitleTrackStale,
} from '@plein/nodes'
import { findNode } from '../../canvas/nodes'
import { useCatalog } from '../../stores/catalog'
import { ModelPicker } from '../generator/ModelPicker'
import type { RecoverJobOptions, SubtitleRecognitionInfo } from '@plein/protocol'
import { useState } from 'react'

/** 字幕编辑的是保存到文档的同一条轨；隐藏不删除，方便逐句恢复。 */
export function SubtitleEditor({
  params,
  rows,
  busy,
  error,
  onBuild,
  onRecognize,
  onChange,
  onModelChange,
  recovery,
  onRecover,
}: {
  params: SequenceParams
  rows: ArrangedClip[]
  busy: boolean
  error: string | null
  onBuild(): void
  onRecognize(): void
  onChange(track: SequenceSubtitleTrack): void
  onModelChange(model: string): void
  recovery: SubtitleRecognitionInfo | null
  onRecover(operation: RecoverJobOptions, confirmed?: boolean): void
}) {
  const catalog = useCatalog((s) => s.catalog)
  const node = findNode(catalog, sequenceNode.type)
  const track = params.subtitleTrack
  const stale = subtitleTrackStale(params, rows)
  const patch = (id: string, value: Partial<SequenceSubtitleTrack['cues'][number]>) => {
    if (track)
      onChange({ ...track, cues: track.cues.map((q) => (q.id === id ? { ...q, ...value } : q)) })
  }
  return (
    <div className="flex flex-col gap-3" aria-label="逐句字幕编辑">
      <p className="ui-help">
        时间相对所属镜头开始。这里保存的文字与时间供预览、MP4 和工程 SRT 共用。
      </p>
      {stale && (
        <p role="status" className="text-sm text-danger">
          字幕已过期：素材、台词或剪辑已变化。请重建或重新识别后再导出。
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      {recovery && (
        <RecognitionRecovery
          key={recovery.expected}
          info={recovery}
          busy={busy}
          onRecover={onRecover}
        />
      )}
      {node && (
        <div className="seq-field">
          <span className="seq-field-label">识别模型</span>
          <ModelPicker
            value={params.model}
            node={{ ...node, capability: 'audio.transcribe' }}
            catalog={catalog}
            onChange={onModelChange}
          />
        </div>
      )}
      <button type="button" className="ui-btn ui-btn-secondary" disabled={busy} onClick={onBuild}>
        {track ? '按当前台词重建字幕（替换手改）' : '按当前台词创建字幕'}
      </button>
      <button
        type="button"
        className="ui-btn ui-btn-secondary"
        disabled={busy}
        onClick={onRecognize}
      >
        {busy ? '识别中…' : '识别全部对白并重建字幕'}
      </button>
      <p className="ui-help">
        识别使用成片设置中的语音识别模型，可能计费；相同音频和模型复用已保存的识别结果。重建会替换手改字幕。
      </p>
      {!track && <p className="ui-help">尚未创建可编辑字幕轨；当前按台词自动生成。</p>}
      {track &&
        rows.map((row, index) => {
          const source = row.source ?? `clip:${index}:${row.clip.assetId}`
          const cues = track.cues.filter((q) => q.source === source)
          return (
            <section key={source} className="seq-section">
              <h3 className="ui-section-title">镜头 {index + 1}</h3>
              {cues.map((q, i) => (
                <div key={q.id} className="mb-3 flex flex-col gap-2 rounded border border-line p-2">
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={!q.hidden}
                      onChange={(e) => patch(q.id, { hidden: !e.target.checked })}
                    />
                    显示字幕 {i + 1}
                  </label>
                  <textarea
                    aria-label={`镜头 ${index + 1} 字幕 ${i + 1} 文本`}
                    className="ui-input w-full"
                    value={q.text}
                    onChange={(e) => patch(q.id, { text: e.target.value })}
                  />
                  <div className="flex gap-2">
                    {(['start', 'end'] as const).map((field) => (
                      <label key={field} className="min-w-0 flex-1 text-xs">
                        {field === 'start' ? '开始' : '结束'}（秒）
                        <input
                          type="number"
                          min={0}
                          step={0.01}
                          className="ui-input w-full"
                          value={q[field]}
                          aria-label={`镜头 ${index + 1} 字幕 ${i + 1} ${field === 'start' ? '开始' : '结束'}（秒）`}
                          aria-invalid={(!q.hidden && q.end <= q.start) || undefined}
                          onChange={(e) => {
                            const n = Number(e.target.value)
                            if (Number.isFinite(n) && n >= 0) patch(q.id, { [field]: n })
                          }}
                        />
                      </label>
                    ))}
                  </div>
                </div>
              ))}
              <button
                type="button"
                className="ui-btn ui-btn-quiet ui-btn-sm"
                onClick={() =>
                  onChange({
                    ...track,
                    cues: [
                      ...track.cues,
                      {
                        id: crypto.randomUUID(),
                        source,
                        start: 0,
                        end: 1,
                        text: '新字幕',
                        hidden: false,
                      },
                    ],
                  })
                }
              >
                新增字幕
              </button>
            </section>
          )
        })}
    </div>
  )
}

function RecognitionRecovery({
  info,
  busy,
  onRecover,
}: {
  info: SubtitleRecognitionInfo
  busy: boolean
  onRecover(operation: RecoverJobOptions, confirmed?: boolean): void
}) {
  const [remoteId, setRemoteId] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const unknown = info.recovery.state === 'submit_unknown'
  return (
    <section
      aria-label="字幕识别恢复"
      className="flex flex-col gap-2 rounded border border-line p-2"
    >
      <p className="text-sm">{info.recovery.note}</p>
      {info.recovery.remoteId && <p className="ui-help">平台任务 ID：{info.recovery.remoteId}</p>}
      {info.recovery.refetchable && (
        <button
          type="button"
          className="ui-btn ui-btn-secondary"
          disabled={busy}
          onClick={() => onRecover({ action: 'refetch' })}
        >
          重新获取识别结果
        </button>
      )}
      {unknown && (
        <>
          {info.recovery.attachable && (
            <>
              <input
                className="ui-input"
                aria-label="字幕识别平台任务 ID"
                value={remoteId}
                onChange={(e) => setRemoteId(e.target.value)}
              />
              <button
                type="button"
                className="ui-btn ui-btn-secondary"
                disabled={busy || !remoteId.trim()}
                onClick={() => onRecover({ action: 'attach', remoteId: remoteId.trim() })}
              >
                关联任务并续查
              </button>
            </>
          )}
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            我已在平台核查，确认未受理；重新提交可能计费
          </label>
          <button
            type="button"
            className="ui-btn ui-btn-secondary"
            disabled={busy || !confirmed}
            onClick={() => onRecover({ action: 'resubmit' }, true)}
          >
            确认未受理，重新提交识别
          </button>
        </>
      )}
    </section>
  )
}
