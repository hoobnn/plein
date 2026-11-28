import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  type ExternalAction,
  type ExternalPlatform,
  type ExternalPreview,
  type ExternalRow,
  type ExternalSpace,
  type RemoteMedia,
  ExternalTarget,
} from '@plein/protocol'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { MediaTransfer, transferMedia, PublishMedia, publishMedia } from './MediaTransfer'
import { actionLabel, RowDetails, type ReviewScope, type SourceNavigation } from './NodeComparison'
import { ReviewList, reviewRows } from './ReviewList'
import { ExternalWatchControl } from './ExternalWatch'
import { ExternalSignIn } from './ExternalSignIn'
import { NovelSpacePicker } from './NovelSpacePicker'
import { api } from '../../api/client'
import { Modal, ModalHeader } from '../../ui/Modal'
import { Select } from '../../ui/Select'
import { useOverlayClosing } from '../../ui/motion'
import { useCanvas } from '../../stores/canvas'

const platforms = [
  { value: 'jimeng-canvas', label: '即梦全能画布' },
  { value: 'jimeng-novel', label: '即梦短剧' },
]
export function ExternalCanvasDialog({ canvasId, onClose }: { canvasId: string; onClose(): void }) {
  const storageKey = 'plein.external-canvas.last-target.' + canvasId
  const [{ provider, target }, setDestination] = useState<ExternalTarget>(() => {
    try {
      const saved = ExternalTarget.safeParse(
        JSON.parse(sessionStorage.getItem(storageKey) ?? 'null'),
      )
      if (saved.success) return saved.data
    } catch {
      // A blocked storage API should not prevent choosing a project.
    }
    return { provider: 'jimeng-canvas', target: '' }
  })
  const retryRead = useRef<'spaces' | 'projects' | 'preview'>('preview')
  const [spaces, setSpaces] = useState<ExternalSpace[] | null>(null)
  const [space, setSpace] = useState('')
  const [projects, setProjects] = useState<{ id: string; title: string }[] | null>(null)
  const [preview, setPreview] = useState<ExternalPreview | null>(null)
  const [selected, setSelected] = useState('')
  const [filter, setFilter] = useState('')
  const [navigation, setNavigation] = useState<SourceNavigation | null>(null)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const active = useRef<AbortController | null>(null)
  const closing = useOverlayClosing()
  const cache = useQueryClient()
  useEffect(() => {
    if (closing) active.current?.abort()
  }, [closing])
  useEffect(
    () => () => {
      active.current?.abort()
    },
    [],
  )
  const fieldId = useId()
  const input = useRef<HTMLInputElement>(null)
  const targets = useQuery({
    queryKey: ['external-canvas-targets', canvasId],
    queryFn: ({ signal }) => api.externalCanvasTargets(canvasId, signal),
    retry: false,
  })
  const known = targets.data?.filter((t) => t.provider === provider) ?? []
  const [scope, setScope] = useState<ReviewScope>('all')
  const visible = useMemo(
    () => reviewRows(preview?.rows ?? [], scope, filter),
    [preview, scope, filter],
  )
  const row =
    visible.find((r) => r.rowId === selected) ??
    visible.find((r) => r.state !== 'synced') ??
    visible[0]

  function inspectSource(source: ExternalRow, referenceKey: string, candidate: string) {
    if (!row || !source.remoteId) return
    const origin = {
      rowId: row.rowId,
      title: row.local?.title || row.remote?.title || '无标题',
      filter,
      scope,
      referenceKey,
      candidate,
    }
    setNavigation({ trail: [...(navigation?.trail ?? []), origin], focusKey: '' })
    if (!visible.some((r) => r.rowId === source.rowId)) {
      setScope('all')
      setFilter(source.remoteId)
    }
    setSelected(source.rowId)
  }
  function returnFromSource() {
    const previous = navigation?.trail.at(-1)
    if (!navigation || !previous) return
    setNavigation({
      trail: navigation.trail.slice(0, -1),
      focusKey: previous.referenceKey,
      candidate: previous.candidate,
    })
    setFilter(previous.filter)
    setScope(previous.scope)
    setSelected(previous.rowId)
  }
  function changeTarget(id: string, platform = provider) {
    setNavigation(null)
    setDestination({ provider: platform, target: id })
    setScope('all')
    setPreview(null)
    setSelected('')
    setFilter('')
    setMessage('')
    setError('')
  }

  async function run(
    label: string,
    task: (signal: AbortSignal) => Promise<void>,
    retry: 'spaces' | 'projects' | 'preview' = 'preview',
  ) {
    if (closing || active.current) return
    retryRead.current = retry
    const controller = new AbortController()
    active.current = controller
    setBusy(true)
    setError('')
    setMessage(label)
    try {
      await task(controller.signal)
    } catch (err) {
      if (!controller.signal.aborted) {
        setMessage('')
        setError(err instanceof Error ? err.message : '请求失败，请重新读取')
      }
    } finally {
      if (controller.signal.aborted) setMessage('')
      setBusy(false)
      active.current = null
    }
  }

  async function read(
    ref: ExternalTarget,
    signal: AbortSignal,
    focusRow?: Pick<ExternalRow, 'localId' | 'remoteId'>,
  ) {
    setNavigation(null)
    // Invalidate the previous revision before fetching. A failed refresh must not leave old actions enabled.
    setPreview(null)
    const next = await api.externalCanvasPreview(canvasId, ref, signal)
    signal.throwIfAborted()
    // A new preview can contain another selected resource even if the card text is unchanged.
    void cache.invalidateQueries({
      queryKey: ['external-media', canvasId, ref.provider, next.target],
      exact: true,
      refetchType: 'none',
    })
    if (focusRow) {
      const match = next.rows.find(
        (r) =>
          (r.localId && r.localId === focusRow.localId) ||
          (r.remoteId && r.remoteId === focusRow.remoteId),
      )
      if (match) {
        if (!reviewRows([match], scope, filter).length) {
          setScope('all')
          setFilter('')
        }
        setSelected(match.rowId)
      }
    }
    setPreview(next)
    const destination = { provider: next.provider, target: next.target }
    setDestination(destination)
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(destination))
    } catch {
      // Keep the verified project in this open dialog when storage is unavailable.
    }
    setMessage(next.rows.length ? `共 ${next.rows.length} 个节点` : '两边尚无可同步的节点')
  }
  async function refreshAfter(
    ref: ExternalTarget,
    signal: AbortSignal,
    receipt: string,
    focusRow: Pick<ExternalRow, 'localId' | 'remoteId'> | undefined = row,
  ) {
    signal.throwIfAborted()
    setMessage(receipt + '，正在重新读取…')
    void targets.refetch()
    try {
      await read(ref, signal, focusRow)
    } catch (reason) {
      throw new Error(
        receipt +
          '。读取最新差异失败，请重新读取。' +
          (reason instanceof Error ? reason.message : ''),
      )
    }
    setMessage(receipt)
  }
  function apply(entry: ExternalRow, action: ExternalAction, remoteId?: string) {
    if (!preview) return
    const ref = { provider: preview.provider, target: preview.target }
    void run('正在更新…', async (signal) => {
      setPreview(null)
      await api.externalCanvasApply(canvasId, {
        ...ref,
        rowId: entry.rowId,
        revision: entry.revision,
        action,
        remoteId,
      })
      await refreshAfter(ref, signal, `已完成「${actionLabel(entry, action)}」`)
    })
  }
  function importNew(newRows: ExternalRow[]) {
    if (!preview || !newRows.length) return
    const ref = { provider: preview.provider, target: preview.target }
    void run('正在导入新增节点…', async (signal) => {
      setPreview(null)
      const result = await api.externalCanvasPullNew(canvasId, {
        ...ref,
        rows: newRows.map(({ rowId, revision }) => ({ rowId, revision })),
      })
      const focus = newRows.find((item) => item.rowId === row?.rowId) ?? newRows[0]
      await refreshAfter(ref, signal, `已导入 ${result.imported} 个即梦节点`, focus)
    })
  }
  function transfer(media: RemoteMedia, localAssetId?: string) {
    if (!preview || media.nodeId !== row?.remoteId) return
    const ref = { provider: preview.provider, target: preview.target }
    void run(localAssetId ? '正在替换即梦素材…' : '正在导入即梦素材…', async (signal) => {
      setPreview(null)
      await transferMedia(canvasId, ref, media, localAssetId)
      await refreshAfter(ref, signal, localAssetId ? '已替换即梦素材' : '已将素材导入 Plein')
    })
  }
  function listSpaces() {
    void run(
      '正在读取短剧空间…',
      async (signal) => {
        const list = await api.externalCanvasSpaces(canvasId, provider, signal)
        signal.throwIfAborted()
        setSpaces(list)
        setMessage('')
      },
      'spaces',
    )
  }
  function listProjects(selectedSpace = space) {
    setProjects(null)
    void run(
      '正在读取即梦项目…',
      async (signal) => {
        const list = await api.externalCanvasProjects(
          canvasId,
          { provider, space: selectedSpace || undefined },
          signal,
        )
        signal.throwIfAborted()
        setProjects(list)
        setMessage(
          list.length
            ? ''
            : provider === 'jimeng-novel'
              ? '此空间没有可选项目'
              : '当前账号没有可选项目',
        )
      },
      'projects',
    )
  }

  return (
    <Modal label="即梦画布同步" size="lg" isolateKeys initialFocus={input} onClose={onClose}>
      <ModalHeader title="即梦画布同步" onClose={onClose} />
      <div className="ui-scrollbar min-h-0 overflow-auto">
        <form
          className="space-y-3 p-4 sm:p-5"
          onSubmit={(event) => {
            event.preventDefault()
            if (target.trim())
              void run('正在比对节点…', (signal) =>
                read({ provider, target: target.trim() }, signal),
              )
          }}
        >
          <div className="flex flex-wrap items-end gap-2">
            <div className="space-y-1">
              <label className="block text-xs text-ink-muted" htmlFor={fieldId + '-provider'}>
                创作平台
              </label>
              <Select
                id={fieldId + '-provider'}
                aria-label="创作平台"
                value={provider}
                options={platforms}
                disabled={busy}
                onChange={(value) => {
                  setSpaces(null)
                  setSpace('')
                  setProjects(null)
                  changeTarget('', value as ExternalPlatform)
                }}
              />
            </div>
            <div className="min-w-48 flex-1 space-y-1">
              <label htmlFor={fieldId} className="block text-xs text-ink-muted">
                即梦项目链接或 ID
              </label>
              <input
                id={fieldId}
                ref={input}
                value={target}
                className="ui-input w-full"
                spellCheck={false}
                autoComplete="off"
                placeholder={
                  provider === 'jimeng-canvas'
                    ? '粘贴画布链接或项目 UUID'
                    : '粘贴短剧链接或数字项目 ID'
                }
                maxLength={2048}
                disabled={busy}
                onChange={(event) => changeTarget(event.target.value)}
              />
            </div>
            <button
              type="submit"
              className="ui-btn ui-btn-primary"
              disabled={busy || !target.trim()}
            >
              读取差异
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {preview && (
              <a
                className="ui-btn ui-btn-quiet ui-btn-sm"
                target="_blank"
                rel="noopener noreferrer"
                href={
                  preview.provider === 'jimeng-canvas'
                    ? 'https://jimeng.jianying.com/ai-tool/ai-canvas/' +
                      encodeURIComponent(preview.target)
                    : 'https://jimeng.jianying.com/novel/detail/canvas?projectId=' +
                      encodeURIComponent(preview.target.split('/').at(-1)!)
                }
              >
                打开即梦画布
              </a>
            )}
            <button
              type="button"
              className="ui-btn ui-btn-secondary ui-btn-sm"
              disabled={busy}
              onClick={() => listProjects()}
            >
              我的即梦项目
            </button>
            {provider === 'jimeng-novel' && (
              <NovelSpacePicker
                value={space}
                spaces={spaces}
                disabled={busy}
                onToggle={(open) => {
                  if (open && !spaces) listSpaces()
                  if (!open && retryRead.current === 'spaces') {
                    setError('')
                    setMessage('')
                  }
                }}
                onChange={(next) => {
                  if (next === space) return
                  changeTarget('')
                  setSpace(next)
                  listProjects(next)
                }}
              />
            )}
            {projects && projects.length > 0 && (
              <Select
                value={projects.some((p) => p.id === target) ? target : ''}
                aria-label="我的即梦项目"
                className="max-w-full"
                options={[
                  { value: '', label: '选择项目' },
                  ...projects.map((p) => ({ value: p.id, label: p.title || p.id })),
                ]}
                onChange={changeTarget}
                disabled={busy}
              />
            )}
            {known.length > 0 && (
              <Select
                aria-label="已关联的项目"
                value={known.some((k) => k.target === target) ? target : ''}
                className="max-w-full"
                options={[
                  { value: '', label: '已关联的项目' },
                  ...known.map((k) => ({ value: k.target })),
                ]}
                onChange={changeTarget}
                disabled={busy}
              />
            )}
          </div>
          <ExternalWatchControl
            canvasId={canvasId}
            target={preview ? { provider: preview.provider, target: preview.target } : undefined}
          />
          {preview?.provider === 'jimeng-canvas' && (
            <PublishMedia
              busy={busy}
              onPublish={(localAssetId) => {
                const ref = { provider: preview.provider, target: preview.target }
                void run('正在向即梦传递素材…', async (signal) => {
                  setPreview(null)
                  const receipt = await publishMedia(canvasId, ref, localAssetId)
                  await refreshAfter(ref, signal, `素材已保存到即梦节点 ${receipt.nodeId}`, {
                    localId: null,
                    remoteId: receipt.nodeId,
                  })
                })
              }}
            />
          )}
          {!preview && !busy && !error && (
            <p className="text-xs text-ink-muted">
              选择项目后，可比较两边的节点，导入新内容或传递修改。
            </p>
          )}
          <p role="status" className="text-xs text-ink-muted empty:hidden">
            {message}
          </p>
          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}
          {/需要登录|未登录|请先登录/.test(error) && (
            <ExternalSignIn
              key={JSON.stringify([canvasId, provider, space, target])}
              canvasId={canvasId}
              provider={provider}
              onReady={() => {
                if (retryRead.current === 'spaces') listSpaces()
                else if (retryRead.current === 'projects' || !target.trim()) listProjects()
                else
                  void run('账号已连接，正在比对节点…', (signal) =>
                    read({ provider, target: target.trim() }, signal),
                  )
              }}
            />
          )}
          {targets.isError && (
            <p className="text-xs text-ink-muted">已关联项目暂时无法读取，可手动输入项目链接。</p>
          )}
        </form>
        {preview && preview.rows.length > 0 && (
          <ReviewList
            rows={preview.rows}
            visible={visible}
            row={row}
            filter={filter}
            scope={scope}
            busy={busy}
            onFilter={(value) => {
              setNavigation(null)
              setFilter(value)
            }}
            onScope={(value) => {
              setNavigation(null)
              setScope(value)
            }}
            onSelect={(id) => {
              setNavigation(null)
              setSelected(id)
            }}
            onImport={importNew}
          >
            {row && (
              <RowDetails
                key={row.rowId + row.revision}
                row={row}
                rows={preview.rows}
                busy={busy}
                onApply={apply}
                navigation={navigation}
                onSource={inspectSource}
                onBack={returnFromSource}
                onLocate={(id) => {
                  const active = useCanvas.getState()
                  if (active.canvasId !== canvasId || !active.engine?.doc.has(id)) {
                    setPreview(null)
                    setError('这张卡已离开当前画布，请重新读取差异。')
                    return
                  }
                  active.engine.selection.set([id])
                  active.engine.zoomToFit([id])
                  onClose()
                }}
              >
                {row.remoteId && row.remote && row.kind !== 'text' && (
                  <MediaTransfer
                    canvasId={canvasId}
                    target={preview}
                    nodeId={row.remoteId}
                    busy={busy}
                    onTransfer={transfer}
                  />
                )}
              </RowDetails>
            )}
          </ReviewList>
        )}
      </div>
    </Modal>
  )
}
