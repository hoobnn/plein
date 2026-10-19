import type { Canvas } from '@plein/protocol'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../../api/client'
import { cacheCanvas, cacheProject, invalidateProjects, queryKeys } from '../../api/query'
import { navigate } from '../../router'
import { useCanvas } from '../../stores/canvas'
import { confirmDialog, promptDialog } from '../../ui/Dialog'
import { Icon } from '../../ui/icons'
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
 * 点项目名打开改名窗口；画布下拉里切换同项目的其他画布、新建、改名、删除当前画布。
 */
export function ProjectSwitcher({ canvas }: { canvas: Canvas }) {
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
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const [retryError, setRetryError] = useState<Error | null>(null)
  const listError = canvasList.error ?? retryError
  const loadCanvases = async () => {
    if (canvasList.isFetching) return
    setRetryError(canvasList.error)
    try {
      await canvasList.refetch({ throwOnError: false })
    } finally {
      setRetryError(null)
    }
  }
  const suffixFor = (item: Canvas) => {
    if (!canvases.some((other) => other.id !== item.id && other.title === item.title)) return ''
    let size = 6
    while (
      canvases.some(
        (other) => other.id !== item.id && other.id.slice(-size) === item.id.slice(-size),
      )
    )
      size++
    return item.id.slice(-size)
  }

  const close = () => setAnchor(null)
  const renameProject = async () => {
    const target = project
    if (!target) return
    const isCurrent = captureCanvasVisit(canvas.id)
    close()
    await promptDialog({
      title: '重命名项目',
      defaultValue: target.title,
      placeholder: '项目名称',
      maxLength: 200,
      confirmLabel: '保存',
      onConfirm: async (title) => {
        if (!isCurrent()) throw new Error('画布已切换，请关闭窗口后重新操作')
        if (title === target.title) return
        cacheProject(await api.renameProject(target.id, title))
        void invalidateProjects()
      },
    })
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
    const isCurrent = captureCanvasVisit(canvas.id)
    close()
    await promptDialog({
      title: '重命名画布',
      defaultValue: canvas.title,
      placeholder: '画布名称',
      maxLength: 200,
      confirmLabel: '保存',
      onConfirm: async (title) => {
        if (!isCurrent()) throw new Error('画布已切换，请关闭窗口后重新操作')
        if (title === canvas.title) return
        await cacheCanvas(await api.renameCanvas(canvas.id, title))
        void invalidateProjects()
      },
    })
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
      <button
        type="button"
        onClick={() => void renameProject()}
        title="重命名项目"
        className="ui-bar-btn block max-w-44 truncate font-medium text-ink"
      >
        {project?.title ?? '…'}
      </button>
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
          void loadCanvases()
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
            {canvasList.isFetching && !listError && (
              <p role="status" className="px-3 py-2 text-xs text-ink-subtle">
                {canvasList.data ? '正在刷新画布…' : '正在加载画布…'}
              </p>
            )}
            {listError && (
              <div role="alert" className="flex flex-col gap-2 px-3 py-2 text-xs text-danger">
                <p className="break-words">
                  {canvasList.data ? '画布列表刷新失败' : '画布列表加载失败'}：{listError.message}
                </p>
                <button
                  type="button"
                  className="ui-btn ui-btn-secondary ui-btn-sm self-start"
                  aria-label="重新加载画布"
                  disabled={canvasList.isFetching}
                  onClick={() => void loadCanvases()}
                >
                  {canvasList.isFetching ? '正在重试…' : '重新加载'}
                </button>
              </div>
            )}
            {!canvasList.isFetching && !listError && canvasList.data && !canvases.length && (
              <p className="px-3 py-2 text-xs text-ink-subtle">
                暂无可切换的画布，可新建画布后继续。
              </p>
            )}
            <div className="ui-scrollbar max-h-72 overflow-y-auto">
              {canvases.map((c) => {
                const suffix = suffixFor(c)
                const label = suffix ? `${c.title} · ${suffix}` : c.title
                return (
                  <button
                    key={c.id}
                    type="button"
                    aria-label={label}
                    title={label}
                    aria-current={c.id === canvas.id || undefined}
                    onClick={() => {
                      close()
                      if (c.id !== canvas.id) navigate({ name: 'canvas', id: c.id })
                    }}
                    className="ui-menu-item"
                  >
                    <span className="flex-1 truncate">{c.title}</span>
                    {suffix && (
                      <span
                        aria-hidden="true"
                        className="shrink-0 font-mono text-xs text-ink-subtle"
                      >
                        {suffix}
                      </span>
                    )}
                    {c.id === canvas.id && <Icon name="check" size={14} />}
                  </button>
                )
              })}
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
