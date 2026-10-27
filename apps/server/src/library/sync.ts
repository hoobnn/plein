import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { referenceAssets, shotAssetMention } from '@plein/capabilities'
import {
  type CanvasElement,
  type PleinDoc,
  removeEdges,
  inputEdges,
  setParams,
  updateElement,
} from '@plein/doc'
import {
  findMentions,
  mentionName,
  libraryKind,
  libraryReferenceImageIds,
  profileOf,
  sceneViewsOf,
  sceneViewAssets,
  voiceOf,
} from '@plein/nodes'
import {
  ApplyLibraryUpdates,
  ArchiveCharacterImage,
  SaveLibraryCard,
  type LibraryItem,
  type LibrarySyncField,
  type LibraryUpdates,
} from '@plein/protocol'
import { Hono } from 'hono'
import type { AuthEnv } from '../auth'
import type { AssetStore } from '../assets/store'
import { listCanvases } from '../storage/canvases'
import type { DB } from '../storage/db'
import type { Rooms } from '../sync/rooms'
import { archiveLibraryCard, LibraryArchiveConflict } from './archive'
import type { LibraryStore } from './store'
import { archiveCharacterImage, CharacterImageConflict } from './character-image'
import { capturePanoramaView, PanoramaCaptureError } from './panorama'

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const fields: LibrarySyncField[] = [
  'name',
  'description',
  'voice',
  'profile',
  'sceneViews',
  'references',
]
export const libraryRevision = (item: LibraryItem) => hash(projection(item))
function projection(item: LibraryItem) {
  const kind = libraryKind(item.kind)!
  return {
    name: item.name,
    description: item.description,
    voice: kind.voice ? voiceOf({ voice: item.voice }) : null,
    profile: item.kind === 'character' ? profileOf(item.profile) : null,
    sceneViews: item.kind === 'scene' ? sceneViewsOf(item.sceneViews) : [],
    references: kind.video
      ? item.video
        ? [item.video]
        : []
      : libraryReferenceImageIds(kind, item.images),
  }
}
function actual(doc: PleinDoc, card: CanvasElement, item: LibraryItem) {
  return {
    name: card.name ?? '',
    description: String(card.params?.description ?? ''),
    voice: libraryKind(item.kind)?.voice ? voiceOf(card.params) : null,
    profile: item.kind === 'character' ? profileOf(card.params?.profile) : null,
    sceneViews: item.kind === 'scene' ? sceneViewsOf(card.params?.sceneViews) : [],
    references: referenceAssets(doc, card, libraryKind(item.kind)?.video ? 'video' : 'image'),
  }
}
const expected = (doc: PleinDoc, card: CanvasElement, item: LibraryItem) =>
  hash({
    value: actual(doc, card, item),
    pinned: card.params?.libraryPinned === true,
    revision: card.params?.libraryRevision ?? null,
  })
interface Deps {
  db: DB
  rooms: Rooms
  assets: AssetStore
  library: LibraryStore
}

