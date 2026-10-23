import {
  type ArrangedClip,
  type SequenceParams,
  type SequenceSubtitleTrack,
  sequenceNode,
  sequenceRowKey,
  subtitleTrackStale,
} from '@plein/nodes'
import { findNode } from '../../canvas/nodes'
import { useCatalog } from '../../stores/catalog'
import { ModelPicker } from '../generator/ModelPicker'
import type { RecoverJobOptions, SubtitleRecognitionInfo } from '@plein/protocol'
import { useEffect, useId, useState } from 'react'

/** 字幕草稿：用户刚输入的文字，以及这次编辑有没有写进文档 */
type SubtitleDraft = { text: string; saved: boolean }

/** 字幕编辑的是保存到文档的同一条轨；隐藏不删除，方便逐句恢复。 */
export function SubtitleEditor({
  params,
  rows,
  busy,
  error,
  onBuild,
  onRecognize,
  onChange,
  onEditBoundary,
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
  onEditBoundary(): void
  onModelChange(model: string): void
  recovery: SubtitleRecognitionInfo | null
  onRecover(operation: RecoverJobOptions, confirmed?: boolean): void
}) {
  const validationId = useId()
  const catalog = useCatalog((s) => s.catalog)
  const node = findNode(catalog, sequenceNode.type)
  const track = params.subtitleTrack
  const stale = subtitleTrackStale(params, rows)
  // 本地草稿：字幕轨过期时编辑写不进文档，用户刚输入的文字不能被回滚冲掉
  const [drafts, setDrafts] = useState<Record<string, SubtitleDraft>>({})
  useEffect(() => {
    // 文档里的字幕和草稿一致：这次编辑已经写进文档，之后按文档走，
    // 撤销重做和别人的改动都要跟得上，不能被草稿挡住。
    // 一直对不上：这次编辑被拒（字幕轨过期），草稿留着给用户核对。
    setDrafts((old) => {
      if (!Object.keys(old).length) return old
      const next: Record<string, SubtitleDraft> = {}
      for (const [id, draft] of Object.entries(old)) {
        const cue = track?.cues.find((q) => q.id === id)
        if (!cue) continue
        if (cue.text === draft.text) {
          if (!draft.saved) next[id] = { ...draft, saved: true }
          continue
        }
        if (!draft.saved) next[id] = draft
      }
      return next
    })
  }, [track])
  const unmappedOccurrences = new Map<string, number>()
  const unmapped = (track?.unmappedCues ?? []).map((item) => {
    const value = JSON.stringify(item)
    const occurrence = unmappedOccurrences.get(value) ?? 0
    unmappedOccurrences.set(value, occurrence + 1)
    return { ...item, displayKey: `${value}:${occurrence}` }
  })
  const patch = (id: string, value: Partial<SequenceSubtitleTrack['cues'][number]>) => {
    if (track)
      onChange({
        ...track,
        cues: track.cues.map((q) =>
          q.id === id
            ? {
                ...q,
                ...value,
                ...('text' in value || 'start' in value || 'end' in value
                  ? { origin: 'manual' as const }
                  : {}),
              }
            : q,
        ),
      })
  }
  return (
    <div
      className="flex flex-col gap-3"
      aria-label="逐句字幕编辑"
      onFocusCapture={onEditBoundary}
      onBlurCapture={onEditBoundary}
      onClickCapture={(event) => {
        // 连续点击按钮或空格切换复选框也应各自独立撤销。
        if ((event.target as Element).closest('button, input[type="checkbox"]')) onEditBoundary()
      }}
    >
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
      {!!track?.unmappedCues?.length && (
        <section
          aria-label="未映射旧字幕"
          className="flex flex-col gap-2 rounded border border-line p-3"
        >
          <h3 className="ui-section-title">保留的未映射旧字幕 · {track.unmappedCues.length} 条</h3>
          <p className="ui-help">
            这些旧条目没有对应当前剪辑实例，原值保留供核对，未加入预览或导出。
          </p>
          {unmapped.map((item, index) => (
            <details key={item.displayKey} className="text-xs">
              <summary className="cursor-pointer">
                旧条目 {index + 1} · {item.reason}
              </summary>
              <pre
                aria-label={`未映射字幕 ${index + 1} 原值`}
                className="ui-scrollbar max-h-60 overflow-auto whitespace-pre-wrap break-words"
              >
                {JSON.stringify(item.cue, null, 2) ?? String(item.cue)}
              </pre>
            </details>
          ))}
          {track.legacyTrack !== undefined && (
            <details className="text-xs">
              <summary className="cursor-pointer">查看迁移前完整字幕轨</summary>
              <pre
                aria-label="迁移前完整字幕轨原值"
                className="ui-scrollbar max-h-60 overflow-auto whitespace-pre-wrap break-words"
              >
                {JSON.stringify(track.legacyTrack, null, 2)}
              </pre>
            </details>
          )}
        </section>
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
        识别模型 {params.model || '尚未选择'}{' '}
        的当前账户权限尚未验证；配置或连接检查不能证明语音识别已授权。识别可能计费，相同音频和模型复用已保存结果。重建会替换手改字幕；本地导出已有字幕不调用识别。
      </p>
      {!track && <p className="ui-help">尚未创建可编辑字幕轨；当前按台词自动生成。</p>}
      {track &&
        rows.map((row, index) => {
          const source = sequenceRowKey(row, index)
          const cues = track.cues.filter((q) => q.source === source)
          return (
            <section key={source} className="seq-section">
              <h3 className="ui-section-title">镜头 {index + 1}</h3>
              {cues.map((q, i) => {
                const text = drafts[q.id]?.text ?? q.text
                const empty = !q.hidden && !text.trim()
                const invalidTime = !q.hidden && q.end <= q.start
                const textError = `${validationId}-${encodeURIComponent(q.id)}-text`
                const timeError = `${validationId}-${encodeURIComponent(q.id)}-time`
                return (
                  <div
                    key={q.id}
                    className="mb-3 flex flex-col gap-2 rounded border border-line p-2"
                  >
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        aria-label={`显示字幕 ${i + 1}`}
                        checked={!q.hidden}
                        onChange={(e) => patch(q.id, { hidden: !e.target.checked })}
                      />
                      显示字幕 {i + 1}
                      <span className="text-xs text-muted">
                        {
                          {
                            manual: '手动校订',
                            estimated: '按台词估时',
                            asr: '语音识别',
                            legacy: '旧版来源',
                          }[q.origin ?? 'legacy']
                        }
                      </span>
                    </label>
                    <textarea
                      aria-label={`镜头 ${index + 1} 字幕 ${i + 1} 文本`}
                      className="ui-input w-full"
                      value={drafts[q.id]?.text ?? q.text}
                      aria-invalid={empty || undefined}
                      aria-describedby={empty ? textError : undefined}
                      onChange={(e) => {
                        setDrafts((old) => ({
                          ...old,
                          [q.id]: { text: e.target.value, saved: false },
                        }))
                        patch(q.id, { text: e.target.value })
                      }}
                    />
                    {empty && (
                      <p id={textError} className="text-xs text-danger">
                        请输入字幕文本，或关闭这句字幕的显示。
                      </p>
                    )}
                    <div className="flex gap-2">
                      {(['start', 'end'] as const).map((field) => (
                        <label key={field} className="min-w-0 flex-1 text-xs">
                          {field === 'start' ? '开始' : '结束'}（秒）
                          <SubtitleTimeInput
                            value={q[field]}
                            label={`镜头 ${index + 1} 字幕 ${i + 1} ${field === 'start' ? '开始' : '结束'}（秒）`}
                            invalid={invalidTime}
                            describedBy={invalidTime ? timeError : undefined}
                            onChange={(n) => patch(q.id, { [field]: n })}
                          />
                        </label>
                      ))}
                    </div>
                    {invalidTime && (
                      <p id={timeError} className="text-xs text-danger">
                        结束时间需要晚于开始时间。
                      </p>
                    )}
                  </div>
                )
              })}
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
                        origin: 'manual',
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

/** 只有有效时间写入字幕轨，清空或尚未输入完的数字保留在输入框内。 */
function SubtitleTimeInput({
  value,
  label,
  invalid,
  describedBy,
  onChange,
}: {
  value: number
  label: string
  invalid: boolean
  describedBy?: string
  onChange(value: number): void
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const errorId = useId()
  const invalidDraft =
    draft !== null && (!draft.trim() || !Number.isFinite(Number(draft)) || Number(draft) < 0)
  return (
    <>
      <input
        type="number"
        min={0}
        step={0.01}
        className="ui-input w-full"
        value={draft ?? value}
        aria-label={label}
        aria-invalid={invalidDraft || invalid || undefined}
        aria-describedby={
          [describedBy, invalidDraft ? errorId : undefined].filter(Boolean).join(' ') || undefined
        }
        onChange={(event) => {
          setDraft(event.target.value)
          const next = event.currentTarget.valueAsNumber
          if (Number.isFinite(next) && next >= 0) onChange(next)
        }}
        onBlur={() => setDraft(null)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return
          if (event.key === 'Enter') event.currentTarget.blur()
        }}
      />
      {invalidDraft && (
        <span id={errorId} className="text-xs text-danger">
          请输入大于或等于 0 的有效时间；失焦后恢复已保存值。
        </span>
      )}
    </>
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
