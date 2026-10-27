// @vitest-environment happy-dom
import type { LibraryItem } from '@plein/protocol'
import { expect, it, vi } from 'vite-plus/test'
import { mockFetch } from '../../testing/fetch'
import { act, renderApp, screen, waitFor } from '../../testing/render'
import { useSession } from '../../stores/session'
import PanoramaDialog from './PanoramaDialog'

const item: LibraryItem = {
  id: 'scene',
  kind: 'scene',
  name: '场景',
  description: '',
  projectId: 'project',
  images: [{ slot: 'panorama', assetId: 'source' }],
  tags: {},
  voice: null,
  video: null,
  models: [],
  profile: null,
  favorite: false,
  usedAt: null,
  createdAt: 1,
  updatedAt: 1,
}
async function setup(capture: (request: Request) => Response | Promise<Response>) {
  useSession.setState({
    status: 'ready',
    info: { principal: { id: 'local', role: 'owner' }, authRequired: false, needsSetup: false },
  })
  // 仅替换浏览器解码和像素载入边界；真实投影像素由保留的浏览器冒烟证明。
  const closeBitmap = vi.fn()
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async () => ({ width: 64, height: 32, close: closeBitmap })),
  )
  vi.stubGlobal(
    'ImageData',
    class {
      constructor(
        public data: Uint8ClampedArray,
        public width: number,
        public height: number,
      ) {}
    },
  )
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage: vi.fn(),
    getImageData: () => ({ data: new Uint8ClampedArray(64 * 32 * 4), width: 64, height: 32 }),
    putImageData: vi.fn(),
  } as unknown as ReturnType<HTMLCanvasElement['getContext']>)
  const requests: Request[] = []
  mockFetch((request) => {
    const path = new URL(request.url).pathname
    if (path === '/api/assets/source/meta')
      return Response.json({ size: 10, width: 64, height: 32 })
    if (path === '/api/assets/source/thumb-1024')
      return new Response('pixels', { headers: { 'content-type': 'image/png' } })
    if (path === '/api/library/scene/panorama-view') {
      requests.push(request)
      return capture(request)
    }
  })
  const onSaved = vi.fn(),
    onClose = vi.fn()
  const f = renderApp(
    <PanoramaDialog
      item={item}
      sourceAssetId="source"
      readOnly={false}
      isCurrent={() => true}
      onSaved={onSaved}
      onClose={onClose}
    />,
  )
  await screen.findByRole('img', { name: '全景透视预览' })
  return { ...f, requests, onSaved, onClose, closeBitmap }
}
const save = () => screen.getByRole('button', { name: '保存为命名视角' }) as HTMLButtonElement

it('场景冲突保留设置并要求重新核对，不能重复提交旧截图', async () => {
  const f = await setup(() =>
    Response.json({ code: 'conflict', message: '场景已变化' }, { status: 409 }),
  )
  await f.user.clear(screen.getByRole('textbox', { name: '视角名称' }))
  await f.user.type(screen.getByRole('textbox', { name: '视角名称' }), '窗边反打')
  await f.user.click(save())
  expect((await screen.findByRole('alert')).textContent).toContain('场景已变化')
  expect(
    (screen.getByRole('button', { name: '请重新核对场景' }) as HTMLButtonElement).disabled,
  ).toBe(true)
  expect((screen.getByRole('textbox', { name: '视角名称' }) as HTMLInputElement).value).toBe(
    '窗边反打',
  )
  expect(f.requests).toHaveLength(1)
  expect(f.onSaved).not.toHaveBeenCalled()
  expect(f.closeBitmap).toHaveBeenCalledTimes(1)
})

it('截图等待中重复点击不发请求，取消终止请求且迟到成功不回写', async () => {
  let finish!: (response: Response) => void
  const held = new Promise<Response>((resolve) => {
    finish = resolve
  })
  const f = await setup(() => held)
  await f.user.click(save())
  const busy = screen.getByRole('button', { name: '正在保存视角…' }) as HTMLButtonElement
  expect(busy.disabled).toBe(true)
  await f.user.click(busy)
  expect(f.requests).toHaveLength(1)
  await f.user.click(screen.getByRole('button', { name: '取消截图' }))
  expect(f.requests[0]!.signal.aborted).toBe(true)
  expect(f.onClose).toHaveBeenCalledTimes(1)
  await act(async () => finish(Response.json(item)))
  expect(f.onSaved).not.toHaveBeenCalled()
})

it('普通保存错误可重试，保留输入且请求带冻结的场景版本和当前视角', async () => {
  let calls = 0
  const f = await setup(() =>
    ++calls === 1
      ? Response.json({ message: '截图暂时失败' }, { status: 503 })
      : Response.json(item),
  )
  await f.user.clear(screen.getByRole('spinbutton', { name: '朝向（度）' }))
  await f.user.type(screen.getByRole('spinbutton', { name: '朝向（度）' }), '-30')
  await f.user.click(save())
  await screen.findByRole('alert')
  expect(save().disabled).toBe(false)
  await f.user.click(save())
  await waitFor(() => expect(f.onSaved).toHaveBeenCalledWith(item))
  expect(await f.requests[1]!.json()).toMatchObject({
    sourceAssetId: 'source',
    pose: { yaw: -30, pitch: 0, fov: 55 },
    expected: expect.any(String),
  })
})
