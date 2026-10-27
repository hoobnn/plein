// @vitest-environment happy-dom
import { useState } from 'react'
import { expect, it, vi } from 'vite-plus/test'
import { act, fireEvent, renderApp, screen, waitFor } from '../../testing/render'
import { mockFetch } from '../../testing/fetch'
import { mockResizeObserver } from '../../testing/browser'
import { MaskEditor } from './MaskEditor'
import { mockMaskCanvas } from './testing/maskCanvas'

let serial = 0
async function setup(options: { failMeta?: boolean; initial?: boolean; failMask?: boolean } = {}) {
  const assetId = `mask-source-${++serial}`
  const drawing = mockMaskCanvas()
  const observer = mockResizeObserver()
  let failMeta = options.failMeta ?? false
  let failUpload = false
  let uploads = 0
  let deferred: ((response: Response) => void) | undefined
  let holdUpload = false
  let uploadSignal: AbortSignal | undefined
  const images: HTMLImageElement[] = []
  const NativeImage = Image
  vi.stubGlobal(
    'Image',
    class extends NativeImage {
      constructor() {
        super()
        images.push(this)
      }
    },
  )
  mockFetch((request) => {
    const path = new URL(request.url).pathname
    if (path === `/api/assets/${assetId}/meta`)
      return failMeta
        ? Response.json({ message: '元信息暂不可用' }, { status: 503 })
        : Response.json({ id: assetId, kind: 'image', width: 160, height: 96 })
    if (path === '/api/assets' && request.method === 'POST') {
      uploads++
      uploadSignal = request.signal
      if (holdUpload)
        return new Promise<Response>((resolve) => {
          deferred = resolve
        })
      return failUpload
        ? Response.json({ message: '上传暂不可用' }, { status: 503 })
        : Response.json({ id: 'saved-mask' })
    }
  })
  const saved = vi.fn(),
    closed = vi.fn()
  function Host() {
    const [open, setOpen] = useState(true)
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          重新打开
        </button>
        {open && (
          <MaskEditor
            assetId={assetId}
            name="原图"
            initial={
              options.initial
                ? { assetId: 'prior-mask', sourceAssetId: assetId, width: 160, height: 96 }
                : null
            }
            onClose={() => {
              closed()
              setOpen(false)
            }}
            onSave={(mask) => {
              saved(mask)
              setOpen(false)
            }}
          />
        )}
      </>
    )
  }
  const view = renderApp(<Host />)
  const resize = () => {
    const stage = screen.getByRole('dialog').querySelector('[aria-busy]')!
    act(() => observer.resize(stage, 368, 240))
  }
  resize()
  await waitFor(() => expect(screen.queryByRole('alert') || screen.queryByRole('img')).toBeTruthy())
  const ready = async () => {
    resize()
    await waitFor(() => expect(screen.queryByRole('img')).toBeTruthy())
    await act(async () => {
      for (const image of images.splice(0)) fireEvent.load(image)
      fireEvent.load(screen.getByRole('img'))
    })
    const canvas = (await screen.findByTestId('mask-canvas')) as HTMLCanvasElement
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 320, 192))
    return canvas
  }
  return {
    ...view,
    assetId,
    drawing,
    images,
    ready,
    resize,
    saved,
    closed,
    recover: () => {
      failMeta = false
    },
    fail: (next: boolean) => {
      failUpload = next
    },
    hold: () => {
      holdUpload = true
    },
    uploads: () => uploads,
    signal: () => uploadSignal,
    release: async () => {
      await act(async () => deferred?.(Response.json({ id: 'late-mask' })))
    },
  }
}
function stroke(canvas: HTMLElement, start = 20, finish = 80, pointerId = 1, end = true) {
  fireEvent.pointerDown(canvas, { pointerId, button: 0, clientX: start, clientY: 20 })
  fireEvent.pointerMove(canvas, { pointerId, clientX: finish, clientY: 80 })
  if (end) fireEvent.pointerUp(canvas, { pointerId })
}
const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement

it('元信息失败时冻结绘制与保存，重试后保存原图尺寸和来源', async () => {
  const f = await setup({ failMeta: true })
  expect(screen.getByRole('alert').textContent).toContain('原图信息读取失败')
  expect(screen.queryByTestId('mask-canvas')).toBeNull()
  for (const name of ['画笔', '框选', '橡皮', '撤销', '重做', '清空', '完成'])
    expect(button(name).disabled || !!button(name).closest('fieldset[disabled]')).toBe(true)
  f.recover()
  await f.user.click(button('重新加载'))
  const canvas = await f.ready()
  await f.user.click(button('框选'))
  stroke(canvas)
  await f.user.click(button('完成'))
  await waitFor(() =>
    expect(f.saved).toHaveBeenCalledExactlyOnceWith({
      assetId: 'saved-mask',
      sourceAssetId: f.assetId,
      width: 160,
      height: 96,
    }),
  )
})

