import type { CaptionLayerParams } from '@plein/nodes'
import { useEffect, useRef, useState } from 'react'
import {
  createCaptionPreview,
  releaseMotionPreview,
  type MotionPreviewSession,
} from '../motion/api'
import { captionPreviewTime } from './captionTime'
import type { Playhead } from './playhead'

/** 主播放头是唯一时钟。HF只接收逐帧seek，不启动自己的播放/音频循环。 */
export function CaptionPreview({
  params,
  playhead,
}: {
  params: CaptionLayerParams
  playhead: Playhead
}) {
  const frame = useRef<HTMLIFrameElement>(null)
  const current = useRef<MotionPreviewSession | null>(null)
  const ready = useRef(false)
  const last = useRef(-1)
  const deadline = useRef<ReturnType<typeof setTimeout> | null>(null)
  const duration = useRef(params.duration)
  duration.current = params.duration
  const [session, setSession] = useState<MotionPreviewSession | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [message, setMessage] = useState('正在准备动画字幕…')
  const [retry, setRetry] = useState(0)
  const send = (command: 'pause' | 'seek' | 'dispose', time?: number) => {
    const session = current.current
    if (session)
      frame.current?.contentWindow?.postMessage(
        { type: 'plein-motion-command', id: session.id, nonce: session.nonce, command, time },
        session.origin,
      )
  }
  const sync = () => {
    if (!ready.current) return
    const at = captionPreviewTime(playhead.t, duration.current, current.current?.duration)
    if (at === last.current) return
    last.current = at
    send('seek', at)
  }
  const syncRef = useRef(sync)
  syncRef.current = sync
  useEffect(() => playhead.subscribe(() => syncRef.current()), [playhead])
  useEffect(() => {
    const receive = (event: MessageEvent<unknown>) => {
      const session = current.current
      if (
        !session ||
        event.source !== frame.current?.contentWindow ||
        event.origin !== session.origin ||
        !event.data ||
        typeof event.data !== 'object'
      )
        return
      const data = event.data as {
        type?: string
        id?: string
        nonce?: string
        event?: string
        message?: unknown
      }
      if (
        data.type !== 'plein-motion-event' ||
        data.id !== session.id ||
        data.nonce !== session.nonce
      )
        return
      if (data.event === 'ready') {
        ready.current = true
        if (deadline.current) clearTimeout(deadline.current)
        setState('ready')
        send('pause')
        syncRef.current()
      } else if (data.event === 'error') {
        ready.current = false
        if (deadline.current) clearTimeout(deadline.current)
        send('dispose')
        void releaseMotionPreview(session.id)
        current.current = null
        setSession(null)
        setState('error')
        setMessage(
          typeof data.message === 'string' ? data.message.slice(0, 1000) : '动画字幕预览失败',
        )
      }
    }
    window.addEventListener('message', receive)
    return () => window.removeEventListener('message', receive)
  }, [])
  const key = JSON.stringify(params)
  useEffect(() => {
    let disposed = false
    let owned: MotionPreviewSession | null = null
    ready.current = false
    last.current = -1
    setState('loading')
    setSession(null)
    const timer = setTimeout(() => {
      void createCaptionPreview(params, AbortSignal.timeout(20_000)).then(
        (created) => {
          if (disposed) {
            void releaseMotionPreview(created.id)
            return
          }
          owned = created
          current.current = created
          setSession(created)
          deadline.current = setTimeout(() => {
            if (disposed || ready.current || current.current !== created) return
            send('dispose')
            current.current = null
            owned = null
            void releaseMotionPreview(created.id)
            setSession(null)
            setState('error')
            setMessage('动画字幕预览加载超时，请重试')
          }, 15_000)
        },
        (error: Error) => {
          if (!disposed) {
            setState('error')
            setMessage(error.message)
          }
        },
      )
    }, 180)
    return () => {
      disposed = true
      clearTimeout(timer)
      if (deadline.current) clearTimeout(deadline.current)
      ready.current = false
      if (owned) {
        if (current.current === owned) {
          send('dispose')
          current.current = null
        }
        void releaseMotionPreview(owned.id)
      }
    }
    // 请求只属于这份结构化字幕；迟到成功释放会话，绝不回写旧字幕。
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [key, retry])
  return (
    <div
      className="pointer-events-none absolute inset-0 z-20"
      aria-label="HyperFrames动画字幕"
      data-state={state}
    >
      {session && (
        <iframe
          ref={frame}
          key={session.id}
          src={session.url}
          title="动画字幕隔离预览"
          sandbox="allow-scripts allow-same-origin"
          referrerPolicy="no-referrer"
          className="h-full w-full border-0 bg-transparent"
          style={{ visibility: state === 'ready' ? 'visible' : 'hidden' }}
        />
      )}
      {state === 'error' && (
        <div
          role="alert"
          className="pointer-events-auto absolute inset-x-0 top-0 flex gap-2 bg-black/75 p-2 text-xs text-white"
        >
          <span>{message}</span>
          <button
            type="button"
            className="ui-btn ui-btn-xs"
            onClick={() => setRetry((value) => value + 1)}
          >
            重试动画字幕
          </button>
        </div>
      )}
    </div>
  )
}
