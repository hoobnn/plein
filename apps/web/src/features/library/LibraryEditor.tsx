import {
  type LibraryKindSpec,
  type OfficialLibraryItem,
  orderedImages,
  panoramaSceneRevision,
  profileEmpty,
  profileSize,
  sceneViewImages,
} from '@plein/nodes'
import type { CharacterImageSlot, LibraryItem } from '@plein/protocol'
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../../api/client'
import { confirmDialog } from '../../ui/Dialog'
import { Icon, type IconName } from '../../ui/icons'
import { Segmented } from '../../ui/Segmented'
import { Select } from '../../ui/Select'
import { SlideSwap } from '../../ui/Slide'
import { VoicePicker } from '../../ui/VoicePicker'
import { loadAssetMeta } from '../../stores/assetMeta'
import { useCompositionSourcePicker } from '../media-library/CompositionSourcePicker'
import { coverAssetOf, type CanvasMedia, placeInputOf, type PlaceInput } from './canvas'
import { CharacterAssets } from './CharacterAssets'
import { CHARACTER_STARTERS } from './CharacterProduction'
import { draftOf, type Draft } from './editorDraft'
import { Hero } from './Hero'
import { SlotField, thumb, VideoField } from './LibraryFields'
import { ReferenceThumbnail } from './LibraryMedia'
import {
  ExpressionsTab,
  type HeroControl,
  PeriodsTab,
  ProfileImageScope,
  ProfileUploadContext,
} from './LibraryProfile'
import { LibraryUpdatesPanel } from './LibraryUpdates'
import { tagLine } from './library.utils'
import { SceneViews } from './SceneViews'
import { settleSavedDraft } from './savedDraft'
import { type LibrarySeed, useLibrary } from './store'

const PanoramaDialog = lazy(() => import('../panorama/PanoramaDialog'))

/** 角色编辑页的分页 */
type Tab = 'assets' | 'basics' | 'periods' | 'expressions'

/**
 * 条目编辑（档案式）：左边一张大图，悬停或选中任何一张图时交叉淡入成它；
 * 右边是设定，角色多两页「时期」「表情」。官方条目只读，可以复制成自己的。
 */
