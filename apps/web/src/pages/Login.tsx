import { type FormEvent, useState } from 'react'
import { api } from '../api/client'
import { useSession } from '../stores/session'

const input =
  'h-10 w-full rounded-lg bg-surface-2 px-3 text-sm text-ink outline-none ring-1 ring-line placeholder:text-ink-muted focus:ring-accent/60'

/** 登录；还没有账号时创建所有者账号 */
export function Login({ setup }: { setup: boolean }) {
  const refresh = useSession((s) => s.refresh)
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      if (setup) await api.setup({ name: name || email.split('@')[0]!, email, password })
      else await api.login({ email, password })
      await refresh()
    } catch (err) {
      setError(setup ? `创建失败：${(err as Error).message}` : '邮箱或密码不正确')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex h-full items-center justify-center p-4">
      <form
        onSubmit={submit}
        className="flex w-full max-w-sm flex-col gap-3 rounded-2xl bg-surface p-6 shadow-[var(--shadow-3)]"
      >
        <h1 className="text-lg font-medium">{setup ? '创建所有者账号' : '登录 Plein'}</h1>
        <p className="text-sm text-ink-muted">
          {setup
            ? '这台 Plein 还没有账号。创建后，只有你能访问这里的画布和素材。'
            : '这台 Plein 需要登录才能访问。'}
        </p>
        {setup && (
          <input
            className={input}
            placeholder="名字（可选）"
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
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error && <p className="text-sm text-red-400">{error}</p>}
        <button
          type="submit"
          disabled={busy}
          className="mt-1 h-10 rounded-lg bg-accent text-sm font-medium text-canvas transition-opacity disabled:opacity-50"
        >
          {setup ? '创建并进入' : '登录'}
        </button>
      </form>
    </div>
  )
}
