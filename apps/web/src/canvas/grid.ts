import type { Engine } from '@plein/canvas-core'
import { createElements, groupElements, type NewElement } from '@plein/doc'
import { api, assetUrls } from '../api/client'
import { freeSpotRight } from './presets'

/** 切出来的每格在画布上的长边 */
const TILE_SIDE = 240
const GAP = 16

/**
 * 宫格切分：把一张九宫格 / 四宫格图按行列切成单张图片，上传为资产，
 * 按原来的格子排在源元素右侧并打成一组。切图在浏览器里完成，不调模型。
 */
export async function splitGrid(
  engine: Engine,
  sourceId: string,
  assetId: string,
  rows: number,
  cols: number,
  onProgress?: (done: number, total: number) => void,
): Promise<string | null> {
  const rect = engine.scene.rect(sourceId)
  if (!rect) return null
  const res = await fetch(assetUrls.original(assetId), { credentials: 'same-origin' })
  if (!res.ok) throw new Error('原图下载失败')
  const bitmap = await createImageBitmap(await res.blob())
  const tw = Math.floor(bitmap.width / cols)
  const th = Math.floor(bitmap.height / rows)
  const canvas = document.createElement('canvas')
  canvas.width = tw
  canvas.height = th
  const ctx = canvas.getContext('2d')!
  const total = rows * cols
  const k = TILE_SIDE / Math.max(tw, th)
  const w = Math.round(tw * k)
  const h = Math.round(th * k)
  // 整组（含打组留的边距）在右侧找空位，不压住已有元素
  const pad = 32
  const spot = freeSpotRight(
    engine,
    sourceId,
    cols * (w + GAP) - GAP + pad * 2,
    rows * (h + GAP) - GAP + pad * 2,
  )
  const x0 = spot.x + pad
  const y0 = spot.y + pad
  const list: NewElement[] = []
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      ctx.clearRect(0, 0, tw, th)
      ctx.drawImage(bitmap, c * tw, r * th, tw, th, 0, 0, tw, th)
      const blob = await new Promise<Blob | null>((ok) => canvas.toBlob(ok, 'image/png'))
      if (!blob) throw new Error('切图失败')
      const n = r * cols + c + 1
      const asset = await api.upload(new File([blob], `宫格-${n}.png`, { type: 'image/png' }))
      list.push({
        kind: 'image',
        assetId: asset.id,
        name: `宫格 ${n}`,
        w,
        h,
        x: Math.round(x0 + c * (w + GAP)),
        y: Math.round(y0 + r * (h + GAP)),
      })
      onProgress?.(n, total)
    }
  }
  bitmap.close()
  const ids = createElements(engine.doc, list)
  const frame = groupElements(engine.doc, ids, { name: `宫格切分 ${rows}×${cols}` })
  engine.selection.set([frame ?? ids[0]!])
  return frame
}

/** 下载资产原文件（浏览器另存为） */
export function downloadAsset(assetId: string, name: string) {
  const a = document.createElement('a')
  a.href = assetUrls.original(assetId)
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
}
