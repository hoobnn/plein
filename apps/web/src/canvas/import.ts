import type { Engine } from '@plein/canvas-core'
import { createElements, type NewElement } from '@plein/doc'
import type { Asset } from '@plein/protocol'
import { api } from '../api/client'

const TEXT_EXT = /\.(md|markdown|mdown|txt)$/i
const MAX_SIDE = 480
const GAP = 24
/** 同时上传的文件数 */
const CONCURRENCY = 3

export interface ImportResult {
  created: string[]
  /** 不支持或失败的文件 */
  skipped: Array<{ name: string; reason: string }>
}

export const isTextFile = (f: File) =>
  TEXT_EXT.test(f.name) || f.type === 'text/markdown' || f.type === 'text/plain'

function fit(w: number | undefined, h: number | undefined, fallback: [number, number]) {
  if (!w || !h) return fallback
  const k = Math.min(1, MAX_SIDE / Math.max(w, h))
  return [Math.round(w * k), Math.round(h * k)] as const
}

/** 文本内容生成 Markdown 元素的尺寸：宽固定，高随行数 */
export function markdownSize(text: string): [number, number] {
  const lines = text.split('\n').length
  return [360, Math.min(480, Math.max(160, lines * 22 + 48))]
}

/** 资产对应的素材元素（按原始比例缩到长边 480） */
export function elementFor(asset: Asset): Omit<NewElement, 'x' | 'y'> | null {
  const base = { assetId: asset.id, name: asset.name }
  switch (asset.kind) {
    case 'image': {
      const [w, h] = fit(asset.width, asset.height, [320, 240])
      return { ...base, kind: 'image', w, h }
    }
    case 'video': {
      const [w, h] = fit(asset.width, asset.height, [480, 270])
      return { ...base, kind: 'video', w, h }
    }
    case 'audio':
      return { ...base, kind: 'audio', w: 384, h: 96 }
    default:
      return null
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>) {
  const out = new Array<R>(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

/**
 * 导入文件：文本类直接建 Markdown 元素；图片 / 视频 / 音频先上传到资产库再建元素。
 * 元素从 at 开始横向排开，全部完成后一次写入文档（一步撤销）。
 */
export async function importFiles(
  engine: Engine,
  files: File[],
  at: { x: number; y: number },
  onProgress?: (done: number, total: number) => void,
): Promise<ImportResult> {
  const skipped: ImportResult['skipped'] = []
  let done = 0
  const inputs = await mapLimit(files, CONCURRENCY, async (file) => {
    try {
      if (isTextFile(file)) {
        const text = await file.text()
        const [w, h] = markdownSize(text)
        return { kind: 'markdown', w, h, text, name: file.name } as Omit<NewElement, 'x' | 'y'>
      }
      const asset = await api.upload(file)
      const input = elementFor(asset)
      if (!input) skipped.push({ name: file.name, reason: '暂不支持这种文件' })
      return input
    } catch (err) {
      skipped.push({ name: file.name, reason: (err as Error).message })
      return null
    } finally {
      onProgress?.(++done, files.length)
    }
  })

  let x = at.x
  const list: NewElement[] = []
  for (const input of inputs) {
    if (!input) continue
    list.push({ ...input, x: Math.round(x), y: Math.round(at.y - input.h / 2) } as NewElement)
    x += input.w + GAP
  }
  const created = list.length ? createElements(engine.doc, list) : []
  if (created.length) engine.selection.set(created)
  return { created, skipped }
}

/** 粘贴的纯文本建成 Markdown 元素 */
export function importText(engine: Engine, text: string, at: { x: number; y: number }) {
  const [w, h] = markdownSize(text)
  const [id] = createElements(engine.doc, [
    { kind: 'markdown', text, w, h, x: Math.round(at.x - w / 2), y: Math.round(at.y - h / 2) },
  ])
  if (id) engine.selection.set([id])
}
