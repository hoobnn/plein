import {
  CHARACTER_IMAGE_SLOTS,
  LIBRARY_KINDS,
  type LibraryKindSpec,
  libraryKind,
  OFFICIAL_LIBRARY,
  type OfficialLibraryItem,
  orderedImages,
  normalizeLibraryImages,
  profileEmpty,
  profileSize,
} from '@plein/nodes'
import type { LibraryItem, LibraryKind } from '@plein/protocol'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { assetUrls } from '../../api/client'
import { type CanvasMedia, canvasMedia, coverOf, placeInputOf, type PlaceInput } from './canvas'
import { useCanvas } from '../../stores/canvas'
import { type LibrarySeed, useLibrary } from './store'
import { confirmDialog, dialogOpen } from '../../ui/Dialog'
import { EmptyState } from '../../ui/EmptyState'
import { Icon, type IconName } from '../../ui/icons'
import { Modal, ModalHeader } from '../../ui/Modal'
import { Presence } from '../../ui/Presence'
import { Segmented } from '../../ui/Segmented'
import { Select } from '../../ui/Select'
import { SlideSwap } from '../../ui/Slide'
import { morphView } from '../../ui/viewTransition'
import { KIND_ICONS } from './LibraryAdd'
import { SlotField, thumb, VideoField } from './LibraryFields'
import {
  ExpressionsTab,
  type HeroControl,
  PeriodsTab,
  ProfileImageScope,
  ProfileUploadContext,
} from './LibraryProfile'
import { VoicePicker } from '../../ui/VoicePicker'
import { LibraryUpdatesPanel } from './LibraryUpdates'
import { CharacterAssets } from './CharacterAssets'
import { LibraryReadStatus } from './LibraryReadStatus'
import { useLibraryPlacement } from './useLibraryPlacement'
import { listFocusTarget } from './listFocus'
import { settleSavedDraft } from './savedDraft'
import { createdEditing, draftOf, editorKeyOf, type Draft, type Editing } from './editorDraft'

/**
 * 资产库面板：
 * 按类别浏览、筛选、收藏，编辑设定与图片槽位，一键放到当前画布上。
 * 没有打开画布时（首页）只能管理，不能放到画布上。
 */

type Scope = 'project' | 'mine' | 'official' | 'favorite' | 'recent'

const SCOPES: Record<'asset' | 'preset', Array<{ id: Scope; label: string }>> = {
  // 角色 / 场景 / 道具：没有官方条目，按项目分
  asset: [
    { id: 'project', label: '本项目' },
    { id: 'mine', label: '全部' },
    { id: 'favorite', label: '收藏' },
    { id: 'recent', label: '最近使用' },
  ],
  // 风格 / 特效：有内置的官方条目
  preset: [
    { id: 'official', label: '官方' },
    { id: 'mine', label: '我的' },
    { id: 'favorite', label: '收藏' },
    { id: 'recent', label: '最近使用' },
  ],
}

const hasOfficial = (kind: LibraryKind) => OFFICIAL_LIBRARY.some((o) => o.kind === kind)

export function LibraryPanel() {
  const open = useLibrary((s) => s.open)
  return <Presence>{open && <Panel kind={open} />}</Presence>
}

