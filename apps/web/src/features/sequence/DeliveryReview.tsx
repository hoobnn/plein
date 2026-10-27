import type { Engine } from '@plein/canvas-core'
import {
  currentResult,
  editDelivery,
  type CanvasElement,
  type DeliveryNote,
  type DeliveryRecord,
  type DeliverySource,
  sequenceInstancesOf,
} from '@plein/doc'
import { sequenceSourcesAt } from '@plein/nodes'
import { type RefObject, useEffect, useRef, useState } from 'react'
import { assetUrls } from '../../api/client'
import { AssetDownloadButton } from '../../shell/AssetDownloadButton'
import { useCanvas } from '../../stores/canvas'
import { useSession } from '../../stores/session'
import { CreativeReviewForm } from '../storyboard/CreativeReviewForm'
import { DeliveryCheck } from '../delivery-check/DeliveryCheck'
import { sequenceTupleLabel } from './instanceModel'

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
    record.historical,
  ])
const noteIdentity = (note: DeliveryNote) =>
  JSON.stringify([note.id, note.time, note.text, note.source, note.shotId, note.clipInstanceId])
const NO_RECORDS: DeliveryRecord[] = []

/** 会话归属于序列编辑器，切换视图不会丢失尚未提交的审阅内容。 */
export function useDeliveryReviewSession() {
  const [selected, setSelected] = useState<string | undefined>()
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const positions = useRef(new Map<string, number>()).current
  const identities = useRef(new Map<string, string>()).current
  return { selected, setSelected, drafts, setDrafts, positions, identities }
}

