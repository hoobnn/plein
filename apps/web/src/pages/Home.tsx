import type { Canvas } from '@plein/protocol'
import { useCallback, useEffect, useState } from 'react'
import { api } from '../api/client'
import { queueStartNode } from '../canvas/start'
import { navigate } from '../router'
import { useSession } from '../stores/session'
import { Icon, type IconName } from '../ui/icons'
import { confirmDialog } from '../ui/Dialog'
import { InlineTitle } from '../ui/InlineTitle'
import { ThemeToggle } from '../ui/ThemeToggle'

/** 快速开始：新建画布并放好对应节点、打开生成器 */
const QUICK_START: Array<{ type: string; title: string; hint: string; icon: IconName }> = [
  { type: 'plein/image', title: '图片生成', hint: '文生图、参考图生图', icon: 'image' },
  { type: 'plein/video', title: '视频生成', hint: '文生视频、首尾帧', icon: 'video' },
  { type: 'plein/llm', title: '剧本创作', hint: '写剧本、改文案', icon: 'sparkle' },
  { type: 'plein/speech', title: '配音', hint: '台词转语音', icon: 'mic' },
  { type: 'plein/music', title: '配乐', hint: '按描述生成音乐', icon: 'audio' },
]

const dateFmt = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' })
const relFmt = new Intl.RelativeTimeFormat('zh-CN', { numeric: 'auto' })

/** 一周内显示相对时间（刚刚、3 小时前），更早显示日期 */
function when(ts: number) {
  const s = (Date.now() - ts) / 1000
  if (s < 60) return '刚刚'
  if (s < 3600) return relFmt.format(-Math.floor(s / 60), 'minute')
  if (s < 86400) return relFmt.format(-Math.floor(s / 3600), 'hour')
  if (s < 7 * 86400) return relFmt.format(-Math.floor(s / 86400), 'day')
  return dateFmt.format(ts)
}

/** 画布列表：新建、打开、重命名、删除 */
export function Home({ onOpenSettings }: { onOpenSettings(): void }) {
  const info = useSession((s) => s.info)
  const refreshSession = useSession((s) => s.refresh)
  const [canvases, setCanvases] = useState<Canvas[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [creating, setCreating] = useState(false)
  const [scrolled, setScrolled] = useState(false)

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

  const create = async (start?: string) => {
    if (creating) return
    setCreating(true)
    try {
      const c = await api.createCanvas()
      if (start) queueStartNode(c.id, start)
      navigate({ name: 'canvas', id: c.id })
    } catch (err) {
      setError((err as Error).message)
      setCreating(false)
    }
  }
  const rename = async (c: Canvas, title: string) => {
    await api.renameCanvas(c.id, title)
    await load()
  }
  const remove = async (c: Canvas) => {
    const ok = await confirmDialog({
      title: `删除画布「${c.title}」？`,
      message: '画布内容会一并删除，素材文件保留。',
      confirmLabel: '删除',
      danger: true,
    })
    if (!ok) return
    await api.deleteCanvas(c.id)
    await load()
  }
  const logout = async () => {
    await api.logout()
    await refreshSession()
  }

  const q = query.trim().toLowerCase()
  const shown = canvases?.filter((c) => !q || c.title.toLowerCase().includes(q)) ?? null

  return (
    <div
      className="ui-scrollbar h-full overflow-y-auto"
      onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 4)}
    >
      <header
        data-scrolled={scrolled || undefined}
        className="home-bar app-titlebar app-drag sticky top-0 z-10 flex h-[68px] items-center justify-between gap-4 px-5 sm:px-6"
      >
        <div className="flex items-center gap-2.5 text-[15px] font-semibold tracking-wide">
          <span className="plein-logo size-[22px]" aria-hidden="true" />
          Plein
        </div>
        <div className="flex items-center gap-1">
          <ThemeToggle />
          <div className="mx-1 h-4 w-px bg-line" />
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

      <main className="mx-auto flex max-w-6xl flex-col gap-6 px-5 pb-16 pt-6 sm:px-10">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="flex items-baseline gap-2 text-[26px] font-semibold tracking-tight">
              我的画布
              {canvases && canvases.length > 0 && (
                <span className="text-sm font-normal text-ink-subtle">{canvases.length}</span>
              )}
            </h1>
            <p className="mt-1 text-[13px] text-ink-subtle">
              把剧本、角色、分镜和生成结果放在一张无限画布上
            </p>
          </div>
          <div className="flex items-center gap-2">
            {canvases && canvases.length > 1 && (
              <label className="home-search">
                <Icon name="search" size={15} />
                <input
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="搜索画布"
                  aria-label="搜索画布"
                />
              </label>
            )}
            <button
              type="button"
              onClick={() => void create()}
              disabled={creating}
              className="ui-btn ui-btn-primary !h-9 !rounded-[10px] !px-4"
            >
              <Icon name="plus" size={15} />
              新建画布
            </button>
          </div>
        </div>

        <section
          aria-label="快速开始"
          className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5"
        >
          {QUICK_START.map((q) => (
            <button
              key={q.type}
              type="button"
              disabled={creating}
              onClick={() => void create(q.type)}
              className="home-quick group"
            >
              <span className="home-quick-icon">
                <Icon name={q.icon} size={20} />
              </span>
              <span className="min-w-0 text-left">
                <span className="block text-[14px] font-medium text-ink">{q.title}</span>
                <span className="block truncate text-xs text-ink-subtle">{q.hint}</span>
              </span>
            </button>
          ))}
        </section>

        {error && <p className="text-sm text-danger">加载失败：{error}</p>}

        {shown && (
          <ul className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {!q && (
              <li>
                <button
                  type="button"
                  onClick={() => void create()}
                  disabled={creating}
                  className="home-new"
                >
                  <span className="home-new-icon">
                    <Icon name="plus" size={20} />
                  </span>
                  <span className="text-[14px] font-medium text-ink">新建画布</span>
                  <span className="text-xs text-ink-subtle">
                    {canvases?.length ? '从一张空白画布开始' : '拖入图片、视频、音频或 Markdown'}
                  </span>
                </button>
              </li>
            )}
            {shown.map((c) => (
              <CanvasCard
                key={c.id}
                canvas={c}
                onRename={(t) => rename(c, t)}
                onDelete={() => remove(c)}
              />
            ))}
          </ul>
        )}
        {q && shown?.length === 0 && (
          <p className="py-16 text-center text-sm text-ink-subtle">没有标题包含「{query}」的画布</p>
        )}
      </main>
    </div>
  )
}

