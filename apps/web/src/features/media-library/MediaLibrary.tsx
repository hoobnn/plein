import type { CanvasElement } from '@plein/doc'
import {
  MEDIA_SEARCH_MAX_LENGTH,
  type MediaLibraryItem,
  type MediaLibraryPage,
  type MediaSource,
  type Project,
} from '@plein/protocol'
import {
  type CSSProperties,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { api, ApiError, assetUrls } from '../../api/client'
import { elementFor } from '../../canvas/import'
import { placeElement } from '../../canvas/nodes'
import { navigate } from '../../router'
import { useCanvas } from '../../stores/canvas'
import { EmptyState } from '../../ui/EmptyState'
import { bytes, fullTime } from '../../ui/format'
import { Icon } from '../../ui/icons'
import { Modal, ModalHeader } from '../../ui/Modal'
import { Presence, useClosing } from '../../ui/Presence'
import { Select } from '../../ui/Select'
import { useLibrary } from '../library/store'
import { mediaApi } from './client'
import { useMediaLibrary } from './store'

function invalidCursor(reason: unknown) {
  return reason instanceof ApiError && reason.status === 400 && reason.code === 'invalid'
}

function referencesAsset(node: CanvasElement, assetId: string) {
  const contains = (value: unknown): boolean =>
    typeof value === 'string'
      ? value === assetId
      : Array.isArray(value)
        ? value.some(contains)
        : !!value && typeof value === 'object' && Object.values(value).some(contains)
  return (
    node.assetId === assetId ||
    node.results?.some((result) => 'assetId' in result.value && result.value.assetId === assetId) ||
    node.deliveries?.some((delivery) => delivery.assetId === assetId) ||
    contains(node.params)
  )
}

export function MediaLibraryPanel() {
  const open = useMediaLibrary((s) => s.open),
    target = useMediaLibrary((s) => s.target)
  const engine = useCanvas((s) => s.engine),
    canvasId = useCanvas((s) => s.canvasId),
    sync = useCanvas((s) => s.sync)
  useEffect(() => {
    if (!target?.canvasId || target.canvasId !== canvasId || !engine || sync !== 'connected') return
    const node = target.nodeId ? engine.doc.get(target.nodeId) : undefined
    if (!node) useCanvas.getState().notify('来源节点已不在画布上')
    else if (!referencesAsset(node, target.assetId))
      useCanvas.getState().notify('来源节点已不再引用此素材，未执行定位')
    else {
      engine.selection.set([node.id])
      engine.zoomToFit([node.id])
    }
    useMediaLibrary.getState().locate(null)
  }, [target, engine, canvasId, sync])
  return (
    <Presence>
      {open && <Panel key={open.projectId ?? 'all'} projectId={open.projectId} />}
    </Presence>
  )
}

function Panel({ projectId: initialProject }: { projectId?: string }) {
  const close = () => useMediaLibrary.getState().close()
  const [projectId, setProjectId] = useState(initialProject ?? '')
  const [projects, setProjects] = useState<Project[]>([])
  // query 保留组词草稿，searchQuery 只包含已确认的搜索内容。
  const [kind, setKind] = useState(''),
    [query, setQuery] = useState(''),
    [searchQuery, setSearchQuery] = useState(''),
    [debounced, setDebounced] = useState('')
  const composing = useRef(false)
  const queryTooLong = searchQuery.trim().length > MEDIA_SEARCH_MAX_LENGTH
  const queryProblemId = useId()
  const [page, setPage] = useState<MediaLibraryPage>({ items: [], nextCursor: null })
  const [selected, setSelected] = useState<MediaLibraryItem | null>(null)
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [refresh, setRefresh] = useState(0)
  const [failedMore, setFailedMore] = useState<'retry' | 'restart' | null>(null)
  const request = useRef<AbortController | null>(null)
  const list = useRef<HTMLDivElement>(null)
  const returnTo = useRef<string | null>(null)
  useLayoutEffect(() => {
    const id = returnTo.current
    if (selected || !id) return
    returnTo.current = null
    list.current
      ?.querySelector<HTMLButtonElement>(`[data-media-asset="${CSS.escape(id)}"]`)
      ?.focus({ preventScroll: true })
  }, [selected])
  const engine = useCanvas((s) => s.engine),
    canvasId = useCanvas((s) => s.canvasId)
  const readOnly = useSyncExternalStore(
    useCallback(
      (notify) => {
        if (!engine) return () => {}
        const offState = engine.onStateChange(notify)
        const offDoc = engine.doc.subscribe(notify)
        return () => {
          offState()
          offDoc()
        }
      },
      [engine],
    ),
    () => engine?.doc.readOnly ?? true,
  )
  const [preview, setPreview] = useState<MediaLibraryItem | null>(null)
  const searching = searchQuery.trim() !== debounced
  const visibleItems = searching || queryTooLong ? [] : page.items
  useEffect(() => () => request.current?.abort(), [])
  useEffect(() => {
    const controller = new AbortController()
    api.projects().then(
      (rows) => {
        if (!controller.signal.aborted) setProjects(rows)
      },
      () => {},
    )
    return () => controller.abort()
  }, [])
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(searchQuery.trim()), 250)
    return () => clearTimeout(timer)
  }, [searchQuery])
  useEffect(() => {
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    setBusy(true)
    setError('')
    setFailedMore(null)
    setPage({ items: [], nextCursor: null })
    setSelected(null)
    if (debounced.length > MEDIA_SEARCH_MAX_LENGTH) {
      setBusy(false)
      return () => controller.abort()
    }
    mediaApi
      .list(
        { projectId: projectId || undefined, kind: kind || undefined, q: debounced },
        controller.signal,
      )
      .then(
        (result) => {
          if (!controller.signal.aborted) setPage(result)
        },
        (reason: Error) => {
          if (!controller.signal.aborted) setError(reason.message)
        },
      )
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false)
      })
    return () => controller.abort()
  }, [projectId, kind, debounced, refresh])
  const more = async () => {
    if (!page.nextCursor || busy) return
    const controller = new AbortController()
    request.current = controller
    setBusy(true)
    setError('')
    setFailedMore(null)
    try {
      const result = await mediaApi.list(
        {
          projectId: projectId || undefined,
          kind: kind || undefined,
          q: debounced,
          cursor: page.nextCursor,
        },
        controller.signal,
      )
      if (!controller.signal.aborted)
        setPage((old) => ({
          items: [...old.items, ...result.items],
          nextCursor: result.nextCursor,
        }))
    } catch (reason) {
      if (!controller.signal.aborted) {
        const restart = invalidCursor(reason)
        setFailedMore(restart ? 'restart' : 'retry')
        if (restart) setPage((old) => ({ ...old, nextCursor: null }))
        setError((reason as Error).message)
      }
    } finally {
      if (!controller.signal.aborted) setBusy(false)
    }
  }
  const place = (asset: MediaLibraryItem) => {
    if (!engine || !canvasId || engine.doc.readOnly) return
    const input = elementFor(asset)
    if (!input) return
    const view = engine.camera.viewRect
    const id = placeElement(engine, input, {
      x: view.x + view.w / 2,
      y: view.y + view.h / 2,
    })
    engine.selection.set([id])
    close()
    engine.zoomToFit([id])
    useCanvas.getState().notify(`已放入画布：${asset.name}`)
  }
  return (
    <>
      <Modal label="素材" onClose={close} isolateKeys className="h-[min(840px,100%)] max-w-6xl">
        <ModalHeader
          title="素材"
          onClose={close}
          meta={<span className="ui-tag">跨画布与项目复用</span>}
        >
          <button
            type="button"
            className="ui-btn ui-btn-secondary"
            onClick={() => setRefresh((n) => n + 1)}
            disabled={busy || searching || queryTooLong}
          >
            <Icon name="retry" />
            刷新
          </button>
        </ModalHeader>
        <div className="flex flex-wrap gap-2 border-b border-line px-5 py-3">
          <label className="home-search flex-1">
            <Icon name="search" />
            <input
              type="search"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value)
                if (!composing.current && !(event.nativeEvent as InputEvent).isComposing)
                  setSearchQuery(event.target.value)
              }}
              onCompositionStart={() => {
                composing.current = true
              }}
              onCompositionEnd={(event) => {
                composing.current = false
                setQuery(event.currentTarget.value)
                setSearchQuery(event.currentTarget.value)
              }}
              onBlur={(event) => {
                if (!composing.current) return
                composing.current = false
                setQuery(event.currentTarget.value)
                setSearchQuery(event.currentTarget.value)
              }}
              placeholder="搜索素材名称或来源"
              aria-label="搜索素材"
              aria-invalid={queryTooLong}
              aria-describedby={queryTooLong ? queryProblemId : undefined}
            />
          </label>
          <Select
            aria-label="关联项目"
            value={projectId}
            onChange={setProjectId}
            options={[
              { value: '', label: '全部项目' },
              ...projects.map((p) => ({ value: p.id, label: p.title })),
            ]}
            className="w-48"
          />
          <Select
            aria-label="素材类型"
            value={kind}
            onChange={setKind}
            options={[
              { value: '', label: '全部类型' },
              { value: 'image', label: '图片' },
              { value: 'video', label: '视频' },
              { value: 'audio', label: '音频' },
            ]}
            className="w-28"
          />
        </div>
        {queryTooLong && (
          <p
            id={queryProblemId}
            role="alert"
            className="border-b border-line px-5 py-2 text-xs text-danger"
          >
            搜索内容最多 {MEDIA_SEARCH_MAX_LENGTH} 个字符，修改后会自动重新搜索。
          </p>
        )}
        {error && !queryTooLong && (
          <div role="alert" className="px-5 py-3 text-sm text-danger">
            {error}
            <button
              type="button"
              className="ui-btn ui-btn-sm ui-btn-quiet ml-2"
              disabled={busy || searching}
              onClick={() => {
                if (failedMore === 'retry') void more()
                else setRefresh((n) => n + 1)
              }}
            >
              {failedMore === 'restart' ? '重新读取素材' : '重试'}
            </button>
          </div>
        )}
        <div className="flex min-h-0 flex-1">
          <div
            ref={list}
            className={`ui-scrollbar min-w-0 flex-1 overflow-y-auto p-5 ${selected && !queryTooLong ? 'hidden md:block' : ''}`}
            aria-busy={busy || searching}
          >
            {!visibleItems.length ? (
              <EmptyState
                icon={queryTooLong ? 'search' : 'library'}
                title={
                  queryTooLong
                    ? '搜索内容过长'
                    : busy || searching
                      ? '正在读取素材…'
                      : error
                        ? '素材读取失败'
                        : '没有找到素材'
                }
                hint={
                  queryTooLong
                    ? '修改后会自动重新搜索。'
                    : busy || searching
                      ? undefined
                      : error
                        ? '可以点击上方重试，或调整筛选后重新读取。'
                        : '可以调整筛选；导入和生成的图片、视频、音频都会在这里。'
                }
              />
            ) : (
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
                {visibleItems.map((asset) => (
                  <button
                    type="button"
                    key={asset.id}
                    data-media-asset={asset.id}
                    aria-label={`查看素材 ${asset.name}`}
                    aria-pressed={selected?.id === asset.id}
                    onClick={() => setSelected(asset)}
                    className={`overflow-hidden rounded-xl border bg-surface-2 text-left transition-colors ${selected?.id === asset.id ? 'border-accent' : 'border-line hover:border-ink-subtle'}`}
                  >
                    <div className="flex aspect-video items-center justify-center overflow-hidden bg-canvas">
                      {asset.kind === 'audio' ? (
                        <Icon name="audio" size={24} />
                      ) : (
                        <MediaImage
                          src={assetUrls.variant(
                            asset.id,
                            asset.kind === 'video' ? 'poster' : 'thumb-256',
                          )}
                          alt=""
                          className="h-full w-full object-contain"
                        />
                      )}
                    </div>
                    <div className="p-3">
                      <span className="block truncate text-sm font-medium">{asset.name}</span>
                      <span className="mt-1 block truncate text-xs text-ink-subtle">
                        {bytes(asset.size)} ·{' '}
                        {asset.sourceCount ? `${asset.sourceCount} 处来源` : '未关联到现存项目'}
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            )}
            {page.nextCursor && !searching && (
              <button
                type="button"
                className="ui-btn ui-btn-secondary mx-auto mt-5"
                onClick={() => void more()}
                disabled={busy}
              >
                {busy ? '读取中…' : '加载更多素材'}
              </button>
            )}
          </div>
          {selected && !queryTooLong && (
            <div className="ui-scrollbar w-full min-w-0 flex-none overflow-y-auto border-line p-4 md:w-80 md:border-l">
              <button
                type="button"
                className="ui-btn ui-btn-secondary mb-3 md:hidden"
                onClick={() => {
                  returnTo.current = selected.id
                  setSelected(null)
                }}
              >
                <Icon name="chevronLeft" />
                返回素材列表
              </button>
              <MediaDetail
                key={selected.id}
                asset={selected}
                onPreview={() => setPreview(selected)}
                onPlace={() => place(selected)}
                placeDisabledReason={
                  !engine || !canvasId
                    ? '打开一张画布后可以放入'
                    : readOnly
                      ? '当前画布为只读，不能放入素材'
                      : undefined
                }
                onClose={close}
              />
            </div>
          )}
        </div>
      </Modal>
      <Presence>
        {preview && (
          <MediaPreview key={preview.id} asset={preview} onClose={() => setPreview(null)} />
        )}
      </Presence>
    </>
  )
}

/** 同名来源只有目的地不同时才需要额外标识，避免正常来源列表堆满 ID。 */
function sourceHint(source: MediaSource, sources: MediaSource[]) {
  if (!source.locatable || !source.canvasId || !source.nodeId) return ''
  const peers = sources.filter((item) => item.locatable && item.label === source.label)
  if (!peers.some((item) => item.canvasId !== source.canvasId || item.nodeId !== source.nodeId))
    return ''
  const suffix = (id: string, key: 'canvasId' | 'nodeId') => {
    let size = 6
    while (
      peers.some(
        (item) => item[key] && item[key] !== id && item[key]!.slice(-size) === id.slice(-size),
      )
    )
      size++
    return id.slice(-size)
  }
  return `画布 ${suffix(source.canvasId, 'canvasId')} · 元素 ${suffix(source.nodeId, 'nodeId')}`
}

function MediaDetail({
  asset,
  onPreview,
  onPlace,
  placeDisabledReason,
  onClose,
}: {
  asset: MediaLibraryItem
  onPreview(): void
  onPlace(): void
  placeDisabledReason?: string
  onClose(): void
}) {
  const [sources, setSources] = useState<MediaSource[]>(asset.sources),
    [cursor, setCursor] = useState<string | null>(null),
    [error, setError] = useState('')
  const placeReasonId = useId()
  const [category, setCategory] = useState('character')
  const [busy, setBusy] = useState(true)
  const [retryCursor, setRetryCursor] = useState<string | undefined>()
  const [restart, setRestart] = useState(false)
  const request = useRef<AbortController | null>(null)
  const load = useCallback(
    async (next?: string) => {
      if (request.current) return
      const controller = new AbortController()
      request.current = controller
      setBusy(true)
      setError('')
      setRestart(false)
      setRetryCursor(next)
      try {
        const result = await mediaApi.sources(asset.id, next, controller.signal)
        if (!controller.signal.aborted) {
          setSources((old) => (next ? [...old, ...result.items] : result.items))
          setCursor(result.nextCursor)
        }
      } catch (reason) {
        if (!controller.signal.aborted) {
          if (next && invalidCursor(reason)) {
            setRetryCursor(undefined)
            setCursor(null)
            setRestart(true)
            setError('来源分页无效，请重新读取来源。')
          } else setError((reason as Error).message)
        }
      } finally {
        if (request.current === controller) {
          request.current = null
          if (!controller.signal.aborted) setBusy(false)
        }
      }
    },
    [asset.id],
  )
  useEffect(() => {
    void load()
    return () => {
      request.current?.abort()
      request.current = null
    }
  }, [load])
  const locate = (source: MediaSource) => {
    if (!source.locatable || !source.canvasId || !source.nodeId) return
    useMediaLibrary
      .getState()
      .locate({ canvasId: source.canvasId, nodeId: source.nodeId, assetId: asset.id })
    if (useCanvas.getState().canvasId !== source.canvasId)
      navigate({ name: 'canvas', id: source.canvasId })
  }
  const save = () => {
    if (asset.kind === 'audio') return
    onClose()
    useLibrary
      .getState()
      .show(
        asset.kind === 'video'
          ? 'effect'
          : (category as 'character' | 'scene' | 'prop' | 'style' | 'effect'),
        {
          name: asset.name,
          images: asset.kind === 'image' ? [asset.id] : [],
          videos: asset.kind === 'video' ? [asset.id] : [],
        },
      )
  }
  return (
    <div className="flex flex-col gap-4">
      <h3 className="break-words text-base font-medium">{asset.name}</h3>
      {asset.kind === 'audio' ? (
        <MediaPlayer asset={asset} className="w-full" />
      ) : (
        <button
          type="button"
          aria-label="放大查看素材"
          onClick={onPreview}
          className="overflow-hidden rounded-lg bg-canvas"
        >
          <MediaImage
            src={assetUrls.variant(asset.id, asset.kind === 'video' ? 'poster' : 'thumb-1024')}
            alt={asset.name}
            className="max-h-52 w-full object-contain"
          />
        </button>
      )}
      <p className="text-xs text-ink-subtle">
        {bytes(asset.size)}
        {asset.width && asset.height ? ` · ${asset.width} × ${asset.height}` : ''}
        {asset.duration ? ` · ${asset.duration.toFixed(1)} 秒` : ''}
        <br />
        {fullTime(asset.createdAt)}
      </p>
      <button
        type="button"
        className="ui-btn ui-btn-primary"
        disabled={!!placeDisabledReason}
        title={placeDisabledReason}
        aria-describedby={placeDisabledReason ? placeReasonId : undefined}
        onClick={onPlace}
      >
        放入当前画布
      </button>
      {placeDisabledReason && (
        <p id={placeReasonId} role="status" className="text-xs text-ink-subtle">
          {placeDisabledReason}
        </p>
      )}
      {asset.kind !== 'audio' && (
        <div className="flex flex-col gap-2">
          {asset.kind === 'image' && (
            <Select
              aria-label="存为资产类别"
              value={category}
              onChange={setCategory}
              options={[
                { value: 'character', label: '角色' },
                { value: 'scene', label: '场景' },
                { value: 'prop', label: '道具' },
                { value: 'style', label: '风格' },
                { value: 'effect', label: '特效' },
              ]}
            />
          )}
          <button type="button" className="ui-btn ui-btn-secondary" onClick={save}>
            存入资产库
          </button>
        </div>
      )}
      <section className="flex flex-col gap-2">
        <h4 className="ui-section-title">来源</h4>
        {busy && (
          <p role="status" className="text-xs text-ink-subtle">
            正在读取来源…
          </p>
        )}
        {sources.length ? (
          <div role="list" aria-label="素材来源" className="flex flex-col gap-2">
            {sources.map((source) => {
              const hint = sourceHint(source, sources)
              return (
                <div
                  role="listitem"
                  aria-label={hint ? `${source.label} · ${hint}` : source.label}
                  key={`${source.type}/${source.id}/${source.locator}`}
                  className="rounded-lg bg-surface-2 p-2.5 text-xs"
                >
                  <span className="block break-words">
                    {source.type === 'checkpoint'
                      ? '检查点 · '
                      : source.type === 'library'
                        ? '资产库 · '
                        : ''}
                    {source.label}
                  </span>
                  {hint && (
                    <span
                      className="mt-1 block break-words text-ink-subtle"
                      title={`画布 ${source.canvasId} · 元素 ${source.nodeId}`}
                    >
                      {hint}
                    </span>
                  )}
                  <span className="mt-1 flex items-center gap-2 text-ink-subtle">
                    {source.adopted && <span>采用中</span>}
                    {source.locatable ? (
                      <button
                        type="button"
                        className="ui-btn ui-btn-xs ui-btn-quiet"
                        onClick={() => locate(source)}
                      >
                        定位来源
                      </button>
                    ) : (
                      <span>
                        {source.type === 'job'
                          ? '来源节点已删除'
                          : source.type === 'checkpoint'
                            ? '保存在检查点'
                            : '素材引用'}
                      </span>
                    )}
                  </span>
                </div>
              )
            })}
          </div>
        ) : !busy && !error ? (
          <p className="text-xs text-ink-subtle">未关联到现存项目，文件仍可复用。</p>
        ) : null}
        {cursor && (
          <button
            type="button"
            aria-label="更多来源"
            className="ui-btn ui-btn-sm ui-btn-secondary"
            disabled={busy}
            onClick={() => void load(cursor ?? undefined)}
          >
            {busy ? '读取中…' : '更多来源'}
          </button>
        )}
        {error && (
          <div role="alert" className="flex flex-col items-start gap-2 text-xs text-danger">
            <p>{error}</p>
            <button
              type="button"
              className="ui-btn ui-btn-sm ui-btn-secondary"
              disabled={busy}
              onClick={() => void load(retryCursor)}
            >
              {restart ? '重新读取来源' : '重试来源'}
            </button>
          </div>
        )}
      </section>
    </div>
  )
}

function MediaPreview({ asset, onClose }: { asset: MediaLibraryItem; onClose(): void }) {
  const [scale, setScale] = useState(1)
  return (
    <Modal
      label="素材预览"
      onClose={onClose}
      top
      isolateKeys
      className="h-[min(860px,100%)] max-w-6xl"
    >
      <ModalHeader title={asset.name} onClose={onClose}>
        {asset.kind === 'image' && (
          <>
            <button
              type="button"
              className="ui-btn ui-btn-secondary"
              aria-label="缩小"
              onClick={() => setScale((s) => Math.max(0.5, s - 0.25))}
            >
              −
            </button>
            <span className="text-xs tabular-nums">{Math.round(scale * 100)}%</span>
            <button
              type="button"
              className="ui-btn ui-btn-secondary"
              aria-label="放大"
              onClick={() => setScale((s) => Math.min(8, s + 0.25))}
            >
              +
            </button>
          </>
        )}
      </ModalHeader>
      <div
        role="region"
        aria-label="素材预览区域"
        // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- 滚动预览区需要接收原生方向键。
        tabIndex={0}
        className="ui-scrollbar flex min-h-0 flex-1 overflow-auto bg-canvas p-4 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
      >
        {asset.kind === 'video' ? (
          <MediaPlayer asset={asset} className="m-auto max-h-full max-w-full" />
        ) : (
          <MediaImage
            src={assetUrls.original(asset.id)}
            alt={asset.name}
            retry
            style={{ width: `${scale * 100}%`, maxWidth: 'none' }}
            className="m-auto flex-none object-contain"
          />
        )}
      </div>
    </Modal>
  )
}

/** 缩略图失败不妨碍打开原文件；原图失败时提供显式重试，避免空白预览。 */
function MediaImage({
  src,
  alt,
  className,
  style,
  retry = false,
}: {
  src: string
  alt: string
  className: string
  style?: CSSProperties
  retry?: boolean
}) {
  const [failed, setFailed] = useState(false)
  if (failed)
    return (
      <MediaFailure
        icon="image"
        label={retry ? '素材加载失败' : '缩略图暂不可用'}
        onRetry={retry ? () => setFailed(false) : undefined}
      />
    )
  return (
    <img
      src={src}
      alt={alt}
      loading="lazy"
      className={className}
      style={style}
      onError={() => setFailed(true)}
    />
  )
}

function MediaPlayer({ asset, className }: { asset: MediaLibraryItem; className: string }) {
  const [failed, setFailed] = useState(false)
  const ref = useRef<HTMLMediaElement | null>(null)
  const closing = useClosing()
  useLayoutEffect(() => {
    const media = ref.current
    if (closing) media?.pause()
    // StrictMode 保留 DOM 重放布局 effect，清理后需恢复当前来源。
    else if (media && !media.getAttribute('src')) media.src = assetUrls.original(asset.id)
    return () => {
      media?.pause()
      media?.removeAttribute('src')
      media?.load()
    }
  }, [asset.id, failed, closing])
  const video = asset.kind === 'video'
  if (failed)
    return (
      <MediaFailure
        icon={video ? 'video' : 'audio'}
        label={video ? '视频加载失败' : '音频加载失败'}
        onRetry={() => {
          if (!closing) setFailed(false)
        }}
      />
    )
  const props = {
    'aria-label': `${asset.name || '未命名素材'} ${video ? '视频' : '音频'}播放器`,
    ref: (media: HTMLMediaElement | null) => {
      ref.current = media
    },
    src: assetUrls.original(asset.id),
    controls: true,
    preload: 'metadata',
    className: video ? `${className} w-full object-contain` : className,
    onError: () => setFailed(true),
  } as const
  // oxlint-disable jsx-a11y/media-has-caption -- 用户素材没有可用字幕轨
  return video ? <video {...props} autoPlay={!closing} /> : <audio {...props} />
  // oxlint-enable jsx-a11y/media-has-caption
}

function MediaFailure({
  icon,
  label,
  onRetry,
}: {
  icon: 'image' | 'video' | 'audio'
  label: string
  onRetry?: () => void
}) {
  return (
    <span
      role={onRetry ? 'alert' : undefined}
      className="flex min-h-24 w-full flex-col items-center justify-center gap-2 p-3 text-sm text-ink-subtle"
    >
      <Icon name={icon} size={24} />
      <span>{label}</span>
      {onRetry && (
        <button type="button" className="ui-btn ui-btn-sm ui-btn-secondary" onClick={onRetry}>
          重试加载
        </button>
      )}
    </span>
  )
}
