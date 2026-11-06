import type { Engine } from '@plein/canvas-core'
import { type CanvasElement, elementMedia, gridPlan, placeGrid } from '@plein/doc'
import { api } from '../api/client'

/**
 * 宫格切分：把一张九宫格 / 四宫格图按行列切成单张图片，上传为资产，
 * 按原来的格子排在源元素右侧并打成一组。切图在浏览器里完成，不调模型。
 * 分界与排布规则在 @plein/doc 的 gridPlan，服务端的 split_grid 用同一份。
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
  if (engine.doc.readOnly || engine.doc.get(sourceId)?.locked)
    throw new Error('当前素材只读或已锁定，不能切分')
  const sourceMap = engine.doc.elementMaps.get(sourceId)
  const rect = engine.scene.rect(sourceId)
  if (!rect) return null
  const bitmap = await createImageBitmap(await api.assetBlob(assetId, signal))
  try {
    signal?.throwIfAborted()
    const plan = gridPlan(bitmap.width, bitmap.height, rows, cols)
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')!
    const total = rows * cols
    const tileAssets: string[] = []
    for (const tile of plan.tiles) {
      canvas.width = tile.width
      canvas.height = tile.height
      ctx.drawImage(
        bitmap,
        tile.left,
        tile.top,
        tile.width,
        tile.height,
        0,
        0,
        tile.width,
        tile.height,
      )
      const blob = await new Promise<Blob | null>((ok) => canvas.toBlob(ok, 'image/png'))
      if (!blob) throw new Error('切图失败')
      signal?.throwIfAborted()
      const asset = await api.upload(
        new File([blob], `宫格-${tile.n}.png`, { type: 'image/png' }),
        signal,
      )
      tileAssets.push(asset.id)
      onProgress?.(tile.n, total)
    }
    signal?.throwIfAborted()
    if (engine.doc.readOnly || engine.doc.get(sourceId)?.locked)
      throw new Error('当前素材只读或已锁定，切图未写入画布')
    if (!engine.doc.has(sourceId) || engine.doc.elementMaps.get(sourceId) !== sourceMap)
      throw new Error('来源元素已删除或替换，切图未写入画布')
    const current = engine.doc.get(sourceId)!
    if (mediaOf(current)?.assetId !== assetId)
      throw new Error('来源图片已变化，切图未写入画布；已上传的切片可在素材中查看')
    // 上传完成后再按当前文档布局找空位，避免沿用旧相机／场景索引中的位置。
    engine.doc.undo.stopCapturing()
    const { frame } = placeGrid(engine.doc, sourceId, plan, tileAssets)
    engine.doc.undo.stopCapturing()
    return frame
  } finally {
    bitmap.close()
  }
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

const FILE_EXTENSIONS: Record<string, readonly string[]> = {
  'image/png': ['png'],
  'image/jpeg': ['jpg', 'jpeg'],
  'image/webp': ['webp'],
  'image/gif': ['gif'],
  'image/avif': ['avif'],
  'image/svg+xml': ['svg'],
  'image/x-icon': ['ico'],
  'image/vnd.microsoft.icon': ['ico'],
  'video/mp4': ['mp4'],
  'video/webm': ['webm'],
  'video/quicktime': ['mov'],
  'audio/mpeg': ['mp3'],
  'audio/wav': ['wav'],
  'audio/x-wav': ['wav'],
  'audio/ogg': ['ogg', 'oga'],
  'audio/mp4': ['m4a'],
  'audio/aac': ['aac'],
  'audio/flac': ['flac'],
}

/** 标题里的点号不等于文件扩展名；以实际读取的格式补齐，保留正确的大小写及别名。 */
function downloadName(name: string, mime: string) {
  const extensions = FILE_EXTENSIONS[mime.split(';')[0]!.trim().toLowerCase()]
  if (!extensions || extensions.some((ext) => name.toLowerCase().endsWith(`.${ext}`))) return name
  return `${name}.${extensions[0]}`
}

/** 逐个读取原文件再交给浏览器，读取失败保留重试队列，不把 HTTP 错误页存成素材。 */
export async function downloadAll(
  items: readonly DownloadItem[],
  signal: AbortSignal,
  onProgress: (started: number, failed: number) => void,
  canDownload: () => boolean = () => true,
) {
  let started = 0
  const failed: DownloadItem[] = []
  let index = 0
  for (; index < items.length; index++) {
    if (signal.aborted || !canDownload()) break
    const item = items[index]!
    try {
      const blob = await api.assetBlob(
        item.assetId,
        AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
      )
      signal.throwIfAborted()
      if (!canDownload()) break
      const url = URL.createObjectURL(blob)
      try {
        const a = document.createElement('a')
        a.href = url
        a.download = downloadName(item.name, blob.type)
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