/** 回看真实导出的资产；编辑预览与交付确认分开。 */
export function DeliveryReview({
  engine,
  node,
  session,
}: {
  engine: Engine
  node: CanvasElement
  session: ReturnType<typeof useDeliveryReviewSession>
}) {
  const records = node.deliveries ?? NO_RECORDS
  const { selected, setSelected, drafts, setDrafts, positions, identities } = session
  const record = records.find((r) => r.id === selected) ?? records[0]
  const identity = record ? recordIdentity(record) : ''
  const recordId = record?.id
  const active = useRef(record?.id)
  active.current = record?.id
  const video = useRef<HTMLVideoElement>(null)
  const text = record ? (drafts[record.id] ?? '') : ''
  const [error, setError] = useState('')
  const principal = useSession((s) => s.info?.principal)
  const [element] = useState(() => engine.doc.elementMaps.get(node.id))
  const readonly =
    engine.doc.readOnly ||
    !!node.locked ||
    !!record?.historical ||
    !principal ||
    principal.role === 'viewer'
  const [filmTime, setFilmTime] = useState(0)
  const [noteSource, setNoteSource] = useState('')
  const canvasId = useCanvas((s) => s.canvasId)
  useEffect(() => {
    setFilmTime(0)
    setNoteSource('')
  }, [recordId])
  useEffect(() => {
    if (!records.length || records.some((r) => r.id === selected)) return
    setSelected(records[0]!.id)
    if (selected) setError('原交付版本已移除，已显示最新版本；原版本草稿仍保留在本次会话中')
  }, [records, selected, setSelected])
  useEffect(() => {
    if (!recordId) return
    const previous = identities.get(recordId)
    identities.set(recordId, identity)
    if (previous && previous !== identity)
      setError('版本内容已变化，请核对当前实际 MP4 后再提交保留的草稿')
  }, [identities, recordId, identity])
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
    if (writable && latest.historical) {
      setError('历史范围的意见与确认只读，请重新导出当前版本后审阅')
      return null
    }
    if (recordIdentity(latest) !== recordIdentity(record)) {
      setError('版本内容已变化，本次操作未执行；请核对当前实际 MP4 后重试')
      return null
    }
    const actor = useSession.getState().info?.principal
    if (engine.doc.elementMaps.get(node.id) !== element || engine.doc.ydoc.isDestroyed) return null
    if (writable && (engine.doc.readOnly || current.locked || !actor || actor.role === 'viewer')) {
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
    const player = video.current
    if (
      !player ||
      player.readyState < HTMLMediaElement.HAVE_METADATA ||
      player.error ||
      !Number.isFinite(player.currentTime)
    ) {
      setError('实际 MP4 尚未就绪，意见草稿已保留；请加载后再记录时间码')
      return
    }
    const time = Math.max(0, Math.min(record.duration || Infinity, player.currentTime))
    // 片尾暂停仍属于最后一帧；中间切点继续使用左闭右开，关联下一镜。
    const at = time === record.duration ? Math.max(0, time - 0.001) : time
    const covering = sequenceSourcesAt(record.sources, at)
    const source =
      covering.length === 1 ? covering[0] : covering.find((s) => s.clipInstanceId === noteSource)
    if (noteSource && !source) return setError('所选意见来源已不覆盖此时间，请重新选择具体实例')
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
          clipInstanceId: source?.clipInstanceId,
        },
      ],
    }))
    if (saved)
      setDrafts((current) =>
        current[record.id] === text ? { ...current, [record.id]: '' } : current,
      )
  }
  const locateInstance = (source: DeliverySource) => {
    const latest = readTarget()
    if (!latest || latest.historical) return
    if (source.clipInstanceId) {
      const current = engine.doc.get(node.id)
      if (
        !current ||
        !sequenceInstancesOf(current).some((c) => c.clipInstanceId === source.clipInstanceId)
      ) {
        setError('此历史实例已不在当前剪辑中；保留原文件、源区间和生成出处，不按名称重新绑定')
        return
      }
      useCanvas.getState().openSequence(node.id, source.clipInstanceId)
      return
    }
    locate(source.source)
  }
  const locate = (source: string | undefined) => {
    const latest = readTarget()
    if (!latest || latest.historical) return
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
        {error && (
          <p role="alert" className="mb-3 text-sm text-danger">
            {error}
          </p>
        )}
        <DeliveryVideo
          key={identity}
          video={video}
          src={assetUrls.original(record.assetId)}
          identity={identity}
          positions={positions}
          onTime={setFilmTime}
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
          {!record.historical && currentResult(node)?.id === record.resultId && (
            <CreativeReviewForm doc={engine.doc} node={node} />
          )}
        </div>
      </div>
      <aside className="w-full shrink-0 space-y-3 lg:w-80">
        {record.kind === 'film' && (
          <DeliveryCheck
            key={`${node.id}:${record.id}`}
            engine={engine}
            node={node}
            record={record}
          />
        )}
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
                {r.version} · {r.historical ? '历史范围 · ' : ''}
                {r.kind === 'animatic' ? '样片草稿' : '成片'} ·{' '}
                {new Date(r.createdAt).toLocaleTimeString()}
              </option>
            ))}
          </select>
        </label>
        <p className="text-sm" aria-label="交付确认状态">
          {record.historical
            ? record.confirmedAt
              ? '历史范围曾人工确认此文件'
              : '历史范围未人工确认此文件'
            : record.confirmedAt
              ? '已人工确认此版本'
              : '待人工确认'}{' '}
          · {unresolved} 条未解决意见
        </p>
        {record.historical && (
          <p role="status" className="ui-help">
            这是复制或恢复保留的历史范围，原意见与出处只读。请导出当前版本后另行审阅。
          </p>
        )}
        <section
          className="space-y-2 rounded border border-line p-2 text-xs"
          aria-label="当前成片时间全部来源"
        >
          <h3>成片 {filmTime.toFixed(3)} 秒的全部来源</h3>
          {sequenceSourcesAt(
            record.sources,
            filmTime === record.duration ? Math.max(0, filmTime - 0.001) : filmTime,
          ).map((source, index) => (
            <div
              key={source.clipInstanceId ?? `${source.source}:${index}`}
              data-clip-instance={source.clipInstanceId}
              data-source-time={source.sourceTime}
            >
              <p className="break-all">
                实例 {source.clipInstanceId ?? '旧记录未保存实例身份'} · 段{' '}
                {source.segmentId ?? '未知'} · 源时刻{' '}
                {source.sourceTime === undefined ? '未知' : `${source.sourceTime.toFixed(3)} 秒`} ·
                speed {source.speed ?? 1}
              </p>
              <p className="break-all">
                文件 {source.assetId ?? '旧记录未保存'} · 端口 {source.port ?? '未知'}
              </p>
              <p className="break-all">原始生成出处：{sequenceTupleLabel(source.origin)}</p>
              <p className="break-all">本地选定候选：{sequenceTupleLabel(source.selection)}</p>
              {!record.historical && (
                <button type="button" className="underline" onClick={() => locateInstance(source)}>
                  定位此具体实例
                </button>
              )}
            </div>
          ))}
          {sequenceSourcesAt(record.sources, filmTime).length > 1 && (
            <p>转场覆盖多个实例；意见可指定一个实例，或保留为整片意见。</p>
          )}
        </section>
        {sequenceSourcesAt(record.sources, filmTime).length > 1 && (
          <label className="block text-xs">
            意见归属实例
            <select
              className="ui-input w-full"
              aria-label="意见归属实例"
              value={noteSource}
              onChange={(event) => setNoteSource(event.target.value)}
            >
              <option value="">整片意见（不猜第一来源）</option>
              {sequenceSourcesAt(record.sources, filmTime)
                .filter((s) => s.clipInstanceId)
                .map((s) => (
                  <option key={s.clipInstanceId} value={s.clipInstanceId}>
                    {s.clipInstanceId} · 源 {s.sourceTime?.toFixed(3)} 秒
                  </option>
                ))}
            </select>
          </label>
        )}
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
            if (!readTarget(true)) return
            const value = e.target.value
            setDrafts((current) => ({ ...current, [record.id]: value }))
          }}
          disabled={readonly}
        />
        <button
          type="button"
          className="ui-btn ui-btn-secondary"
          disabled={!text.trim() || readonly}
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
                  disabled={readonly}
                  onChange={(e) => editNote(note, e.target.checked)}
                />{' '}
                已解决
              </label>
              {!record.historical && (note.source || note.clipInstanceId) && (
                <button
                  type="button"
                  className="underline"
                  onClick={() => {
                    const latest = readNote(note)
                    if (latest) {
                      const source = record.sources.find((s) =>
                        latest.clipInstanceId
                          ? s.clipInstanceId === latest.clipInstanceId
                          : s.source === latest.source,
                      )
                      if (source) locateInstance(source)
                      else setError('此意见未保存可核对的实例出处')
                    }
                  }}
                >
                  定位镜头返工
                </button>
              )}
              <button
                type="button"
                className="text-ink-subtle"
                disabled={readonly}
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
          disabled={unresolved > 0 || readonly}
          onClick={() => {
            const confirm = !record.confirmedAt
            save((latest) => {
              if (confirm && latest.notes.some((note) => !note.resolved))
                return '有未解决意见，不能确认交付'
              return !!latest.confirmedAt === confirm ? null : { confirm }
            })
          }}
        >
          {record.historical
            ? '历史范围确认只读'
            : record.confirmedAt
              ? '撤回此版确认'
              : record.kind === 'animatic'
                ? '确认此版草稿已审阅'
                : '确认此版本可交付'}
        </button>
        <p className="ui-help">
          {record.historical
            ? '保留原文件、原始出处和曾有的人工结论，当前范围须重新导出后审阅。'
            : '确认只绑定这份实际 MP4。重新导出创建新版本，不继承旧确认；新增或修改意见会撤回确认。'}
        </p>
      </aside>
    </div>
  )
}

