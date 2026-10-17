import type { Engine } from '@plein/canvas-core'
import {
  type CanvasElement,
  createElements,
  elementMedia,
  groupElements,
  makeShotGroup,
  type NewElement,
  spotRightOf,
} from '@plein/doc'
import { api, assetUrls } from '../api/client'

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
  signal?: AbortSignal,
): Promise<string | null> {
  const rect = engine.scene.rect(sourceId)
  if (!rect) return null
  const bitmap = await createImageBitmap(await api.assetBlob(assetId, signal))
  try {
    signal?.throwIfAborted()
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
    const list: NewElement[] = []
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        ctx.clearRect(0, 0, tw, th)
        ctx.drawImage(bitmap, c * tw, r * th, tw, th, 0, 0, tw, th)
        const blob = await new Promise<Blob | null>((ok) => canvas.toBlob(ok, 'image/png'))
        if (!blob) throw new Error('切图失败')
        const n = r * cols + c + 1
        signal?.throwIfAborted()
        const asset = await api.upload(
          new File([blob], `宫格-${n}.png`, { type: 'image/png' }),
          signal,
        )
        list.push({
          kind: 'image',
          assetId: asset.id,
          name: `宫格 ${n}`,
          w,
          h,
          x: c * (w + GAP),
          y: r * (h + GAP),
        })
        onProgress?.(n, total)
      }
    }
    signal?.throwIfAborted()
    if (!engine.doc.has(sourceId)) throw new Error('来源元素已删除，切图未写入画布')
    const current = engine.doc.get(sourceId)!
    if (mediaOf(current)?.assetId !== assetId)
      throw new Error('来源图片已变化，切图未写入画布；已上传的切片可在素材中查看')
    // 上传完成后再按当前文档布局找空位，避免沿用旧相机／场景索引中的位置。
    const pad = 32
    const spot = spotRightOf(
      engine.doc,
      sourceId,
      cols * (w + GAP) - GAP + pad * 2,
      rows * (h + GAP) - GAP + pad * 2,
    )
    engine.doc.undo.stopCapturing()
    const ids = createElements(
      engine.doc,
      list.map((el) => ({
        ...el,
        x: Math.round(el.x + spot.x + pad),
        y: Math.round(el.y + spot.y + pad),
      })),
    )
    const frame = groupElements(engine.doc, ids, { name: `宫格切分 ${rows}×${cols}` })
    // 切出来的直接是分镜组：按格子顺序编号，记下原图，能从组回到切之前的那张
    if (frame)
      makeShotGroup(engine.doc, frame, { cols, source: { elementId: sourceId, rows, cols } })
    engine.doc.undo.stopCapturing()
    engine.selection.set([frame ?? ids[0]!])
    return frame
  } finally {
    bitmap.close()
  }
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

/** 元素当前展示的图片或视频（不含音频） */
export function mediaOf(el: CanvasElement): { assetId: string; kind: 'image' | 'video' } | null {
  const m = elementMedia(el)
  return m && m.kind !== 'audio' ? { assetId: m.assetId, kind: m.kind } : null
}

/** 批量下载：逐个触发，间隔一点免得浏览器吞掉；返回下载的个数 */
export function downloadAll(items: Array<{ assetId: string; name: string }>) {
  items.forEach((it, i) => {
    setTimeout(() => downloadAsset(it.assetId, it.name), i * 250)
  })
  return items.length
}
