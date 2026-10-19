import type { Engine } from '@plein/canvas-core'
import { AUDIO_SIZE, createElements, findFreeSpot, type NewElement } from '@plein/doc'
import type { Asset } from '@plein/protocol'
import { api } from '../api/client'
import { containingFrame, placeElement } from './nodes'

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

const isTextFile = (f: File) =>
  TEXT_EXT.test(f.name) || f.type === 'text/markdown' || f.type === 'text/plain'

function fit(w: number | undefined, h: number | undefined, fallback: [number, number]) {
  if (!w || !h) return fallback
  const k = Math.min(1, MAX_SIDE / Math.max(w, h))
  return [Math.round(w * k), Math.round(h * k)] as const
}

/** 文本内容生成 Markdown 元素的尺寸：宽固定，高随行数 */
function markdownSize(text: string): [number, number] {
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
      return { ...base, kind: 'audio', ...AUDIO_SIZE }
    default:
      return null
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>) {
  // oxlint-disable-next-line unicorn/no-new-array -- 按长度预分配，结果按下标写回
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
  options: { signal?: AbortSignal; select?: boolean } = {},
): Promise<ImportResult> {
  const { signal } = options
  signal?.throwIfAborted()
  if (engine.doc.readOnly) throw new Error('当前画布只读，无法导入素材')
  const skipped: ImportResult['skipped'] = []
  let done = 0
  const inputs = await mapLimit(files, CONCURRENCY, async (file) => {
    try {
      signal?.throwIfAborted()
      if (isTextFile(file)) {
        const text = await file.text()
        const [w, h] = markdownSize(text)
        return { kind: 'markdown', w, h, text, name: file.name } as Omit<NewElement, 'x' | 'y'>
      }
      const asset = await api.upload(file, signal)
      const input = elementFor(asset)
      if (!input) skipped.push({ name: file.name, reason: '暂不支持这种文件' })
      // 相同内容会复用已有资产，画布名称仍应来自这次导入的文件。
      return input ? { ...input, name: file.name } : null
    } catch (err) {
      skipped.push({ name: file.name, reason: (err as Error).message })
      return null
    } finally {
      done++
      if (!signal?.aborted) onProgress?.(done, files.length)
    }
  })

  signal?.throwIfAborted()
  const valid = inputs.filter((input) => input !== null)
  if (!valid.length) return { created: [], skipped }
  let x = at.x
  const list: NewElement[] = []
  for (const input of valid) {
    list.push({ ...input, x, y: at.y - input.h / 2 } as NewElement)
    x += input.w + GAP
  }
  const created = placeImports(engine, list)
  if (created.length && options.select !== false) engine.selection.set(created)
  return { created, skipped }
}

/** 按世界坐标布局整批避让并归组，保留相对位置与一步撤销。 */
export function placeImports(engine: Engine, list: NewElement[]): string[] {
  if (!list.length) return []
  const x0 = Math.min(...list.map((el) => el.x))
  const y0 = Math.min(...list.map((el) => el.y))
  const spot = findFreeSpot(engine.doc, {
    x: x0,
    y: y0,
    w: Math.max(...list.map((el) => el.x + el.w)) - x0,
    h: Math.max(...list.map((el) => el.y + el.h)) - y0,
  })
  const placed = list.map((input) => {
    const x = input.x + spot.x - x0
    const y = input.y + spot.y - y0
    const parentId = containingFrame(engine, { x, y, w: input.w, h: input.h })
    const origin = (parentId && engine.doc.worldRect(parentId)) || { x: 0, y: 0 }
    return {
      ...input,
      parentId,
      x: Math.round(x - origin.x),
      y: Math.round(y - origin.y),
    } as NewElement
  })
  engine.doc.undo.stopCapturing()
  const created = createElements(engine.doc, placed)
  engine.doc.undo.stopCapturing()
  return created
}

/** 成功放入后保留选择；新内容超出可见区域时让用户立即找到它。参考图上传不调用此入口。 */
export function revealImports(engine: Engine, ids: string[]) {
  if (!ids.length) return
  engine.doc.flush()
  engine.selection.set(ids)
  engine.setTool('select')
  const rects = ids.map((id) => engine.doc.worldRect(id)).filter((r) => !!r)
  if (!rects.length) return
  const x = Math.min(...rects.map((r) => r.x))
  const y = Math.min(...rects.map((r) => r.y))
  const w = Math.max(...rects.map((r) => r.x + r.w)) - x
  const h = Math.max(...rects.map((r) => r.y + r.h)) - y
  const camera = engine.camera
  const tl = camera.worldToScreen(x, y)
  const br = camera.worldToScreen(x + w, y + h)
  const left = camera.insets.left + 12
  const right = camera.width - camera.insets.right - 12
  const top = Math.max(64, camera.insets.top)
  const bottom = camera.height - Math.max(64, camera.insets.bottom)
  if (tl.x >= left && br.x <= right && tl.y >= top && br.y <= bottom) return
  if (w * camera.zoom <= right - left && h * camera.zoom <= bottom - top)
    camera.centerOn(x + w / 2, y + h / 2)
  else engine.zoomToFit(ids)
}

/** 粘贴的纯文本建成 Markdown 元素 */
export function importText(engine: Engine, text: string, at: { x: number; y: number }) {
  const [w, h] = markdownSize(text)
  const id = placeElement(engine, { kind: 'markdown', text, w, h }, at)
  if (id) engine.selection.set([id])
}
