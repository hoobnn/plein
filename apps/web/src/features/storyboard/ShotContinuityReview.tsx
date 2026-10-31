import type { Engine } from '@plein/canvas-core'
import { creativeReviewTarget, type CanvasElement } from '@plein/doc'
import { profileImages, profileOf, type Shot } from '@plein/nodes'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { api, assetUrls } from '../../api/client'
import { upstreams } from '../../canvas/nodes'
import { useCatalog } from '../../stores/catalog'
import { Modal, ModalHeader } from '../../ui/Modal'
import { useStale } from '../runs/stale'
import { CreativeReviewForm } from './CreativeReviewForm'
import { continuityWindow } from './reviewModel'
import { ShotObservationForm } from './ShotObservationForm'
import type { ContinuityPlayback } from './continuityModel'

type PairSide = { shot: Shot; node: CanvasElement }

/** 相邻镜头的视觉衔接，只读抽帧和本地播放，不生成新镜头或改变采用。 */
export function ShotContinuityReview({
  engine,
  canvasId,
  boardId,
  before,
  after,
  onClose,
  isCurrent,
}: {
  engine: Engine
  canvasId: string
  boardId: string
  before: PairSide
  after: PairSide
  onClose(): void
  isCurrent?(): boolean
}) {
  const a = creativeReviewTarget(before.node)
  const b = creativeReviewTarget(after.node)
  if (a?.kind !== 'video' || b?.kind !== 'video')
    return (
      <Modal label="连续性审看" onClose={onClose}>
        <ModalHeader title="连续性审看" onClose={onClose} />
        <p className="p-5 text-sm">相邻两镜都需要已有采用的视频，才可检查切点。</p>
      </Modal>
    )
  return (
    <PairReview
      key={`${a.resultId}/${a.assetId}/${b.resultId}/${b.assetId}`}
      engine={engine}
      canvasId={canvasId}
      boardId={boardId}
      before={before}
      after={after}
      a={a.assetId}
      b={b.assetId}
      onClose={onClose}
      isCurrent={isCurrent}
    />
  )
}