it('原图和已有蒙版加载错误可重试，等待中关闭不保存', async () => {
  const f = await setup({ initial: true })
  expect(button('完成').disabled).toBe(true)
  await act(async () => fireEvent.error(f.images.shift()!))
  expect(screen.getByRole('alert').textContent).toContain('已有重绘区域加载失败')
  await f.user.click(button('重新加载'))
  await waitFor(() => expect(screen.queryByRole('img')).toBeTruthy())
  fireEvent.error(screen.getByRole('img'))
  expect(screen.getByRole('alert').textContent).toContain('原图加载失败')
  await f.user.click(button('关闭'))
  expect(f.saved).not.toHaveBeenCalled()
  expect(f.uploads()).toBe(0)
  await f.user.click(button('重新打开'))
  const canvas = await f.ready()
  expect(f.drawing.draws(canvas).some(([kind]) => kind === 'image')).toBe(true)
  await f.user.click(button('清空'))
  expect(button('完成').disabled).toBe(true)
  await f.user.click(button('撤销'))
  expect(button('完成').disabled).toBe(false)
})

it('上传失败在弹窗内保留区域和重试说明，重复点击只提交一次', async () => {
  const f = await setup()
  const canvas = await f.ready()
  await f.user.click(button('框选'))
  stroke(canvas)
  const drawn = f.drawing.draws(canvas)
  f.fail(true)
  await f.user.click(button('完成'))
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('已保留绘制内容'))
  expect(f.drawing.draws(canvas)).toEqual(drawn)
  expect(f.saved).not.toHaveBeenCalled()
  f.fail(false)
  f.hold()
  fireEvent.click(button('完成'))
  fireEvent.click(button('保存中…'))
  await waitFor(() => expect(f.uploads()).toBe(2))
  for (const name of ['保存中…', '撤销', '清空', '框选'])
    expect(button(name).disabled || !!button(name).closest('fieldset[disabled]')).toBe(true)
  fireEvent.keyDown(window, { key: 'z', ctrlKey: true })
  expect(f.drawing.draws(canvas)).toEqual(drawn)
  await f.release()
  await waitFor(() => expect(f.saved).toHaveBeenCalledTimes(1))
})

it('保存等待中关闭取消请求，迟到响应不能写入，重开可保存', async () => {
  const f = await setup()
  const canvas = await f.ready()
  stroke(canvas)
  f.hold()
  await f.user.click(button('完成'))
  await waitFor(() => expect(f.uploads()).toBe(1))
  await f.user.click(button('关闭'))
  expect(f.signal()?.aborted).toBe(true)
  await f.release()
  expect(f.saved).not.toHaveBeenCalled()
  await f.user.click(button('重新打开'))
  const reopened = await f.ready()
  expect(button('完成').disabled).toBe(true)
  stroke(reopened, 120, 180)
  await f.user.click(button('完成'))
  await waitFor(() => expect(f.uploads()).toBe(2))
  await f.release()
  await waitFor(() =>
    expect(f.saved).toHaveBeenCalledExactlyOnceWith({
      assetId: 'late-mask',
      sourceAssetId: f.assetId,
      width: 160,
      height: 96,
    }),
  )
})

it('撤销重做、清空恢复和分支历史只作用于完成的笔画，组字按键不回退', async () => {
  const f = await setup()
  const canvas = await f.ready()
  await f.user.click(button('框选'))
  stroke(canvas)
  const first = f.drawing.draws(canvas)
  for (const extra of [{ isComposing: true }, { keyCode: 229 }]) {
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true, ...extra })
    expect(f.drawing.draws(canvas)).toEqual(first)
  }
  stroke(canvas, 120, 160)
  const second = f.drawing.draws(canvas)
  fireEvent.keyDown(window, { key: 'z', ctrlKey: true })
  expect(f.drawing.draws(canvas)).toEqual(first)
  fireEvent.keyDown(window, { key: 'y', ctrlKey: true })
  expect(f.drawing.draws(canvas)).toEqual(second)
  await f.user.click(button('清空'))
  expect(button('完成').disabled).toBe(true)
  await f.user.click(button('撤销'))
  expect(f.drawing.draws(canvas)).toEqual(second)
  stroke(canvas, 180, 200, 1, false)
  fireEvent.keyDown(window, { key: 'z', ctrlKey: true })
  fireEvent.pointerUp(canvas, { pointerId: 1 })
  expect(f.drawing.draws(canvas)).toEqual(second)
  await f.user.click(button('撤销'))
  stroke(canvas, 180, 220)
  expect(button('重做').disabled).toBe(true)
})

for (const tool of ['框选', '画笔', '橡皮'])
  for (const end of ['cancel', 'blur', 'capture', 'foreign']) {
    it(`${tool} ${end} 只处理当前指针并保留已完成笔画`, async () => {
      const f = await setup()
      const canvas = await f.ready()
      await f.user.click(button('框选'))
      stroke(canvas)
      const first = f.drawing.draws(canvas)
      await f.user.click(button(tool))
      stroke(canvas, 120, 180, 1, false)
      if (end === 'foreign') {
        const draft = f.drawing.draws(canvas)
        stroke(canvas, 200, 250, 77)
        expect(f.drawing.draws(canvas)).toEqual(draft)
        fireEvent.pointerUp(canvas, { pointerId: 1 })
        await f.user.click(button('撤销'))
      } else if (end === 'blur') fireEvent(window, new Event('blur'))
      else if (end === 'capture') fireEvent.lostPointerCapture(canvas, { pointerId: 1 })
      else fireEvent.pointerCancel(canvas, { pointerId: 1 })
      fireEvent.pointerUp(canvas, { pointerId: 1 })
      expect(f.drawing.draws(canvas)).toEqual(first)
      await f.user.click(button('撤销'))
      expect(button('完成').disabled).toBe(true)
    })
  }
