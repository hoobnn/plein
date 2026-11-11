import { Readable } from 'node:stream'
import { CapabilityError, capabilityFor, need } from '@plein/capabilities'
import { elementMedia, gridPlan, placeGrid, setParams } from '@plein/doc'
import sharp, { type Sharp } from 'sharp'
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
    '把一张九宫格 / 四宫格等宫格图按 rows 行 cols 列切成单张图片，排在原图右侧并打成一个分镜组（分组框，按行优先编号，记下原图）。返回 frame_id、每格的 element_ids 和 asset_ids。element_id 是图片元素，或当前结果是图片的节点。每条分界线均分原图，余数归入后续格子，不丢像素；与界面「宫格切分」同一规则。本地加工，不调模型；每格都是新的资产。',
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

const num = z.number().finite()
const rect = z.object({ x: num, y: num, w: num.positive(), h: num.positive() })

/** 把形状画成黑底白区的二值蒙版（和界面 exportMask 同一契约：和原图同宽高，白 = 重绘，黑 = 保留） */
async function drawMask(
  width: number,
  height: number,
  shapes: { rects: z.output<typeof rect>[]; polygons: Array<Array<[number, number]>> },
  grow: number,
) {
  // 外扩 grow 像素：给形状加同色描边（圆角连接），边缘就向外长出一圈
  const stroke = grow > 0 ? ` stroke="#fff" stroke-width="${grow * 2}" stroke-linejoin="round"` : ''
  const body = [
    ...shapes.rects.map(
      (r) => `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" fill="#fff"${stroke}/>`,
    ),
    ...shapes.polygons.map(
      (p) => `<polygon points="${p.map(([x, y]) => `${x},${y}`).join(' ')}" fill="#fff"${stroke}/>`,
    ),
  ].join('')
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#000"/>${body}</svg>`
  return binarize(sharp(Buffer.from(svg)))
}

/** 抗锯齿的灰边二值化：平台只认黑白 */
async function binarize(img: Sharp) {
  return img
    .flatten({ background: '#000' })
    .greyscale()
    .threshold(128)
    .toColourspace('srgb')
    .png()
    .toBuffer()
}