function Panel({ kind: kindId }: { kind: LibraryKind }) {
  const { items, loaded, loading, error, projectId, show, load } = useLibrary()
  const engine = useCanvas((s) => s.engine)
  const open = useLibrary((s) => s.open)
  const placement = useLibraryPlacement(engine, open)
  const canvasId = useCanvas((s) => s.canvasId)
  // 只有打开了远端画布时才能放到画布上
  const canPlace = !!engine && !!canvasId && !engine.doc.readOnly
  const kind = libraryKind(kindId)!
  const preset = hasOfficial(kindId)
  const [scope, setScope] = useState<Scope>(preset ? 'official' : projectId ? 'project' : 'mine')
  const [query, setQuery] = useState('')
  const [tags, setTags] = useState<Record<string, string>>({})
  const [editing, setEditing] = useState<Editing | null>(null)
  const [uploadPending, setUploadPending] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const returnFocus = useRef<string | null | undefined>(undefined)
  const focusedCard = useRef<{ id: string; index: number } | null>(null)
  const close = () => {
    if (!uploadPending) show(null)
  }
  const seed = useLibrary((s) => s.seed)
  const context = useRef({ kindId, projectId })
  const parkFocus = () =>
    document
      .querySelector<HTMLElement>('[role="dialog"][aria-label="资产库"]')
      ?.focus({ preventScroll: true })

  // 换类别时重置筛选；从画布带来的新建内容跟着换到新类别，方便选错了类别再改
  useEffect(() => {
    // 初次挂载的状态已按当前类别初始化；StrictMode 重放 effect 时也不清掉已接手的编辑目标。
    if (context.current.kindId === kindId && context.current.projectId === projectId) return
    context.current = { kindId, projectId }
    setScope(hasOfficial(kindId) ? 'official' : projectId ? 'project' : 'mine')
    setTags({})
    setQuery('')
    setEditing((e) => (e?.type === 'new' && e.seed ? e : null))
  }, [kindId, projectId])

  // 画布上「存入资产库」：直接进预填好的新建表单
  useEffect(() => {
    if (!seed) return
    const taken = useLibrary.getState().takeSeed()
    if (taken) setEditing({ type: 'new', seed: taken })
  }, [seed])

  // 从画布上的角色卡点「编辑档案」：直接打开那一条
  const focus = useLibrary((s) => s.focus)
  useEffect(() => {
    if (!focus) return
    const id = useLibrary.getState().takeFocus()
    if (id) setEditing({ type: 'item', id })
  }, [focus])

  /** 卡片封面长成档案大图 */
  const openItem = (id: string, cover: HTMLElement | null) => {
    parkFocus()
    morphView(
      () => setEditing({ type: 'item', id }),
      cover,
      () => document.querySelector('.lib-hero'),
    )
  }
  /** 返回列表：大图缩回它的卡片 */
  const back = () => {
    if (uploadPending) return
    parkFocus()
    const id =
      editing?.type === 'item' ? editing.id : editing?.type === 'official' ? editing.item.id : null
    returnFocus.current = id
    morphView(
      () => setEditing(null),
      document.querySelector('.lib-hero'),
      () => (id ? document.querySelector(`[data-lib-cover="${id}"]`) : null),
    )
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && e.isComposing) {
        e.stopPropagation()
        return
      }
      // 确认框、弹层（下拉框、从画布选）开着时 Esc 归它们
      if (
        e.key !== 'Escape' ||
        e.defaultPrevented ||
        dialogOpen() ||
        document.querySelector('.ui-menu')
      )
        return
      if (e.target instanceof HTMLElement && e.target.closest('[data-library-escape]')) return
      e.stopPropagation()
      if (editing) back()
      else close()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })

  const q = query.trim().toLowerCase()
  const matches = (name: string, description: string, t: Record<string, string>) =>
    (!q || name.toLowerCase().includes(q) || description.toLowerCase().includes(q)) &&
    Object.entries(tags).every(([k, v]) => !v || t[k] === v)

  const mine = items.filter((i) => i.kind === kindId && matches(i.name, i.description, i.tags))
  const shown: Array<LibraryItem | OfficialLibraryItem> =
    scope === 'official'
      ? OFFICIAL_LIBRARY.filter((o) => o.kind === kindId && matches(o.name, o.description, o.tags))
      : scope === 'project'
        ? mine.filter((i) => i.projectId === projectId)
        : scope === 'favorite'
          ? mine.filter((i) => i.favorite)
          : scope === 'recent'
            ? mine.filter((i) => i.usedAt).sort((a, b) => (b.usedAt ?? 0) - (a.usedAt ?? 0))
            : mine

  const place = async (input: PlaceInput) => {
    const r = await placement.place(input)
    if (r?.id) close()
  }

  const shownKey = shown.map((item) => item.id).join(',')
  useLayoutEffect(() => {
    if (editing || open !== kindId) return
    const cards = [...(listRef.current?.querySelectorAll<HTMLElement>('[data-library-id]') ?? [])]
    const id = listFocusTarget(
      cards.map((card) => card.dataset.libraryId!),
      returnFocus.current,
      focusedCard.current,
      document.activeElement === document.body,
    )
    returnFocus.current = undefined
    if (id !== undefined) {
      const target = cards.find((card) => card.dataset.libraryId === id)
      ;(target?.querySelector('button') ?? searchRef.current)?.focus()
    }
  }, [editing, shownKey, open, kindId])

  const scopes = SCOPES[preset ? 'preset' : 'asset'].filter((s) => s.id !== 'project' || projectId)
  const slideIndex =
    LIBRARY_KINDS.findIndex((k) => k.id === kindId) * 10 + scopes.findIndex((s) => s.id === scope)

  const editingItem = editing?.type === 'item' ? items.find((i) => i.id === editing.id) : undefined

  // 「从画布选」的候选：打开着画布时取画布上的图片和视频
  const media = useMemo(() => (canPlace && engine ? canvasMedia(engine) : []), [canPlace, engine])

  return (
    <Modal label="资产库" onClose={close} isolateKeys top className="h-[min(860px,100%)] max-w-6xl">
      <ModalHeader
        title="资产库"
        onClose={close}
        closeDisabled={uploadPending}
        meta={
          <fieldset disabled={uploadPending} className="contents">
            <Segmented
              label="资产类别"
              size="lg"
              options={LIBRARY_KINDS.map((k) => ({
                value: k.id,
                label: k.title,
                icon: KIND_ICONS[k.id],
              }))}
              value={kindId}
              onChange={show}
            />
          </fieldset>
        }
      >
        {!editing && (
          <>
            <label className="home-search w-48">
              <Icon name="search" />
              <input
                ref={searchRef}
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={`搜索${kind.title}`}
                aria-label={`搜索${kind.title}`}
              />
            </label>
            <button
              type="button"
              onClick={() => {
                parkFocus()
                setEditing({ type: 'new' })
              }}
              className="ui-btn ui-btn-primary"
            >
              <Icon name="plus" />
              新建{kind.title}
            </button>
          </>
        )}
      </ModalHeader>
      {placement.error && (
        <p role="alert" className="mx-5 my-3 rounded-lg bg-danger/5 px-3 py-2 text-sm text-danger">
          {placement.error}。请重试放入。
        </p>
      )}
      {editing ? (
        <Editor
          key={editorKeyOf(kindId, editing)}
          kind={kind}
          item={editingItem}
          official={editing.type === 'official' ? editing.item : undefined}
          seed={editing.type === 'new' ? editing.seed : undefined}
          media={media}
          projectId={projectId}
          canPlace={canPlace}
          placing={placement.placing}
          onBack={back}
          onUploadPendingChange={setUploadPending}
          onCreated={(id) => {
            setEditing(createdEditing(editing, id))
          }}
          onPlace={place}
        />
      ) : (
        <>
          <div className="flex flex-none flex-wrap items-center gap-2 border-b border-line px-5 py-3">
            <Segmented
              label="范围"
              options={scopes.map((s) => ({ value: s.id, label: s.label }))}
              value={scope}
              onChange={setScope}
            />
            {kind.tags.map((t) => (
              <Select
                key={t.id}
                aria-label={t.label}
                value={tags[t.id] ?? ''}
                options={[{ value: '', label: t.label }, ...t.options.map((v) => ({ value: v }))]}
                onChange={(v) => setTags({ ...tags, [t.id]: v })}
                className="w-28"
              />
            ))}
          </div>
          <div className="ui-scrollbar min-h-0 flex-1 overflow-x-hidden overflow-y-auto p-5">
            {/* 换类别或范围时内容按切换方向滑入 */}
            <SlideSwap index={slideIndex}>
              {scope === 'official' && (
                <p className="mb-4 text-xs text-ink-subtle">
                  官方{kind.title}只包含提示词，不带模型或
                  LoRA；放到画布上后可以连参考图加强约束，效果取决于所选模型。
                </p>
              )}
              {scope !== 'official' && (
                <LibraryReadStatus loaded={loaded} loading={loading} error={error} load={load} />
              )}
              {!loaded && scope !== 'official' ? null : shown.length === 0 ? (
                scope !== 'official' && (loading || error) ? null : (
                  <Empty
                    kind={kind}
                    scope={scope}
                    onCreate={() => {
                      parkFocus()
                      setEditing({ type: 'new' })
                    }}
                  />
                )
              ) : (
                <ul
                  ref={listRef}
                  onFocusCapture={(event) => {
                    const card = (event.target as HTMLElement).closest<HTMLElement>(
                      '[data-library-id]',
                    )
                    if (card)
                      focusedCard.current = {
                        id: card.dataset.libraryId!,
                        index: [...event.currentTarget.children].indexOf(card),
                      }
                  }}
                  className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5"
                >
                  {shown.map((it) =>
                    'favorite' in it ? (
                      <Card
                        key={it.id}
                        kind={kind}
                        item={it}
                        canPlace={canPlace}
                        placing={placement.isPlacing(placeInputOf(it)!)}
                        onOpen={(cover) => openItem(it.id, cover)}
                        onPlace={() => {
                          const input = placeInputOf(it)
                          if (input) void place(input)
                        }}
                      />
                    ) : (
                      <OfficialCard
                        key={it.id}
                        item={it}
                        canPlace={canPlace}
                        placing={placement.isPlacing({
                          kind,
                          name: it.name,
                          description: it.description,
                        })}
                        onOpen={() => {
                          parkFocus()
                          setEditing({ type: 'official', item: it })
                        }}
                        onPlace={() =>
                          void place({ kind, name: it.name, description: it.description })
                        }
                      />
                    ),
                  )}
                </ul>
              )}
            </SlideSwap>
          </div>
        </>
      )}
    </Modal>
  )
}

