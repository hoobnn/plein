import type { Canvas, Project } from '@plein/protocol'
import { useCallback, useEffect, useState } from 'react'
import { api } from '../api/client'
import { navigate } from '../router'
import { useCanvas } from '../stores/canvas'
import { confirmDialog, promptDialog } from '../ui/Dialog'
import { Icon } from '../ui/icons'
import { InlineTitle } from '../ui/InlineTitle'
import { Popover } from '../ui/Popover'

/** 读过的项目，按 id */
const projects = new Map<string, Project>()

const fail = (err: unknown) => useCanvas.getState().notify((err as Error).message)

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
  // 侧栏展开收起、切故事板时会换位置重新挂载，先用上次读到的，免得项目名闪成「…」
  const [project, setProject] = useState<Project | null>(
    () => projects.get(canvas.projectId) ?? null,
  )
  const [canvases, setCanvases] = useState<Canvas[]>([])
  const [renaming, setRenaming] = useState(false)
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)

  const load = useCallback(async () => {
    const [p, list] = await Promise.all([
      api.project(canvas.projectId),
      api.projectCanvases(canvas.projectId),
    ])
    projects.set(p.id, p)
    setProject(p)
    setCanvases(list)
  }, [canvas.projectId])
  useEffect(() => {
    load().catch(() => {})
  }, [load])

  const close = () => setAnchor(null)
  const renameProject = async (title: string | null) => {
    setRenaming(false)
    if (project && title && title !== project.title) {
      try {
        const next = await api.renameProject(project.id, title)
        projects.set(next.id, next)
        setProject(next)
      } catch (err) {
        fail(err)
      }
    }
  }
  const addCanvas = async () => {
    close()
    const title = await promptDialog({
      title: '新建画布',
      message: `建在项目「${project?.title ?? ''}」下，可以和其他画布共用资产库里的角色、场景`,
      defaultValue: `画布 ${canvases.length + 1}`,
      placeholder: '画布名称',
      confirmLabel: '新建',
    })
    if (!title) return
    try {
      const c = await api.createCanvas(canvas.projectId, title)
      navigate({ name: 'canvas', id: c.id })
    } catch (err) {
      fail(err)
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
      await load()
    } catch (err) {
      fail(err)
    }
  }
  const removeCanvas = async () => {
    close()
    const ok = await confirmDialog({
      title: `删除画布「${canvas.title}」？`,
      message: '画布内容会一并删除，素材文件和资产库保留。',
      confirmLabel: '删除',
      danger: true,
    })
    if (!ok) return
    try {
      await api.deleteCanvas(canvas.id)
    } catch (err) {
      return fail(err)
    }
    const next = canvases.find((c) => c.id !== canvas.id)
    navigate(next ? { name: 'canvas', id: next.id } : { name: 'home' }, { replace: true })
  }

  return (
    <>
      {renaming && project ? (
        <InlineTitle
          value={project.title}
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
          void load().catch(() => {})
        }}
        className="ui-bar-btn max-w-52 gap-1 font-medium text-ink"
      >
        <span className="truncate">{canvas.title}</span>
        <Icon name="chevronDown" size={14} />
      </button>
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
    </>
  )
}
