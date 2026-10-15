import type { Project } from '@plein/protocol'
import { useQuery } from '@tanstack/react-query'
import { type MouseEvent, useRef, useState } from 'react'
import { api } from '../api/client'
import { invalidateProjects, queryClient, queryKeys } from '../api/query'
import { queueStartNode } from '../canvas/start'
import { navigate, routeHash } from '../router'
import { forgetLocalCache } from '../canvas/localCache'
import { useLibrary } from '../features/library/store'
import { useSession } from '../stores/session'
import { Brand, isPlainClick } from '../ui/Brand'
import { confirmDialog } from '../ui/Dialog'
import { fullTime, relativeTime } from '../ui/format'
import { Icon, type IconName } from '../ui/icons'
import { InlineTitle } from '../ui/InlineTitle'
import { ThemeToggle } from '../ui/ThemeToggle'
import { EmptyState } from '../ui/EmptyState'
import { zoomView } from '../ui/viewTransition'
import { Welcome } from '../features/onboarding/Welcome'
import { ExportPackageDialog, ImportPackageDialog } from '../features/projects/ProjectPackage'
import { Presence } from '../ui/Presence'
import { Toast } from '../ui/Toast'
import { useCanvas } from '../stores/canvas'

/** 快速开始：新建项目并在它的第一张画布上放好对应节点、打开生成器 */
const QUICK_START: Array<{
  type: string
  title: string
  /** 卡片上的一行说明，要短到不被截断；更完整的写在 detail，悬停时看 */
  hint: string
  detail?: string
  icon: IconName
}> = [
  { type: 'plein/image', title: '图片生成', hint: '文生图、图生图', icon: 'image' },
  {
    type: 'plein/video',
    title: '视频生成',
    hint: '文生、图生视频',
    detail: '文生视频、图生视频、首尾帧、图片参考',
    icon: 'video',
  },
  { type: 'plein/llm', title: '剧本创作', hint: '写剧本、改文案', icon: 'sparkle' },
  { type: 'plein/speech', title: '配音', hint: '台词转语音', icon: 'mic' },
  { type: 'plein/music', title: '配乐', hint: '按描述生成音乐', icon: 'music' },
]