function Empty({
  kind,
  scope,
  onCreate,
}: {
  kind: LibraryKindSpec
  scope: Scope
  onCreate(): void
}) {
  const text =
    scope === 'favorite'
      ? `还没有收藏的${kind.title}`
      : scope === 'recent'
        ? `还没有用过的${kind.title}`
        : scope === 'project'
          ? `这个项目还没有${kind.title}`
          : `还没有${kind.title}`
  return (
    <EmptyState
      icon="library"
      title={text}
      hint={`${kind.description}。也可以在画布上选中图片${kind.video ? '或视频' : ''}，点工具条上的「存入资产库」。`}
      action={
        <button type="button" onClick={onCreate} className="ui-btn ui-btn-secondary">
          <Icon name="plus" />
          新建{kind.title}
        </button>
      }
    />
  )
}

function tagLine(kind: LibraryKindSpec, tags: Record<string, string>) {
  return kind.tags
    .map((t) => tags[t.id])
    .filter(Boolean)
    .join(' · ')
}

function Card({
  kind,
  item,
  canPlace,
  placing,
  onOpen,
  onPlace,
}: {
  kind: LibraryKindSpec
  item: LibraryItem
  canPlace: boolean
  placing: boolean
  onOpen(cover: HTMLElement | null): void
  onPlace(): void
}) {
  const cover = coverOf(item, kind)
  const update = useLibrary((s) => s.update)
  const favoritePending = useRef(false)
  const favoriteLive = useRef(false)
  const [favoriteBusy, setFavoriteBusy] = useState(false)
  const [favoriteError, setFavoriteError] = useState<string | null>(null)
  useEffect(() => {
    favoriteLive.current = true
    return () => {
      favoriteLive.current = false
    }
  }, [])
  const toggleFavorite = async () => {
    if (favoritePending.current) return
    favoritePending.current = true
    setFavoriteBusy(true)
    setFavoriteError(null)
    try {
      await update(item.id, { favorite: !item.favorite })
    } catch (error) {
      if (favoriteLive.current) setFavoriteError(`收藏未更改：${(error as Error).message}`)
    } finally {
      favoritePending.current = false
      if (favoriteLive.current) setFavoriteBusy(false)
    }
  }
  const coverRef = useRef<HTMLDivElement>(null)
  const profile = item.profile ? profileSize(item.profile) : null
  // 悬停时从底部升起：一行一个时期，后面跟着这个时期的服饰
  const peek = item.profile ? profilePeek(item.profile) : []
  const characterImages = kind.id === 'character' ? normalizeLibraryImages(kind, item.images) : []
  const imageKinds = CHARACTER_IMAGE_SLOTS.filter((slot) =>
    characterImages.some((image) => image.slot === slot.id),
  ).length
  return (
    <li data-library-id={item.id} className="home-card lib-card group relative">
      <div className="relative">
        <button
          type="button"
          onClick={() => onOpen(coverRef.current)}
          className="lib-card-open block w-full text-left"
        >
          <div
            ref={coverRef}
            data-lib-cover={item.id}
            data-kind={kind.id}
            className="lib-card-cover"
          >
            {cover ? (
              <img src={cover} alt="" loading="lazy" draggable={false} />
            ) : (
              <span className="line-clamp-6 px-4 text-xs text-ink-subtle">
                {item.description || '没有参考图'}
              </span>
            )}
            {peek.length > 0 && (
              <span className="lib-card-peek" aria-hidden="true">
                {peek.map((row, r) => (
                  <span key={row.id} className="lib-card-peek-row">
                    <span
                      className="lib-card-peek-period"
                      style={{ '--i': r * 4 } as React.CSSProperties}
                    >
                      {row.image ? (
                        <img src={thumb(row.image)} alt="" loading="lazy" draggable={false} />
                      ) : (
                        <Icon name="period" size={12} />
                      )}
                      <span className="truncate">{row.name}</span>
                    </span>
                    {row.outfits.map((id, i) => (
                      <img
                        key={id}
                        src={thumb(id)}
                        alt=""
                        loading="lazy"
                        draggable={false}
                        style={{ '--i': r * 4 + i + 1 } as React.CSSProperties}
                      />
                    ))}
                    {row.more > 0 && (
                      <span
                        className="lib-card-peek-more"
                        style={{ '--i': r * 4 + 4 } as React.CSSProperties}
                      >
                        +{row.more}
                      </span>
                    )}
                  </span>
                ))}
              </span>
            )}
          </div>
          <div className="px-3 pt-2.5 pb-3">
            <div className="truncate text-sm font-medium">{item.name}</div>
            <div className="truncate text-xs text-ink-subtle">
              {item.profile && profile && (profile.periods || profile.expressions)
                ? profileLine(item.profile, profile)
                : tagLine(kind, item.tags) || `${item.images.length} 张参考图`}
            </div>
          </div>
        </button>
        {kind.id === 'character' && (
          <span className="ui-badge lib-card-completeness" title="已添加的角色图片类型">
            {imageKinds} / 4 形象
          </span>
        )}
        <button
          type="button"
          aria-label={item.favorite ? '取消收藏' : '收藏'}
          aria-pressed={item.favorite}
          title={item.favorite ? '取消收藏' : '收藏'}
          disabled={favoriteBusy}
          aria-busy={favoriteBusy || undefined}
          onClick={() => void toggleFavorite()}
          className={`ui-btn ui-btn-quiet ui-btn-sm ui-icon-btn absolute top-2 right-2 bg-float ${
            item.favorite
              ? 'text-warning'
              : 'opacity-0 group-focus-within:opacity-100 group-hover:opacity-100'
          }`}
        >
          <Icon name="star" size={14} />
        </button>
        {canPlace && (
          <button
            type="button"
            onClick={onPlace}
            disabled={placing}
            className="ui-btn ui-btn-primary ui-btn-sm lib-card-place absolute bottom-16 left-1/2"
          >
            {placing ? '正在放入…' : '添加到画布'}
          </button>
        )}
      </div>
      {favoriteError && (
        <p role="alert" className="mx-3 mb-3 rounded-lg bg-danger/5 px-2 py-2 text-xs text-danger">
          {favoriteError}。点击星标重试。
        </p>
      )}
    </li>
  )
}

