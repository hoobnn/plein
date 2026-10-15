import { Readable } from 'node:stream'
import { MediaCollageRequest, type MediaCollage } from '@plein/protocol'
import sharp, { type OverlayOptions } from 'sharp'
import { DeriveError } from './derive'
import type { AssetStore } from './store'

/** 拼图最长边上限：再大浏览器和平台都吃不消 */
export const COLLAGE_MAX_SIDE = 8192

/** 序号角标：圆角深底白字，按格子大小缩放 */
function badge(n: number, cell: number) {
  const size = Math.max(28, Math.round(cell * 0.14))
  const w = Math.round(size * (n >= 10 ? 1.5 : 1.1))
  const font = Math.round(size * 0.62)
  return {
    svg: Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${size}">` +
        `<rect width="${w}" height="${size}" rx="${Math.round(size * 0.28)}" fill="#000" fill-opacity="0.72"/>` +
        `<text x="50%" y="50%" dy="0.35em" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" ` +
        `font-weight="700" font-size="${font}" fill="#fff">${n}</text></svg>`,
    ),
    pad: Math.round(size * 0.35),
  }
}

/**
 * 按顺序把图片拼成一张：每格大小一致（取第一张的比例），图片等比放进格子居中，留白用底色。
 * 返回新资产和它的实际像素
 */
export async function collageAssets(
  store: AssetStore,
  ownerId: string,
  input: MediaCollageRequest,
): Promise<MediaCollage> {
  const req = MediaCollageRequest.parse(input)
  const srcs = req.assetIds.map((id) => {
    const a = store.get(ownerId, id)
    if (!a) throw new DeriveError('not_found', '资产不存在')
    if (a.kind !== 'image') throw new DeriveError('unsupported', `「${a.name}」不是图片，不能拼图`)
    return a
  })
  const metas = await Promise.all(
    srcs.map((a) => sharp(store.originalPath(a.id), { failOn: 'none' }).metadata()),
  )
  // 按纠正方向后的尺寸算（手机照片常带 EXIF 旋转）
  const first = metas[0]!.autoOrient
  if (!first?.width || !first.height) throw new DeriveError('invalid', '读不到图片尺寸')
  const cols = Math.min(req.cols, srcs.length)
  const rows = Math.ceil(srcs.length / cols)
  const aspect = first.width / first.height
  // 格子长边：默认第一张原图的长边，再按总尺寸上限收
  let long = req.cell ?? Math.min(2048, Math.max(first.width, first.height))
  const outOf = (l: number) => {
    const cw = Math.round(aspect >= 1 ? l : l * aspect)
    const ch = Math.round(aspect >= 1 ? l / aspect : l)
    return {
      cw,
      ch,
      W: cols * cw + (cols + 1) * req.gap,
      H: rows * ch + (rows + 1) * req.gap,
    }
  }
  let dim = outOf(long)
  const over = Math.max(dim.W, dim.H) / COLLAGE_MAX_SIDE
  if (over > 1) {
    long = Math.floor(long / over) - req.gap
    dim = outOf(long)
  }
  const { cw, ch, W, H } = dim

  const layers: OverlayOptions[] = []
  for (const [i, a] of srcs.entries()) {
    const x = req.gap + (i % cols) * (cw + req.gap)
    const y = req.gap + Math.floor(i / cols) * (ch + req.gap)
    const { data, info } = await sharp(store.originalPath(a.id), { failOn: 'none' })
      .rotate()
      .resize(cw, ch, { fit: 'inside' })
      .png()
      .toBuffer({ resolveWithObject: true })
    layers.push({
      input: data,
      left: x + Math.floor((cw - info.width) / 2),
      top: y + Math.floor((ch - info.height) / 2),
    })
    if (req.numbers) {
      const b = badge(i + 1, Math.min(cw, ch))
      layers.push({ input: b.svg, left: x + b.pad, top: y + b.pad })
    }
  }
  const png = await sharp({
    create: { width: W, height: H, channels: 3, background: req.background },
  })
    .composite(layers)
    .removeAlpha()
    .png()
    .toBuffer()
  const asset = await store.ingest(ownerId, Readable.from(png), {
    mime: 'image/png',
    name: `${req.name ?? '拼图'}.png`,
  })
  return { asset, width: W, height: H, cols, rows }
}
