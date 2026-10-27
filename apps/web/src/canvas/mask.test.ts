import { afterEach, expect, it, vi } from 'vite-plus/test'
import { drawMask, exportMask, normRect } from './mask'

afterEach(() => vi.unstubAllGlobals())
it('反向框选和越界矩形裁到原图范围，零面积不变成负尺寸', () => {
  expect(normRect([180, 100], [-20, -10], { width: 160, height: 96 })).toEqual({
    x: 0,
    y: 0,
    w: 160,
    h: 96,
  })
  expect(normRect([80, 60], [20, 30], { width: 160, height: 96 })).toEqual({
    x: 20,
    y: 30,
    w: 60,
    h: 30,
  })
  expect(normRect([-20, 20], [-10, 30], { width: 160, height: 96 }).w).toBe(0)
})
it('橡皮在叠加层擦透明，在导出层涂黑；原图坐标按比例回放', () => {
  const calls: Array<{ color: string; composite: string; size: number }> = []
  const ctx = {
    canvas: { width: 320, height: 192 },
    globalCompositeOperation: '',
    fillStyle: '',
    lineWidth: 0,
    save() {},
    restore() {},
    clearRect() {},
    fillRect: vi.fn(),
    beginPath() {},
    arc() {},
    fill() {
      calls.push({
        color: this.fillStyle,
        composite: this.globalCompositeOperation,
        size: this.lineWidth,
      })
    },
  }
  for (const mode of ['overlay', 'export'] as const)
    drawMask(
      ctx as unknown as CanvasRenderingContext2D,
      [
        { type: 'rect', x: 10, y: 20, w: 30, h: 40 },
        { type: 'erase', size: 10, points: [[20, 20]] },
      ],
      { mode, scale: 2 },
    )
  expect(calls).toEqual([
    { color: '#000000', composite: 'destination-out', size: 20 },
    { color: '#000000', composite: 'source-over', size: 20 },
  ])
  expect(ctx.fillRect).toHaveBeenCalledWith(20, 40, 60, 80)
})
it('全黑区域拒绝导出，有覆盖时二值化灰边并输出原图尺寸', async () => {
  let data = new Uint8ClampedArray([127, 127, 127, 0, 0, 0, 0, 0])
  const put = vi.fn()
  const encode = vi.fn((done: BlobCallback) => done(new Blob(['png'])))
  const canvas = { width: 0, height: 0, getContext: () => ctx, toBlob: encode }
  const ctx = {
    canvas,
    save() {},
    restore() {},
    fillRect() {},
    getImageData: () => ({ data }),
    putImageData: put,
  }
  vi.stubGlobal('document', { createElement: () => canvas })
  expect(await exportMask([], { width: 2, height: 1 })).toBeNull()
  expect(encode).not.toHaveBeenCalled()
  data = new Uint8ClampedArray([128, 80, 60, 0, 127, 200, 255, 0])
  expect(await exportMask([], { width: 2, height: 1 })).toBeInstanceOf(Blob)
  expect([canvas.width, canvas.height]).toEqual([2, 1])
  expect([...data]).toEqual([255, 255, 255, 255, 0, 0, 0, 255])
  expect(put).toHaveBeenCalledOnce()
  expect(encode).toHaveBeenCalledWith(expect.any(Function), 'image/png')
})
