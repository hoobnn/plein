import { API, type SubtitleFontInfo } from '@plein/protocol'
import type JASSUB from 'jassub'
import { useEffect, useRef, useState } from 'react'
import type { Playhead } from './playhead'

/** 共享成功结果与进行中的查询，临时失败后允许重试。 */
let fontInfo: Promise<SubtitleFontInfo | null> | null = null
function loadFont() {
  fontInfo ??= fetch(API.subtitleFont)
    .then((r) => (r.ok ? (r.json() as Promise<SubtitleFontInfo>) : null))
    .catch(() => null)
    .then((info) => {
      if (!info) fontInfo = null
      return info
    })
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
  // JASSUB 会自行移除 canvas；React 只拥有宿主，避免销毁或重试时重复移除。
  const host = useRef<HTMLDivElement>(null)
  const [font, setFont] = useState<SubtitleFontInfo | null>(null)
  const instance = useRef<JASSUB | null>(null)
  const [ready, setReady] = useState(false)
  const failRef = useRef<(sub: JASSUB, error: unknown) => void>(() => {})
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
      .catch((error) => failRef.current(sub, error))
  }
  const renderRef = useRef(render)
  renderRef.current = render

  useEffect(() => {
    let live = true
    let sub: JASSUB | null = null
    let observer: ResizeObserver | null = null
    let resizeFrame = 0
    const controller = new AbortController()
    const dispose = () => {
      observer?.disconnect()
      observer = null
      cancelAnimationFrame(resizeFrame)
      const retired = sub
      sub = null
      instance.current = null
      void retired?.destroy().catch(() => {})
    }
    const fail = (error: unknown) => {
      if (!live) return
      console.warn('[字幕预览] JASSUB 不可用，退回近似字幕：', error)
      dispose()
      setReady(false)
      modeRef.current('fallback')
    }
    failRef.current = (target, error) => {
      if (instance.current === target) fail(error)
    }
    modeRef.current('loading')
    setReady(false)
    void (async () => {
      const info = await loadFont()
      if (!live) return
      if (!info || !host.current || typeof OffscreenCanvas === 'undefined')
        return modeRef.current('fallback')
      setFont(info)
      try {
        // addFonts(URL) 内部吞掉下载失败；先验证字节，不能把缺字误报为就绪。
        const [module, response] = await Promise.all([
          import('jassub'),
          fetch(API.subtitleFontFile(info.version), { signal: controller.signal }),
        ])
        if (!response.ok) throw new Error(`字幕字体读取失败 (${response.status})`)
        const bytes = new Uint8Array(await response.arrayBuffer())
        if (!live || !host.current) return
        const canvas = document.createElement('canvas')
        canvas.className = 'h-full w-full'
        host.current.replaceChildren(canvas)
        const Jassub = module.default
        sub = new Jassub({
          canvas,
          subContent: '[Script Info]\nScriptType: v4.00+\n',
          defaultFont: info.family.toLowerCase(),
          queryFonts: false,
        })
        instance.current = sub
        await sub.ready
        // 字体先加载完再开始画：按需加载的话第一帧是空的，暂停时又不会再画
        await sub.renderer.addFonts([bytes])
        if (!live) return
        const current = sub
        observer = new ResizeObserver(() => {
          cancelAnimationFrame(resizeFrame)
          // canvas 模式没有 paused video；JASSUB 自动 resize 不会强制刷新字形。
          // 等它完成尺寸同步，再重画，避免校验提示等布局变化留下旧尺寸的缓存帧。
          resizeFrame = requestAnimationFrame(() => {
            if (instance.current === current)
              void current.resize(true).catch((error) => failRef.current(current, error))
          })
        })
        observer.observe(host.current!)
        setReady(true)
        modeRef.current('libass')
      } catch (err) {
        fail(err)
      }
    })()
    return () => {
      live = false
      controller.abort()
      dispose()
    }
  }, [])

  // 字幕内容变了换整条轨道
  useEffect(() => {
    const sub = instance.current
    if (!sub || !ready || !content) return
    void Promise.resolve(sub.renderer.setTrack(content))
      .then(() => {
        if (instance.current === sub) renderRef.current()
      })
      .catch((error) => failRef.current(sub, error))
  }, [content, ready])

  // 跟着播放头逐帧渲染；尺寸变了也重画
  useEffect(() => playhead.subscribe(() => renderRef.current()), [playhead])
  useEffect(() => {
    renderRef.current()
  }, [width, height])

  return <div ref={host} className="pointer-events-none absolute inset-0 z-20 h-full w-full" />
}