/** 卡片底部一行：「少年 3 套 · 青年 2 套 · 8 表情」，一眼看出服饰挂在哪个时期 */
function profileLine(p: NonNullable<LibraryItem['profile']>, n: ReturnType<typeof profileSize>) {
  return [
    ...p.periods.map((x) => (x.outfits.length ? `${x.name} ${x.outfits.length} 套` : x.name)),
    n.expressions && `${n.expressions} 表情`,
  ]
    .filter(Boolean)
    .join(' · ')
}

/** 悬停预览：最多 3 个时期，每个时期带服饰首图，一行放不下 3 张时末格换成「+N」 */
function profilePeek(p: NonNullable<LibraryItem['profile']>) {
  return p.periods.slice(0, 3).map((x) => {
    const outfits = x.outfits.flatMap((o) => o.images.slice(0, 1))
    const shown = outfits.length > 3 ? 2 : 3
    return {
      id: x.id,
      name: x.name,
      image: x.images[0] ?? null,
      outfits: outfits.slice(0, shown),
      more: Math.max(0, x.outfits.length - shown),
    }
  })
}

function OfficialCard({
  item,
  canPlace,
  placing,
  onOpen,
  onPlace,
}: {
  item: OfficialLibraryItem
  canPlace: boolean
  placing: boolean
  onOpen(): void
  onPlace(): void
}) {
  return (
    <li data-library-id={item.id} className="home-card lib-card group relative">
      <button type="button" onClick={onOpen} className="lib-card-open block w-full text-left">
        <div className="plein-thumb flex aspect-[4/3] flex-col justify-end gap-1 p-3">
          <span className="ui-chip self-start">{Object.values(item.tags)[0]}</span>
          <span className="line-clamp-3 text-xs text-ink-muted">{item.description}</span>
        </div>
        <div className="px-3 pt-2.5 pb-3">
          <div className="truncate text-sm font-medium">{item.name}</div>
          <div className="truncate text-xs text-ink-subtle">官方 · 提示词</div>
        </div>
      </button>
      {canPlace && (
        <button
          type="button"
          onClick={onPlace}
          disabled={placing}
          className="ui-btn ui-btn-primary ui-btn-sm lib-card-place absolute bottom-16 left-1/2"
        >
          {placing ? '正在放入…' : '添加到画布'}
        </button>
      )}
    </li>
  )
}

