import type { Canvas } from '@plein/protocol'
import { useCallback, useEffect, useState } from 'react'
import { api } from '../api/client'
import { SettingsDialog } from '../panels/Settings'
import { navigate } from '../router'
import { useSession } from '../stores/session'

const timeFmt = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' })

/** 画布列表：新建、打开、重命名、删除 */
export function Home() {
  const info = useSession((s) => s.info)
  const refreshSession = useSession((s) => s.refresh)
  const [canvases, setCanvases] = useState<Canvas[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [settings, setSettings] = useState(false)

  const load = useCallback(async () => {
    try {
      setCanvases(await api.canvases())
    } catch (err) {
      setError((err as Error).message)
    }
  }, [])
  useEffect(() => {
    void load()
  }, [load])

  const create = async () => {
    const c = await api.createCanvas()
    navigate({ name: 'canvas', id: c.id })
  }
  const rename = async (c: Canvas) => {
    const title = prompt('画布名称', c.title)?.trim()
    if (!title || title === c.title) return
    await api.renameCanvas(c.id, title)
    await load()
  }
  const remove = async (c: Canvas) => {
    if (!confirm(`删除画布「${c.title}」？画布内容会一并删除，素材文件保留。`)) return
    await api.deleteCanvas(c.id)
    await load()
  }
  const logout = async () => {
    await api.logout()
    await refreshSession()
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-5xl flex-col gap-6 px-4 py-10 sm:px-8">
        <header className="flex items-center justify-between gap-4">
          <h1 className="text-xl font-medium tracking-wide">Plein</h1>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setSettings(true)}
              className="h-9 rounded-lg px-3 text-sm text-ink-muted hover:text-ink"
            >
              设置
            </button>
            {info?.authRequired && (
              <button
                type="button"
                onClick={logout}
                className="h-9 rounded-lg px-3 text-sm text-ink-muted hover:text-ink"
              >
                退出登录
              </button>
            )}
            <button
              type="button"
              onClick={create}
              className="h-9 rounded-lg bg-accent px-4 text-sm font-medium text-canvas"
            >
              新建画布
            </button>
          </div>
        </header>
        {error && <p className="text-sm text-red-400">加载失败：{error}</p>}
        {canvases && canvases.length === 0 && (
          <div className="rounded-2xl bg-surface p-10 text-center text-sm text-ink-muted">
            还没有画布。新建一个，然后把图片、视频、音频或 Markdown 文件拖进去。
          </div>
        )}
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {canvases?.map((c) => (
            <li
              key={c.id}
              className="group relative rounded-2xl bg-surface shadow-[var(--shadow-2)]"
            >
              <a href={`#/c/${encodeURIComponent(c.id)}`} className="block p-5">
                <div className="truncate font-medium">{c.title}</div>
                <div className="mt-1 text-xs text-ink-muted">
                  更新于 {timeFmt.format(c.updatedAt)}
                </div>
              </a>
              <div className="absolute right-3 top-3 flex gap-1 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
                <button
                  type="button"
                  onClick={() => rename(c)}
                  className="rounded-md px-2 py-1 text-xs text-ink-muted hover:bg-white/5 hover:text-ink"
                >
                  重命名
                </button>
                <button
                  type="button"
                  onClick={() => remove(c)}
                  className="rounded-md px-2 py-1 text-xs text-ink-muted hover:bg-white/5 hover:text-red-400"
                >
                  删除
                </button>
              </div>
            </li>
          ))}
        </ul>
      </div>
      {settings && <SettingsDialog onClose={() => setSettings(false)} />}
    </div>
  )
}
