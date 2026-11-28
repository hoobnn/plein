import { externalAuthPath, ExternalAuthState, type ExternalPlatform } from '@plein/protocol'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { json, request } from '../../api/http'
import { useOverlayClosing } from '../../ui/motion'

export function ExternalSignIn({
  canvasId,
  provider,
  onReady,
}: {
  canvasId: string
  provider: ExternalPlatform
  onReady(): void
}) {
  const [state, setState] = useState<ExternalAuthState | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const current = useRef<AbortController | null>(null)
  const closing = useOverlayClosing()
  useLayoutEffect(() => {
    if (closing) current.current?.abort()
    return () => current.current?.abort()
  }, [closing])

  const pending = state?.status === 'pending' ? state : null
  useEffect(() => {
    if (!pending) return
    const timer = setTimeout(
      () => {
        current.current?.abort()
        setState({ status: 'expired' })
        setBusy(false)
        setMessage('')
      },
      Math.max(0, Date.parse(pending.expiresAt) - Date.now()),
    )
    return () => clearTimeout(timer)
  }, [pending])
  async function authorize(action: 'start' | 'finish') {
    if (closing || current.current) return
    if (action === 'finish' && (!pending || Date.parse(pending.expiresAt) <= Date.now())) {
      setState({ status: 'expired' })
      return
    }
    const controller = new AbortController()
    current.current = controller
    setBusy(true)
    setMessage('')
    try {
      const next = ExternalAuthState.parse(
        await request<unknown>(externalAuthPath(canvasId, action), {
          ...json('POST', { provider }),
          signal: controller.signal,
        }),
      )
      controller.signal.throwIfAborted()
      if (next.status === 'authenticated') {
        onReady()
        return
      }
      if (next.status === 'pending') {
        if (
          !Number.isFinite(Date.parse(next.expiresAt)) ||
          Date.parse(next.expiresAt) <= Date.now()
        ) {
          setState({ status: 'expired' })
          return
        }
        if (new URL(next.verificationUrl).protocol !== 'https:')
          throw new Error('无法打开即梦授权链接，请重新获取')
        if (action === 'finish') setMessage('即梦尚未确认授权，请在官方页面完成后重新检查。')
      }
      setState(next)
    } catch (err) {
      if (!controller.signal.aborted)
        setMessage(err instanceof Error ? err.message : '无法读取授权状态')
    } finally {
      if (current.current === controller) {
        current.current = null
        if (!controller.signal.aborted) setBusy(false)
      }
    }
  }
  return (
    <section aria-label="即梦账号授权" className="space-y-2">
      {pending ? (
        <>
          <p className="text-sm">在即梦官方页面确认账号授权，完成后回到这里。</p>
          <div className="flex flex-wrap items-center gap-2">
            <a
              href={pending.verificationUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(event) => {
                if (closing || Date.parse(pending.expiresAt) <= Date.now()) {
                  event.preventDefault()
                  setState({ status: 'expired' })
                }
              }}
              className="ui-btn ui-btn-primary ui-btn-sm"
            >
              打开即梦授权页
            </a>
            <button
              type="button"
              className="ui-btn ui-btn-secondary ui-btn-sm"
              disabled={busy}
              onClick={() => void authorize('finish')}
            >
              {busy ? '正在检查…' : '已授权，重新读取'}
            </button>
          </div>
          {pending.userCode && (
            <p className="text-sm">
              在授权页输入验证码 <code className="font-semibold">{pending.userCode}</code>
            </p>
          )}
          <p className="text-xs text-ink-muted">
            链接有效至{' '}
            {new Date(pending.expiresAt).toLocaleTimeString('zh-CN', {
              hour: '2-digit',
              minute: '2-digit',
            })}
          </p>
        </>
      ) : (
        <>
          {state?.status === 'expired' && (
            <p className="text-xs text-ink-muted">授权链接已过期，请获取新链接。</p>
          )}
          {state?.status === 'denied' && <p className="text-xs text-ink-muted">此次授权已取消。</p>}
          <button
            type="button"
            className="ui-btn ui-btn-secondary ui-btn-sm"
            disabled={busy}
            onClick={() => void authorize('start')}
          >
            {busy ? '正在获取授权链接…' : state ? '重新获取授权链接' : '连接即梦账号'}
          </button>
        </>
      )}
      {message && (
        <p role="status" className="text-xs text-ink-muted">
          {message}
        </p>
      )}
    </section>
  )
}
