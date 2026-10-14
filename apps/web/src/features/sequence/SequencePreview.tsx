import {
  type ArrangedClip,
  SUBTITLE_STYLE_IDS,
  type SequenceParams,
  sequenceSize,
  subtitleAss,
  type Timeline,
} from '@plein/nodes'
import { useEffect, useRef, useState } from 'react'
import { PreviewEngine } from './engine'
import { type Playhead, usePlayheadTime } from './playhead'
import { previewScene } from './scene'
import { SubtitleLayer, type SubtitleMode } from './SubtitleLayer'

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
}: {
  /** pending 的镜头没有素材，轮到它时显示占位 */
  rows: Array<ArrangedClip & { pending?: boolean }>
  timeline: Timeline
  params: SequenceParams
  music?: string
  playhead: Playhead
}) {
  const t = usePlayheadTime(playhead)
  const [subMode, setSubMode] = useState<SubtitleMode>('loading')
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

  useEffect(() => {
    const e = new PreviewEngine(playhead)
    engine.current = e
    e.setScene(sceneRef.current)
    e.attach(canvas.current)
    return () => {
      engine.current = null
      e.dispose()
    }
  }, [playhead])

  useEffect(() => {
    engine.current?.setScene(sceneRef.current)
  }, [sceneKey])

  const placeholder = timeline.clips.some(
    (c, i) => rows[i]?.pending && c.length > 0 && t >= c.start && t < c.start + c.length,
  )

  // 字幕优先用 libass 渲染（与成片一致），不可用时退回近似的 DOM 字幕
  const cue = subMode === 'fallback' ? cues.find((q) => t >= q.start && t < q.end) : undefined

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center gap-2">
      <div className="seq-viewer">
        <div
          className="seq-stage"
          data-portrait={portrait || undefined}
          data-subtitles={params.subtitles ? subMode : undefined}
        >
          <canvas ref={canvas} className="absolute inset-0 h-full w-full" />
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
          {cue && (
            <div
              className={`pointer-events-none absolute inset-x-4 z-20 flex justify-center ${portrait ? 'bottom-[12%]' : 'bottom-[7%]'}`}
            >
              <span
                className={`whitespace-pre-line text-center text-white ${
                  params.subtitleStyle === '底框'
                    ? 'rounded-xs bg-black/40 px-2 py-0.5 text-sm'
                    : params.subtitleStyle === '醒目'
                      ? 'text-base font-semibold [text-shadow:0_0_3px_#000,0_0_3px_#000,0_0_3px_#000]'
                      : 'text-sm [text-shadow:0_0_2px_#000,0_0_2px_#000]'
                }`}
              >
                {cue.text}
              </span>
            </div>
          )}
          {(total === 0 || placeholder) && (
            <div className="absolute inset-0 z-30 flex items-center justify-center text-xs text-white/70">
              {total === 0 ? '没有可播放的镜头' : '这段镜头还没有生成'}
            </div>
          )}
        </div>
      </div>
      <p className="flex-none text-2xs text-ink-subtle">
        {subMode === 'fallback'
          ? '预览字幕样式是近似的，导出的成片以服务端合成为准。'
          : '预览按成片的时间、转场、混音和字幕播放，画质略低于导出。'}
        {params.asrTiming && ' 语音识别校准的字幕时间只在导出时生效。'}
        {params.loudnorm && ' 响度标准化只在导出时处理。'}
        {rows.some((r) => r.speed !== 1) && ' 变速镜头的原声预览会变调，导出时不变调。'}
      </p>
    </div>
  )
}
