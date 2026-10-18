import type { Project } from '@plein/protocol'
import { useQuery } from '@tanstack/react-query'
import { type MouseEvent, useEffect, useRef, useState } from 'react'
import { api } from '../api/client'
import { cacheProject, invalidateProjects, queryClient, queryKeys } from '../api/query'
import { queueStartNode } from '../canvas/startQueue'
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
import { useMediaLibrary } from '../features/media-library/store'
import { useCheckpoints } from '../features/checkpoints/store'
import { HomeAgentTrigger } from '../features/agent/HomeAgentTrigger'

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
  const [retryError, setRetryError] = useState<Error | null>(null)
  const [query, setQuery] = useState('')
  const [creating, setCreating] = useState(false)
  const createPending = useRef(false)
  const active = useRef(true)
  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
    }
  }, [])
  const [scrolled, setScrolled] = useState(false)
  const [exporting, setExporting] = useState<Project | null>(null)
  const [importing, setImporting] = useState<File | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const listError = list.error ?? retryError
  const reloadProjects = async () => {
    if (list.isFetching) return
    // 首次加载重试会立即清空查询错误；保留提示区直到这次读取结束。
    setRetryError(list.error)
    try {
      await list.refetch({ throwOnError: false })
    } finally {
      setRetryError(null)
    }
  }

  const create = async (from: Element, start?: string) => {
    if (createPending.current) return
    createPending.current = true
    setError(null)
    setCreating(true)
    try {
      const p = await api.createProject()
      if (!p.lastCanvasId) throw new Error('项目建好了，但没有画布')
      if (start) queueStartNode(p.lastCanvasId, start)
      // 先把新项目塞进列表缓存：从画布回首页时它的卡片立刻就在，画布能缩回去
      queryClient.setQueryData<Project[]>(queryKeys.projects, (prev) => [
        p,
        ...(prev ?? []).filter((item) => item.id !== p.id),
      ])
      void invalidateProjects()
      if (!active.current) {
        useCanvas.getState().notify(`已创建项目「${p.title}」`)
        return
      }
      const id = p.lastCanvasId
      zoomView(
        'enter',
        () => {
          if (active.current) navigate({ name: 'canvas', id })
        },
        {
          from,
          shape: from.classList.contains('home-new') ? undefined : 'rect',
        },
      )
    } catch (err) {
      createPending.current = false
      if (active.current) {
        setError((err as Error).message)
        setCreating(false)
      } else useCanvas.getState().notify(`创建项目未获确认：${(err as Error).message}`)
    }
  }
  const rename = async (p: Project, title: string) => {
    cacheProject(await api.renameProject(p.id, title))
    void invalidateProjects()
  }
  const remove = async (p: Project) => {
    // 先记下画布，删完把它们的本机缓存一起清掉
    const canvases = await api.projectCanvases(p.id)
    await api.deleteProject(p.id)
    for (const c of canvases) forgetLocalCache(c.id)
    queryClient.setQueryData<Project[]>(queryKeys.projects, (items) =>
      items?.filter((item) => item.id !== p.id),
    )
    void invalidateProjects()
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
            <Brand compactOnMobile />
          </div>
          <div className="app-actions ui-bar ui-bar-bare -mr-1 max-sm:h-auto max-sm:min-w-0 max-sm:flex-1 max-sm:flex-wrap max-sm:justify-end">
            <HomeAgentTrigger />
            <button
              type="button"
              className="ui-bar-btn gap-1.5"
              title="素材"
              onClick={() => useMediaLibrary.getState().show()}
            >
              <Icon name="image" />
              <span className="max-sm:sr-only">素材</span>
            </button>
            <button
              type="button"
              onClick={() => useLibrary.getState().show('character')}
              title="资产库：角色、场景、道具、风格、特效"
              className="ui-bar-btn gap-1.5"
            >
              <Icon name="library" />
              <span className="max-sm:sr-only">资产库</span>
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
              <button
                type="button"
                onClick={logout}
                title="退出登录"
                className="ui-bar-btn gap-1.5"
              >
                <Icon name="logout" />
                <span className="max-sm:sr-only">退出登录</span>
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
          <div className="flex w-full min-w-0 flex-wrap items-center gap-2 sm:w-auto">
            {projects && (projects.length > 1 || query) && (
              <label className="home-search max-sm:basis-full">
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
              className="ui-btn ui-btn-secondary ui-btn-lg max-sm:flex-1"
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
              className="ui-btn ui-btn-primary ui-btn-lg max-sm:flex-1"
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

        {creating && (
          <p role="status" className="flex items-center gap-2 text-sm text-ink-muted">
            <span className="ui-spinner size-4" />
            正在创建项目…
          </p>
        )}
        {error && (
          <p role="alert" className="text-sm text-danger">
            操作失败：{error}
          </p>
        )}
        {listError && (
          <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-danger">
            <p>
              {projects ? '项目列表刷新失败' : '项目列表加载失败'}：{listError.message}
            </p>
            <button
              type="button"
              className="ui-btn ui-btn-secondary ui-btn-sm"
              aria-label="重新加载项目"
              disabled={list.isFetching}
              onClick={() => void reloadProjects()}
            >
              {list.isFetching ? '正在重试…' : '重新加载'}
            </button>
          </div>
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
            onImported={(r) => {
              setImporting(null)
              void invalidateProjects()
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
  onDelete(): Promise<void>
}) {
  const [editing, setEditing] = useState(false)
  const [renameDraft, setRenameDraft] = useState(c.title)
  const [renaming, setRenaming] = useState(false)
  const [renameError, setRenameError] = useState<string | null>(null)
  const [renameFocus, setRenameFocus] = useState(true)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const deletePending = useRef(false)
  const remove = async () => {
    if (deletePending.current || renaming || editing) return
    deletePending.current = true
    try {
      const ok = await confirmDialog({
        title: `删除项目「${c.title}」？`,
        message: `项目里的 ${c.canvases} 张画布会一并删除；素材文件和资产库里的角色、场景等保留。`,
        confirmLabel: '删除',
        danger: true,
      })
      if (!ok) return
      setDeleteError(null)
      setRenameError(null)
      setDeleting(true)
      await onDelete()
    } catch (err) {
      setDeleteError((err as Error).message)
    } finally {
      deletePending.current = false
      setDeleting(false)
    }
  }
  const finishRename = async (title: string | null) => {
    if (renaming || deleting) return
    setEditing(false)
    setRenameError(null)
    if (!title || title === c.title) return
    setRenameDraft(title)
    setRenaming(true)
    try {
      await onRename(title)
    } catch (err) {
      setRenameError((err as Error).message)
      // 等待期间已去操作其他控件时，恢复草稿不抢走用户当前焦点。
      setRenameFocus(document.activeElement === document.body)
      setEditing(true)
    } finally {
      setRenaming(false)
    }
  }
  const covers = c.covers ?? []
  const href = routeHash({ name: 'project', id: c.id })
  // 有最近画布就直接进去，封面放大成画布；没有画布的项目照旧走打开项目（会先建一张）
  const open = (e: MouseEvent<HTMLAnchorElement>) => {
    if (deleting) {
      e.preventDefault()
      return
    }
    const id = c.lastCanvasId
    if (!id || !isPlainClick(e)) return
    e.preventDefault()
    const from = e.currentTarget.closest('.home-card')?.querySelector('.home-cover')
    zoomView('enter', () => navigate({ name: 'canvas', id }), { from })
  }
  return (
    <li className="home-card group" data-project={c.id}>
      <a
        href={href}
        onClick={open}
        onAuxClick={deleting ? (e) => e.preventDefault() : undefined}
        aria-disabled={deleting || undefined}
        className="block"
        draggable={false}
      >
        <Cover covers={covers} empty={c.canvases === 0} />
      </a>
      <div className="flex items-center gap-2 px-3 pb-3 pt-2.5">
        <div className="min-w-0 flex-1">
          {editing ? (
            <InlineTitle
              value={renameDraft}
              label="项目名称"
              // oxlint-disable-next-line jsx-a11y/no-autofocus -- 明确改名时聚焦；迟到失败不抢占其他控件。
              autoFocus={renameFocus}
              className="-mx-1 h-6 w-full rounded-sm px-1 text-base font-medium"
              onDone={finishRename}
            />
          ) : (
            <a
              href={href}
              onClick={open}
              onAuxClick={deleting ? (e) => e.preventDefault() : undefined}
              aria-disabled={deleting || undefined}
              className="block truncate text-base font-medium"
              title={c.title}
              draggable={false}
            >
              {c.title}
            </a>
          )}
          <div className="truncate text-xs text-ink-subtle" title={fullTime(c.updatedAt)}>
            {relativeTime(c.updatedAt)}编辑 · {c.canvases} 张画布
          </div>
          {renaming && (
            <p role="status" className="mt-1 text-xs text-ink-muted">
              正在保存项目名称…
            </p>
          )}
          {deleting && (
            <p role="status" className="mt-1 text-xs text-ink-muted">
              正在删除项目…
            </p>
          )}
          {renameError && (
            <p role="alert" className="mt-1 break-words text-xs text-danger">
              {renameError}
            </p>
          )}
          {deleteError && (
            <p role="alert" className="mt-1 break-words text-xs text-danger">
              {deleteError}
            </p>
          )}
        </div>
        <div className="home-card-actions absolute top-3 right-3 flex gap-0.5 rounded-lg bg-surface p-1 opacity-0 shadow-2 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
          <button
            type="button"
            aria-label="项目素材"
            disabled={deleting}
            title="项目素材"
            className="ui-btn ui-btn-quiet ui-btn-sm ui-icon-btn"
            onClick={() => useMediaLibrary.getState().show({ projectId: c.id })}
          >
            <Icon name="image" size={14} />
          </button>
          <button
            type="button"
            aria-label="项目检查点"
            disabled={deleting}
            title="项目检查点"
            className="ui-btn ui-btn-quiet ui-btn-sm ui-icon-btn"
            onClick={() => useCheckpoints.getState().show({ projectId: c.id })}
          >
            <Icon name="history" size={14} />
          </button>
          <button
            type="button"
            onClick={() => {
              setRenameDraft(c.title)
              setRenameError(null)
              setDeleteError(null)
              setRenameFocus(true)
              setEditing(true)
            }}
            disabled={renaming || editing || deleting}
            aria-label="重命名"
            title="重命名"
            className="ui-btn ui-btn-quiet ui-btn-sm ui-icon-btn"
          >
            <Icon name="pencil" size={14} />
          </button>
          <button
            type="button"
            onClick={onExport}
            disabled={deleting}
            aria-label="导出项目包"
            title="导出项目包"
            className="ui-btn ui-btn-quiet ui-btn-sm ui-icon-btn"
          >
            <Icon name="download" size={14} />
          </button>
          <button
            type="button"
            onClick={() => void remove()}
            disabled={deleting || renaming || editing}
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