interface DeliveryVideoProps {
  src: string
  video: RefObject<HTMLVideoElement | null>
  identity: string
  positions: Map<string, number>
  onTime(time: number): void
}

function DeliveryVideo(props: DeliveryVideoProps) {
  const [attempt, setAttempt] = useState(0)
  return <DeliveryVideoAttempt key={attempt} {...props} onRetry={() => setAttempt((n) => n + 1)} />
}

/** 来源变化或重试时重新挂载，避免旧视频事件污染当前版本的错误状态。 */
function DeliveryVideoAttempt({
  src,
  video,
  identity,
  positions,
  onTime,
  onRetry,
}: DeliveryVideoProps & {
  onRetry(): void
}) {
  const [failed, setFailed] = useState(false)
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    const element = video.current
    return () => {
      if (!element) return
      if (element.readyState >= 1 && Number.isFinite(element.currentTime))
        positions.set(identity, element.currentTime)
      element.pause()
      element.removeAttribute('src')
      element.load()
    }
  }, [video, identity, positions])
  return (
    <>
      {/* oxlint-disable-next-line jsx-a11y/media-has-caption -- 实际导出的字幕已烧录在画面内 */}
      <video
        ref={video}
        src={src}
        controls
        onTimeUpdate={(event) => onTime(event.currentTarget.currentTime)}
        onSeeked={(event) => onTime(event.currentTarget.currentTime)}
        aria-busy={loading || undefined}
        onError={() => {
          setLoading(false)
          setFailed(true)
        }}
        onLoadedMetadata={(e) => {
          setLoading(false)
          setFailed(false)
          const at = positions.get(identity)
          if (at !== undefined && Number.isFinite(e.currentTarget.duration))
            e.currentTarget.currentTime = Math.max(0, Math.min(at, e.currentTarget.duration))
          onTime(e.currentTarget.currentTime)
        }}
        className="max-h-[65vh] w-full bg-black"
        aria-label="实际导出 MP4"
      />
      {loading && (
        <p role="status" className="ui-help mt-2">
          正在加载实际 MP4…
        </p>
      )}
      {failed && (
        <div role="alert" className="mt-2 flex flex-wrap items-center gap-2 text-sm text-danger">
          <span>实际 MP4 加载失败，请重新加载后继续回看。</span>
          <button type="button" className="ui-btn ui-btn-secondary ui-btn-sm" onClick={onRetry}>
            重新加载实际 MP4
          </button>
        </div>
      )}
    </>
  )
}
