import {
  LIBRARY_KINDS,
  type LibraryKindSpec,
  libraryKind,
  OFFICIAL_LIBRARY,
  type OfficialLibraryItem,
  slotImages,
} from '@plein/nodes'
import type { LibraryImage, LibraryItem, LibraryKind } from '@plein/protocol'
import { useEffect, useMemo, useRef, useState } from 'react'
import { api, assetUrls } from '../api/client'
import {
  type CanvasMedia,
  canvasMedia,
  coverOf,
  placeInputOf,
  placeLibraryItem,
  type PlaceInput,
} from '../canvas/library'
import { useCanvas } from '../stores/canvas'
import { useCatalog } from '../stores/catalog'
import { type LibrarySeed, useLibrary } from '../stores/library'
import { confirmDialog, dialogOpen } from '../ui/Dialog'
import { Icon } from '../ui/icons'
import { Modal, ModalHeader } from '../ui/Modal'
import { Popover } from '../ui/Popover'
import { Presence } from '../ui/Presence'
import { Select } from '../ui/Select'
import { KIND_ICONS } from './LibraryAdd'
import { VoicePicker } from './VoicePicker'
import { Segmented } from '../ui/Segmented'
import { SlideSwap } from '../ui/Slide'
import { EmptyState } from '../ui/EmptyState'

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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // 确认框、弹层（下拉框、从画布选）开着时 Esc 归它们
      if (e.key !== 'Escape' || dialogOpen() || document.querySelector('.ui-menu')) return
      e.stopPropagation()
      if (editing) setEditing(null)
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
          onBack={() => setEditing(null)}
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
                        onOpen={() => setEditing({ type: 'item', id: it.id })}
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

/** 缩略图地址：图片取 256 缩略图，视频取封面 */
const thumb = (assetId: string) => assetUrls.variant(assetId, 'thumb-256')

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
  onOpen(): void
  onPlace(): void
}) {
  const cover = coverOf(item, kind)
  const update = useLibrary((s) => s.update)
  return (
    <li className="home-card group relative">
      <button type="button" onClick={onOpen} className="block w-full text-left">
        <div className="flex aspect-[3/4] items-center justify-center overflow-hidden bg-surface-2">
          {cover ? (
            <img
              src={cover}
              alt=""
              loading="lazy"
              draggable={false}
              className="size-full object-cover"
            />
          ) : (
            <span className="line-clamp-6 px-4 text-xs text-ink-subtle">
              {item.description || '没有参考图'}
            </span>
          )}
        </div>
        <div className="px-3 pt-2.5 pb-3">
          <div className="truncate text-sm font-medium">{item.name}</div>
          <div className="truncate text-xs text-ink-subtle">
            {tagLine(kind, item.tags) || `${item.images.length} 张参考图`}
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
          className="ui-btn ui-btn-primary ui-btn-sm absolute bottom-16 left-1/2 -translate-x-1/2 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100"
        >
          添加到画布
        </button>
      )}
    </li>
  )
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
    <li className="home-card group relative">
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
          className="ui-btn ui-btn-primary ui-btn-sm absolute bottom-16 left-1/2 -translate-x-1/2 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100"
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
    // 新建的角色 / 场景 / 道具默认归到当前项目；风格、特效默认全局
    inProject: item ? item.projectId !== null : !!projectId && !kind.video && kind.id !== 'style',
  }
}

