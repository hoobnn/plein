import { vi } from 'vite-plus/test'

/** 只替换 2D 绘制边界；命令顺序可观察，不把替身当作真实像素验收。 */
export function mockMaskCanvas() {
  const contexts = new Map<HTMLCanvasElement, ReturnType<typeof makeContext>>()
  function makeContext(canvas: HTMLCanvasElement) {
    const draws: unknown[][] = []
    return {
      canvas,
      draws,
      save: vi.fn(),
      restore: vi.fn(),
      clearRect: () => {
        draws.length = 0
      },
      fillRect: (...args: number[]) => {
        draws.push(['rect', ...args])
      },
      drawImage: (...args: unknown[]) => {
        draws.push(['image', ...args])
      },
      beginPath: vi.fn(),
      arc: (...args: number[]) => {
        draws.push(['arc', ...args])
      },
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: () => {
        draws.push(['stroke'])
      },
      fill: vi.fn(),
      getImageData: () => ({ data: new Uint8ClampedArray([255, 255, 255, 255]) }),
      putImageData: vi.fn(),
    }
  }
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (
    this: HTMLCanvasElement,
  ) {
    if (!contexts.has(this)) contexts.set(this, makeContext(this))
    return contexts.get(this) as never
  })
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) =>
    callback(new Blob(['mask'], { type: 'image/png' })),
  )
  const captures = new WeakMap<Element, number>()
  vi.spyOn(Element.prototype, 'setPointerCapture').mockImplementation(function (this: Element, id) {
    captures.set(this, id)
  })
  vi.spyOn(Element.prototype, 'hasPointerCapture').mockImplementation(function (this: Element, id) {
    return captures.get(this) === id
  })
  vi.spyOn(Element.prototype, 'releasePointerCapture').mockImplementation(function (this: Element) {
    captures.delete(this)
  })
  return {
    draws: (canvas: HTMLCanvasElement) => contexts.get(canvas)!.draws.map((draw) => [...draw]),
  }
}
