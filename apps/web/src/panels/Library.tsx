import { setParam } from '@plein/doc'
import {
  type CharacterProfile,
  emptyProfile,
  LIBRARY_KINDS,
  type LibraryKindSpec,
  libraryKind,
  OFFICIAL_LIBRARY,
  type OfficialLibraryItem,
  orderedImages,
  profileEmpty,
  profileOf,
  profileSize,
  slotImages,
} from '@plein/nodes'
import type { LibraryImage, LibraryItem, LibraryKind } from '@plein/protocol'
import { useEffect, useMemo, useRef, useState } from 'react'
import { assetUrls } from '../api/client'
import {
  type CanvasMedia,
  canvasMedia,
  coverOf,
  findPlacedCard,
  placeInputOf,
  placeLibraryItem,
  type PlaceInput,
} from '../canvas/library'
import { useCanvas } from '../stores/canvas'
import { useCatalog } from '../stores/catalog'
import { type LibrarySeed, useLibrary } from '../stores/library'
import { confirmDialog, dialogOpen } from '../ui/Dialog'
import { EmptyState } from '../ui/EmptyState'
import { Icon, type IconName } from '../ui/icons'
import { Modal, ModalHeader } from '../ui/Modal'
import { Presence } from '../ui/Presence'
import { Segmented } from '../ui/Segmented'
import { Select } from '../ui/Select'
import { SlideSwap } from '../ui/Slide'
import { morphView } from '../ui/viewTransition'
import { KIND_ICONS } from './LibraryAdd'
import { SlotField, thumb, VideoField } from './LibraryFields'
import { ExpressionsTab, type HeroControl, PeriodsTab } from './LibraryProfile'
import { VoicePicker } from './VoicePicker'

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

/** 编辑中的条目：已有条目、官方条目（只读）或新建草稿 */
type Editing =
  | { type: 'item'; id: string }
  | { type: 'official'; item: OfficialLibraryItem }
  | { type: 'new'; seed?: LibrarySeed }

export function LibraryPanel() {
  const open = useLibrary((s) => s.open)
  return <Presence>{open && <Panel kind={open} />}</Presence>
}

