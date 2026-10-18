import type { CanvasCheckpoint, CheckpointDetail, CheckpointPage } from '@plein/protocol'
import { useEffect, useRef, useState } from 'react'
import * as Y from 'yjs'
import { invalidateProjects } from '../../api/query'
import { navigate } from '../../router'
import { useCanvas } from '../../stores/canvas'
import { confirmDialog } from '../../ui/Dialog'
import { EmptyState } from '../../ui/EmptyState'
import { fullTime } from '../../ui/format'
import { Icon } from '../../ui/icons'
import { Modal, ModalHeader } from '../../ui/Modal'
import { Presence } from '../../ui/Presence'
import { checkpointApi, saveSynchronizedCheckpoint } from './client'
import { CheckpointPreview } from './CheckpointPreview'
import { useCheckpoints } from './store'

export function CheckpointsPanel() {
  const open = useCheckpoints((s) => s.open)
  return (
    <Presence>
      {open && (
        <Panel
          key={`${open.projectId}/${open.canvasId ?? ''}`}
          projectId={open.projectId}
          canvasId={open.canvasId}
        />
      )}
    </Presence>
  )
}

const base64 = (data: Uint8Array) => {
  let text = ''
  for (const byte of data) text += String.fromCharCode(byte)
  return btoa(text)
}

