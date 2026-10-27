import { type MotionParams, motionSize } from '@plein/nodes'
import { useEffect, useRef, useState } from 'react'
import { Icon } from '../../ui/icons'
import {
  createMotionPreview,
  releaseMotionPreview,
  type MotionInputs,
  type MotionPreviewSession,
} from './api'

interface PreviewEvent {
  type: 'plein-motion-event'
  id: string
  nonce: string
  event: 'ready' | 'timeupdate' | 'play' | 'pause' | 'ended' | 'error'
  time?: number
  duration?: number
  message?: string
}

const clock = (time: number) =>
  `${Math.floor(time / 60)}:${(time % 60).toFixed(2).padStart(5, '0')}`

/** 只有消息桥跨越预览边界；主界面不访问合成 DOM，不携带应用凭据。 */
export function MotionPreview({
  params,
  inputs,
  active,
}: {
  params: MotionParams
  inputs: MotionInputs
  active: boolean
}) {
  const frame = useRef<HTMLIFrameElement>(null)
  const current = useRef<MotionPreviewSession | null>(null)
  const playback = useRef({ time: 0, playing: false })
  const duration = useRef(params.duration)
  duration.current = params.duration
  const [session, setSession] = useState<MotionPreviewSession | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [message, setMessage] = useState('准备预览…')
  const [time, setTime] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [retry, setRetry] = useState(0)
  const send = (command: 'play' | 'pause' | 'seek' | 'dispose', at?: number) => {
    const s = current.current
    if (!s) return
    frame.current?.contentWindow?.postMessage(
      { type: 'plein-motion-command', id: s.id, nonce: s.nonce, command, time: at },
      s.origin,
    )
  }
  const sendRef = useRef(send)
  sendRef.current = send
  useEffect(() => {
    const receive = (event: MessageEvent<unknown>) => {
      const s = current.current
      if (!s || event.source !== frame.current?.contentWindow || event.origin !== s.origin) return
      const raw = event.data
      if (!raw || typeof raw !== 'object') return
      const data = raw as PreviewEvent
      if (data.type !== 'plein-motion-event' || data.id !== s.id || data.nonce !== s.nonce) return
      if (data.event === 'ready') {
        setState('ready')
        setMessage('实时预览')
        sendRef.current(
          'seek',
          Math.min(playback.current.time, Math.max(0, duration.current - 1 / 30)),
        )
        if (playback.current.playing) sendRef.current('play')
      } else if (
        data.event === 'timeupdate' &&
        typeof data.time === 'number' &&
        Number.isFinite(data.time)
      ) {
        const at = Math.min(duration.current, Math.max(0, data.time))
        playback.current.time = at
        setTime(at)
      } else if (data.event === 'play' || data.event === 'pause' || data.event === 'ended') {
        const next = data.event === 'play'
        playback.current.playing = next
        setPlaying(next)
      } else if (data.event === 'error') {
        playback.current.playing = false
        setPlaying(false)
        setState('error')
        setMessage(
          typeof data.message === 'string' ? data.message.slice(0, 1000) : '动态合成预览失败',
        )
      }
    }
    window.addEventListener('message', receive)
    return () => window.removeEventListener('message', receive)
  }, [])

  const key = JSON.stringify({ params, inputs })
  useEffect(() => {
    if (!active) return
    let disposed = false
    const signal = AbortSignal.timeout(20_000)
    let owned: MotionPreviewSession | null = null
    setState('loading')
    setMessage('更新预览…')
    setSession(null)
    const timer = setTimeout(() => {
      void createMotionPreview(params, inputs, signal).then(
        (created) => {
          if (disposed) {
            void releaseMotionPreview(created.id)
            return
          }
          owned = created
          current.current = created
          setSession(created)
        },
        (error: unknown) => {
          if (disposed) return
          setState('error')
          setMessage((error as Error).message)
        },
      )
    }, 180)
    return () => {
      clearTimeout(timer)
      // 已发出的创建请求继续收回会话ID，迟到应答立即释放，避免留下不可回收的预览。
      disposed = true
      if (owned) {
        if (current.current === owned) {
          sendRef.current('dispose')
          current.current = null
        }
        void releaseMotionPreview(owned.id)
      }
    }
    // 参数和输入的完整身份变化才重建，ready 后恢复时间与播放状态。
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [key, active, retry])

  useEffect(() => {
    if (!session || !active || state !== 'loading') return
    const timer = setTimeout(() => {
      setState('error')
      setMessage('预览加载超时，请重试预览')
    }, 20_000)
    return () => clearTimeout(timer)
  }, [session, active, state])

  const size = motionSize(params)
  return (
    <section className="motion-preview" aria-label="动态合成预览" data-state={state}>
      <div className="motion-preview-stage">
        {session && active && (
          <iframe
            ref={frame}
            key={session.id}
            src={session.url}
            title="动态合成隔离预览"
            sandbox="allow-scripts allow-same-origin"
            allow="autoplay"
            referrerPolicy="no-referrer"
            style={{ aspectRatio: `${size.width} / ${size.height}` }}
          />
        )}
        {state !== 'ready' && (
          <div className="motion-preview-notice" role="status">
            <span>{message}</span>
            {state === 'error' && (
              <button type="button" className="ui-btn" onClick={() => setRetry((v) => v + 1)}>
                重试预览
              </button>
            )}
          </div>
        )}
      </div>
      <div className="motion-transport">
        <button
          type="button"
          className="ui-btn ui-icon-btn"
          aria-label={playing ? '暂停预览' : '播放预览'}
          disabled={state !== 'ready' || !active}
          onClick={() => {
            if (!playing && playback.current.time >= params.duration - 1 / 30) send('seek', 0)
            send(playing ? 'pause' : 'play')
          }}
        >
          <Icon name={playing ? 'pause' : 'play'} />
        </button>
        <input
          type="range"
          aria-label="预览时间"
          min={0}
          max={Math.max(0, params.duration - 1 / 30)}
          step={1 / 30}
          value={Math.min(time, Math.max(0, params.duration - 1 / 30))}
          disabled={state !== 'ready' || !active}
          onChange={(event) => {
            const at = Number(event.target.value)
            playback.current = { time: at, playing: false }
            setTime(at)
            setPlaying(false)
            send('pause')
            send('seek', at)
          }}
        />
        <output aria-label="当前预览时间">
          {clock(time)} / {clock(params.duration)}
        </output>
      </div>
      <p className="motion-preview-caption">
        {size.width} × {size.height} · 30 fps · {state === 'ready' ? '预览不会生成候选' : message}
      </p>
    </section>
  )
}