export const createMask = serverCapability({
  name: 'create_mask',
  title: '生成重绘蒙版',
  description:
    '为局部重绘生成蒙版：element_id 是 plein/image-edit 节点（原图取自连入 image 端口的图片，也可用 source_asset_id 指定）时，蒙版写入该节点的 mask 参数，下次 run_node 只重绘圈出的区域；element_id 是图片元素时只生成蒙版资产，返回 mask_asset_id。圈区域用 rects（{x,y,w,h}）和 polygons（点列 [[x,y],…]，至少 3 点），坐标是原图像素（左上角为原点；normalized=true 时改用 0–1 的比例）。feather 把边缘向外扩这么多像素，让重绘边界融入周围（平台只认黑白，所以不做渐变）。也可以不画而传 mask_asset_id，用 import_asset 送进来的外部蒙版（白色 = 重绘，黑色 = 保留，宽高比须与原图一致，会缩放到原图尺寸并二值化）。蒙版为黑底白区 PNG，与原图同宽高；至少要圈出一块区域。',
  group: 'media',
  where: 'server',
  effect: 'edit',
  input: z
    .object({
      element_id: id.describe('plein/image-edit 节点，或要为其生成蒙版的图片元素'),
      rects: z.array(rect).max(200).optional(),
      polygons: z
        .array(
          z
            .array(z.tuple([num, num]))
            .min(3)
            .max(2000),
        )
        .max(100)
        .optional(),
      normalized: z.boolean().default(false).describe('坐标是 0–1 的比例而不是像素'),
      feather: z.number().int().min(0).max(200).default(0).describe('边缘向外扩的像素数'),
      mask_asset_id: id.optional().describe('外部蒙版的资产 id（与 rects / polygons 二选一）'),
      source_asset_id: id.optional().describe('原图资产 id；节点没连原图时指定'),
    })
    .refine((a) => !!(a.rects?.length || a.polygons?.length) !== !!a.mask_asset_id, {
      message: '圈区域（rects / polygons）和 mask_asset_id 必须且只能给一类',
    }),
  run: async (ctx, a) => {
    const target = ctx.withDoc((doc) => {
      const el = need(doc, a.element_id)
      if (doc.readOnly || el.locked) throw new CapabilityError('元素只读或已锁定')
      if (el.kind === 'node') {
        if (el.nodeType !== 'plein/image-edit')
          throw new CapabilityError('只有局部重绘节点（plein/image-edit）有蒙版')
        let source = a.source_asset_id
        if (!source) {
          for (const e of doc.edgesOf(el.id)) {
            if (e.to[0] !== el.id || e.to[1] !== 'image') continue
            const media = elementMedia(need(doc, e.from[0]))
            if (media?.kind === 'image') source = media.assetId
          }
        }
        if (!source)
          throw new CapabilityError(
            '节点还没有连入原图：先把图片连到 image 端口，或传 source_asset_id',
          )
        return { node: el.id, source, name: el.name ?? '局部重绘' }
      }
      const media = elementMedia(el)
      if (media?.kind !== 'image')
        throw new CapabilityError(`${a.element_id} 不是图片或局部重绘节点`)
      return { node: null, source: a.source_asset_id ?? media.assetId, name: el.name ?? '图片' }
    })
    const src = ctx.env.assets.get(ctx.env.ownerId, target.source)
    if (!src || src.kind !== 'image')
      throw new CapabilityError(`原图 ${target.source} 不是有效的图片资产`)
    const path = ctx.env.assets.originalPath(src.id)
    const { width, height } = await orientedSize(path)

    let png: Buffer
    if (a.mask_asset_id) {
      const ext = ctx.env.assets.get(ctx.env.ownerId, a.mask_asset_id)
      if (!ext || ext.kind !== 'image')
        throw new CapabilityError(`蒙版 ${a.mask_asset_id} 不是有效的图片资产`)
      const m = await orientedSize(ctx.env.assets.originalPath(ext.id))
      if (Math.abs(m.width / m.height - width / height) > 0.01)
        throw new CapabilityError(
          `蒙版 ${m.width}×${m.height} 与原图 ${width}×${height} 宽高比不一致，请按原图比例重新制作`,
        )
      png = await binarize(
        sharp(ctx.env.assets.originalPath(ext.id))
          .rotate()
          .resize(width, height, { fit: 'fill', kernel: 'nearest' }),
      )
    } else {
      const fx = a.normalized ? width : 1
      const fy = a.normalized ? height : 1
      png = await drawMask(
        width,
        height,
        {
          rects: (a.rects ?? []).map((r) => ({
            x: r.x * fx,
            y: r.y * fy,
            w: r.w * fx,
            h: r.h * fy,
          })),
          polygons: (a.polygons ?? []).map((p) =>
            p.map(([x, y]) => [x * fx, y * fy] as [number, number]),
          ),
        },
        a.feather,
      )
    }
    // 全黑的蒙版提交了也没用
    const stats = await sharp(png).stats()
    if (stats.channels[0]!.max <= 127)
      throw new CapabilityError('蒙版里没有圈出任何区域（坐标是否超出原图范围？）')

    let made
    try {
      made = await ctx.env.assets.ingest(ctx.env.ownerId, Readable.from([png]), {
        mime: 'image/png',
        name: `${target.name}-蒙版.png`,
      })
    } catch (err) {
      if (err instanceof UploadTooLargeError) throw new CapabilityError(err.message)
      throw err
    }
    const mask = { assetId: made.id, width, height, sourceAssetId: src.id }
    if (!target.node) return { mask_asset_id: made.id, width, height, applied: false }
    ctx.withDoc((doc) => {
      const el = need(doc, target.node!)
      if (doc.readOnly || el.locked) throw new CapabilityError('节点已锁定，蒙版未写入')
      const def = el.nodeType ? ctx.nodes.latest(el.nodeType)?.def : undefined
      if (def) {
        const check = def.params.safeParse({ ...el.params, mask })
        if (!check.success) throw new CapabilityError(`参数不对：${z.prettifyError(check.error)}`)
      }
      setParams(doc, target.node!, { mask })
    })
    return { mask_asset_id: made.id, width, height, applied: true, node_id: target.node }
  },
})

export const imageCapabilities = [splitGrid, createMask]
