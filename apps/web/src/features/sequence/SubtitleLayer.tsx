import { API, type SubtitleFontInfo } from '@plein/protocol'
import type JASSUB from 'jassub'
import { useEffect, useRef, useState } from 'react'
import type { Playhead } from './playhead'

/** 字幕字体整个会话问一次；服务端没有可用的中文字体时为 null */
let fontInfo: Promise<SubtitleFontInfo | null> | null = null
function loadFont() {
  fontInfo ??= fetch(API.subtitleFont)
    .then((r) => (r.ok ? (r.json() as Promise<SubtitleFontInfo>) : null))
    .catch(() => null)
  return fontInfo
}

export type SubtitleMode = 'loading' | 'libass' | 'fallback'

/**
 * 预览字幕：用 JASSUB（浏览器里的 libass）渲染和导出同一份 ASS、同一个字体文件，
 * 字形、描边、换行和成片一致。拿不到字体或 WASM 起不来时报告 fallback，由外面退回 DOM 字幕。
 */
export function SubtitleLayer({
  build,
  width,
  height,
  playhead,
  onMode,
}: {
  /** 按字体族名生成 ASS 全文 */
  build(font: string): string
  /** 成片像素尺寸（ASS 的 PlayRes） */
  width: number
  height: number
  playhead: Playhead
  onMode(mode: SubtitleMode): void
}) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const [font, setFont] = useState<SubtitleFontInfo | null>(null)
  const instance = useRef<JASSUB | null>(null)
  const [ready, setReady] = useState(false)
  const modeRef = useRef(onMode)
  modeRef.current = onMode
  const content = font ? build(font.family) : ''

  const render = () => {
    const sub = instance.current
    if (!sub || !ready) return
    void sub
      .manualRender(
        { expectedDisplayTime: performance.now(), width, height, mediaTime: playhead.t },
        true,
      )
      .catch(() => {})
  }
  const renderRef = useRef(render)
  renderRef.current = render

  useEffect(() => {
    let live = true
    let sub: JASSUB | null = null
    void (async () => {
      const info = await loadFont()
      if (!live) return
      if (!info || !canvas.current || typeof OffscreenCanvas === 'undefined')
        return modeRef.current('fallback')
      setFont(info)
      try {
        const { default: Jassub } = await import('jassub')
        if (!live || !canvas.current) return
        sub = new Jassub({
          canvas: canvas.current,
          subContent: '[Script Info]\nScriptType: v4.00+\n',
          defaultFont: info.family.toLowerCase(),
          queryFonts: false,
        })
        instance.current = sub
        await sub.ready
        // 字体先加载完再开始画：按需加载的话第一帧是空的，暂停时又不会再画
        await sub.renderer.addFonts([`${location.origin}${API.subtitleFontFile(info.version)}`])
        if (!live) return
        setReady(true)
        modeRef.current('libass')
      } catch (err) {
        console.warn('[字幕预览] JASSUB 不可用，退回近似字幕：', err)
        if (live) modeRef.current('fallback')
      }
    })()
    return () => {
      live = false
      instance.current = null
      void sub?.destroy().catch(() => {})
    }
  }, [])

  // 字幕内容变了换整条轨道
  useEffect(() => {
    const sub = instance.current
    if (!sub || !ready || !content) return
    void Promise.resolve(sub.renderer.setTrack(content)).then(() => renderRef.current())
  }, [content, ready])

  // 跟着播放头逐帧渲染；尺寸变了也重画
  useEffect(() => playhead.subscribe(() => renderRef.current()), [playhead])
  useEffect(() => {
    renderRef.current()
  }, [width, height])

  return <canvas ref={canvas} className="pointer-events-none absolute inset-0 z-20 h-full w-full" />
}