/** 项目列表：新建、打开（进入最近的画布）、重命名、删除 */
export function Home({ onOpenSettings }: { onOpenSettings(): void }) {
  const notice = useCanvas((s) => s.notice)
  const info = useSession((s) => s.info)
  const refreshSession = useSession((s) => s.refresh)
  // 回到首页时先显示上次的列表，同时重新拉（在画布里改过的标题、更新时间）
  const list = useQuery({
    queryKey: queryKeys.projects,
    queryFn: api.projects,
    refetchOnMount: 'always',
  })
  const projects = list.data ?? null
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [creating, setCreating] = useState(false)
  const [scrolled, setScrolled] = useState(false)
  const [exporting, setExporting] = useState<Project | null>(null)
  const [importing, setImporting] = useState<File | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  const create = async (from: Element, start?: string) => {
    if (creating) return
    setCreating(true)
    try {
      const p = await api.createProject()
      if (!p.lastCanvasId) throw new Error('项目建好了，但没有画布')
      if (start) queueStartNode(p.lastCanvasId, start)
      // 先把新项目塞进列表缓存：从画布回首页时它的卡片立刻就在，画布能缩回去
      queryClient.setQueryData<Project[]>(queryKeys.projects, (prev) => prev && [p, ...prev])
      const id = p.lastCanvasId
      zoomView('enter', () => navigate({ name: 'canvas', id }), {
        from,
        shape: from.classList.contains('home-new') ? undefined : 'rect',
      })
    } catch (err) {
      setError((err as Error).message)
      setCreating(false)
    }
  }
  const rename = async (p: Project, title: string) => {
    await api.renameProject(p.id, title)
    await invalidateProjects()
  }
  const remove = async (p: Project) => {
    const ok = await confirmDialog({
      title: `删除项目「${p.title}」？`,
      message: `项目里的 ${p.canvases} 张画布会一并删除；素材文件和资产库里的角色、场景等保留。`,
      confirmLabel: '删除',
      danger: true,
    })
    if (!ok) return
    // 先记下画布，删完把它们的本机缓存一起清掉
    const canvases = await api.projectCanvases(p.id).catch(() => [])
    await api.deleteProject(p.id)
    for (const c of canvases) forgetLocalCache(c.id)
    await invalidateProjects()
  }
  const logout = async () => {
    await api.logout()
    queryClient.clear()
    await refreshSession()
  }

  const q = query.trim().toLowerCase()
  const shown = projects?.filter((p) => !q || p.title.toLowerCase().includes(q)) ?? null

  return (
    <div
      className="ui-scrollbar h-full overflow-y-auto"
      onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 4)}
    >
      <header data-scrolled={scrolled || undefined} className="home-bar app-drag sticky top-0 z-10">
        {/* 和下面的内容同一条栏宽，Logo 与标题左对齐；红绿灯让位见 .home-col */}
        <div className="home-col mx-auto flex max-w-6xl items-center justify-between gap-4 px-5 py-3 sm:px-10">
          {/* 和画布顶栏同一套尺寸（44 高的工具条、36 的按钮），只是不带底色；
              -mx 抵掉工具条和按钮的内边距，Logo 与右侧按钮仍和正文左右对齐 */}
          <div className="ui-bar ui-bar-bare -ml-3.5">
            <Brand />
          </div>
          <div className="app-actions ui-bar ui-bar-bare -mr-1">
            <button
              type="button"
              onClick={() => useLibrary.getState().show('character')}
              title="资产库：角色、场景、道具、风格、特效"
              className="ui-bar-btn gap-1.5"
            >
              <Icon name="library" />
              资产库
            </button>
            <div className="ui-bar-sep" />
            <ThemeToggle />
            <div className="ui-bar-sep" />
            <button
              type="button"
              onClick={onOpenSettings}
              aria-label="设置"
              title="设置"
              className="ui-bar-btn"
            >
              <Icon name="settings" />
            </button>
            {info?.authRequired && (
              <button type="button" onClick={logout} className="ui-bar-btn gap-1.5">
                <Icon name="logout" />
                退出登录
              </button>
            )}
          </div>
        </div>
      </header>

      <main className="home-col mx-auto flex max-w-6xl flex-col gap-6 px-5 pb-16 pt-4 sm:px-10">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="flex items-baseline gap-2 text-2xl font-semibold">
              我的项目
              {projects && projects.length > 0 && (
                <span className="text-sm font-normal text-ink-subtle">{projects.length}</span>
              )}
            </h1>
            <p className="mt-1 text-sm text-ink-subtle">
              一个项目一部片子，下面可以分多张画布；角色、场景、风格存进资产库跨画布复用
            </p>
          </div>
          <div className="flex items-center gap-2">
            {projects && projects.length > 1 && (
              <label className="home-search">
                <Icon name="search" />
                <input
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="搜索项目"
                  aria-label="搜索项目"
                />
              </label>
            )}
            <button
              type="button"
              onClick={() => fileInput.current?.click()}
              title="导入从另一台电脑或数据目录导出的 .plein 项目包"
              className="ui-btn ui-btn-secondary ui-btn-lg"
            >
              <Icon name="upload" />
              导入项目包
            </button>
            <input
              ref={fileInput}
              type="file"
              accept=".plein"
              hidden
              data-testid="project-import-input"
              onChange={(e) => {
                const file = e.target.files?.[0]
                e.target.value = ''
                if (file) setImporting(file)
              }}
            />
            <button
              type="button"
              onClick={(e) => void create(e.currentTarget)}
              disabled={creating}
              className="ui-btn ui-btn-primary ui-btn-lg"
            >
              <Icon name="plus" />
              新建项目
            </button>
          </div>
        </div>

        <section
          aria-label="快速开始"
          className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5"
        >
          {QUICK_START.map((q) => (
            <button
              key={q.type}
              type="button"
              disabled={creating}
              onClick={(e) => void create(e.currentTarget, q.type)}
              title={q.detail}
              className="home-quick group"
            >
              <span className="home-quick-icon">
                <Icon name={q.icon} size={20} />
              </span>
              <span className="min-w-0 text-left">
                <span className="block text-base font-medium text-ink">{q.title}</span>
                <span className="block truncate text-xs text-ink-subtle">{q.hint}</span>
              </span>
            </button>
          ))}
        </section>

        {(error ?? list.error) && (
          <p className="text-sm text-danger">加载失败：{error ?? list.error?.message}</p>
        )}

        {shown && (
          <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {!q && (
              <li>
                <button
                  type="button"
                  onClick={(e) => void create(e.currentTarget)}
                  disabled={creating}
                  className="home-new"
                >
                  <span className="home-new-icon">
                    <Icon name="plus" size={20} />
                  </span>
                  <span className="text-base font-medium text-ink">新建项目</span>
                  <span className="text-xs text-ink-subtle">
                    {projects?.length ? '从一张空白画布开始' : '拖入图片、视频、音频或 Markdown'}
                  </span>
                </button>
              </li>
            )}
            {shown.map((p) => (
              <ProjectCard
                key={p.id}
                project={p}
                onRename={(t) => rename(p, t)}
                onExport={() => setExporting(p)}
                onDelete={() => remove(p)}
              />
            ))}
          </ul>
        )}
        {q && shown?.length === 0 && (
          <EmptyState icon="search" title={`没有标题包含「${query}」的项目`} />
        )}
      </main>
      <Welcome />
      {/* 画布页留下的提示（如画布已在别处删除，跳回首页时） */}
      <Presence>{notice && <Toast>{notice}</Toast>}</Presence>
      <Presence>
        {exporting && (
          <ExportPackageDialog project={exporting} onClose={() => setExporting(null)} />
        )}
      </Presence>
      <Presence>
        {importing && (
          <ImportPackageDialog
            file={importing}
            onClose={() => setImporting(null)}
            onImported={async (r) => {
              setImporting(null)
              await invalidateProjects()
              if (r.canvasId) navigate({ name: 'canvas', id: r.canvasId })
            }}
          />
        )}
      </Presence>
    </div>
  )
}

