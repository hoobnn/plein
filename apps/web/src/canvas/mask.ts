/**
 * 局部重绘的蒙版：记成一串操作（框选、画笔、橡皮），坐标都是原图像素。
 * 屏幕上按缩放回放成半透明高亮；导出时按原图尺寸回放成黑底白区的 PNG，和原图严格对齐。
 */

export type MaskTool = 'rect' | 'brush' | 'erase'

export type MaskOp =
  | { type: 'rect'; x: number; y: number; w: number; h: number }
  | { type: 'brush' | 'erase'; size: number; points: Array<[number, number]> }
  /** 已有的蒙版图（重画时打底） */
  | { type: 'image'; image: CanvasImageSource }

/** 拖出来的矩形：任意方向拖都规整成左上角 + 正宽高，并夹在图内 */
export function normRect(
  a: [number, number],
  b: [number, number],
  size: { width: number; height: number },
) {
  const x0 = Math.max(0, Math.min(a[0], b[0]))
  const y0 = Math.max(0, Math.min(a[1], b[1]))
  const x1 = Math.min(size.width, Math.max(a[0], b[0]))
  const y1 = Math.min(size.height, Math.max(a[1], b[1]))
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) }
}

/**
 * 回放操作。overlay：透明底上画高亮色、橡皮擦掉；export：黑底白区，橡皮涂黑。
 * scale 是原图像素到画布像素的比例。
 */
export function drawMask(
  ctx: CanvasRenderingContext2D,
  ops: readonly MaskOp[],
  opts: { scale: number; mode: 'overlay' | 'export'; color?: string },
) {
  const { scale, mode } = opts
  const { width, height } = ctx.canvas
  const paint = mode === 'export' ? '#ffffff' : (opts.color ?? '#4d8dff')
  ctx.save()
  ctx.globalCompositeOperation = 'source-over'
  if (mode === 'export') {
    ctx.fillStyle = '#000000'
    ctx.fillRect(0, 0, width, height)
  } else ctx.clearRect(0, 0, width, height)
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  for (const op of ops) {
    if (op.type === 'image') {
      ctx.globalCompositeOperation = 'source-over'
      if (mode === 'export') ctx.drawImage(op.image, 0, 0, width, height)
      else drawTinted(ctx, op.image, paint)
      continue
    }
    const erase = op.type === 'erase'
    // 叠加层用 destination-out 擦成透明；导出直接涂黑
    ctx.globalCompositeOperation = erase && mode === 'overlay' ? 'destination-out' : 'source-over'
    const color = erase ? '#000000' : paint
    if (op.type === 'rect') {
      ctx.fillStyle = color
      ctx.fillRect(op.x * scale, op.y * scale, op.w * scale, op.h * scale)
      continue
    }
    ctx.strokeStyle = color
    ctx.fillStyle = color
    ctx.lineWidth = op.size * scale
    const [first, ...rest] = op.points
    if (!first) continue
    if (!rest.length) {
      ctx.beginPath()
      ctx.arc(first[0] * scale, first[1] * scale, (op.size * scale) / 2, 0, Math.PI * 2)
      ctx.fill()
      continue
    }
    ctx.beginPath()
    ctx.moveTo(first[0] * scale, first[1] * scale)
    for (const [x, y] of rest) ctx.lineTo(x * scale, y * scale)
    ctx.stroke()
  }
  ctx.restore()
}

/** 黑白蒙版图转成高亮色叠加：白的地方着色，黑的地方透明 */
function drawTinted(ctx: CanvasRenderingContext2D, image: CanvasImageSource, color: string) {
  const { width, height } = ctx.canvas
  const tmp = document.createElement('canvas')
  tmp.width = width
  tmp.height = height
  const t = tmp.getContext('2d')!
  t.drawImage(image, 0, 0, width, height)
  const data = t.getImageData(0, 0, width, height)
  for (let i = 0; i < data.data.length; i += 4) {
    // 亮度当透明度：白 = 不透明，黑 = 透明
    data.data[i + 3] = data.data[i]!
    data.data[i] = data.data[i + 1] = data.data[i + 2] = 255
  }
  t.putImageData(data, 0, 0)
  t.globalCompositeOperation = 'source-in'
  t.fillStyle = color
  t.fillRect(0, 0, width, height)
  ctx.drawImage(tmp, 0, 0)
}

/** 有没有圈出任何区域（全黑的蒙版提交了也没用） */
function hasCoverage(data: Uint8ClampedArray) {
  for (let i = 0; i < data.length; i += 4) if (data[i]! > 127) return true
  return false
}

/** 按原图尺寸导出黑底白区 PNG */
export async function exportMask(
  ops: readonly MaskOp[],
  size: { width: number; height: number },
): Promise<Blob | null> {
  const canvas = document.createElement('canvas')
  canvas.width = size.width
  canvas.height = size.height
  const ctx = canvas.getContext('2d')!
  drawMask(ctx, ops, { scale: 1, mode: 'export' })
  const img = ctx.getImageData(0, 0, size.width, size.height)
  if (!hasCoverage(img.data)) return null
  // 抗锯齿的灰边二值化：平台只认黑白
  for (let i = 0; i < img.data.length; i += 4) {
    const v = img.data[i]! > 127 ? 255 : 0
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v
    img.data[i + 3] = 255
  }
  ctx.putImageData(img, 0, 0)
  return new Promise((done) => canvas.toBlob((b) => done(b), 'image/png'))
}