function CanvasCard({
  canvas: c,
  onRename,
  onDelete,
}: {
  canvas: Canvas
  onRename(title: string): Promise<void>
  onDelete(): void
}) {
  const [editing, setEditing] = useState(false)
  const covers = c.covers ?? []
  return (
    <li className="home-card group">
      <a href={`#/c/${encodeURIComponent(c.id)}`} className="block" draggable={false}>
        <Cover covers={covers} elements={c.elements ?? 0} />
      </a>
      <div className="flex items-center gap-2 px-3.5 pb-3 pt-2.5">
        <div className="min-w-0 flex-1">
          {editing ? (
            <InlineTitle
              value={c.title}
              className="-mx-1 h-6 w-full rounded-md px-1 text-[14px] font-medium"
              onDone={async (t) => {
                setEditing(false)
                if (t && t !== c.title) await onRename(t)
              }}
            />
          ) : (
            <a
              href={`#/c/${encodeURIComponent(c.id)}`}
              className="block truncate text-[14px] font-medium leading-6"
              draggable={false}
            >
              {c.title}
            </a>
          )}
          <div className="truncate text-xs text-ink-subtle" title={dateFmt.format(c.updatedAt)}>
            {when(c.updatedAt)}编辑
            {c.elements ? ` · ${c.elements} 个元素` : ''}
          </div>
        </div>
        <div className="flex shrink-0 gap-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
          <button
            type="button"
            onClick={() => setEditing(true)}
            aria-label="重命名"
            title="重命名"
            className="ui-btn ui-btn-quiet ui-icon-btn !size-7"
          >
            <Icon name="pencil" size={14} />
          </button>
          <button
            type="button"
            onClick={onDelete}
            aria-label="删除"
            title="删除"
            className="ui-btn ui-btn-quiet ui-icon-btn !size-7 hover:!text-danger"
          >
            <Icon name="trash" size={14} />
          </button>
        </div>
      </div>
    </li>
  )
}

/** 缩略图：最近的 1–4 张生成结果拼成马赛克；没有媒体时画一张示意的空画布 */
function Cover({ covers, elements }: { covers: string[]; elements: number }) {
  if (covers.length === 0)
    return (
      <div className="plein-thumb home-cover flex items-center justify-center">
        <span className="flex flex-col items-center gap-1.5 text-ink-subtle">
          <Icon name={elements ? 'node' : 'frame'} size={22} />
          <span className="text-xs">{elements ? '还没有生成图片' : '空画布'}</span>
        </span>
      </div>
    )
  const layout =
    covers.length === 1
      ? ''
      : covers.length === 2
        ? 'grid-cols-2'
        : covers.length === 3
          ? 'grid-cols-[2fr_1fr] grid-rows-2'
          : 'grid-cols-2 grid-rows-2'
  return (
    <div className={`home-cover grid gap-0.5 ${layout}`}>
      {covers.map((src, i) => (
        <img
          key={src}
          src={src}
          alt=""
          loading="lazy"
          draggable={false}
          className={`size-full min-h-0 bg-surface-2 object-cover ${covers.length === 3 && i === 0 ? 'row-span-2' : ''}`}
        />
      ))}
    </div>
  )
}