function ProjectCard({
  project: c,
  onRename,
  onExport,
  onDelete,
}: {
  project: Project
  onRename(title: string): Promise<void>
  onExport(): void
  onDelete(): void
}) {
  const [editing, setEditing] = useState(false)
  const covers = c.covers ?? []
  const href = routeHash({ name: 'project', id: c.id })
  // 有最近画布就直接进去，封面放大成画布；没有画布的项目照旧走打开项目（会先建一张）
  const open = (e: MouseEvent<HTMLAnchorElement>) => {
    const id = c.lastCanvasId
    if (!id || !isPlainClick(e)) return
    e.preventDefault()
    const from = e.currentTarget.closest('.home-card')?.querySelector('.home-cover')
    zoomView('enter', () => navigate({ name: 'canvas', id }), { from })
  }
  return (
    <li className="home-card group" data-project={c.id}>
      <a href={href} onClick={open} className="block" draggable={false}>
        <Cover covers={covers} empty={c.canvases === 0} />
      </a>
      <div className="flex items-center gap-2 px-3 pb-3 pt-2.5">
        <div className="min-w-0 flex-1">
          {editing ? (
            <InlineTitle
              value={c.title}
              className="-mx-1 h-6 w-full rounded-sm px-1 text-base font-medium"
              onDone={async (t) => {
                setEditing(false)
                if (t && t !== c.title) await onRename(t)
              }}
            />
          ) : (
            <a
              href={href}
              onClick={open}
              className="block truncate text-base font-medium"
              draggable={false}
            >
              {c.title}
            </a>
          )}
          <div className="truncate text-xs text-ink-subtle" title={fullTime(c.updatedAt)}>
            {relativeTime(c.updatedAt)}编辑 · {c.canvases} 张画布
          </div>
        </div>
        <div className="flex shrink-0 gap-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
          <button
            type="button"
            onClick={() => setEditing(true)}
            aria-label="重命名"
            title="重命名"
            className="ui-btn ui-btn-quiet ui-btn-sm ui-icon-btn"
          >
            <Icon name="pencil" size={14} />
          </button>
          <button
            type="button"
            onClick={onExport}
            aria-label="导出项目包"
            title="导出项目包"
            className="ui-btn ui-btn-quiet ui-btn-sm ui-icon-btn"
          >
            <Icon name="download" size={14} />
          </button>
          <button
            type="button"
            onClick={onDelete}
            aria-label="删除"
            title="删除"
            className="ui-btn ui-btn-quiet ui-btn-sm ui-icon-btn hover:text-danger"
          >
            <Icon name="trash" size={14} />
          </button>
        </div>
      </div>
    </li>
  )
}

/** 缩略图：项目里最近的 1–4 张生成结果拼成马赛克；没有媒体时画一张示意的空画布 */
function Cover({ covers, empty }: { covers: string[]; empty: boolean }) {
  if (covers.length === 0)
    return (
      <div className="plein-thumb home-cover flex items-center justify-center">
        <span className="flex flex-col items-center gap-2 text-ink-subtle">
          <Icon name="frame" size={24} />
          <span className="text-xs">{empty ? '还没有画布' : '还没有生成图片'}</span>
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
