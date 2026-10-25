import type { Engine } from '@plein/canvas-core'
import { shotsOf } from '@plein/capabilities'
import {
  addFixedSequenceInstance,
  currentResult,
  duplicateSequenceInstance,
  editSequenceInstance,
  fixSequenceInstance,
  isVideoSegment,
  removeSequenceInstance,
  replaceSequenceSegment,
  sequenceInstancesOf,
  setParam,
  type NarrativeScope,
  type SequenceSound,
} from '@plein/doc'
import {
  duplicateInstanceSubtitleTrack,
  retainInstanceSubtitleTrack,
  type ArrangedClip,
  type SequenceParams,
} from '@plein/nodes'
import { useEffect, useRef, useState } from 'react'
import { loadAssetMeta } from '../../stores/assetMeta'
import { useCanvas } from '../../stores/canvas'
import { Modal, ModalHeader } from '../../ui/Modal'
import { sequenceSourceIdentity, sequenceTupleLabel } from './instanceModel'

export const SOUND_LABELS = {
  legacy: '沿用旧版自动声音',
  native: '原生声音',
  voice: '独立配音',
  mix: '原生声音与配音混合',
}
type ExplicitSound = Exclude<SequenceSound, 'legacy'>
type Read = { params: SequenceParams; rows: ArrangedClip[] }
interface Context {
  engine: Engine
  canvasId: string | null
  sequenceId: string
  writable(): boolean
  readCurrent(): Read
  onSelect(id: string): void
  onNotice?(message: string): void
}

/** Fixed files are chosen explicitly; this action adds no generation input edge. */
export function AddFixedInstance({ engine, sequenceId, writable, onSelect }: Context) {
  const [source, setSource] = useState(''),
    [sound, setSound] = useState<ExplicitSound | ''>('')
  const [chosenFile, setChosenFile] = useState('')
  const [error, setError] = useState('')
  const videos = [...engine.doc.elements()].filter(
    (el) =>
      el.kind === 'video' &&
      isVideoSegment(el.videoSegment) &&
      el.assetId === el.videoSegment.asset.assetId,
  )
  return (
    <div
      className="flex flex-wrap items-center gap-2 px-4 py-2 text-xs"
      aria-label="添加固定素材实例"
    >
      <select
        className="ui-input max-w-64"
        aria-label="已固定视频素材"
        value={source}
        onChange={(e) => {
          const el = engine.doc.get(e.target.value)
          setSource(e.target.value)
          setChosenFile(JSON.stringify([el?.assetId, el?.videoSegment]))
        }}
        disabled={!writable()}
      >
        <option value="">选择已有固定素材</option>
        {videos.map((el) => (
          <option key={el.id} value={el.id}>
            {el.name ?? el.id} · {el.videoSegment!.segmentId.slice(-8)}
          </option>
        ))}
      </select>
      <SoundChoice
        value={sound}
        onChange={setSound}
        disabled={!writable()}
        label="新增实例声音路线"
      />
      <button
        type="button"
        className="ui-btn ui-btn-secondary ui-btn-xs"
        disabled={!source || !sound || !writable()}
        onClick={() => {
          if (!writable() || !sound) return
          const chosen = engine.doc.get(source)
          if (JSON.stringify([chosen?.assetId, chosen?.videoSegment]) !== chosenFile)
            return setError('选定固定素材已变化，请重新选择文件')
          engine.doc.undo.stopCapturing()
          const id = addFixedSequenceInstance(engine.doc, sequenceId, source, { sound })
          engine.doc.undo.stopCapturing()
          if (id) {
            engine.doc.flush()
            onSelect(id)
            setError('')
          } else setError('固定素材或编辑目标已变化，未添加')
        }}
      >
        添加独立实例
      </button>
      {error && <p role="alert">{error}</p>}
    </div>
  )
}

