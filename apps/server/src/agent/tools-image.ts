import { Readable } from 'node:stream'
import { CapabilityError, capabilityFor, need } from '@plein/capabilities'
import { elementMedia, gridPlan, placeGrid } from '@plein/doc'
import sharp from 'sharp'
import { z } from 'zod'
import { UploadTooLargeError } from '../assets/store'
import type { ServerContext } from './tool-registry'

const id = z.string().min(1).max(200)
const serverCapability = capabilityFor<ServerContext>()

/** 方向校正后的像素尺寸（浏览器 createImageBitmap 会按 EXIF 方向展开，这里同样处理） */
async function orientedSize(path: string) {
  const meta = await sharp(path).metadata()
  const swap = (meta.orientation ?? 1) >= 5
  const width = swap ? meta.height : meta.width
  const height = swap ? meta.width : meta.height
  if (!width || !height) throw new CapabilityError('读不出图片尺寸')
  return { width, height }
}

export const splitGrid = serverCapability({
  name: 'split_grid',
  title: '宫格切分',
  description:
    '把一张九宫格 / 四宫格等宫格图按 rows 行 cols 列切成单张图片，排在原图右侧并打成一个分镜组（Frame，按行优先编号，记下原图）。返回 frame_id、每格的 element_ids 和 asset_ids。element_id 是图片元素，或当前结果是图片的节点。每条分界线均分原图，余数归入后续格子，不丢像素；与界面「宫格切分」同一规则。本地加工，不调模型；每格都是新的资产。',
  group: 'media',
  where: 'server',
  effect: 'edit',
  input: z.object({
    element_id: id.describe('宫格图所在的元素'),
    rows: z.number().int().min(1).max(8),
    cols: z.number().int().min(1).max(8),
  }),
  run: async (ctx, a) => {
    if (a.rows * a.cols < 2) throw new CapabilityError('行列至少有一个大于 1')
    const source = ctx.withDoc((doc) => {
      const el = need(doc, a.element_id)
      if (doc.readOnly || el.locked) throw new CapabilityError('素材只读或已锁定，不能切分')
      const media = elementMedia(el)
      if (media?.kind !== 'image') throw new CapabilityError(`${a.element_id} 上没有图片`)
      return media.assetId
    })
    const asset = ctx.env.assets.get(ctx.env.ownerId, source)
    if (!asset) throw new CapabilityError(`资产 ${source} 不存在`)
    const path = ctx.env.assets.originalPath(source)
    let plan
    try {
      const { width, height } = await orientedSize(path)
      plan = gridPlan(width, height, a.rows, a.cols)
    } catch (err) {
      if (err instanceof CapabilityError) throw err
      throw new CapabilityError((err as Error).message)
    }
    const tileAssets: string[] = []
    for (const tile of plan.tiles) {
      const png = await sharp(path)
        .rotate()
        .extract({ left: tile.left, top: tile.top, width: tile.width, height: tile.height })
        .png()
        .toBuffer()
      try {
        const made = await ctx.env.assets.ingest(ctx.env.ownerId, Readable.from([png]), {
          mime: 'image/png',
          name: `宫格-${tile.n}.png`,
        })
        tileAssets.push(made.id)
      } catch (err) {
        if (err instanceof UploadTooLargeError) throw new CapabilityError(err.message)
        throw err
      }
    }
    return ctx.withDoc((doc) => {
      // 切图期间来源可能已被改动：以现在的文档为准，不把旧图的切片写进去
      const el = doc.get(a.element_id)
      if (!el)
        throw new CapabilityError('来源元素已删除，切图未写入画布；已入库的切片可在素材中查看')
      if (doc.readOnly || el.locked) throw new CapabilityError('素材只读或已锁定，切图未写入画布')
      if (elementMedia(el)?.assetId !== source)
        throw new CapabilityError('来源图片已变化，切图未写入画布；已入库的切片可在素材中查看')
      const placed = placeGrid(doc, a.element_id, plan, tileAssets)
      return {
        frame_id: placed.frame,
        element_ids: placed.elements,
        asset_ids: tileAssets,
        rows: plan.rows,
        cols: plan.cols,
        source_size: `${plan.tiles.at(-1)!.left + plan.tiles.at(-1)!.width}×${plan.tiles.at(-1)!.top + plan.tiles.at(-1)!.height}`,
      }
    })
  },
})

export const imageCapabilities = [splitGrid]