export function Editor({
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
  onProduce,
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
  onProduce(item: LibraryItem, slot: CharacterImageSlot): Promise<void>
  onUploadPendingChange(pending: boolean): void
}) {
  const lib = useLibrary()
  const videoSourcePicker = useCompositionSourcePicker(kind.id, true)
  const readOnly = !!official
  const character = kind.id === 'character'
  const [draft, setDraft] = useState(() => draftOf(kind, item, official, projectId, seed))
  const editor = useRef<HTMLDivElement>(null)
  const actions = useRef<HTMLElement>(null)
  const parkActionFocus = (button: HTMLButtonElement) => {
    if (document.activeElement === button) actions.current?.focus({ preventScroll: true })
  }
  const latestDraft = useRef(draft)
  latestDraft.current = draft
  const [saveNotice, setSaveNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  /** 删除等待期间锁定设定输入 */
  const [deleting, setDeleting] = useState(false)
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
  const openingPanorama = useRef(false)
  const [panoramaOpening, setPanoramaOpening] = useState(false)
  const [panorama, setPanorama] = useState<{
    item: LibraryItem
    sourceAssetId: string
    session: { active: boolean }
    snapshot: string
  } | null>(null)
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
    // 普通编辑保留独立封面；归档响应由 store 按 ID 合并，不用旧条目回写。
    coverAssetId: item?.coverAssetId ?? null,
    video: kind.video ? draft.video : null,
    videoCompositionSource: kind.video && draft.video ? draft.videoCompositionSource : null,
    models: kind.video
      ? draft.models
          .split(/[,，、\n]/)
          .map((m) => m.trim())
          .filter(Boolean)
      : [],
    profile: character && !profileEmpty(draft.profile) ? draft.profile : null,
    sceneViews: kind.id === 'scene' ? draft.sceneViews : [],
    projectId: draft.inProject ? (draft.projectTarget ?? projectId) : null,
  })

  /** 保存并返回条目；官方条目复制一份成自己的。画布上已经放下的这张角色卡跟着同步档案 */
  const beginMutation = (validateDraft = false) => {
    if (mutation.current || pendingUploads > 0) return null
    const invalid = editor.current?.querySelector<HTMLElement>('[aria-invalid="true"]')
    if (validateDraft && invalid) {
      setError('请先修正标记的输入，再保存或添加到画布。')
      // 错误条会压缩编辑区；等布局提交后再定位，不能只聚焦到被页脚遮住的字段。
      requestAnimationFrame(() => {
        if (!editor.current?.contains(invalid)) return
        invalid.focus()
        invalid.scrollIntoView({ block: 'center', inline: 'nearest' })
      })
      return null
    }
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
    const session = beginMutation(true)
    if (!session) return null
    const submitted = draft
    try {
      const payload = body()
      let resolvedSource = false
      if (payload.video && !payload.videoCompositionSource) {
        const source = await videoSourcePicker.resolve(await loadAssetMeta(payload.video))
        if (!current(session)) return null
        payload.videoCompositionSource = source ?? null
        resolvedSource = !!source
      }
      const saved = item
        ? dirty || resolvedSource
          ? await lib.update(item.id, payload)
          : item
        : await lib.create({ kind: kind.id, ...payload })
      if (!current(session)) return null
      const normalized = draftOf(kind, saved, undefined, projectId)
      const outcome = settleSavedDraft(submitted, latestDraft.current, normalized, placingAfterSave)
      setDraft((current) => settleSavedDraft(submitted, current, normalized, false).draft)
      // 等待期间又改了内容时要说清楚：这次存的是提交时的内容，最新的还没存。
      const changed = JSON.stringify(latestDraft.current) !== JSON.stringify(submitted)
      setSaveNotice(
        outcome.notice ??
          (!placingAfterSave && changed ? '已保存提交时的内容，仍有新修改，请再次保存。' : null),
      )
      if (!item) onCreated(saved.id)
      return outcome.continuePlacement ? saved : null
    } catch (err) {
      if (current(session) && (err as Error).name !== 'AbortError')
        setError(`保存失败：${(err as Error).message}。请稍后重试。`)
      return null
    } finally {
      finishMutation(session)
    }
  }

  const panoramaCurrent = () => {
    if (
      !panorama ||
      !current(panorama.session) ||
      JSON.stringify(latestDraft.current) !== panorama.snapshot
    )
      return false
    const source = useLibrary.getState().items.find((entry) => entry.id === panorama.item.id)
    return !!source && panoramaSceneRevision(source) === panoramaSceneRevision(panorama.item)
  }
  const openPanorama = async () => {
    if (panorama || openingPanorama.current) return
    const session = lifetime.current
    openingPanorama.current = true
    setPanoramaOpening(true)
    try {
      const saved = readOnly ? item : await save(true)
      if (!saved || !current(session)) return
      const snapshot = JSON.stringify(
        readOnly ? latestDraft.current : draftOf(kind, saved, undefined, projectId),
      )
      const latest = await api.libraryItem(saved.id)
      if (!current(session)) return
      if (JSON.stringify(latestDraft.current) !== snapshot) {
        setError('读取全景期间设定已变化，请核对后重试。')
        return
      }
      const normalized = draftOf(kind, latest, undefined, projectId)
      useLibrary.setState((state) => ({
        items: state.items.map((entry) => (entry.id === latest.id ? latest : entry)),
      }))
      setDraft(normalized)
      const sourceAssetId = latest.images.find((image) => image.slot === 'panorama')?.assetId
      if (!sourceAssetId) {
        setError('场景中已没有全景原图，请重新选择。')
        return
      }
      setPanorama({ item: latest, sourceAssetId, session, snapshot: JSON.stringify(normalized) })
    } catch (cause) {
      if (current(session)) setError((cause as Error).message)
    } finally {
      openingPanorama.current = false
      if (session.active) setPanoramaOpening(false)
    }
  }
  const capturedPanorama = (saved: LibraryItem) => {
    if (!panoramaCurrent()) return
    useLibrary.setState((state) => ({
      items: state.items.map((entry) => (entry.id === saved.id ? saved : entry)),
    }))
    setDraft(draftOf(kind, saved, undefined, projectId))
    setPanorama(null)
    setSaveNotice('已保存命名视角。画布上的场景卡仍可通过“查看画布中的版本”选择同步。')
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

  const produce = async (slot: CharacterImageSlot) => {
    if (!draft.name.trim()) {
      setError('请先填写有效的角色名称，再制作角色图片。')
      editor.current?.querySelector<HTMLInputElement>('input[aria-label="名称"]')?.focus()
      return
    }
    // save(true) 同时拦截无效输入、上传中与保存期间的新草稿；失败时保留编辑现场。
    const saved = await save(true)
    if (saved) await onProduce(saved, slot)
  }

  // 从画布存进来的内容本来就在画布上，新建时不再提供放回画布
  const placeable = canPlace && !(seed && !item)

  const remove = async () => {
    if (!item) return
    const session = beginMutation()
    if (!session) return
    // 删除期间锁定设定输入：这份内容马上要消失，继续输入只会白写。
    setDeleting(true)
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
      if (current(session)) setError(`删除失败：${(err as Error).message}。请稍后重试。`)
    } finally {
      setDeleting(false)
      finishMutation(session)
    }
  }

  const ordered = orderedImages(kind, draft.images)
  const thumbnails = ordered.filter(
    (image, index) => ordered.findIndex((entry) => entry.assetId === image.assetId) === index,
  )
  const explicitCover = coverAssetOf(
    {
      kind: kind.id,
      images: draft.images,
      profile: draft.profile,
      sceneViews: draft.sceneViews,
      video: draft.video,
      coverAssetId: item?.coverAssetId,
    },
    kind,
  )
  const cover =
    explicitCover ??
    ordered[0]?.assetId ??
    (kind.id === 'scene' ? (sceneViewImages(draft.sceneViews)[0] ?? null) : null)
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
    <div key={slot.id} className="flex flex-col gap-2">
      <SlotField
        key={slot.id}
        slot={slot}
        images={draft.images.filter((i) => i.slot === slot.id)}
        used={draft.images.map((i) => i.assetId)}
        media={media}
        disabled={busy || pendingUploads > 0}
        onBusyChange={trackUpload}
        onAdd={(ids) =>
          setDraft((current) => {
            const retained = slot.multiple
              ? current.images
              : current.images.filter((i) => i.slot !== slot.id)
            const used = new Set(retained.map((image) => image.assetId))
            const added = [...new Set(ids)]
              .filter((id) => !used.has(id))
              .map((assetId) => ({ slot: slot.id, assetId }))
            return { ...current, images: [...retained, ...added] }
          })
        }
        onRemove={(assetId) => {
          setDraft((current) => ({
            ...current,
            images: current.images.filter((i) => !(i.slot === slot.id && i.assetId === assetId)),
          }))
          setPreview((current) => (current?.id === assetId ? null : current))
          setPin((current) => (current.id === assetId ? { id: null } : current))
        }}
      />
      {kind.id === 'scene' &&
        slot.id === 'panorama' &&
        draft.images.some((image) => image.slot === 'panorama') && (
          <button
            type="button"
            className="ui-btn ui-btn-secondary ui-btn-sm self-start"
            disabled={busy || pendingUploads > 0 || !!panorama || panoramaOpening}
            onClick={() => void openPanorama()}
          >
            浏览全景与截取视角
          </button>
        )}
    </div>
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
        <>
          <div className="grid grid-cols-2 gap-4">{kind.slots.map(slotField)}</div>
          {draft.images.length >= 24 && (
            <p className="text-xs text-ink-subtle">已达到 24 张参考图上限，请先移除部分图片。</p>
          )}
        </>
      )}
      {kind.video && !readOnly && (
        <VideoField
          value={draft.video}
          media={media}
          onChange={(video, videoCompositionSource) => patch({ video, videoCompositionSource })}
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
          {draft.projectTarget && draft.projectTarget !== projectId
            ? '保留在来源项目（不勾选则不归属任何项目）'
            : '归到当前项目（「本项目」里能看到；不勾选则不归属任何项目）'}
        </label>
      )}
    </div>
  )

  return (
    <div ref={editor} className="flex min-h-0 flex-1 flex-col">
      {videoSourcePicker.picker}
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
              disabled={deleting}
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
                  <ReferenceThumbnail
                    src={thumb(img.assetId)}
                    label={kind.slots.find((s) => s.id === img.slot)?.label ?? '参考图'}
                    selected={shown === img.assetId}
                    onPreview={(active) =>
                      setPreview(
                        active
                          ? {
                              id: img.assetId,
                              caption: kind.slots.find((s) => s.id === img.slot)?.label,
                            }
                          : null,
                      )
                    }
                    onSelect={() =>
                      setPin({
                        id: img.assetId,
                        caption: kind.slots.find((s) => s.id === img.slot)?.label,
                      })
                    }
                  />
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
              disabled={busy || pendingUploads > 0 || deleting}
              className="contents"
              aria-label="角色档案编辑"
            >
              {!item && (
                <section
                  aria-label="示例设定，尚未生成图片"
                  className="mb-4 rounded-xl border border-line bg-surface-2 p-3"
                >
                  <h3 className="text-sm font-medium">本地文字起点</h3>
                  <p className="mt-1 text-xs text-ink-subtle">
                    示例设定，尚未生成图片。选择后仍可编辑，再从下方图片槽位开始制作。
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {CHARACTER_STARTERS.map((starter) => (
                      <button
                        key={starter.id}
                        type="button"
                        className="ui-btn ui-btn-secondary ui-btn-sm"
                        onClick={() =>
                          patch({ name: starter.name, description: starter.description })
                        }
                      >
                        使用「{starter.name}」示例
                      </button>
                    ))}
                  </div>
                </section>
              )}
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
                        setPreview(null)
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
                        canProduce={canPlace}
                        onProduce={(slot) => void produce(slot)}
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
            <fieldset
              disabled={pendingUploads > 0 || deleting}
              className="contents"
              aria-label="资产设定编辑"
            >
              {basics}
              {kind.id === 'scene' && (
                <SceneViews
                  value={draft.sceneViews}
                  onChange={(sceneViews) => patch({ sceneViews })}
                  media={media}
                  disabled={readOnly || busy || pendingUploads > 0}
                  onBusyChange={trackUpload}
                />
              )}
            </fieldset>
          )}
          {item && !readOnly && <LibraryUpdatesPanel key={item.id} item={item} />}
        </section>
      </div>
      <footer
        ref={actions}
        role="group"
        aria-label="资产操作"
        tabIndex={-1}
        className="lib-focus-region flex flex-none flex-wrap items-center gap-2 border-t border-line px-5 py-3"
      >
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
              onClick={(event) => {
                parkActionFocus(event.currentTarget)
                void save()
              }}
              className="ui-btn ui-btn-secondary"
            >
              <Icon name="copy" />
              复制到我的
            </button>
          ) : (
            <button
              type="button"
              disabled={busy || pendingUploads > 0 || (!!item && !dirty)}
              onClick={(event) => {
                parkActionFocus(event.currentTarget)
                void save()
              }}
              className={`ui-btn ${placeable ? 'ui-btn-secondary' : 'ui-btn-primary'}`}
            >
              {item ? (dirty ? '保存' : '已保存') : '保存'}
            </button>
          )}
          {placeable && (
            <button
              type="button"
              disabled={busy || placing || pendingUploads > 0}
              onClick={(event) => {
                parkActionFocus(event.currentTarget)
                void place()
              }}
              className="ui-btn ui-btn-primary"
            >
              {placing ? '正在放入…' : readOnly || !dirty ? '添加到画布' : '保存并添加到画布'}
            </button>
          )}
        </div>
      </footer>
      {panorama && (
        <Suspense fallback={<p role="status">正在打开全景…</p>}>
          <PanoramaDialog
            item={panorama.item}
            sourceAssetId={panorama.sourceAssetId}
            readOnly={readOnly}
            isCurrent={panoramaCurrent}
            onSaved={capturedPanorama}
            onClose={() => setPanorama(null)}
          />
        </Suspense>
      )}
    </div>
  )
}