function Panel({ kind: kindId }: { kind: LibraryKind }) {
  const { items, loaded, projectId, show } = useLibrary()
  const engine = useCanvas((s) => s.engine)
  const canvasId = useCanvas((s) => s.canvasId)
  // 只有打开了远端画布时才能放到画布上
  const canPlace = !!engine && !!canvasId && !engine.doc.readOnly
  const kind = libraryKind(kindId)!
  const preset = hasOfficial(kindId)
  const [scope, setScope] = useState<Scope>(preset ? 'official' : projectId ? 'project' : 'mine')
  const [query, setQuery] = useState('')
  const [tags, setTags] = useState<Record<string, string>>({})
  const [editing, setEditing] = useState<Editing | null>(null)
  const close = () => show(null)
  const seed = useLibrary((s) => s.seed)

  // 换类别时重置筛选；从画布带来的新建内容跟着换到新类别，方便选错了类别再改
  useEffect(() => {
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
  const openItem = (id: string, cover: HTMLElement | null) =>
    morphView(
      () => setEditing({ type: 'item', id }),
      cover,
      () => document.querySelector('.lib-hero'),
    )
  /** 返回列表：大图缩回它的卡片 */
  const back = () => {
    const id = editing?.type === 'item' ? editing.id : null
    morphView(
      () => setEditing(null),
      document.querySelector('.lib-hero'),
      () => (id ? document.querySelector(`[data-lib-cover="${id}"]`) : null),
    )
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // 确认框、弹层（下拉框、从画布选）开着时 Esc 归它们
      if (e.key !== 'Escape' || dialogOpen() || document.querySelector('.ui-menu')) return
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
    if (!engine) return
    const r = await placeLibraryItem(engine, useCatalog.getState().catalog, input)
    if (input.libraryId && r.id) useLibrary.getState().markUsed(input.libraryId)
    useCanvas.getState().notify(r.notice)
    if (r.id) close()
  }

  const scopes = SCOPES[preset ? 'preset' : 'asset'].filter((s) => s.id !== 'project' || projectId)
  const slideIndex =
    LIBRARY_KINDS.findIndex((k) => k.id === kindId) * 10 + scopes.findIndex((s) => s.id === scope)

  const editingItem = editing?.type === 'item' ? items.find((i) => i.id === editing.id) : undefined
  // 「从画布选」的候选：打开着画布时取画布上的图片和视频
  const media = useMemo(() => (canPlace && engine ? canvasMedia(engine) : []), [canPlace, engine])

  return (
    <Modal label="资产库" onClose={close} isolateKeys top className="h-[min(820px,100%)] max-w-6xl">
      <ModalHeader
        title="资产库"
        onClose={close}
        meta={
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
        }
      >
        {!editing && (
          <>
            <label className="home-search w-48">
              <Icon name="search" />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={`搜索${kind.title}`}
                aria-label={`搜索${kind.title}`}
              />
            </label>
            <button
              type="button"
              onClick={() => setEditing({ type: 'new' })}
              className="ui-btn ui-btn-primary"
            >
              <Icon name="plus" />
              新建{kind.title}
            </button>
          </>
        )}
      </ModalHeader>
      {editing ? (
        <Editor
          key={`${kindId}:${editing.type === 'item' ? editing.id : editing.type}`}
          kind={kind}
          item={editingItem}
          official={editing.type === 'official' ? editing.item : undefined}
          seed={editing.type === 'new' ? editing.seed : undefined}
          media={media}
          projectId={projectId}
          canPlace={canPlace}
          onBack={back}
          onCreated={(id) => setEditing({ type: 'item', id })}
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
              {!loaded && scope !== 'official' ? null : shown.length === 0 ? (
                <Empty kind={kind} scope={scope} onCreate={() => setEditing({ type: 'new' })} />
              ) : (
                <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
                  {shown.map((it) =>
                    'favorite' in it ? (
                      <Card
                        key={it.id}
                        kind={kind}
                        item={it}
                        canPlace={canPlace}
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
                        onOpen={() => setEditing({ type: 'official', item: it })}
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
  onOpen,
  onPlace,
}: {
  kind: LibraryKindSpec
  item: LibraryItem
  canPlace: boolean
  onOpen(cover: HTMLElement | null): void
  onPlace(): void
}) {
  const cover = coverOf(item, kind)
  const update = useLibrary((s) => s.update)
  const coverRef = useRef<HTMLDivElement>(null)
  const profile = item.profile ? profileSize(item.profile) : null
  // 悬停时从底部升起的一排小图：各时期、服饰的首图
  const peek = item.profile ? profilePeek(item.profile) : []
  return (
    <li className="home-card lib-card group relative">
      <button
        type="button"
        onClick={() => onOpen(coverRef.current)}
        className="block w-full text-left"
      >
        <div ref={coverRef} data-lib-cover={item.id} className="lib-card-cover">
          {cover ? (
            <img src={cover} alt="" loading="lazy" draggable={false} />
          ) : (
            <span className="line-clamp-6 px-4 text-xs text-ink-subtle">
              {item.description || '没有参考图'}
            </span>
          )}
          {peek.length > 0 && (
            <span className="lib-card-peek" aria-hidden="true">
              {peek.map((id, i) => (
                <img
                  key={id}
                  src={thumb(id)}
                  alt=""
                  loading="lazy"
                  draggable={false}
                  style={{ '--i': i } as React.CSSProperties}
                />
              ))}
            </span>
          )}
        </div>
        <div className="px-3 pt-2.5 pb-3">
          <div className="truncate text-sm font-medium">{item.name}</div>
          <div className="truncate text-xs text-ink-subtle">
            {profile && (profile.periods || profile.expressions)
              ? profileLine(profile)
              : tagLine(kind, item.tags) || `${item.images.length} 张参考图`}
          </div>
        </div>
      </button>
      <button
        type="button"
        aria-label={item.favorite ? '取消收藏' : '收藏'}
        aria-pressed={item.favorite}
        title={item.favorite ? '取消收藏' : '收藏'}
        onClick={() =>
          update(item.id, { favorite: !item.favorite }).catch((err) =>
            useCanvas.getState().notify(`收藏没改成：${(err as Error).message}`),
          )
        }
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
          className="ui-btn ui-btn-primary ui-btn-sm lib-card-place absolute bottom-16 left-1/2"
        >
          添加到画布
        </button>
      )}
    </li>
  )
}

/** 卡片底部一行：「3 时期 · 5 服饰 · 8 表情」 */
function profileLine(n: ReturnType<typeof profileSize>) {
  return [
    n.periods && `${n.periods} 时期`,
    n.outfits && `${n.outfits} 服饰`,
    n.expressions && `${n.expressions} 表情`,
  ]
    .filter(Boolean)
    .join(' · ')
}

/** 悬停预览的小图：各时期首图在前，再是服饰、表情，最多 4 张 */
function profilePeek(p: NonNullable<LibraryItem['profile']>) {
  const ids = [
    ...p.periods.flatMap((x) => x.images.slice(0, 1)),
    ...p.periods.flatMap((x) => x.outfits.flatMap((o) => o.images.slice(0, 1))),
    ...p.expressions.flatMap((e) => e.images.slice(0, 1)),
  ]
  return [...new Set(ids)].slice(0, 4)
}

function OfficialCard({
  item,
  canPlace,
  onOpen,
  onPlace,
}: {
  item: OfficialLibraryItem
  canPlace: boolean
  onOpen(): void
  onPlace(): void
}) {
  return (
    <li className="home-card lib-card group relative">
      <button type="button" onClick={onOpen} className="block w-full text-left">
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
          className="ui-btn ui-btn-primary ui-btn-sm lib-card-place absolute bottom-16 left-1/2"
        >
          添加到画布
        </button>
      )}
    </li>
  )
}

interface Draft {
  name: string
  description: string
  tags: Record<string, string>
  voice: { provider: string; voiceId: string }
  images: LibraryImage[]
  video: string | null
  models: string
  profile: CharacterProfile
  /** 归属当前项目 */
  inProject: boolean
}

function draftOf(
  kind: LibraryKindSpec,
  item: LibraryItem | undefined,
  official: OfficialLibraryItem | undefined,
  projectId: string | null,
  seed?: LibrarySeed,
): Draft {
  return {
    name: item?.name ?? official?.name ?? seed?.name?.replace(/\.[a-z0-9]{2,5}$/i, '') ?? '',
    description: item?.description ?? official?.description ?? '',
    tags: { ...(item?.tags ?? official?.tags) },
    voice: item?.voice ?? { provider: '', voiceId: '' },
    images: item?.images ?? (seed ? slotImages(kind, seed.images) : []),
    video: item?.video ?? (kind.video ? (seed?.videos[0] ?? null) : null),
    models: (item?.models ?? official?.models ?? []).join('，'),
    profile: profileOf(item?.profile),
    // 新建的角色 / 场景 / 道具默认归到当前项目；风格、特效默认全局
    inProject: item ? item.projectId !== null : !!projectId && !kind.video && kind.id !== 'style',
  }
}

/** 角色编辑页的分页 */
type Tab = 'basics' | 'periods' | 'expressions'

/** 情绪九宫格是表情的总览图，放到「表情」页，不在「设定」页的槽位里重复出现 */
const SHEET_SLOT = 'emotions'

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
  onBack,
  onCreated,
  onPlace,
}: {
  kind: LibraryKindSpec
  item?: LibraryItem
  official?: OfficialLibraryItem
  seed?: LibrarySeed
  media: CanvasMedia[]
  projectId: string | null
  canPlace: boolean
  onBack(): void
  onCreated(id: string): void
  onPlace(input: PlaceInput): Promise<void>
}) {
  const lib = useLibrary()
  const readOnly = !!official
  const character = kind.id === 'character'
  const [draft, setDraft] = useState(() => draftOf(kind, item, official, projectId, seed))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>(() => useLibrary.getState().takeTab() ?? 'basics')
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
  const save = async (): Promise<LibraryItem | null> => {
    setBusy(true)
    setError(null)
    try {
      const saved = item
        ? dirty
          ? await lib.update(item.id, body())
          : item
        : await lib.create({ kind: kind.id, ...body() })
      if (!item) onCreated(saved.id)
      if (character) syncPlacedProfile(saved)
      return saved
    } catch (err) {
      setError((err as Error).message)
      return null
    } finally {
      setBusy(false)
    }
  }

  const place = async () => {
    if (official && !item) {
      await onPlace({ kind, name: official.name, description: official.description })
      return
    }
    const saved = await save()
    const input = saved && placeInputOf(saved)
    if (input) await onPlace(input)
  }

  // 从画布存进来的内容本来就在画布上，新建时不再提供放回画布
  const placeable = canPlace && !(seed && !item)

  const remove = async () => {
    if (!item) return
    const ok = await confirmDialog({
      title: `删除${kind.title}「${item.name}」？`,
      message: '只删除资产库里的条目；画布上已经放下的卡片和素材文件保留。',
      confirmLabel: '删除',
      danger: true,
    })
    if (!ok) return
    try {
      await lib.remove(item.id)
    } catch (err) {
      setError((err as Error).message)
      return
    }
    onBack()
  }

  const ordered = orderedImages(kind, draft.images)
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
    { value: 'basics', label: '设定', icon: 'character' },
    { value: 'periods', label: '时期', icon: 'period', extra: size.periods || undefined },
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
      {!readOnly && (
        <div className="grid grid-cols-2 gap-4">
          {kind.slots.filter((s) => !character || s.id !== SHEET_SLOT).map(slotField)}
        </div>
      )}
      {kind.video && !readOnly && (
        <VideoField value={draft.video} media={media} onChange={(video) => patch({ video })} />
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

  const sheet = kind.slots.find((s) => s.id === SHEET_SLOT)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="ui-scrollbar grid min-h-0 flex-1 gap-6 overflow-y-auto p-5 md:grid-cols-[minmax(0,340px)_minmax(0,1fr)]">
        <aside aria-label="预览" className="lib-hero-col">
          <Hero
            kind={kind}
            assetId={readOnly ? null : shown}
            caption={caption}
            name={draft.name.trim() || `新${kind.title}`}
            readOnly={readOnly}
          />
          {!readOnly && ordered.length > 1 && (
            <ul className="lib-hero-strip" aria-label="参考图">
              {ordered.map((img) => (
                <li key={`${img.slot}:${img.assetId}`}>
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
            <>
              <div className="flex-none">
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
                {tab === 'basics' ? (
                  basics
                ) : tab === 'periods' ? (
                  <PeriodsTab
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
                    sheet={sheet ? slotField(sheet) : null}
                  />
                )}
              </SlideSwap>
            </>
          ) : (
            basics
          )}
          {error && <p className="text-sm text-danger">{error}</p>}
        </section>
      </div>
      <footer className="flex flex-none flex-wrap items-center gap-2 border-t border-line px-5 py-3">
        <button type="button" onClick={onBack} className="ui-btn ui-btn-quiet">
          <Icon name="chevronLeft" />
          返回
        </button>
        {item && (
          <button
            type="button"
            onClick={() => void remove()}
            className="ui-btn ui-btn-quiet hover:text-danger"
          >
            <Icon name="trash" />
            删除
          </button>
        )}
        <div className="ml-auto flex gap-2">
          {readOnly ? (
            <button
              type="button"
              disabled={busy}
              onClick={async () => {
                const created = await lib
                  .create({ kind: kind.id, ...body() })
                  .catch((err: Error) => {
                    setError(err.message)
                    return null
                  })
                if (created) onCreated(created.id)
              }}
              className="ui-btn ui-btn-secondary"
            >
              <Icon name="copy" />
              复制到我的
            </button>
          ) : (
            <button
              type="button"
              disabled={busy || (!!item && !dirty)}
              onClick={() => void save()}
              className={`ui-btn ${placeable ? 'ui-btn-secondary' : 'ui-btn-primary'}`}
            >
              {item ? (dirty ? '保存' : '已保存') : '保存'}
            </button>
          )}
          {placeable && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void place()}
              className="ui-btn ui-btn-primary"
            >
              {readOnly || !dirty ? '添加到画布' : '保存并添加到画布'}
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
}: {
  kind: LibraryKindSpec
  assetId: string | null
  caption?: string
  name: string
  readOnly: boolean
}) {
  // 叠两层：下面是上一张，上面是新的一张从透明淡入，换得再快也不闪白
  const [layers, setLayers] = useState<Array<{ id: string | null; key: number }>>([
    { id: assetId, key: 0 },
  ])
  const top = layers[layers.length - 1]!
  if (top.id !== assetId) setLayers([top, { id: assetId, key: top.key + 1 }])
  return (
    <div className="lib-hero">
      {layers.map((l, i) =>
        l.id ? (
          <img
            key={l.key}
            src={assetUrls.variant(l.id, 'thumb-1024')}
            alt=""
            draggable={false}
            data-enter={i === layers.length - 1 && layers.length > 1 ? '' : undefined}
            onAnimationEnd={() => setLayers((ls) => ls.slice(-1))}
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
      <div className="lib-hero-caption">
        <span className="truncate text-base font-semibold">{name}</span>
        {caption && <span className="truncate text-xs">{caption}</span>}
      </div>
    </div>
  )
}

/** 资产库里改了档案：当前画布上从这条资产放下的角色卡跟着同步，@ 引用马上用上新的 */
function syncPlacedProfile(item: LibraryItem) {
  const engine = useCanvas.getState().engine
  if (!engine || engine.doc.readOnly) return
  const card = findPlacedCard(engine, item.id)
  if (!card) return
  const next = item.profile ?? emptyProfile()
  if (JSON.stringify(profileOf(card.params?.profile)) === JSON.stringify(profileOf(next))) return
  setParam(engine.doc, card.id, 'profile', next)
}