export function SequenceInstanceTools(props: Context & { row: ArrangedClip }) {
  const { engine, canvasId, sequenceId, row, writable, readCurrent, onSelect } = props
  const id = row.clipInstanceId!
  const raw = sequenceInstancesOf(engine.doc.get(sequenceId)!).find((c) => c.clipInstanceId === id)
  const source = row.source ? engine.doc.get(row.source) : undefined
  const [mode, setMode] = useState<'fix' | 'duplicate' | 'replace' | 'remove' | null>(null)
  const [expected, setExpected] = useState('')
  const [sourceMap, setSourceMap] = useState<unknown>()
  const [candidateId, setCandidateId] = useState('')
  const [sound, setSound] = useState<ExplicitSound | ''>('')
  const [fixedId, setFixedId] = useState('')
  const [fixedFile, setFixedFile] = useState('')
  const [ack, setAck] = useState(false)
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  const operation = useRef(0)
  useEffect(
    () => () => {
      operation.current++
    },
    [],
  )
  const closeOperation = () => {
    operation.current++
    setBusy(false)
    setMode(null)
  }
  const [seenSource, setSeenSource] = useState(() => sequenceSourceIdentity(row))
  const [boardId, setBoardId] = useState(raw?.narrative?.boardId ?? '')
  const [shotId, setShotId] = useState(raw?.narrative?.shotId ?? '')
  const boards = [...engine.doc.elements()].filter((el) => el.nodeType === 'plein/storyboard')
  const shots = shotsOf(engine.doc.get(boardId))
  const currentCandidate = source && currentResult(source, row.port)
  const candidates =
    source?.results?.filter((r) => r.port === row.port && r.value.type === 'video') ?? []
  const chosen = candidates.find((r) => r.id === candidateId)
  const assetId =
    chosen?.value.type === 'video'
      ? chosen.value.assetId
      : source?.kind === 'video'
        ? source.assetId
        : undefined
  const fixedVideos = [...engine.doc.elements()].filter(
    (el) =>
      el.kind === 'video' &&
      isVideoSegment(el.videoSegment) &&
      el.assetId === el.videoSegment.asset.assetId,
  )
  const users = row.segment
    ? [...engine.doc.elements()].flatMap((el) =>
        sequenceInstancesOf(el)
          .filter((c) => c.segment?.segmentId === row.segment!.segmentId)
          .map((c) => ({ sequenceId: el.id, name: el.name ?? el.id, id: c.clipInstanceId })),
      )
    : []
  const open = (next: typeof mode) => {
    if (!writable() || !raw) return
    operation.current++
    setExpected(JSON.stringify(raw))
    setMode(next)
    setSound('')
    setAck(false)
    setError('')
    setSourceMap(source && engine.doc.elementMaps.get(source.id))
    setCandidateId(currentCandidate?.id ?? '')
    setFixedId('')
  }
  const guard = () => {
    const now = engine.doc.get(sequenceId),
      live = now && sequenceInstancesOf(now).find((c) => c.clipInstanceId === id)
    return writable() && !!live && JSON.stringify(live) === expected
  }
  const mutate = (
    action: () => string | boolean | undefined,
    subtitle?: 'duplicate' | 'retain',
  ) => {
    if (!guard()) return setError('实例、权限或编辑目标已变化，请关闭后重新核对')
    const before = readCurrent()
    let result: string | boolean | undefined
    engine.doc.undo.stopCapturing()
    engine.doc.ydoc.transact(() => {
      result = action()
      if (!result || !subtitle) return
      const after = readCurrent()
      try {
        const track =
          subtitle === 'duplicate' && typeof result === 'string'
            ? duplicateInstanceSubtitleTrack(
                before.params,
                before.rows,
                after.params,
                after.rows,
                id,
                result,
              )
            : retainInstanceSubtitleTrack(before.params, before.rows, after.params, after.rows)
        if (track) setParam(engine.doc, sequenceId, 'subtitleTrack', track)
      } catch (cause) {
        const message = `实例已保存；字幕保持待核对：${(cause as Error).message}`
        setError(message)
        props.onNotice?.(message)
      }
    }, engine.doc.origin)
    engine.doc.flush()
    engine.doc.undo.stopCapturing()
    if (!result!) return setError('来源或实例已变化，本次未保存')
    if (typeof result === 'string') onSelect(result)
    closeOperation()
  }
  const fix = async () => {
    if (!guard() || !sound || !assetId || !canvasId || !source)
      return setError('请核对具体候选与声音路线')
    const selected = chosen && JSON.stringify(chosen),
      original = source.id
    const request = ++operation.current
    setBusy(true)
    setError('')
    try {
      const metadata = await loadAssetMeta(assetId)
      if (request !== operation.current) return
      if (
        !guard() ||
        engine.doc.elementMaps.get(original) !== sourceMap ||
        (chosen &&
          JSON.stringify(engine.doc.get(original)?.results?.find((r) => r.id === chosen.id)) !==
            selected)
      )
        return setError('读取文件期间实例或候选变化，未固定')
      if (metadata.kind !== 'video' || !metadata.duration || !Number.isFinite(metadata.duration))
        throw new Error('文件缺少实际视频时长，无法固定')
      mutate(() =>
        fixSequenceInstance(engine.doc, sequenceId, id, {
          canvasId,
          assetId,
          duration: metadata.duration!,
          sound,
          resultId: chosen?.id,
          expectedRow: expected,
        }),
      )
    } catch (cause) {
      if (request === operation.current) setError((cause as Error).message)
    } finally {
      if (request === operation.current) setBusy(false)
    }
  }
  const map = () => {
    if (!writable() || !raw || !canvasId) return
    const board = engine.doc.get(boardId)
    if (
      boardId &&
      (board?.nodeType !== 'plein/storyboard' ||
        shotsOf(board).filter((s) => s.id === shotId).length !== 1)
    )
      return setError('叙事分镜或镜头已变化，未绑定')
    const narrative: NarrativeScope | undefined = boardId
      ? { canvasId, boardId, shotId }
      : undefined
    engine.doc.undo.stopCapturing()
    const saved = editSequenceInstance(
      engine.doc,
      sequenceId,
      id,
      { narrative },
      JSON.stringify(raw),
    )
    engine.doc.undo.stopCapturing()
    engine.doc.flush()
    setError(saved ? '' : '实例已变化，未绑定')
  }
  if (!raw) return null
  return (
    <section className="seq-section space-y-2 text-xs" aria-label="独立剪辑实例">
      <h3 className="ui-section-title">独立剪辑实例</h3>
      <p className="break-all">
        实例 {id} · 端口 {row.port ?? '未知'}
      </p>
      {row.segment ? (
        <>
          <p>
            固定段 {row.segment.segmentId} · 文件 {row.segment.asset.assetId.slice(0, 12)} · 实际{' '}
            {row.segment.duration.toFixed(2)} 秒
          </p>
          <p className="break-all">原始生成出处：{sequenceTupleLabel(row.segment.origin)}</p>
          <p className="break-all">
            固定时选定的本地候选：{sequenceTupleLabel(row.segment.selection)}
          </p>
          {!source && <p>固定素材视图已删除；仍使用保存的文件和历史出处。</p>}
        </>
      ) : (
        <p>Live 来源：跟随此端口采用候选。换候选会影响本实例及相关字幕；固定后文件不再跟随。</p>
      )}
      {!row.segment && seenSource !== sequenceSourceIdentity(row) && (
        <p role="status">
          Live 来源候选已变化，请重新核对本实例的修剪、字幕和声音。
          <button
            type="button"
            className="underline"
            onClick={() => setSeenSource(sequenceSourceIdentity(row))}
          >
            我已核对当前候选
          </button>
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {!row.segment && (
          <button
            type="button"
            className="ui-btn ui-btn-secondary ui-btn-xs"
            onClick={() => open('fix')}
          >
            选定候选并固定素材
          </button>
        )}
        {row.segment && (
          <>
            <button
              type="button"
              className="ui-btn ui-btn-secondary ui-btn-xs"
              onClick={() => open('duplicate')}
            >
              复制独立实例
            </button>
            <button
              type="button"
              className="ui-btn ui-btn-secondary ui-btn-xs"
              onClick={() => open('replace')}
            >
              替换本实例固定素材
            </button>
          </>
        )}
        <button
          type="button"
          className="ui-btn ui-btn-quiet ui-btn-xs"
          onClick={() => open('remove')}
        >
          移除此实例
        </button>
      </div>
      {users.length > 0 && (
        <details>
          <summary>此固定段的全部使用者（{users.length}）</summary>
          {users.map((u) => (
            <button
              key={`${u.sequenceId}:${u.id}`}
              type="button"
              className="ui-btn ui-btn-quiet ui-btn-xs block"
              onClick={() => {
                if (writable()) useCanvas.getState().openSequence(u.sequenceId, u.id)
              }}
            >
              {u.name} · {u.id}
            </button>
          ))}
        </details>
      )}
      <label className="block">
        叙事分镜{' '}
        <select
          aria-label="实例叙事分镜"
          className="ui-input w-full"
          value={boardId}
          onChange={(e) => {
            setBoardId(e.target.value)
            setShotId('')
          }}
        >
          <option value="">未绑定</option>
          {boards.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name ?? b.id} · {b.id.slice(-6)}
            </option>
          ))}
        </select>
      </label>
      <label className="block">
        叙事镜头{' '}
        <select
          aria-label="实例叙事镜头"
          className="ui-input w-full"
          value={shotId}
          onChange={(e) => setShotId(e.target.value)}
        >
          <option value="">选择确切镜头</option>
          {shots.map((s) => (
            <option key={s.id} value={s.id}>
              镜头 {s.no} · {s.description.slice(0, 32)} · {s.id}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        className="ui-btn ui-btn-secondary ui-btn-xs"
        disabled={!!boardId && !shotId}
        onClick={map}
      >
        保存本实例叙事绑定
      </button>
      <p>
        {raw.narrative
          ? `保存绑定：${raw.narrative.canvasId} / ${raw.narrative.boardId} / ${raw.narrative.shotId}${raw.narrative.historical ? '（历史，未绑定当前范围）' : ''}`
          : '本实例未绑定叙事镜头；不按名称猜测。'}
      </p>
      {raw.narrative &&
        (!engine.doc.has(raw.narrative.boardId) ||
          !shotsOf(engine.doc.get(raw.narrative.boardId)).some(
            (s) => s.id === raw.narrative!.shotId,
          )) && <p>原叙事绑定已缺失，仅保留原身份；需显式重新选择。</p>}
      {error && <p role="alert">{error}</p>}
      {mode && (
        <Modal
          label="固定素材与实例操作"
          top
          isolateKeys
          onClose={closeOperation}
          className="max-w-xl"
        >
          <ModalHeader
            title={
              {
                fix: '固定具体候选',
                duplicate: '复制独立剪辑实例',
                replace: '替换本实例素材',
                remove: '移除剪辑实例',
              }[mode]
            }
            onClose={closeOperation}
          />
          <div className="space-y-3 overflow-auto p-4 text-sm">
            <p className="break-all">仅操作实例 {id}；其他实例和原候选保留。</p>
            <p>
              当前源范围 [{raw.in}, {raw.out ?? '素材结尾'}) · 速度 {raw.speed ?? 1} · 字幕{' '}
              {readCurrent().params.subtitleTrack?.cues.filter((c) => c.source === id).length ??
                (raw.subtitle ? 1 : 0)}{' '}
              条 · 配音 {raw.dialogue || '未明确绑定'} · 追加台词 {raw.more?.length ?? 0} 条 · 音效{' '}
              {raw.sfx || '未明确绑定'}
            </p>
            {mode === 'fix' && (
              <>
                <p>
                  来源 {source?.name ?? row.source} · 精确端口 {row.port}
                </p>
                {source?.kind === 'node' ? (
                  <select
                    aria-label="固定具体视频候选"
                    className="ui-input w-full"
                    value={candidateId}
                    onChange={(e) => setCandidateId(e.target.value)}
                  >
                    <option value="">选择具体候选</option>
                    {candidates.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.id === currentCandidate?.id ? '当前采用' : '历史候选'} · {c.id} ·{' '}
                        {c.port}
                      </option>
                    ))}
                  </select>
                ) : (
                  <p>直接视频文件，生成出处保持未知。</p>
                )}
                <p className="break-all">
                  固定文件：{assetId ?? '未选定'}。不会改变生成节点采用项。
                </p>
              </>
            )}
            {(mode === 'fix' || mode === 'duplicate') && (
              <SoundChoice
                value={sound}
                onChange={setSound}
                disabled={busy}
                label="明确选择新实例声音路线"
              />
            )}
            {mode === 'replace' && (
              <select
                aria-label="替换固定素材"
                className="ui-input w-full"
                value={fixedId}
                onChange={(e) => {
                  const el = engine.doc.get(e.target.value)
                  setFixedId(e.target.value)
                  setFixedFile(JSON.stringify([el?.assetId, el?.videoSegment]))
                }}
              >
                <option value="">选择已有固定素材</option>
                {fixedVideos.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name ?? v.id} · {v.videoSegment!.segmentId}
                  </option>
                ))}
              </select>
            )}
            {(mode === 'replace' || mode === 'remove') && (
              <label className="flex items-start gap-2">
                <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
                <span>
                  {mode === 'replace'
                    ? '仅替换所选实例，保留其入出点、字幕和音轨设置并重新核对；字幕可能过期或范围越界，不更新其他使用者。'
                    : '仅移除所选实例及其字幕归属，不删除共享文件或其他实例。'}
                </span>
              </label>
            )}
            {mode === 'duplicate' && (
              <p>
                新实例的叙事绑定与配音、音效为空，需另行明确选择。原手工字幕仅在实际输入仍有效时复制为独立条目。
              </p>
            )}
            {error && <p role="alert">{error}</p>}
            <button
              type="button"
              className="ui-btn ui-btn-primary"
              disabled={
                busy ||
                !writable() ||
                (mode === 'fix' && (!sound || !assetId)) ||
                (mode === 'duplicate' && !sound) ||
                (mode === 'replace' && (!ack || !fixedId)) ||
                (mode === 'remove' && !ack)
              }
              onClick={() => {
                if (mode === 'fix') void fix()
                else if (mode === 'duplicate' && sound)
                  mutate(
                    () =>
                      duplicateSequenceInstance(engine.doc, sequenceId, id, { sound, expected }),
                    'duplicate',
                  )
                else if (mode === 'replace') {
                  const chosen = engine.doc.get(fixedId)
                  if (JSON.stringify([chosen?.assetId, chosen?.videoSegment]) !== fixedFile)
                    return setError('选定替换文件已变化，请重新选择')
                  mutate(() =>
                    replaceSequenceSegment(engine.doc, sequenceId, id, fixedId, expected),
                  )
                } else if (mode === 'remove')
                  mutate(() => removeSequenceInstance(engine.doc, sequenceId, id), 'retain')
              }}
            >
              {busy ? '核对实际文件…' : '确认本次实例操作'}
            </button>
          </div>
        </Modal>
      )}
    </section>
  )
}

function SoundChoice({
  value,
  onChange,
  disabled,
  label,
}: {
  value: ExplicitSound | ''
  onChange(value: ExplicitSound | ''): void
  disabled?: boolean
  label: string
}) {
  return (
    <label className="block text-xs">
      {label}
      <select
        className="ui-input"
        aria-label={label}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value as ExplicitSound | '')}
      >
        <option value="">请明确选择声音</option>
        {(['native', 'voice', 'mix'] as const).map((s) => (
          <option key={s} value={s}>
            {SOUND_LABELS[s]}
          </option>
        ))}
      </select>
    </label>
  )
}