function PairReview({
  engine,
  canvasId,
  boardId,
  before,
  after,
  a,
  b,
  onClose,
  isCurrent,
}: {
  engine: Engine
  canvasId: string
  boardId: string
  before: PairSide
  after: PairSide
  a: string
  b: string
  onClose(): void
  isCurrent?(): boolean
}) {
  const catalog = useCatalog((s) => s.catalog)
  const stale = useStale((s) => s.nodes.has(before.node.id) || s.nodes.has(after.node.id))
  const [reference, setReference] = useState('')
  const [played, setPlayed] = useState<Partial<Record<'before' | 'after', ContinuityPlayback>>>({})
  const refs = [...engine.doc.elements()]
    .filter((node) => node.nodeType === 'plein/character')
    .flatMap((node) => [
      ...profileImages(profileOf(node.params?.profile)).map((id) => ({
        id,
        name: node.name ?? '角色参考',
      })),
      ...[...upstreams(engine, node.id, catalog).values()]
        .flat()
        .flatMap((u) =>
          u.value?.type === 'image' ? [{ id: u.value.assetId, name: node.name ?? '角色参考' }] : [],
        ),
    ])
  const unique = [...new Map(refs.map((ref) => [ref.id, ref])).values()]
  const frames = useQuery({
    queryKey: ['continuity-frames', a, b],
    queryFn: async () => {
      const [tail, head] = await Promise.all([
        api.mediaDerive({
          op: 'frame',
          assetId: a,
          at: 0,
          last: true,
          name: `镜头${before.shot.no}尾帧`,
        }),
        api.mediaDerive({ op: 'frame', assetId: b, at: 0, name: `镜头${after.shot.no}首帧` }),
      ])
      if (!tail.assets[0] || !head.assets[0]) throw new Error('未取到相邻镜头的真实画面')
      return { tail: tail.assets[0].id, head: head.assets[0].id }
    },
    retry: false,
    staleTime: Infinity,
  })
  return (
    <Modal label="连续性审看" onClose={onClose} className="max-w-250">
      <ModalHeader title={`连续性 · 镜头 ${before.shot.no} → ${after.shot.no}`} onClose={onClose} />
      <div className="ui-scrollbar min-h-0 overflow-auto p-5">
        <p className="mb-3 text-xs text-ink-muted">
          比较角色、景别、光向和动作方向。意见记录在当前镜头的具体视频候选上。
        </p>
        {stale && (
          <p className="mb-3 text-xs text-warning">
            有镜头的输入已变化；当前显示的是已采用的旧候选，请重新核对。
          </p>
        )}
        {frames.isPending ? (
          <p role="status">正在本地抽取真实首尾帧…</p>
        ) : frames.isError ? (
          <div>
            <p role="alert" className="text-danger">
              {frames.error.message}
            </p>
            <button
              type="button"
              className="ui-btn ui-btn-secondary"
              onClick={() => void frames.refetch()}
            >
              重试抽帧
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            <figure>
              <img
                src={assetUrls.original(frames.data.tail)}
                alt={`镜头 ${before.shot.no} 真实尾帧`}
                className="h-56 w-full rounded-lg bg-black object-contain"
              />
              <figcaption className="mt-1 text-xs text-ink-muted">上一镜 · 实际尾帧</figcaption>
            </figure>
            <figure>
              <img
                src={assetUrls.original(frames.data.head)}
                alt={`镜头 ${after.shot.no} 真实首帧`}
                className="h-56 w-full rounded-lg bg-black object-contain"
              />
              <figcaption className="mt-1 text-xs text-ink-muted">当前镜 · 0 秒首帧</figcaption>
            </figure>
          </div>
        )}
        <div className="my-3 flex flex-wrap items-center gap-3 text-xs">
          <label className="flex items-center gap-2">
            固定角色参考
            <select
              aria-label="固定角色参考"
              className="ui-input"
              value={reference}
              onChange={(e) => setReference(e.target.value)}
            >
              <option value="">不显示</option>
              {unique.map((ref) => (
                <option key={ref.id} value={ref.id}>
                  {ref.name} · {ref.id.slice(0, 6)}
                </option>
              ))}
            </select>
          </label>
          {reference && (
            <img
              src={assetUrls.original(reference)}
              alt="固定角色参考"
              className="h-32 w-32 rounded border border-line object-contain"
            />
          )}
        </div>
        <CutLoop
          before={a}
          after={b}
          onPlayback={(side, range) => setPlayed((old) => ({ ...old, [side]: range }))}
        />
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          <ShotObservationForm
            engine={engine}
            canvasId={canvasId}
            boardId={boardId}
            shotId={before.shot.id}
            phase="end"
            node={before.node}
            frameAssetId={frames.data?.tail}
            playback={played.before}
            isCurrent={isCurrent}
          />
          <ShotObservationForm
            engine={engine}
            canvasId={canvasId}
            boardId={boardId}
            shotId={after.shot.id}
            phase="start"
            node={after.node}
            frameAssetId={frames.data?.head}
            playback={played.after}
            isCurrent={isCurrent}
          />
        </div>
        <div className="mt-3">
          <CreativeReviewForm
            doc={engine.doc}
            node={after.node}
            stale={stale}
            defaultOpen
            isCurrent={isCurrent}
          />
        </div>
      </div>
    </Modal>
  )
}