function Panel({ projectId, canvasId }: { projectId: string; canvasId?: string }) {
  const close = () => useCheckpoints.getState().close()
  const [page, setPage] = useState<CheckpointPage>({ items: [], nextCursor: null }),
    [loading, setLoading] = useState(false),
    [error, setError] = useState(''),
    [revision, setRevision] = useState(0)
  const [loadFailed, setLoadFailed] = useState(false)
  const [name, setName] = useState(''),
    [saving, setSaving] = useState(false),
    [waiting, setWaiting] = useState(false),
    [working, setWorking] = useState<{ id: string; kind: 'restore' | 'remove' } | null>(null)
  const [selected, setSelected] = useState<CanvasCheckpoint | null>(null),
    [detail, setDetail] = useState<CheckpointDetail | null>(null),
    [previewError, setPreviewError] = useState(''),
    [previewRevision, setPreviewRevision] = useState(0)
  const engine = useCanvas((s) => s.engine),
    currentId = useCanvas((s) => s.canvasId)
  const saveController = useRef<AbortController | null>(null)
  const canSave = !!canvasId && canvasId === currentId && !!engine && !engine.doc.readOnly
  useEffect(
    () => () => saveController.current?.abort(new DOMException('已取消等待', 'AbortError')),
    [],
  )
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setLoadFailed(false)
    setError('')
    setPage({ items: [], nextCursor: null })
    checkpointApi
      .list(projectId, undefined, controller.signal)
      .then(
        (result) => {
          if (!controller.signal.aborted) setPage(result)
        },
        (reason: Error) => {
          if (!controller.signal.aborted) {
            setLoadFailed(true)
            setError(reason.message)
          }
        },
      )
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [projectId, revision])
  useEffect(() => {
    setDetail(null)
    setPreviewError('')
    if (!selected) return
    const controller = new AbortController()
    checkpointApi.detail(selected.id, controller.signal).then(
      (result) => {
        if (!controller.signal.aborted) setDetail(result)
      },
      (reason: Error) => {
        if (!controller.signal.aborted) setPreviewError(reason.message)
      },
    )
    return () => controller.abort()
  }, [selected, previewRevision])
  const save = async () => {
    if (!canSave || !name.trim() || saving) return
    const controller = new AbortController()
    saveController.current = controller
    const sourceEngine = engine
    // 点击这一刻的 Snapshot 同时冻结时钟与 DeleteSet；重试不会换成更旧的屏障。
    const body = {
      name: name.trim(),
      expectedSnapshot: base64(Y.encodeSnapshot(Y.snapshot(sourceEngine.doc.ydoc))),
    }
    setSaving(true)
    setWaiting(false)
    setError('')
    try {
      const saved = await saveSynchronizedCheckpoint({
        canvasId: canvasId!,
        body,
        signal: controller.signal,
        connected: () => useCanvas.getState().sync === 'connected',
        current: () =>
          useCanvas.getState().canvasId === canvasId &&
          useCanvas.getState().engine === sourceEngine,
        onWaiting: () => setWaiting(true),
      })
      if (controller.signal.aborted) return
      setName('')
      setRevision((n) => n + 1)
      setSelected(saved)
      useCanvas.getState().notify(`已保存检查点：${saved.name}`)
    } catch (reason) {
      if (!controller.signal.aborted) setError((reason as Error).message)
    } finally {
      if (!controller.signal.aborted) {
        setSaving(false)
        setWaiting(false)
      }
      if (saveController.current === controller) saveController.current = null
    }
  }
  const cancelSave = () => {
    saveController.current?.abort(new DOMException('已取消等待', 'AbortError'))
    saveController.current = null
    setSaving(false)
    setWaiting(false)
  }
  const more = async () => {
    if (!page.nextCursor || loading) return
    setLoading(true)
    try {
      const result = await checkpointApi.list(projectId, page.nextCursor)
      setPage((old) => ({ items: [...old.items, ...result.items], nextCursor: result.nextCursor }))
    } catch (reason) {
      setError((reason as Error).message)
    } finally {
      setLoading(false)
    }
  }
  const restore = async (checkpoint: CanvasCheckpoint) => {
    const visit = useCheckpoints.getState().open
    const source = useCanvas.getState()
    const current = () => {
      const state = useCanvas.getState()
      return (
        !!visit &&
        useCheckpoints.getState().open === visit &&
        visit.projectId === projectId &&
        visit.canvasId === canvasId &&
        state.engine === source.engine &&
        state.canvasId === source.canvasId
      )
    }
    if (working || saving || !current()) return
    setWorking({ id: checkpoint.id, kind: 'restore' })
    setError('')
    try {
      const result = await checkpointApi.restore(checkpoint.id)
      await invalidateProjects()
      if (!current()) return
      close()
      navigate({ name: 'canvas', id: result.canvasId })
      useCanvas.getState().notify(`已从「${checkpoint.name}」创建新画布`)
    } catch (reason) {
      if (current()) setError((reason as Error).message)
    } finally {
      setWorking(null)
    }
  }
  const remove = async (checkpoint: CanvasCheckpoint) => {
    if (working || saving) return
    const accepted = await confirmDialog({
      title: `删除检查点「${checkpoint.name}」？`,
      message: '只删除这份检查点，当前画布和素材文件保留。',
      confirmLabel: '删除检查点',
      danger: true,
    })
    if (!accepted) return
    setWorking({ id: checkpoint.id, kind: 'remove' })
    setError('')
    try {
      await checkpointApi.remove(checkpoint.id)
      if (selected?.id === checkpoint.id) setSelected(null)
      setRevision((n) => n + 1)
    } catch (reason) {
      setError((reason as Error).message)
    } finally {
      setWorking(null)
    }
  }
  return (
    <Modal label="创作检查点" onClose={close} isolateKeys className="h-[min(850px,100%)] max-w-6xl">
      <ModalHeader
        title="创作检查点"
        onClose={close}
        meta={<span className="ui-tag">项目内保存 · 随项目包迁移</span>}
      >
        <button
          type="button"
          className="ui-btn ui-btn-secondary"
          disabled={loading || saving}
          onClick={() => setRevision((n) => n + 1)}
        >
          <Icon name="retry" />
          刷新
        </button>
      </ModalHeader>
      {canSave && (
        <form
          className="flex flex-wrap items-center gap-2 border-b border-line px-5 py-3"
          onSubmit={(event) => {
            event.preventDefault()
            void save()
          }}
        >
          <label className="flex min-w-48 flex-1 items-center gap-2 text-sm">
            <span className="flex-none">检查点名称</span>
            <input
              aria-label="检查点名称"
              value={name}
              maxLength={100}
              disabled={saving}
              onChange={(event) => setName(event.target.value)}
              placeholder="例如：分镜审核通过"
              className="ui-input w-full"
            />
          </label>
          <button type="submit" className="ui-btn ui-btn-primary" disabled={saving || !name.trim()}>
            {saving ? (waiting ? '等待同步…' : '保存中…') : '保存当前画布'}
          </button>
          {saving && (
            <button type="button" className="ui-btn ui-btn-secondary" onClick={cancelSave}>
              取消等待
            </button>
          )}
          {waiting && (
            <p role="status" className="w-full text-xs text-ink-subtle">
              正在等待本机编辑同步，连接恢复后继续保存。
            </p>
          )}
        </form>
      )}
      {error && (
        <p role="alert" className="px-5 py-3 text-sm text-danger">
          {error}
        </p>
      )}
      {working?.kind === 'restore' && (
        <p role="status" className="px-5 py-3 text-sm text-ink-muted">
          正在恢复为新画布…关闭窗口后仍会继续执行。
        </p>
      )}
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <div
          className={`ui-scrollbar min-h-0 overflow-y-auto p-4 ${selected ? 'max-md:max-h-36 max-md:flex-none md:w-80 md:flex-none md:border-r md:border-line' : 'flex-1'}`}
          aria-busy={loading}
        >
          {!page.items.length ? (
            <EmptyState
              icon="history"
              title={
                loading ? '正在读取检查点…' : loadFailed ? '检查点读取失败' : '还没有命名检查点'
              }
              hint={
                loadFailed
                  ? '恢复连接或服务后，点击上方刷新。'
                  : canSave
                    ? '给当前画布保存一个名字，之后可以恢复为独立新画布。'
                    : '打开画布后可以保存检查点。'
              }
            />
          ) : (
            <div
              className={`grid gap-3 ${selected ? 'grid-cols-1' : 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3'}`}
            >
              {page.items.map((checkpoint) => (
                <article
                  key={checkpoint.id}
                  className={`rounded-xl border p-3 ${selected?.id === checkpoint.id ? 'border-accent bg-surface-2' : 'border-line'}`}
                >
                  <h3 className="break-words font-medium">{checkpoint.name}</h3>
                  <p className="mt-1 text-xs text-ink-subtle">
                    {fullTime(checkpoint.createdAt)}
                    <br />
                    {checkpoint.sourceCanvasTitle}
                    {!checkpoint.sourceCanvasId ? ' · 来源画布已删除' : ''}
                    <br />
                    {checkpoint.assets} 个素材
                    {checkpoint.missingAssets.length
                      ? ` · ${checkpoint.missingAssets.length} 个缺失`
                      : ''}
                  </p>
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    <button
                      type="button"
                      className="ui-btn ui-btn-sm ui-btn-secondary"
                      disabled={selected?.id === checkpoint.id && !detail && !previewError}
                      onClick={() => {
                        if (selected?.id === checkpoint.id) setPreviewRevision((n) => n + 1)
                        else setSelected(checkpoint)
                      }}
                    >
                      只读预览
                    </button>
                    <button
                      type="button"
                      className="ui-btn ui-btn-sm ui-btn-secondary"
                      disabled={!!working || saving}
                      onClick={() => void restore(checkpoint)}
                    >
                      {working?.kind === 'restore' && working.id === checkpoint.id
                        ? '恢复中…'
                        : '恢复为新画布'}
                    </button>
                    <button
                      type="button"
                      aria-label={`删除检查点 ${checkpoint.name}`}
                      className="ui-btn ui-btn-sm ui-btn-quiet ui-icon-btn hover:text-danger"
                      disabled={!!working || saving}
                      onClick={() => void remove(checkpoint)}
                    >
                      <Icon name="trash" size={14} />
                    </button>
                  </div>
                </article>
              ))}
            </div>
          )}
          {page.nextCursor && (
            <button
              type="button"
              className="ui-btn ui-btn-secondary mx-auto mt-4"
              disabled={loading}
              onClick={() => void more()}
            >
              加载更多检查点
            </button>
          )}
        </div>
        {selected && (
          <section
            className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 p-4"
            aria-label={`预览检查点 ${selected.name}`}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="min-w-0 flex-1 truncate font-medium max-sm:basis-full">
                {selected.name}
              </h3>
              <button
                type="button"
                className="ui-btn ui-btn-sm ui-btn-secondary"
                disabled={!detail && !previewError}
                onClick={() => setPreviewRevision((n) => n + 1)}
              >
                <Icon name="retry" size={14} />
                重新加载预览
              </button>
              <button
                type="button"
                className="ui-btn ui-btn-sm ui-btn-quiet"
                onClick={() => setSelected(null)}
              >
                关闭预览
              </button>
            </div>
            {detail ? (
              <CheckpointPreview state={detail.state} />
            ) : (
              <p
                role={previewError ? 'alert' : 'status'}
                className={previewError ? 'text-sm text-danger' : 'text-sm text-ink-subtle'}
              >
                {previewError || '正在读取预览…'}
              </p>
            )}
            {detail?.missingAssets.length ? (
              <p className="text-xs text-warning">
                {detail.missingAssets.length} 个素材在本机缺失，预览保留原有引用。
              </p>
            ) : null}
            <p className="text-xs text-ink-subtle">
              恢复会创建新画布，保留素材和候选，不会启动生成任务。
            </p>
          </section>
        )}
      </div>
    </Modal>
  )
}
