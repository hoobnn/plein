/** 画幅字符串（`16:9`）转宽高比，无法识别时为 1 */
export function ratioOf(aspect: string | undefined) {
  const m = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(aspect ?? '')
  return m ? Number(m[1]) / Number(m[2]) : 1
}

/** 按总像素和画幅算宽高，向下取到 step 的倍数（不会超过总像素） */
export function sizeByArea(aspect: string | undefined, pixels: number, step = 16) {
  const r = ratioOf(aspect)
  const width = Math.floor(Math.sqrt(pixels * r) / step) * step
  const height = Math.floor(Math.sqrt(pixels / r) / step) * step
  return { width, height }
}

/** 按长边和画幅算宽高，短边向下取到 step 的倍数 */
export function sizeByLongEdge(aspect: string | undefined, edge: number, step = 8) {
  const r = ratioOf(aspect)
  const short = Math.floor(edge / Math.max(r, 1 / r) / step) * step
  return r >= 1 ? { width: edge, height: short } : { width: short, height: edge }
}

/** `2K`、`1.5K` 这类档位换成边长（1K = 1024） */
export function tierEdge(tier: string) {
  const m = /^(\d+(?:\.\d+)?)K$/i.exec(tier)
  return m ? Math.round(Number(m[1]) * 1024) : undefined
}