/** Read and apply are deliberately separate: library edits never overwrite another canvas. */
export function librarySyncRoutes(deps: Deps) {
  return new Hono<AuthEnv>()
    .post('/api/library/:id/panorama-view', async (c) => {
      try {
        const saved = await capturePanoramaView(
          deps.assets,
          deps.library,
          c.var.principal.id,
          c.req.param('id'),
          await c.req.json().catch(() => null),
          c.req.raw.signal,
          () => c.var.principal.role !== 'viewer',
        )
        return c.json(saved)
      } catch (error) {
        if (error instanceof PanoramaCaptureError)
          return c.json({ error: 'panorama_capture', message: error.message }, error.status)
        if (c.req.raw.signal.aborted)
          return c.json({ error: 'cancelled', message: '截图已取消，未保存视角' }, 409)
        throw error
      }
    })
    .post('/api/library/:id/character-image', async (c) => {
      const owner = c.var.principal.id
      if (c.var.principal.role === 'viewer')
        return c.json({ error: 'forbidden', message: '只读成员不能归档角色图片' }, 403)
      const parsed = ArchiveCharacterImage.safeParse(await c.req.json().catch(() => null))
      if (!parsed.success)
        return c.json({ error: 'invalid', message: '角色图片归档参数不合法' }, 400)
      if (!listCanvases(deps.db, owner).some((canvas) => canvas.id === parsed.data.canvasId))
        return c.json({ error: 'not_found', message: '来源画布不存在' }, 404)
      if (!deps.library.get(owner, c.req.param('id')))
        return c.json({ error: 'not_found', message: '角色不存在' }, 404)
      try {
        const item = deps.rooms.withDoc(parsed.data.canvasId, (doc) =>
          archiveCharacterImage(
            doc,
            deps.assets,
            deps.library,
            owner,
            c.req.param('id'),
            parsed.data,
          ),
        )
        return c.json(item)
      } catch (error) {
        if (error instanceof CharacterImageConflict)
          return c.json({ error: 'conflict', message: error.message }, 409)
        throw error
      }
    })
    .post('/api/library/save-card', async (c) => {
      const owner = c.var.principal.id
      if (c.var.principal.role === 'viewer')
        return c.json({ error: 'forbidden', message: '只读成员不能存入资产库' }, 403)
      const payload = await c.req.json().catch(() => null)
      const input = SaveLibraryCard.safeParse(payload)
      if (!input.success) return c.json({ error: 'invalid', message: '存档参数不合法' }, 400)
      // Zod 会补 sceneViews: []；是否更新必须看原始请求，避免旧客户端清空已有视角。
      const rawSnapshot =
        payload && typeof payload === 'object' && 'snapshot' in payload
          ? payload.snapshot
          : undefined
      const updateSceneViews =
        !!rawSnapshot && typeof rawSnapshot === 'object' && Object.hasOwn(rawSnapshot, 'sceneViews')
      const source = listCanvases(deps.db, owner).find(
        (canvas) => canvas.id === input.data.canvasId,
      )
      if (!source) return c.json({ error: 'not_found', message: '来源画布不存在' }, 404)
      try {
        const saved = deps.rooms.withDoc(source.id, (doc) =>
          archiveLibraryCard(
            doc,
            input.data.nodeId,
            owner,
            source.projectId,
            deps.library,
            input.data.snapshot,
            input.data.expectedLibraryId,
            { updateSceneViews },
          ),
        )
        try {
          deps.rooms.get(source.id).flush()
        } catch {
          return c.json({ ...saved, persistence: 'pending' as const }, 202)
        }
        return c.json({ ...saved, persistence: 'saved' as const })
      } catch (error) {
        if (error instanceof LibraryArchiveConflict)
          return c.json({ error: 'conflict', message: error.message }, 409)
        throw error
      }
    })
    .get('/api/library/:id/updates', (c) => {
      const owner = c.var.principal.id
      const item = deps.library.get(owner, c.req.param('id'))
      if (!item) return c.json({ error: 'not_found', message: '资产不存在' }, 404)
      const wanted = projection(item)
      const result: LibraryUpdates = { revision: libraryRevision(item), cards: [] }
      for (const canvas of listCanvases(deps.db, owner))
        deps.rooms.withDoc(canvas.id, (doc) => {
          for (const card of doc.elements()) {
            if (
              card.params?.libraryId !== item.id ||
              card.nodeType !== libraryKind(item.kind)?.nodeType
            )
              continue
            const value = actual(doc, card, item)
            result.cards.push({
              canvasId: canvas.id,
              canvasTitle: canvas.title,
              nodeId: card.id,
              name: card.name ?? item.name,
              expected: expected(doc, card, item),
              pinned: card.params.libraryPinned === true,
              revision:
                typeof card.params.libraryRevision === 'string'
                  ? card.params.libraryRevision
                  : null,
              changes: fields
                .filter((field) => hash(value[field]) !== hash(wanted[field]))
                .map((field) => ({ field, before: value[field], after: wanted[field] })),
            })
          }
        })
      return c.json(result)
    })
    .post('/api/library/:id/updates', async (c) => {
      const owner = c.var.principal.id
      if (c.var.principal.role === 'viewer')
        return c.json({ error: 'forbidden', message: '只读成员不能同步资产' }, 403)
      const input = ApplyLibraryUpdates.safeParse(await c.req.json().catch(() => null))
      if (!input.success) return c.json({ error: 'invalid', message: '同步参数不合法' }, 400)
      const item = deps.library.get(owner, c.req.param('id'))
      if (!item) return c.json({ error: 'not_found', message: '资产不存在' }, 404)
      if (libraryRevision(item) !== input.data.revision)
        return c.json({ error: 'conflict', message: '资产又有更新，请重新查看差异' }, 409)
      const owned = new Set(listCanvases(deps.db, owner).map((x) => x.id))
      const seen = new Set<string>()
      // Validate every target synchronously before writing any canvas. No await between check and write.
      for (const t of input.data.targets) {
        const key = `${t.canvasId}:${t.nodeId}`
        if (!owned.has(t.canvasId) || seen.has(key))
          return c.json({ error: 'invalid', message: '画布不存在或目标重复' }, 400)
        seen.add(key)
        const ok = deps.rooms.withDoc(t.canvasId, (doc) => {
          const card = doc.get(t.nodeId)
          return (
            card?.params?.libraryId === item.id &&
            card.nodeType === libraryKind(item.kind)?.nodeType &&
            !(t.mode === 'update' && card.params.libraryPinned === true) &&
            expected(doc, card, item) === t.expected
          )
        })
        if (!ok)
          return c.json(
            { error: 'conflict', message: '画布卡片已变化或已固定版本，请刷新差异并先解除固定' },
            409,
          )
      }
      const wanted = projection(item)
      const selected = (field: LibrarySyncField) =>
        input.data.targets.some(
          (t) => t.mode === 'update' && (!t.fields || t.fields.includes(field)),
        )
      const imageExists = (id: string, kind: 'image' | 'video' = 'image') => {
        const asset = deps.assets.get(owner, id)
        return asset?.kind === kind && existsSync(deps.assets.originalPath(id))
      }
      const profileImages = wanted.profile
        ? [
            ...wanted.profile.periods.flatMap((period) => [
              ...period.images,
              ...period.outfits.flatMap((outfit) => outfit.images),
            ]),
            ...wanted.profile.expressions.flatMap((expression) => expression.images),
          ]
        : []
      if (
        (selected('references') &&
          wanted.references.some(
            (id) => !imageExists(id, item.kind === 'effect' ? 'video' : 'image'),
          )) ||
        (selected('profile') && profileImages.some((id) => !imageExists(id))) ||
        (selected('sceneViews') &&
          sceneViewAssets(wanted.sceneViews).some((id) => !imageExists(id)))
      )
        return c.json(
          {
            error: 'missing_asset',
            message: '新版参考素材缺失、类型不符或不属于当前用户，请先修复资产',
          },
          422,
        )
      for (const t of input.data.targets)
        deps.rooms.withDoc(t.canvasId, (doc) => {
          const card = doc.get(t.nodeId)!
          doc.ydoc.transact(() => {
            if (t.mode !== 'update') {
              setParams(doc, card.id, { libraryPinned: t.mode === 'keep' })
              return
            }
            const selected = new Set(t.fields ?? fields)
            const params: Record<string, unknown> = {
              libraryRevision: input.data.revision,
              libraryPinned: false,
            }
            if (selected.has('name') && card.name !== wanted.name)
              renameReferences(doc, card, wanted.name)
            for (const field of ['description', 'voice', 'profile', 'sceneViews'] as const)
              if (selected.has(field)) params[field] = wanted[field]
            if (selected.has('references')) {
              removeEdges(
                doc,
                inputEdges(doc, card.id, 'references').map((x) => x.id),
              )
              // Disconnect old edges only; the original media elements and candidate history remain.
              const refs = wanted.references
                .map((id) => deps.assets.get(owner, id)!)
                .map((a) => ({
                  assetId: a.id,
                  kind: a.kind as 'image' | 'video',
                  width: a.width,
                  height: a.height,
                  name: a.name,
                }))
              addReferences(doc, card, refs)
            }
            setParams(doc, card.id, params)
          }, doc.origin)
          doc.flush()
        })
      const pendingCanvases: string[] = []
      for (const canvasId of new Set(input.data.targets.map((t) => t.canvasId))) {
        try {
          deps.rooms.get(canvasId).flush()
        } catch {
          pendingCanvases.push(canvasId)
        }
      }
      return c.json(
        {
          updated: input.data.targets.length,
          persistence: pendingCanvases.length ? ('pending' as const) : ('saved' as const),
          pendingCanvases,
        },
        pendingCanvases.length ? 202 : 200,
      )
    })
}

