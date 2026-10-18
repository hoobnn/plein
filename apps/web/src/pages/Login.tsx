import { type FormEvent, useRef, useState } from 'react'
import { api, ApiError } from '../api/client'
import { useSession } from '../stores/session'

const input = 'ui-input ui-input-lg w-full'

/** 登录；还没有账号时创建所有者账号 */
export function Login({ setup }: { setup: boolean }) {
  const refresh = useSession((s) => s.refresh)
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const pending = useRef(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (pending.current) return
    pending.current = true
    setBusy(true)
    setError(null)
    try {
      if (setup) await api.setup({ name: name || email.split('@')[0]!, email, password })
      else await api.login({ email, password })
      await refresh()
    } catch (err) {
      setError(
        setup
          ? `创建失败：${(err as Error).message}`
          : err instanceof ApiError && err.status === 401
            ? '邮箱或密码不正确'
            : `登录失败：${(err as Error).message}`,
      )
    } finally {
      pending.current = false
      setBusy(false)
    }
  }

  return (
    <div className="flex h-full items-center justify-center p-4">
      <form
        onSubmit={submit}
        aria-busy={busy}
        className="ui-dialog flex w-full max-w-sm flex-col gap-3 rounded-2xl bg-surface p-8 shadow-4"
      >
        <h1 className="text-xl font-semibold">{setup ? '创建所有者账号' : '登录 Plein'}</h1>
        <p className="text-sm text-ink-muted">
          {setup
            ? '这台 Plein 还没有账号。创建后，只有你能访问这里的画布和素材。'
            : '这台 Plein 需要登录才能访问。'}
        </p>
        {setup && (
          <input
            className={input}
            placeholder="名字（可选）"
            aria-label="名字（可选）"
            autoComplete="name"
            disabled={busy}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        )}
        <input
          className={input}
          type="email"
          required
          autoComplete="email"
          placeholder="邮箱"
          aria-label="邮箱"
          disabled={busy}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <input
          className={input}
          type="password"
          required
          minLength={8}
          autoComplete={setup ? 'new-password' : 'current-password'}
          placeholder={setup ? '密码（至少 8 位）' : '密码'}
          aria-label={setup ? '密码（至少 8 位）' : '密码'}
          disabled={busy}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <button type="submit" disabled={busy} className="ui-btn ui-btn-primary ui-btn-lg mt-2">
          {busy ? (setup ? '正在创建…' : '正在登录…') : setup ? '创建并进入' : '登录'}
        </button>
      </form>
    </div>
  )
}