/** 前镜末一秒 → 后镜首一秒交替循环；短片段按真实 duration 收窄。 */
function CutLoop({
  before,
  after,
  onPlayback,
}: {
  before: string
  after: string
  onPlayback?(side: 'before' | 'after', range: ContinuityPlayback): void
}) {
  const refs = useRef<Partial<Record<'before' | 'after', HTMLVideoElement>>>({})
  const [phase, setPhase] = useState<'before' | 'after'>('before')
  const [playing, setPlaying] = useState(false)
  const [muted, setMuted] = useState(false)
  const [error, setError] = useState('')
  const onPlaybackRef = useRef(onPlayback)
  onPlaybackRef.current = onPlayback
  useEffect(() => {
    const media = refs.current[phase]
    let alive = true,
      advanced = false,
      frame = 0
    let viewed: ReturnType<typeof continuityWindow>
    let audible = false
    for (const video of Object.values(refs.current)) video.pause()
    if (!playing || !media) return
    const next = () => {
      if (alive && !advanced) {
        if (
          viewed &&
          Array.from({ length: media.played.length }, (_, i) => i).some(
            (i) =>
              media.played.start(i) <= viewed!.start + 0.12 &&
              media.played.end(i) >= viewed!.end - 0.12,
          )
        )
          onPlaybackRef.current?.(phase, {
            assetId: phase === 'before' ? before : after,
            start: viewed.start,
            end: viewed.end,
            duration: media.duration,
            audible,
          })
        advanced = true
        media.pause()
        setPhase((value) => (value === 'before' ? 'after' : 'before'))
      }
    }
    const start = () => {
      const range = continuityWindow(media.duration, phase)
      if (!range) {
        setError('无法读取实际视频时长，暂不能循环回看')
        setPlaying(false)
        return
      }
      media.currentTime = range.start
      viewed = range
      audible = !media.muted && media.volume > 0
      media.play().catch(() => {
        if (alive) {
          setError('播放未开始，请再点一次循环回看')
          setPlaying(false)
        }
      })
      const tick = () => {
        if (!alive) return
        if (media.currentTime >= range.end) next()
        else frame = requestAnimationFrame(tick)
      }
      frame = requestAnimationFrame(tick)
    }
    media.addEventListener('ended', next)
    const volumeChanged = () => {
      if (media.muted || media.volume === 0) audible = false
    }
    media.addEventListener('volumechange', volumeChanged)
    if (media.readyState >= 1) start()
    else media.addEventListener('loadedmetadata', start, { once: true })
    return () => {
      alive = false
      cancelAnimationFrame(frame)
      media.pause()
      media.removeEventListener('loadedmetadata', start)
      media.removeEventListener('ended', next)
      media.removeEventListener('volumechange', volumeChanged)
    }
  }, [playing, phase, before, after])
  return (
    <div className="rounded-lg border border-line p-4">
      <div className="mb-2 flex flex-wrap items-center gap-3 text-xs">
        <button
          type="button"
          className="ui-btn ui-btn-secondary"
          onClick={() => {
            setError('')
            setPlaying(!playing)
          }}
        >
          {playing ? '暂停回看' : '循环回看切点前后各一秒'}
        </button>
        <label className="inline-flex items-center gap-1">
          <input type="checkbox" checked={muted} onChange={(e) => setMuted(e.target.checked)} />
          静音
        </label>
        <span className="text-ink-subtle">
          {phase === 'before' ? '上一镜末尾' : '当前镜开头'} · 按实际视频时长播放
        </span>
      </div>
      {(['before', 'after'] as const).map((side) => (
        // oxlint-disable-next-line jsx-a11y/media-has-caption -- 审看原始候选，不一定包含字幕轨
        <video
          key={side}
          ref={(el) => {
            if (el) refs.current[side] = el
            else delete refs.current[side]
          }}
          src={assetUrls.original(side === 'before' ? before : after)}
          preload="metadata"
          muted={muted}
          playsInline
          aria-label={side === 'before' ? '上一镜切点前一秒' : '当前镜切点后一秒'}
          className={`h-64 w-full rounded-lg bg-black object-contain ${side === phase ? '' : 'hidden'}`}
          onError={() => {
            setError('视频无法播放，请先确认素材可用')
            setPlaying(false)
          }}
        />
      ))}
      {error && (
        <p role="alert" className="mt-2 text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  )
}
