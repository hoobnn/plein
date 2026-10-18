import {
  type ArrangedClip,
  SUBTITLE_STYLE_IDS,
  type SequenceParams,
  sequenceSize,
  subtitleAss,
  type Timeline,
} from '@plein/nodes'
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { PreviewEngine } from './engine'
import type { Playhead } from './playhead'
import { previewScene } from './scene'
import { SubtitleLayer, type SubtitleMode } from './SubtitleLayer'
import { Transport } from './Transport'
import { useClosing } from '../../ui/Presence'

/**
 * 序列预览：不导出，直接在浏览器里按时间线播放。
 * 画面由预览引擎用 WebCodecs 逐帧解码合成到一块画布上，声音用 Web Audio 按成片时间排程，
 * 字幕用 libass 叠在上面，和导出的成片同一套时间、转场、混音和字幕规则。
 */
export function SequencePreview({
  rows,
  timeline,
  params,
  music,
  playhead,
  draft = false,
}: {
  /** pending 的镜头没有素材，轮到它时显示占位 */
  rows: Array<ArrangedClip & { pending?: boolean }>
  timeline: Timeline
  params: SequenceParams
  music?: string
  playhead: Playhead
  draft?: boolean
}) {
  const [subMode, setSubMode] = useState<SubtitleMode>('loading')
  const [failed, setFailed] = useState(0)
  const closing = useClosing()
  const size = sequenceSize(params)
  const cues = params.subtitles ? timeline.clips.flatMap((c) => c.cues) : []
  const { total } = timeline
  const portrait = params.aspectRatio === '9:16'
  const canvas = useRef<HTMLCanvasElement>(null)
  const engine = useRef<PreviewEngine | null>(null)
  const scene = previewScene(rows, timeline, params, music)
  const sceneKey = JSON.stringify(scene)
  const sceneRef = useRef(scene)
  sceneRef.current = scene

  useLayoutEffect(() => {
    if (closing) return
    setFailed(0)
    const e = new PreviewEngine(playhead, setFailed)
    engine.current = e
    e.setScene(sceneRef.current)
    e.attach(canvas.current)
    return () => {
      engine.current = null
      // 退场开始或切到成片回看时立即停播，不等待浮层动画结束。
      playhead.pause()
      e.dispose()
    }
  }, [playhead, closing])

  useEffect(() => {
    engine.current?.setScene(sceneRef.current)
  }, [sceneKey])

  const note = [
    subMode === 'fallback'
      ? '预览字幕样式是近似的，导出的成片以服务端合成为准。'
      : '预览按成片的时间、转场、混音和字幕播放，画质略低于导出。',
    params.subtitleTrack && '字幕按保存的字幕轨预览，与 MP4 和工程 SRT 共用。',
    params.loudnorm && '响度标准化只在导出时处理。',
    rows.some((r) => r.speed !== 1) && '变速镜头的原声预览会变调，导出时不变调。',
  ]
    .filter(Boolean)
    .join('')

  return (
    <div className="seq-monitor">
      <div className="seq-viewer">
        <div
          className="seq-stage"
          data-portrait={portrait || undefined}
          data-subtitles={params.subtitles ? subMode : undefined}
        >
          <canvas ref={canvas} className="absolute inset-0 h-full w-full" />
          {draft && (
            <div className="absolute inset-x-0 top-0 z-30 bg-black/70 px-3 py-2 text-xs text-white">
              样片 / 草稿 · 已有分镜图与配音节奏预演
            </div>
          )}
          {params.subtitles && (
            <SubtitleLayer
              build={(font) =>
                subtitleAss(
                  { ...size, subtitles: { cues, style: SUBTITLE_STYLE_IDS[params.subtitleStyle] } },
                  font,
                )
              }
              width={size.width}
              height={size.height}
              playhead={playhead}
              onMode={setSubMode}
            />
          )}
          <PlaybackOverlay
            playhead={playhead}
            rows={rows}
            timeline={timeline}
            cues={subMode === 'fallback' ? cues : []}
            portrait={portrait}
            subtitleStyle={params.subtitleStyle}
            draft={draft}
          />
        </div>
      </div>
      {failed > 0 && (
        <div
          role="alert"
          className="flex shrink-0 items-center justify-between gap-2 px-3 py-2 text-xs text-danger"
        >
          <span>预览素材读取失败，画面或声音可能不完整。</span>
          <button
            type="button"
            className="ui-btn ui-btn-secondary ui-btn-xs"
            onClick={() => engine.current?.retryFailed()}
          >
            重试失败素材
          </button>
        </div>
      )}
      <Transport playhead={playhead} total={total} note={note} />
    </div>
  )
}

/** 只有字幕文本或占位状态变化才重绘，不因逐帧推进重建场景、序列化或重新生成 ASS。 */
function PlaybackOverlay({
  playhead,
  rows,
  timeline,
  cues,
  portrait,
  subtitleStyle,
  draft,
}: {
  playhead: Playhead
  rows: Array<{ pending?: boolean }>
  timeline: Timeline
  cues: Timeline['clips'][number]['cues']
  portrait: boolean
  subtitleStyle: SequenceParams['subtitleStyle']
  draft: boolean
}) {
  const placeholder = useSyncExternalStore(playhead.subscribe, () =>
    timeline.clips.some(
      (c, i) =>
        rows[i]?.pending &&
        c.length > 0 &&
        playhead.t >= c.start &&
        playhead.t < c.start + c.length,
    ),
  )
  // 字幕优先用 libass 渲染，不可用时退回近似的 DOM 字幕。
  const text = useSyncExternalStore(
    playhead.subscribe,
    () => cues.find((q) => playhead.t >= q.start && playhead.t < q.end)?.text,
  )
  return (
    <>
      {text && (
        <div
          className={`pointer-events-none absolute inset-x-4 z-20 flex justify-center ${portrait ? 'bottom-[12%]' : 'bottom-[7%]'}`}
        >
          <span
            className={`whitespace-pre-line text-center text-white ${
              subtitleStyle === '底框'
                ? 'rounded-xs bg-black/40 px-2 py-0.5 text-sm'
                : subtitleStyle === '醒目'
                  ? 'text-base font-semibold [text-shadow:0_0_3px_#000,0_0_3px_#000,0_0_3px_#000]'
                  : 'text-sm [text-shadow:0_0_2px_#000,0_0_2px_#000]'
            }`}
          >
            {text}
          </span>
        </div>
      )}
      {(timeline.total === 0 || placeholder) && (
        <div className="absolute inset-0 z-30 flex items-center justify-center text-xs text-white/70">
          <span className="min-w-0 break-words px-3 text-center">
            {timeline.total === 0
              ? '没有可播放的镜头'
              : draft
                ? '缺少分镜图 · 保留镜头时长与已有配音'
                : '这段镜头还没有生成'}
          </span>
        </div>
      )}
    </>
  )
}