/** 角色编辑页的分页 */
type Tab = 'assets' | 'basics' | 'periods' | 'expressions'

/**
 * 条目编辑（档案式）：左边一张大图，悬停或选中任何一张图时交叉淡入成它；
 * 右边是设定，角色多两页「时期」「表情」。官方条目只读，可以复制成自己的。
 */
function Editor({
  kind,
  item,
  official,
  seed,
  media,
  projectId,
  canPlace,
  placing,
  onBack,
  onCreated,
  onPlace,
  onUploadPendingChange,
}: {
  kind: LibraryKindSpec
  item?: LibraryItem
  official?: OfficialLibraryItem
  seed?: LibrarySeed
  media: CanvasMedia[]
  projectId: string | null
  canPlace: boolean
  placing: boolean
  onBack(): void
  onCreated(id: string): void
  onPlace(input: PlaceInput): Promise<void>
  onUploadPendingChange(pending: boolean): void
}) {
  const lib = useLibrary()
  const readOnly = !!official
  const character = kind.id === 'character'
  const [draft, setDraft] = useState(() => draftOf(kind, item, official, projectId, seed))
  const latestDraft = useRef(draft)
  latestDraft.current = draft
  const [saveNotice, setSaveNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const mutation = useRef(false)
  const lifetime = useRef({ active: true })
  useEffect(() => {
    const session = { active: true }
    lifetime.current = session
    return () => {
      session.active = false
    }
  }, [])
  const [pendingUploads, setPendingUploads] = useState(0)
  const trackUpload = (uploading: boolean) =>
    setPendingUploads((count) => Math.max(0, count + (uploading ? 1 : -1)))
  useEffect(() => {
    onUploadPendingChange(pendingUploads > 0)
    return () => onUploadPendingChange(false)
  }, [pendingUploads, onUploadPendingChange])
  const [referenceRevision, setReferenceRevision] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>(
    () => useLibrary.getState().tab ?? (character ? 'assets' : 'basics'),
  )
  useEffect(() => {
    useLibrary.getState().takeTab()
  }, [])
  const [preview, setPreview] = useState<{ id: string | null; caption?: string } | null>(null)
  const [pin, setPin] = useState<{ id: string | null; caption?: string }>({ id: null })
  const initial = useMemo(
    () => JSON.stringify(draftOf(kind, item, official, projectId)),
    [kind, item, official, projectId],
  )
  const dirty = !readOnly && JSON.stringify(draft) !== initial
  const patch = (p: Partial<Draft>) => setDraft((d) => ({ ...d, ...p }))

  const body = () => ({
    name: draft.name.trim() || kind.title,
    description: draft.description.trim(),
    tags: Object.fromEntries(Object.entries(draft.tags).filter(([, v]) => v)),
    voice: kind.voice && draft.voice.voiceId.trim() ? draft.voice : null,
    images: draft.images,
    video: kind.video ? draft.video : null,
    models: kind.video
      ? draft.models
          .split(/[,，、\n]/)
          .map((m) => m.trim())
          .filter(Boolean)
      : [],
    profile: character && !profileEmpty(draft.profile) ? draft.profile : null,
    projectId: draft.inProject ? (item?.projectId ?? projectId) : null,
  })

  /** 保存并返回条目；官方条目复制一份成自己的。画布上已经放下的这张角色卡跟着同步档案 */
  const beginMutation = () => {
    if (mutation.current || pendingUploads > 0) return null
    mutation.current = true
    setBusy(true)
    setError(null)
    setSaveNotice(null)
    return lifetime.current
  }
  const current = (session: { active: boolean }) =>
    session.active &&
    useLibrary.getState().open === kind.id &&
    useLibrary.getState().projectId === projectId
  const finishMutation = (session: { active: boolean }) => {
    mutation.current = false
    if (session.active) setBusy(false)
  }
  const save = async (placingAfterSave = false): Promise<LibraryItem | null> => {
    const session = beginMutation()
    if (!session) return null
    const submitted = draft
    try {
      const saved = item
        ? dirty
          ? await lib.update(item.id, body())
          : item
        : await lib.create({ kind: kind.id, ...body() })
      if (!current(session)) return null
      const normalized = draftOf(kind, saved, undefined, projectId)
      const outcome = settleSavedDraft(submitted, latestDraft.current, normalized, placingAfterSave)
      setDraft((current) => settleSavedDraft(submitted, current, normalized, false).draft)
      setSaveNotice(outcome.notice)
      if (!item) onCreated(saved.id)
      return outcome.continuePlacement ? saved : null
    } catch (err) {
      if (current(session)) setError((err as Error).message)
      return null
    } finally {
      finishMutation(session)
    }
  }

  const place = async () => {
    if (official && !item) {
      await onPlace({ kind, name: official.name, description: official.description })
      return
    }
    const saved = await save(true)
    const input = saved && placeInputOf(saved)
    if (input) await onPlace(input)
  }

  // 从画布存进来的内容本来就在画布上，新建时不再提供放回画布
  const placeable = canPlace && !(seed && !item)

  const remove = async () => {
    if (!item) return
    const session = beginMutation()
    if (!session) return
    try {
      const ok = await confirmDialog({
        title: `删除${kind.title}「${item.name}」？`,
        message: '只删除资产库里的条目；画布上已经放下的卡片和素材文件保留。',
        confirmLabel: '删除',
        danger: true,
      })
      if (!ok || !current(session)) return
      await lib.remove(item.id)
      if (current(session)) onBack()
    } catch (err) {
      if (current(session)) setError((err as Error).message)
    } finally {
      finishMutation(session)
    }
  }

  const ordered = orderedImages(kind, draft.images)
  const thumbnails = ordered.filter(
    (image, index) => ordered.findIndex((entry) => entry.assetId === image.assetId) === index,
  )
  const cover = ordered[0]?.assetId ?? null
  // 悬停中的图优先，其次是选中项钉住的图，最后是封面；悬停到没有图的项时不换
  const shown = preview?.id ?? pin.id ?? cover
  const caption = preview?.id ? preview.caption : pin.id ? pin.caption : undefined
  const hero: HeroControl = {
    onPreview: (id, c) => setPreview(id ? { id, caption: c } : null),
    onPin: (id, c) => setPin({ id, caption: c }),
  }
  const size = profileSize(draft.profile)
  const tabs: Array<{ value: Tab; label: string; icon: IconName; extra?: number }> = [
    { value: 'assets', label: '角色资产', icon: 'image' },
    { value: 'basics', label: '基础设定', icon: 'character' },
    { value: 'periods', label: '时期与服饰', icon: 'period', extra: size.periods || undefined },
    {
      value: 'expressions',
      label: '表情',
      icon: 'expression',
      extra: size.expressions || undefined,
    },
  ]
  const tabIndex = tabs.findIndex((t) => t.value === tab)
  const slotField = (slot: LibraryKindSpec['slots'][number]) => (
    <SlotField
      key={slot.id}
      slot={slot}
      images={draft.images.filter((i) => i.slot === slot.id)}
      used={draft.images.map((i) => i.assetId)}
      media={media}
      disabled={busy || pendingUploads > 0}
      onBusyChange={trackUpload}
      onAdd={(ids) =>
        patch({
          images: [
            ...(slot.multiple ? draft.images : draft.images.filter((i) => i.slot !== slot.id)),
            ...ids.map((assetId) => ({ slot: slot.id, assetId })),
          ],
        })
      }
      onRemove={(assetId) =>
        patch({
          images: draft.images.filter((i) => !(i.slot === slot.id && i.assetId === assetId)),
        })
      }
    />
  )

  const basics = (
    <div className="flex flex-col gap-4">
      {!character && (
        <label className="ui-field">
          <span className="ui-label">名称</span>
          <input
            className="ui-input"
            value={draft.name}
            readOnly={readOnly}
            maxLength={60}
            placeholder={`${kind.title}名，提示词里用 @名称 引用`}
            onChange={(e) => patch({ name: e.target.value })}
          />
        </label>
      )}
      {kind.tags.length > 0 && (
        <div className="grid grid-cols-2 gap-3">
          {kind.tags.map((t) => (
            <div key={t.id} className="ui-field">
              <span className="ui-label">{t.label}</span>
              {readOnly ? (
                <span className="text-sm">{draft.tags[t.id] || '—'}</span>
              ) : (
                <Select
                  aria-label={t.label}
                  value={draft.tags[t.id] ?? ''}
                  options={[{ value: '', label: '不限' }, ...t.options.map((v) => ({ value: v }))]}
                  onChange={(v) => patch({ tags: { ...draft.tags, [t.id]: v } })}
                />
              )}
            </div>
          ))}
        </div>
      )}
      <label className="ui-field">
        <span className="ui-label">{character ? '基础设定' : kind.descriptionLabel}</span>
        <textarea
          className="ui-input h-32"
          value={draft.description}
          readOnly={readOnly}
          maxLength={4000}
          placeholder={kind.placeholder}
          onChange={(e) => patch({ description: e.target.value })}
        />
        <span className="text-xs text-ink-subtle">
          {character
            ? '各时期共用的部分；时期、服饰、表情里只写不一样的地方，@ 引用时按顺序叠加'
            : '放到画布上就是卡片的「设定」；提示词里 @ 它时会并入提示词'}
        </span>
      </label>
      {kind.voice && (
        <div className="ui-field">
          <span className="ui-label">{character ? '基础音色' : '音色'}</span>
          <VoicePicker value={draft.voice} onChange={(voice) => patch({ voice })} />
          <span className="text-xs text-ink-subtle">
            {character ? '时期没有单独设主音色时用它；' : ''}音色只能在同一家平台的配音模型里使用
          </span>
        </div>
      )}
      {!readOnly && !character && (
        <div className="grid grid-cols-2 gap-4">{kind.slots.map(slotField)}</div>
      )}
      {kind.video && !readOnly && (
        <VideoField
          value={draft.video}
          media={media}
          onChange={(video) => patch({ video })}
          disabled={busy || pendingUploads > 0}
          onBusyChange={trackUpload}
        />
      )}
      {kind.video && (
        <label className="ui-field">
          <span className="ui-label">适配模型</span>
          <input
            className="ui-input"
            value={draft.models}
            readOnly={readOnly}
            placeholder="仅作记录，如：Seedance 2.0，Kling 3.0"
            onChange={(e) => patch({ models: e.target.value })}
          />
        </label>
      )}
      {projectId && !readOnly && (
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={draft.inProject}
            onChange={(e) => patch({ inProject: e.target.checked })}
          />
          归到当前项目（「本项目」里能看到；不勾选则不归属任何项目）
        </label>
      )}
    </div>
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {saveNotice && (
        <p
          role="status"
          className="mx-5 my-3 rounded-lg bg-surface-2 px-3 py-2 text-sm text-ink-subtle"
        >
          {saveNotice}
        </p>
      )}
      {error && (
        <p role="alert" className="mx-5 my-3 rounded-lg bg-danger/5 px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}
      {character && !readOnly && (
        <div className="lib-character-heading">
          <label className="ui-field min-w-0 flex-1">
            <span className="sr-only">名称</span>
            <input
              className="lib-character-name"
              aria-label="名称"
              value={draft.name}
              maxLength={60}
              placeholder="给角色起个名字"
              onChange={(e) => patch({ name: e.target.value })}
            />
          </label>
          <span className="text-xs text-ink-subtle">
            {tagLine(kind, draft.tags) || '创建并复用角色的形象、造型与音色'}
          </span>
        </div>
      )}
      <div className={`ui-scrollbar lib-editor-content ${character ? 'is-character' : ''}`}>
        <aside aria-label="预览" className="lib-hero-col">
          <Hero
            key={referenceRevision}
            kind={kind}
            assetId={readOnly ? null : shown}
            caption={caption}
            name={draft.name.trim() || `新${kind.title}`}
            readOnly={readOnly}
            completeImage={character}
          />
          {!readOnly && thumbnails.length > 1 && (
            <ul className="lib-hero-strip" aria-label="参考图">
              {thumbnails.map((img) => (
                <li key={img.assetId}>
                  <button
                    type="button"
                    aria-label={kind.slots.find((s) => s.id === img.slot)?.label ?? '参考图'}
                    title={kind.slots.find((s) => s.id === img.slot)?.label}
                    aria-pressed={shown === img.assetId}
                    onPointerEnter={() =>
                      setPreview({
                        id: img.assetId,
                        caption: kind.slots.find((s) => s.id === img.slot)?.label,
                      })
                    }
                    onPointerLeave={() => setPreview(null)}
                    onClick={() =>
                      setPin({
                        id: img.assetId,
                        caption: kind.slots.find((s) => s.id === img.slot)?.label,
                      })
                    }
                    className="lib-hero-thumb"
                  >
                    <img src={thumb(img.assetId)} alt="" draggable={false} />
                  </button>
                </li>
              ))}
            </ul>
          )}
          {character && !readOnly && (size.periods > 0 || size.expressions > 0) && (
            <p className="text-xs text-ink-subtle">
              提示词里写{' '}
              <code className="ui-kbd">
                @{draft.name.trim() || kind.title}/
                {draft.profile.periods[0]?.name ?? draft.profile.expressions[0]?.name}
              </code>{' '}
              引用档案里的一项，可以叠加时期、服饰、表情。
            </p>
          )}
        </aside>
        <section aria-label="设定" className="flex min-w-0 flex-col gap-4">
          {character && !readOnly ? (
            <fieldset
              disabled={busy || pendingUploads > 0}
              className="contents"
              aria-label="角色档案编辑"
            >
              <ProfileUploadContext.Provider
                value={{ pending: busy || pendingUploads > 0, onBusyChange: trackUpload }}
              >
                <ProfileImageScope>
                  <div className="lib-profile-tabs flex-none">
                    <Segmented
                      label="档案分页"
                      options={tabs.map((t) => ({
                        value: t.value,
                        label: t.label,
                        icon: t.icon,
                        extra: t.extra,
                      }))}
                      value={tab}
                      onChange={(t) => {
                        setTab(t)
                        setPin({ id: null })
                      }}
                    />
                  </div>
                  <SlideSwap index={tabIndex}>
                    {tab === 'assets' ? (
                      <CharacterAssets
                        images={draft.images}
                        media={media}
                        selected={shown}
                        onSelect={hero.onPin}
                        onChange={(update) => {
                          setDraft((d) => ({ ...d, images: update(d.images) }))
                          setReferenceRevision((revision) => revision + 1)
                        }}
                        busy={busy || pendingUploads > 0}
                        onBusyChange={trackUpload}
                      />
                    ) : tab === 'basics' ? (
                      basics
                    ) : tab === 'periods' ? (
                      <PeriodsTab
                        name={draft.name.trim() || kind.title}
                        profile={draft.profile}
                        onChange={(profile) => patch({ profile })}
                        media={media}
                        hero={hero}
                      />
                    ) : (
                      <ExpressionsTab
                        profile={draft.profile}
                        onChange={(profile) => patch({ profile })}
                        media={media}
                        hero={hero}
                        sheet={null}
                      />
                    )}
                  </SlideSwap>
                </ProfileImageScope>
              </ProfileUploadContext.Provider>
            </fieldset>
          ) : (
            <fieldset disabled={pendingUploads > 0} className="contents" aria-label="资产设定编辑">
              {basics}
            </fieldset>
          )}
          {item && !readOnly && <LibraryUpdatesPanel key={item.id} item={item} />}
        </section>
      </div>
      <footer className="flex flex-none flex-wrap items-center gap-2 border-t border-line px-5 py-3">
        <button
          type="button"
          disabled={busy || pendingUploads > 0}
          onClick={onBack}
          className="ui-btn ui-btn-quiet"
        >
          <Icon name="chevronLeft" />
          返回
        </button>
        {item && (
          <button
            type="button"
            onClick={() => void remove()}
            disabled={busy || pendingUploads > 0}
            className="ui-btn ui-btn-quiet hover:text-danger"
          >
            <Icon name="trash" />
            删除
          </button>
        )}
        <div className="ml-auto flex gap-2">
          {busy && (
            <span role="status" className="self-center text-xs text-ink-subtle">
              正在处理…
            </span>
          )}
          {pendingUploads > 0 && (
            <span role="status" className="self-center text-xs text-ink-subtle">
              {kind.video ? '素材上传中…' : '图片上传中…'}
            </span>
          )}
          {readOnly ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void save()}
              className="ui-btn ui-btn-secondary"
            >
              <Icon name="copy" />
              复制到我的
            </button>
          ) : (
            <button
              type="button"
              disabled={busy || pendingUploads > 0 || (!!item && !dirty)}
              onClick={() => void save()}
              className={`ui-btn ${placeable ? 'ui-btn-secondary' : 'ui-btn-primary'}`}
            >
              {item ? (dirty ? '保存' : '已保存') : '保存'}
            </button>
          )}
          {placeable && (
            <button
              type="button"
              disabled={busy || placing || pendingUploads > 0}
              onClick={() => void place()}
              className="ui-btn ui-btn-primary"
            >
              {placing ? '正在放入…' : readOnly || !dirty ? '添加到画布' : '保存并添加到画布'}
            </button>
          )}
        </div>
      </footer>
    </div>
  )
}

/** 档案大图：换图时新图在旧图上交叉淡入并轻微回缩，底部一行写着现在看的是哪一项 */
function Hero({
  kind,
  assetId,
  caption,
  name,
  readOnly,
  completeImage = false,
}: {
  kind: LibraryKindSpec
  assetId: string | null
  caption?: string
  name: string
  readOnly: boolean
  completeImage?: boolean
}) {
  // 叠两层：下面是上一张，上面是新的一张从透明淡入，换得再快也不闪白
  const [layers, setLayers] = useState<Array<{ id: string | null; key: number }>>([
    { id: assetId, key: 0 },
  ])
  const [failedKey, setFailedKey] = useState(-1)
  const top = layers[layers.length - 1]!
  if (top.id !== assetId) setLayers([top, { id: assetId, key: top.key + 1 }])
  return (
    <div className="lib-hero" data-complete-image={completeImage || undefined}>
      {layers.map((l, i) =>
        l.id ? (
          <img
            key={l.key}
            src={assetUrls.variant(l.id, 'thumb-1024')}
            alt=""
            draggable={false}
            data-enter={i === layers.length - 1 && layers.length > 1 ? '' : undefined}
            onAnimationEnd={() => setLayers((ls) => ls.slice(-1))}
            onError={() => setFailedKey((previous) => Math.max(previous, l.key))}
          />
        ) : (
          <span
            key={l.key}
            data-enter={i === layers.length - 1 && layers.length > 1 ? '' : undefined}
            onAnimationEnd={() => setLayers((ls) => ls.slice(-1))}
            className="lib-hero-empty"
          >
            <Icon name={KIND_ICONS[kind.id]} size={24} />
            {readOnly
              ? `官方${kind.title}只有提示词，复制到「我的」之后可以加参考图`
              : '还没有参考图'}
          </span>
        ),
      )}
      {assetId && failedKey === top.key && (
        <span role="alert" className="lib-hero-empty">
          <Icon name="image" size={24} />
          <span>参考图加载失败</span>
          <button
            type="button"
            className="ui-btn ui-btn-secondary"
            onClick={() => setLayers([{ id: assetId, key: top.key + 1 }])}
          >
            <Icon name="retry" size={14} />
            重新加载参考图
          </button>
        </span>
      )}
      {assetId && (
        <a
          href={assetUrls.original(assetId)}
          target="_blank"
          rel="noreferrer"
          aria-label="查看原图"
          title="查看原图"
          className="ui-btn ui-btn-quiet ui-btn-sm ui-icon-btn lib-hero-original"
        >
          <Icon name="expand" size={14} />
        </a>
      )}
      <div className="lib-hero-caption">
        <span className="truncate text-base font-semibold">{name}</span>
        {caption && <span className="truncate text-xs">{caption}</span>}
      </div>
    </div>
  )
}
