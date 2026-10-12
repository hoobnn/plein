import type { Canvas } from '@plein/protocol'
import { useCallback, useEffect, useState } from 'react'
import { api } from '../api/client'
import { navigate } from '../router'
import { useSession } from '../stores/session'
import { Icon } from '../ui/icons'
import { ThemeToggle } from '../ui/ThemeToggle'

const timeFmt = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' })

/** 画布列表：新建、打开、重命名、删除 */
export function Home({ onOpenSettings }: { onOpenSettings(): void }) {
  const info = useSession((s) => s.info)
  const refreshSession = useSession((s) => s.refresh)
  const [canvases, setCanvases] = useState<Canvas[] | null>(null)
  const [error, setError] = useState<string | null>(null)

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
    <div className="ui-scrollbar h-full overflow-y-auto">
      <div className="mx-auto flex max-w-6xl flex-col gap-8 px-5 py-8 sm:px-10">
        <header className="flex items-center justify-between gap-4">
          <h1 className="flex items-center gap-2.5 text-lg font-semibold tracking-wide">
            <span className="size-5 rounded-md bg-accent" aria-hidden="true" />
            Plein
          </h1>
          <div className="flex items-center gap-1.5">
            <ThemeToggle />
            <button
              type="button"
              onClick={onOpenSettings}
              aria-label="设置"
              title="设置"
              className="ui-btn ui-btn-quiet ui-icon-btn"
            >
              <Icon name="settings" />
            </button>
            {info?.authRequired && (
              <button type="button" onClick={logout} className="ui-btn ui-btn-quiet">
                退出登录
              </button>
            )}
          </div>
        </header>
        <section className="flex flex-col gap-4">
          <div className="flex items-end justify-between gap-4">
            <div>
              <h2 className="text-2xl font-semibold tracking-tight">画布</h2>
              <p className="mt-1 text-[13px] text-ink-subtle">
                把剧本、角色、分镜和生成结果放在一张无限画布上
              </p>
            </div>
            <button type="button" onClick={create} className="ui-btn ui-btn-primary !h-9 !px-4">
              <Icon name="plus" size={15} />
              新建画布
            </button>
          </div>
          {error && <p className="text-sm text-danger">加载失败：{error}</p>}
          {canvases && canvases.length === 0 && (
            <div className="rounded-[18px] border border-dashed border-line-strong p-12 text-center text-sm text-ink-subtle">
              还没有画布。新建一个，然后把图片、视频、音频或 Markdown 文件拖进去。
            </div>
          )}
          <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {canvases?.map((c) => (
              <li
                key={c.id}
                className="group relative overflow-hidden rounded-[16px] bg-surface shadow-[var(--shadow-2)] transition-shadow duration-200 hover:shadow-[var(--shadow-3)]"
              >
                <a href={`#/c/${encodeURIComponent(c.id)}`} className="block">
                  <div className="plein-thumb aspect-[16/9] border-b border-line" />
                  <div className="px-4 py-3">
                    <div className="truncate text-[14px] font-medium">{c.title}</div>
                    <div className="mt-0.5 text-xs text-ink-subtle">
                      {timeFmt.format(c.updatedAt)}
                    </div>
                  </div>
                </a>
                <div className="ui-float absolute right-2 top-2 flex gap-0.5 rounded-[10px] p-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
                  <button
                    type="button"
                    onClick={() => rename(c)}
                    aria-label="重命名"
                    title="重命名"
                    className="ui-btn ui-btn-quiet ui-icon-btn !size-7"
                  >
                    <Icon name="pencil" size={14} />
                  </button>
                  <button
                    type="button"
                    onClick={() => remove(c)}
                    aria-label="删除"
                    title="删除"
                    className="ui-btn ui-btn-quiet ui-icon-btn !size-7 hover:!text-danger"
                  >
                    <Icon name="trash" size={14} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  )
}
