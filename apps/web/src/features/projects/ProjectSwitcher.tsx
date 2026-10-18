import type { Canvas } from '@plein/protocol'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../../api/client'
import { invalidateProjects, queryClient, queryKeys } from '../../api/query'
import { navigate } from '../../router'
import { useCanvas } from '../../stores/canvas'
import { confirmDialog, promptDialog } from '../../ui/Dialog'
import { Icon } from '../../ui/icons'
import { InlineTitle } from '../../ui/InlineTitle'
import { Popover } from '../../ui/Popover'
import { Presence } from '../../ui/Presence'
import { forgetLocalCache } from '../../canvas/localCache'

const fail = (err: unknown) => useCanvas.getState().notify((err as Error).message)

/** 同一画布离开再返回也是新会话，旧请求只完成数据更新，不再接管导航。 */
const captureCanvasVisit = (canvasId: string) => {
  const engine = useCanvas.getState().engine
  return () => {
    const current = useCanvas.getState()
    return current.canvasId === canvasId && current.engine === engine
  }
}

/**
 * 页头的「项目 / 画布 ▾」：
 * 点项目名改名；画布下拉里切换同项目的其他画布、新建、改名、删除当前画布。
 */
export function ProjectSwitcher({
  canvas,
  onCanvas,
}: {
  canvas: Canvas
  onCanvas(c: Canvas): void
}) {
  // 侧栏展开收起、切故事板时会换位置重新挂载，查询缓存里有上次读到的，项目名不会闪成「…」
  const project =
    useQuery({
      queryKey: queryKeys.project(canvas.projectId),
      queryFn: () => api.project(canvas.projectId),
    }).data ?? null
  const canvasList = useQuery({
    queryKey: queryKeys.projectCanvases(canvas.projectId),
    queryFn: () => api.projectCanvases(canvas.projectId),
  })
  const canvases = canvasList.data ?? []
  const [renaming, setRenaming] = useState(false)
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)

  const close = () => setAnchor(null)
  const renameProject = async (title: string | null) => {
    setRenaming(false)
    if (project && title && title !== project.title) {
      try {
        const next = await api.renameProject(project.id, title)
        queryClient.setQueryData(queryKeys.project(next.id), next)
        void invalidateProjects()
      } catch (err) {
        fail(err)
      }
    }
  }
  const addCanvas = async () => {
    const isCurrent = captureCanvasVisit(canvas.id)
    close()
    const title = await promptDialog({
      title: '新建画布',
      message: `建在项目「${project?.title ?? ''}」下，可以和其他画布共用资产库里的角色、场景`,
      defaultValue: `画布 ${canvases.length + 1}`,
      placeholder: '画布名称',
      confirmLabel: '新建',
    })
    if (!title || !isCurrent()) return
    try {
      const c = await api.createCanvas(canvas.projectId, title)
      void invalidateProjects()
      if (isCurrent()) navigate({ name: 'canvas', id: c.id })
    } catch (err) {
      if (isCurrent()) fail(err)
    }
  }
  const renameCanvas = async () => {
    close()
    const title = await promptDialog({
      title: '重命名画布',
      defaultValue: canvas.title,
      placeholder: '画布名称',
      confirmLabel: '保存',
    })
    if (!title || title === canvas.title) return
    try {
      onCanvas(await api.renameCanvas(canvas.id, title))
      await invalidateProjects()
    } catch (err) {
      fail(err)
    }
  }
  const removeCanvas = async () => {
    const isCurrent = captureCanvasVisit(canvas.id)
    close()
    const ok = await confirmDialog({
      title: `删除画布「${canvas.title}」？`,
      message: '画布内容会一并删除，素材文件和资产库保留。',
      confirmLabel: '删除',
      danger: true,
    })
    if (!ok || !isCurrent()) return
    try {
      await api.deleteCanvas(canvas.id)
      forgetLocalCache(canvas.id)
      void invalidateProjects()
    } catch (err) {
      if (isCurrent()) fail(err)
      return
    }
    // 已回到原画布时仍需离开刚被删除的文档；停留在其他画布则保持当前位置。
    if (useCanvas.getState().canvasId !== canvas.id) return
    const next = canvases.find((c) => c.id !== canvas.id)
    navigate(next ? { name: 'canvas', id: next.id } : { name: 'home' }, { replace: true })
  }

  return (
    <>
      {renaming && project ? (
        <InlineTitle
          value={project.title}
          label="项目名称"
          onDone={renameProject}
          className="h-9 w-44 rounded-md px-2 text-sm font-medium"
        />
      ) : (
        <button
          type="button"
          onClick={() => setRenaming(!!project)}
          title="重命名项目"
          className="ui-bar-btn block max-w-44 truncate font-medium text-ink"
        >
          {project?.title ?? '…'}
        </button>
      )}
      <span className="text-ink-subtle" aria-hidden="true">
        /
      </span>
      <button
        type="button"
        aria-expanded={!!anchor}
        aria-label="切换画布"
        title="切换、新建画布"
        onClick={(e) => {
          if (anchor) return close()
          setAnchor(e.currentTarget)
          void canvasList.refetch()
        }}
        className="ui-bar-btn max-w-52 gap-1 font-medium text-ink"
      >
        <span className="truncate">{canvas.title}</span>
        <Icon name="chevronDown" size={14} />
      </button>
      <Presence>
        {anchor && (
          <Popover anchor={anchor} onClose={close} label="画布" width={240} placement="below">
            <div className="ui-menu-label">画布</div>
            <div className="ui-scrollbar max-h-72 overflow-y-auto">
              {canvases.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  aria-current={c.id === canvas.id || undefined}
                  onClick={() => {
                    close()
                    if (c.id !== canvas.id) navigate({ name: 'canvas', id: c.id })
                  }}
                  className="ui-menu-item"
                >
                  <span className="flex-1 truncate">{c.title}</span>
                  {c.id === canvas.id && <Icon name="check" size={14} />}
                </button>
              ))}
            </div>
            <div className="ui-sep" />
            <button type="button" onClick={() => void addCanvas()} className="ui-menu-item">
              <Icon name="plus" size={14} />
              新建画布
            </button>
            <button type="button" onClick={() => void renameCanvas()} className="ui-menu-item">
              <Icon name="pencil" size={14} />
              重命名当前画布
            </button>
            <button
              type="button"
              onClick={() => void removeCanvas()}
              className="ui-menu-item hover:text-danger"
            >
              <Icon name="trash" size={14} />
              删除当前画布
            </button>
          </Popover>
        )}
      </Presence>
    </>
  )
}