import { connect, createElement, findFreeSpot } from '@plein/doc'
import { type CardRef, REF_W, REF_COL_GAP, refsHeight } from '@plein/capabilities'
function addReferences(doc: PleinDoc, card: CanvasElement, refs: CardRef[]) {
  const rect = doc.worldRect(card.id)!
  const spot = findFreeSpot(
    doc,
    {
      x: rect.x - REF_COL_GAP - REF_W,
      y: rect.y + rect.h / 2 - refsHeight(refs) / 2,
      w: REF_W,
      h: refsHeight(refs),
    },
    { direction: 'down' },
  )
  let y = spot.y
  for (const ref of refs) {
    const h = Math.round(
      REF_W *
        (ref.width && ref.height ? ref.height / ref.width : ref.kind === 'video' ? 9 / 16 : 1),
    )
    const id = createElement(doc, {
      kind: ref.kind,
      assetId: ref.assetId,
      name: ref.name,
      x: spot.x,
      y: Math.round(y),
      w: REF_W,
      h,
    })
    connect(doc, [id, ref.kind], [card.id, 'references'])
    y += h + 24
  }
}

/** Preserve already unambiguous @ references when an approved library update renames a card. */
function renameReferences(doc: PleinDoc, card: CanvasElement, name: string) {
  const targets = [...doc.elements()].flatMap((el) => {
    const name = mentionName(el)
    return name
      ? [
          {
            id: el.id,
            name,
            ...(el.nodeType === 'plein/character'
              ? { profile: profileOf(el.params?.profile) }
              : {}),
            ...(el.nodeType === 'plein/scene'
              ? { sceneViews: sceneViewsOf(el.params?.sceneViews) }
              : {}),
          },
        ]
      : []
  })
  const edits: Array<{
    id: string
    key: string
    value: string
    mentions: ReturnType<typeof findMentions>
  }> = []
  for (const el of doc.elements())
    for (const [key, value] of Object.entries(el.params ?? {})) {
      if (typeof value !== 'string' || !value.includes('@')) continue
      const mentions = findMentions(value, targets).filter((m) => m.id === card.id)
      if (mentions.length) edits.push({ id: el.id, key, value, mentions })
    }
  updateElement(doc, card.id, { name })
  const token = shotAssetMention(doc, doc.get(card.id)!)
  for (const edit of edits) {
    let value = edit.value
    for (const mention of edit.mentions.toReversed()) {
      const end =
        mention.start +
        1 +
        mention.name.length +
        (mention.index === undefined ? 0 : `#${mention.index}`.length)
      value = value.slice(0, mention.start) + token + value.slice(end)
    }
    setParams(doc, edit.id, { [edit.key]: value })
  }
}
