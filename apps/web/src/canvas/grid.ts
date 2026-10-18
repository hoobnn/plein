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
    if (bitmap.width < cols || bitmap.height < rows)
      throw new Error(
        `图片只有 ${bitmap.width}×${bitmap.height} 像素，无法切成 ${rows}×${cols}；请使用至少 ${cols}×${rows} 像素的图片`,
      )
    // 用每条分界线划分原图，余数归入后续格子，不丢弃右侧或底部像素。
    const xs = Array.from({ length: cols + 1 }, (_, c) => Math.floor((c * bitmap.width) / cols))
    const ys = Array.from({ length: rows + 1 }, (_, r) => Math.floor((r * bitmap.height) / rows))
    const k = TILE_SIDE / Math.max(Math.ceil(bitmap.width / cols), Math.ceil(bitmap.height / rows))
    const widths = Array.from({ length: cols }, (_, c) =>
      Math.max(1, Math.round((xs[c + 1]! - xs[c]!) * k)),
    )
    const heights = Array.from({ length: rows }, (_, r) =>
      Math.max(1, Math.round((ys[r + 1]! - ys[r]!) * k)),
    )
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')!
    const total = rows * cols
    const list: NewElement[] = []
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const tw = xs[c + 1]! - xs[c]!
        const th = ys[r + 1]! - ys[r]!
        canvas.width = tw
        canvas.height = th
        ctx.drawImage(bitmap, xs[c]!, ys[r]!, tw, th, 0, 0, tw, th)
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
          w: widths[c]!,
          h: heights[r]!,
          x: widths.slice(0, c).reduce((sum, w) => sum + w, 0) + c * GAP,
          y: heights.slice(0, r).reduce((sum, h) => sum + h, 0) + r * GAP,
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
      widths.reduce((sum, w) => sum + w, 0) + (cols - 1) * GAP + pad * 2,
      heights.reduce((sum, h) => sum + h, 0) + (rows - 1) * GAP + pad * 2,
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

export interface DownloadItem {
  assetId: string
  name: string
}

/** 逐个读取原文件再交给浏览器，读取失败保留重试队列，不把 HTTP 错误页存成素材。 */
export async function downloadAll(
  items: readonly DownloadItem[],
  signal: AbortSignal,
  onProgress: (started: number, failed: number) => void,
) {
  let started = 0
  const failed: DownloadItem[] = []
  let index = 0
  for (; index < items.length; index++) {
    if (signal.aborted) break
    const item = items[index]!
    try {
      const blob = await api.assetBlob(
        item.assetId,
        AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
      )
      signal.throwIfAborted()
      const url = URL.createObjectURL(blob)
      try {
        const a = document.createElement('a')
        a.href = url
        a.download = item.name
        document.body.appendChild(a)
        try {
          a.click()
        } finally {
          a.remove()
        }
      } finally {
        // 给浏览器接手 Blob 的时间；不在整个批次结束前积存所有文件。
        setTimeout(() => URL.revokeObjectURL(url), 1000)
      }
      started++
    } catch {
      if (signal.aborted) break
      failed.push(item)
    }
    onProgress(started, failed.length)
    if (index + 1 < items.length) await new Promise<void>((resolve) => setTimeout(resolve, 250))
  }
  return { started, failed, remaining: [...failed, ...items.slice(index)] }
}