/** 条目编辑：左边图片槽位，右边设定；官方条目只读，可以复制成自己的 */
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
  const [draft, setDraft] = useState(() => draftOf(kind, item, official, projectId, seed))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
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
    projectId: draft.inProject ? (item?.projectId ?? projectId) : null,
  })

  /** 保存并返回条目；官方条目复制一份成自己的 */
  const save = async (): Promise<LibraryItem | null> => {
    setBusy(true)
    setError(null)
    try {
      if (item) return dirty ? await lib.update(item.id, body()) : item
      const created = await lib.create({ kind: kind.id, ...body() })
      onCreated(created.id)
      return created
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

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="ui-scrollbar grid min-h-0 flex-1 gap-6 overflow-y-auto p-5 md:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
        <section aria-label="图片" className="flex flex-col gap-4">
          {readOnly ? (
            <div className="plein-thumb flex aspect-video items-center justify-center rounded-xl p-6 text-center text-sm text-ink-muted">
              官方{kind.title}只有提示词。复制到「我的」之后可以加参考图
              {kind.video ? '和参考视频' : ''}。
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-4">
              {kind.slots.map((slot) => (
                <SlotField
                  key={slot.id}
                  slot={slot}
                  images={draft.images.filter((i) => i.slot === slot.id)}
                  used={draft.images.map((i) => i.assetId)}
                  media={media}
                  onAdd={(ids) =>
                    patch({
                      images: [
                        ...(slot.multiple
                          ? draft.images
                          : draft.images.filter((i) => i.slot !== slot.id)),
                        ...ids.map((assetId) => ({ slot: slot.id, assetId })),
                      ],
                    })
                  }
                  onRemove={(assetId) =>
                    patch({
                      images: draft.images.filter(
                        (i) => !(i.slot === slot.id && i.assetId === assetId),
                      ),
                    })
                  }
                />
              ))}
            </div>
          )}
          {kind.video && !readOnly && (
            <VideoField value={draft.video} media={media} onChange={(video) => patch({ video })} />
          )}
        </section>
        <section aria-label="设定" className="flex flex-col gap-4">
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
                      options={[
                        { value: '', label: '不限' },
                        ...t.options.map((v) => ({ value: v })),
                      ]}
                      onChange={(v) => patch({ tags: { ...draft.tags, [t.id]: v } })}
                    />
                  )}
                </div>
              ))}
            </div>
          )}
          <label className="ui-field">
            <span className="ui-label">{kind.descriptionLabel}</span>
            <textarea
              className="ui-input h-36"
              value={draft.description}
              readOnly={readOnly}
              maxLength={4000}
              placeholder={kind.placeholder}
              onChange={(e) => patch({ description: e.target.value })}
            />
            <span className="text-xs text-ink-subtle">
              放到画布上就是卡片的「设定」；提示词里 @ 它时会并入提示词
            </span>
          </label>
          {kind.voice && (
            <div className="ui-field">
              <span className="ui-label">音色</span>
              <VoicePicker value={draft.voice} onChange={(voice) => patch({ voice })} />
              <span className="text-xs text-ink-subtle">音色只能在同一家平台的配音模型里使用</span>
            </div>
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

/** 上传文件进资产存储，返回资产 id；kind 不对的文件跳过 */
async function uploadAll(files: File[], want: 'image' | 'video') {
  const out: string[] = []
  for (const f of files) {
    if (!f.type.startsWith(`${want}/`)) continue
    const a = await api.upload(f)
    out.push(a.id)
  }
  return out
}

/** 「从画布选」：列出当前画布上的图片 / 视频，单张槽位点一下就选中，多张槽位可以连续点 */
function CanvasPick({
  media,
  type,
  multiple,
  taken,
  onPick,
}: {
  media: CanvasMedia[]
  type: 'image' | 'video'
  multiple: boolean
  /** 已经用在条目里的资产，列表里标出来、不能重复选 */
  taken: string[]
  onPick(assetId: string): void
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const list = media.filter((m) => m.kind === type)
  if (!media.length) return null
  return (
    <>
      <button
        type="button"
        aria-expanded={!!anchor}
        disabled={!list.length}
        title={list.length ? undefined : `画布上没有${type === 'image' ? '图片' : '视频'}`}
        onClick={(e) => setAnchor(anchor ? null : e.currentTarget)}
        className="ui-drop-tile"
      >
        <Icon name="board" size={16} />
        从画布选
      </button>
      <Presence>
        {anchor && (
          <Popover
            anchor={anchor}
            onClose={() => setAnchor(null)}
            label="从画布选"
            width={344}
            placement="below"
          >
            <div className="ui-menu-label">
              画布上的{type === 'image' ? '图片' : '视频'}（{list.length}）
            </div>
            <div className="ui-scrollbar grid max-h-80 grid-cols-4 gap-2 overflow-y-auto p-2">
              {list.map((m) => {
                const on = taken.includes(m.assetId)
                return (
                  <button
                    key={m.assetId}
                    type="button"
                    title={m.name || undefined}
                    aria-pressed={on}
                    disabled={on}
                    onClick={() => {
                      onPick(m.assetId)
                      if (!multiple) setAnchor(null)
                    }}
                    className={`relative aspect-square overflow-hidden rounded-md bg-surface-2 ${
                      on ? 'opacity-40' : 'hover:ring-2 hover:ring-accent'
                    }`}
                  >
                    <img
                      src={
                        type === 'image' ? thumb(m.assetId) : assetUrls.variant(m.assetId, 'poster')
                      }
                      alt=""
                      loading="lazy"
                      draggable={false}
                      className="size-full object-cover"
                    />
                    {on && (
                      <span className="absolute inset-0 flex items-center justify-center text-ink">
                        <Icon name="check" size={16} />
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
          </Popover>
        )}
      </Presence>
    </>
  )
}

function SlotField({
  slot,
  images,
  used,
  media,
  onAdd,
  onRemove,
}: {
  slot: LibraryKindSpec['slots'][number]
  images: LibraryImage[]
  /** 整个条目已经用到的图片，「从画布选」里标出来 */
  used: string[]
  media: CanvasMedia[]
  onAdd(ids: string[]): void
  onRemove(assetId: string): void
}) {
  const ref = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const pick = async (files: File[]) => {
    setBusy(true)
    setError(null)
    try {
      const ids = await uploadAll(files, 'image')
      if (ids.length) onAdd(slot.multiple ? ids : ids.slice(0, 1))
      else setError('只能放图片')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const canAdd = slot.multiple || images.length === 0
  return (
    <div className="ui-field">
      {/* 标签和提示只占一行：提示折行会把这一格的上传框挤下去，跟同一行另一格对不齐 */}
      <span className="ui-label flex min-w-0 items-baseline" title={slot.hint}>
        <span className="flex-none">{slot.label}</span>
        {slot.hint && (
          <span className="ml-2 truncate font-normal text-ink-subtle">{slot.hint}</span>
        )}
      </span>
      <div className="flex flex-wrap gap-2">
        {images.map((img) => (
          <div
            key={img.assetId}
            className="group relative size-24 overflow-hidden rounded-lg bg-surface-2"
          >
            <img
              src={thumb(img.assetId)}
              alt=""
              draggable={false}
              className="size-full object-cover"
            />
            <button
              type="button"
              aria-label="移除"
              title="移除"
              onClick={() => onRemove(img.assetId)}
              className="ui-btn ui-btn-quiet ui-btn-sm ui-icon-btn absolute top-1 right-1 bg-float opacity-0 group-hover:opacity-100 focus:opacity-100"
            >
              <Icon name="x" size={12} />
            </button>
          </div>
        ))}
        {canAdd && (
          <button
            type="button"
            disabled={busy}
            onClick={() => ref.current?.click()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault()
              void pick([...e.dataTransfer.files])
            }}
            className="ui-drop-tile"
          >
            <Icon name={busy ? 'upload' : 'plus'} size={16} />
            {busy ? '上传中' : '上传'}
          </button>
        )}
        {canAdd && (
          <CanvasPick
            media={media}
            type="image"
            multiple={!!slot.multiple}
            taken={used}
            onPick={(id) => onAdd([id])}
          />
        )}
      </div>
      {error && <span className="text-xs text-danger">{error}</span>}
      <input
        ref={ref}
        type="file"
        accept="image/*"
        multiple={slot.multiple}
        hidden
        onChange={(e) => {
          const files = [...(e.target.files ?? [])]
          e.target.value = ''
          if (files.length) void pick(files)
        }}
      />
    </div>
  )
}

function VideoField({
  value,
  media,
  onChange,
}: {
  value: string | null
  media: CanvasMedia[]
  onChange(v: string | null): void
}) {
  const ref = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <div className="ui-field">
      <span className="ui-label">
        参考视频
        <span className="ml-2 font-normal text-ink-subtle">只给人看，不会送进模型</span>
      </span>
      {value ? (
        <div className="flex items-start gap-2">
          {/* oxlint-disable-next-line jsx-a11y/media-has-caption -- 参考视频没有字幕 */}
          <video
            src={assetUrls.original(value)}
            controls
            className="max-h-56 w-full rounded-lg bg-black"
          />
          <button
            type="button"
            onClick={() => onChange(null)}
            className="ui-btn ui-btn-quiet ui-btn-sm"
          >
            移除
          </button>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => ref.current?.click()}
            className="ui-drop-tile"
          >
            <Icon name="upload" size={16} />
            {busy ? '上传中' : '上传视频'}
          </button>
          <CanvasPick media={media} type="video" multiple={false} taken={[]} onPick={onChange} />
        </div>
      )}
      {error && <span className="text-xs text-danger">{error}</span>}
      <input
        ref={ref}
        type="file"
        accept="video/*"
        hidden
        onChange={async (e) => {
          const files = [...(e.target.files ?? [])]
          e.target.value = ''
          if (!files.length) return
          setBusy(true)
          setError(null)
          try {
            const [id] = await uploadAll(files, 'video')
            if (id) onChange(id)
            else setError('只能放视频')
          } catch (err) {
            setError((err as Error).message)
          } finally {
            setBusy(false)
          }
        }}
      />
    </div>
  )
}
