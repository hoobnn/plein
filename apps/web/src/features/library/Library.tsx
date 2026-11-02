import {
  LIBRARY_KINDS,
  libraryKind,
  OFFICIAL_LIBRARY,
  type OfficialLibraryItem,
} from '@plein/nodes'
import type { CharacterImageSlot, LibraryItem, LibraryKind } from '@plein/protocol'
import { useQuery } from '@tanstack/react-query'
import { useShallow } from 'zustand/react/shallow'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { api } from '../../api/client'
import { queryKeys } from '../../api/query'
import { canvasMedia, placeInputOf, type PlaceInput } from './canvas'
import { useCanvas } from '../../stores/canvas'
import { useCatalog } from '../../stores/catalog'
import { createCharacterImageDraft } from './CharacterProduction'
import { useLibrary } from './store'
import { dialogOpen } from '../../ui/Dialog'
import { Icon } from '../../ui/icons'
import { ModalHeader } from '../../ui/Modal'
import { hasMenuEscapeLayer, isMenuEscape } from '../../ui/menuEscape'
import { AnimatePresence } from '../../ui/motion'
import { Segmented } from '../../ui/Segmented'
import { Select } from '../../ui/Select'
import { SlideSwap } from '../../ui/Slide'
import { morphView } from '../../ui/viewTransition'
import { LibraryReadStatus } from './LibraryReadStatus'
import { LibraryModal, LibraryTabs, useLibraryClose, VoicePanel } from './VoicePanel'
import { useLibraryPlacement } from './useLibraryPlacement'
import { listFocusTarget } from './listFocus'
import { createdEditing, editorKeyOf, type Editing } from './editorDraft'
import { useWindowKeyDown } from '../../ui/useWindowKeyDown'
import { Card } from './Card'
import { Editor } from './LibraryEditor'
import { Empty } from './Empty'
import { OfficialCard } from './OfficialCard'
import type { Scope } from './library.utils'

/**
 * 资产库面板：
 * 按类别浏览、筛选、收藏，编辑设定与图片槽位，一键放到当前画布上。
 * 没有打开画布时（首页）只能管理，不能放到画布上。
 */

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
  return (
    <AnimatePresence>
      {open && (
        // 弹窗外壳各页签共用：切到「音色」时只换内容，不重新弹出
        <LibraryModal>{open === 'voice' ? <VoicePanel /> : <Panel kind={open} />}</LibraryModal>
      )}
    </AnimatePresence>
  )
}

function Panel({ kind: kindId }: { kind: LibraryKind }) {
  const { items, loaded, loading, error, projectId, show, load } = useLibrary(
    useShallow((s) => ({
      items: s.items,
      loaded: s.loaded,
      loading: s.loading,
      error: s.error,
      projectId: s.projectId,
      show: s.show,
      load: s.load,
    })),
  )
  const projects = useQuery({
    queryKey: queryKeys.projects,
    queryFn: api.projects,
    refetchOnMount: 'always',
  })
  const sources = useMemo(() => {
    const rows = projects.data ?? []
    const ids = [
      ...new Set([
        ...rows.map((p) => p.id),
        ...items.flatMap((item) => (item.projectId ? [item.projectId] : [])),
      ]),
    ]
    const counts = new Map<string, number>()
    for (const project of rows) counts.set(project.title, (counts.get(project.title) ?? 0) + 1)
    return new Map(
      ids.map((id) => {
        const project = rows.find((p) => p.id === id)
        if (project && counts.get(project.title) === 1) return [id, project.title]
        let size = 6
        while (ids.some((other) => other !== id && other.slice(-size) === id.slice(-size))) size++
        return [id, `${project?.title ?? '项目'} · ${id.slice(-size)}`]
      }),
    )
  }, [items, projects.data])
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

  useWindowKeyDown(
    (e) => {
      if (
        !(e.target instanceof Element) ||
        !e.target.closest('[role="dialog"]')?.classList.contains('lib-dialog')
      )
        return
      if (e.key === 'Escape' && (e.isComposing || e.keyCode === 229)) {
        e.stopPropagation()
        return
      }
      // 确认框、弹层（下拉框、从画布选）开着时 Esc 归它们
      if (
        e.key !== 'Escape' ||
        e.defaultPrevented ||
        dialogOpen() ||
        isMenuEscape(e) ||
        hasMenuEscapeLayer()
      )
        return
      if (e.target instanceof HTMLElement && e.target.closest('[data-library-escape]')) return
      e.stopPropagation()
      if (editing) back()
      else close()
    },
    { capture: true },
  )

  const q = query.trim().toLowerCase()
  const filtered = !!q || Object.values(tags).some(Boolean)
  const clearFilters = () => {
    setQuery('')
    setTags({})
    searchRef.current?.focus()
  }
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

  const produce = async (item: LibraryItem, slot: CharacterImageSlot) => {
    const input = placeInputOf(item)
    if (!input || !engine || !canvasId) return
    const placed = await placement.place({ ...input, fresh: true })
    if (!placed?.id) return
    const current = useCanvas.getState()
    if (current.engine !== engine || current.canvasId !== canvasId || engine.doc.readOnly) return
    const id = createCharacterImageDraft(
      engine,
      useCatalog.getState().catalog,
      placed.id,
      item,
      slot,
    )
    if (!id) {
      current.notify('无法创建角色图片草稿，请确认图片生成节点可用后重试')
      return
    }
    close()
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

  useLibraryClose(close)

  return (
    <>
      <ModalHeader
        title="资产库"
        onClose={close}
        closeDisabled={uploadPending}
        meta={<LibraryTabs value={kindId} disabled={uploadPending} />}
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
      {!editing && scope !== 'project' && scope !== 'official' && projects.isError && (
        <div
          role="alert"
          className="mx-5 my-2 flex flex-wrap items-center gap-2 text-xs text-danger"
        >
          <span>来源项目读取失败，可重试更新名称。</span>
          <button
            type="button"
            className="ui-btn ui-btn-secondary ui-btn-xs"
            disabled={projects.isFetching}
            aria-busy={projects.isFetching}
            onClick={() => void projects.refetch()}
          >
            重试来源项目
          </button>
        </div>
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
          onProduce={produce}
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
            {filtered && (
              <button
                type="button"
                className="ui-btn ui-btn-quiet ui-btn-sm"
                onClick={clearFilters}
                title="清空搜索和所有标签，保留当前范围"
              >
                重置筛选
              </button>
            )}
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
                    filtered={filtered}
                    onClear={clearFilters}
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
                        source={
                          scope === 'project'
                            ? undefined
                            : it.projectId
                              ? sources.get(it.projectId)
                              : '未归属项目'
                        }
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
      {placement.sourcePicker}
    </>
  )
}
