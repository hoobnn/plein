import {
  type CardRef,
  CapabilityError,
  capabilityFor,
  cardSnapshot,
  clip,
  findPlacedCard,
  need,
  nodeElementOf,
  REF_COL_GAP,
  REF_W,
  placeLibraryCard,
} from '@plein/capabilities'
import { setParam, spotAfterContent, spotRightOf } from '@plein/doc'
import { libraryKind, orderedImages } from '@plein/nodes'
import { LibraryKind } from '@plein/protocol'
import { z } from 'zod'
import type { ServerContext } from './tools'

/** 资产库能力：搜索、用到画布上、存回资产库。与资产库面板、卡片菜单是同一套逻辑 */

const serverCapability = capabilityFor<ServerContext>()
const id = z.string().min(1).max(200)

const library = (ctx: ServerContext) => {
  if (!ctx.env.library) throw new CapabilityError('资产库不可用')
  return ctx.env.library
}

export const searchLibrary = serverCapability({
  name: 'search_library',
  title: '搜索资产库',
  description:
    '在资产库里找角色、场景、道具、风格、特效条目（按名称、设定、标签匹配）。找到后用 place_library_item 放到画布上，比重新生成角色更省钱、形象也一致。',
  group: 'library',
  where: 'server',
  effect: 'read',
  input: z.object({
    query: z.string().max(100).optional().describe('不填列出最近的'),
    kind: LibraryKind.optional(),
    limit: z.number().int().min(1).max(50).default(20),
  }),
  run: (ctx, a) => {
    const q = a.query?.trim().toLowerCase()
    const items = library(ctx)
      .list(ctx.env.ownerId, a.kind)
      .filter(
        (i) =>
          !q ||
          [i.name, i.description, ...Object.values(i.tags).flat()]
            .join('\n')
            .toLowerCase()
            .includes(q),
      )
    return {
      total: items.length,
      items: items.slice(0, a.limit).map((i) => ({
        id: i.id,
        kind: i.kind,
        name: i.name,
        description: clip(i.description, 200),
        images: i.images.length,
        voice: !!i.voice,
        favorite: i.favorite,
      })),
    }
  },
})

export const placeLibraryItem = serverCapability({
  name: 'place_library_item',
  title: '用到画布上',
  description:
    '把资产库条目放到画布上：一张设定卡（设定、音色写在卡上），参考图排在左侧连进卡片。同一条目已在画布上时直接返回那张卡。',
  group: 'library',
  where: 'server',
  effect: 'edit',
  input: z.object({
    item_id: id,
    near: id.optional().describe('放在这个元素右侧；不填时放在画布内容右侧'),
    x: z.number().optional(),
    y: z.number().optional(),
  }),
  run: (ctx, a) => {
    const item = library(ctx).get(ctx.env.ownerId, a.item_id)
    if (!item) throw new CapabilityError(`资产库里没有 ${a.item_id}，先用 search_library 查找`)
    const kind = libraryKind(item.kind)
    const info = kind && ctx.nodes.latest(kind.nodeType)
    if (!kind || !info) throw new CapabilityError(`当前没有「${kind?.title ?? item.kind}」卡片节点`)
    const base = nodeElementOf(info.descriptor)
    const refs: CardRef[] = [
      ...orderedImages(kind, item.images).map((i) => ({
        kind: 'image' as const,
        assetId: i.assetId,
      })),
      ...(item.video ? [{ kind: 'video' as const, assetId: item.video }] : []),
    ].flatMap((r) => {
      const meta = ctx.assetMeta(r.assetId)
      return meta ? [{ ...r, width: meta.width, height: meta.height }] : []
    })
    const result = ctx.withDoc((doc) => {
      const placed = findPlacedCard(doc, item.id)
      if (placed) return { id: placed.id, existed: true, loose: 0 }
      const left = refs.length ? REF_W + REF_COL_GAP : 0
      const w = left + base.w
      const h = Math.max(base.h, 400)
      if (a.near) need(doc, a.near)
      const spot =
        a.x !== undefined && a.y !== undefined
          ? { x: a.x - left, y: a.y }
          : a.near
            ? spotRightOf(doc, a.near, w, h)
            : spotAfterContent(doc, w, h)
      const card = placeLibraryCard(
        doc,
        {
          ...base,
          name: item.name,
          params: {
            ...base.params,
            description: item.description,
            ...(kind.voice && item.voice ? { voice: item.voice } : {}),
            libraryId: item.id,
          },
        },
        { x: Math.round(spot.x + left), y: Math.round(spot.y + (h - base.h) / 2) },
        refs,
      )
      return { ...card, existed: false }
    })
    if (!result.existed) library(ctx).markUsed(ctx.env.ownerId, item.id)
    const skipped = item.images.length + (item.video ? 1 : 0) - refs.length
    return {
      id: result.id,
      existed: result.existed,
      ...(skipped > 0 ? { skipped_assets: skipped } : {}),
      ...(result.loose ? { unlinked: result.loose } : {}),
    }
  },
})

export const saveToLibrary = serverCapability({
  name: 'save_to_library',
  title: '存入资产库',
  description:
    '把画布上的设定卡（角色 / 场景 / 道具 / 风格 / 特效）存进资产库：名字、设定、音色和连入的参考图。卡片来自资产库时更新原条目，否则新建。',
  group: 'library',
  where: 'server',
  effect: 'edit',
  input: z.object({ id: id.describe('设定卡节点') }),
  run: (ctx, a) => {
    const lib = library(ctx)
    const project = lib.projectOf(ctx.env.ownerId, ctx.env.canvasId)
    const snap = ctx.withDoc((doc) => cardSnapshot(doc, need(doc, a.id), project))
    if (!snap) throw new CapabilityError('这个节点不是设定卡，不能存入资产库')
    const linkedId = ctx.withDoc((doc) => doc.get(a.id)?.params?.libraryId)
    const linked = typeof linkedId === 'string' ? lib.get(ctx.env.ownerId, linkedId) : null
    const { body } = snap
    if (linked) {
      // 保留已有图片的槽位、标签和收藏
      const slots = new Map(linked.images.map((i) => [i.assetId, i.slot]))
      const item = lib.update(ctx.env.ownerId, linked.id, {
        name: body.name,
        description: body.description,
        // 资产库里手选过的标签优先，没选的按设定补上
        tags: {
          ...body.tags,
          ...Object.fromEntries(Object.entries(linked.tags).filter(([, v]) => v)),
        },
        images: body.images.map((i) => ({ ...i, slot: slots.get(i.assetId) ?? i.slot })),
        video: body.video,
        voice: body.voice,
      })!
      return { item_id: item.id, created: false }
    }
    const item = lib.create(ctx.env.ownerId, { ...body, models: [] })
    ctx.withDoc((doc) => setParam(doc, a.id, 'libraryId', item.id))
    return { item_id: item.id, created: true }
  },
})

export const libraryCapabilities = [searchLibrary, placeLibraryItem, saveToLibrary]
