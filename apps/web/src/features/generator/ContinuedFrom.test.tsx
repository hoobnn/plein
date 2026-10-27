// @vitest-environment happy-dom
import type { Engine } from '@plein/canvas-core'
import { connect, createElement, type PleinDoc } from '@plein/doc'
import { openDoc } from '@plein/doc/testing'
import { afterEach, expect, it, vi } from 'vite-plus/test'
import { useDocVersion } from '../../canvas/hooks'
import { useCanvas } from '../../stores/canvas'
import { mockFetch } from '../../testing/fetch'
import { act, renderApp, resetStoreAfterEach, screen, waitFor } from '../../testing/render'
import { ContinuedFrom } from './ContinuedFrom'
import { useContinueRequests } from './continueRequests'
resetStoreAfterEach(useContinueRequests)
const docs: PleinDoc[] = []
afterEach(() => docs.splice(0).forEach((doc) => doc.destroy()))
function setup() {
  const doc = openDoc()
  docs.push(doc)
  const parent = createElement(doc, {
    kind: 'video',
    assetId: 'new-video',
    name: '父视频',
    x: 0,
    y: 0,
    w: 200,
    h: 100,
  })
  const frame = createElement(doc, {
    kind: 'image',
    assetId: 'old-frame',
    x: 0,
    y: 0,
    w: 200,
    h: 100,
  })
  const next = createElement(doc, {
    kind: 'node',
    nodeType: 'plein/video',
    x: 0,
    y: 0,
    w: 200,
    h: 100,
    ports: { inputs: [{ id: 'images', type: 'image', label: '首帧' }], outputs: [] },
    params: {
      continuesFrom: {
        elementId: parent,
        assetId: 'old-video',
        frameAssetId: 'old-frame',
        last: true,
      },
    },
  })
  connect(doc, [frame, 'image'], [next, 'images'])
  const engine = { doc, selection: { set: vi.fn() }, zoomToFit: vi.fn() } as unknown as Engine
  useCanvas.setState({ engine, canvasId: 'c' })
  let finish!: (response: Response) => void,
    requests = 0
  mockFetch((req) => {
    if (req.url.endsWith('/media/derive')) {
      requests++
      return new Promise<Response>((resolve) => {
        finish = resolve
      })
    }
  })
  function Harness() {
    useDocVersion(doc)
    return <ContinuedFrom engine={engine} el={doc.get(next)!} />
  }
  const rendered = renderApp(<Harness />)
  const done = (response = Response.json({ assets: [{ id: 'new-frame' }], params: { at: 2 } })) =>
    act(async () => {
      finish(response)
      await Promise.resolve()
    })
  return { ...rendered, doc, parent, frame, next, engine, done, requests: () => requests }
}
it('等待期间卸载重开共享状态，完成不夺取选择，更新来路和首帧', async () => {
  const f = setup()
  await f.user.click(screen.getByRole('button', { name: '换成新画面' }))
  expect(screen.getByRole<HTMLButtonElement>('button', { name: '取帧中…' }).disabled).toBe(true)
  f.rerender(<ContinuedFrom engine={f.engine} el={f.doc.get(f.next)!} />)
  expect(screen.getByRole<HTMLButtonElement>('button', { name: '取帧中…' }).disabled).toBe(true)
  await f.done()
  await waitFor(() => expect(f.doc.get(f.frame)?.assetId).toBe('new-frame'))
  expect(f.doc.get(f.next)?.params?.continuesFrom).toMatchObject({
    assetId: 'new-video',
    frameAssetId: 'new-frame',
  })
  expect(f.engine.selection.set).not.toHaveBeenCalled()
  expect(f.requests()).toBe(1)
})
it('失败保留旧首帧并能重试，取消后焦点回到入口', async () => {
  const f = setup()
  await f.user.click(screen.getByRole('button', { name: '换成新画面' }))
  await f.done(Response.json({ message: '取帧暂不可用' }, { status: 503 }))
  await waitFor(() => expect(useCanvas.getState().notice).toBe('取帧暂不可用'))
  expect(f.doc.get(f.frame)?.assetId).toBe('old-frame')
  await f.user.click(screen.getByRole('button', { name: '换成新画面' }))
  await f.user.click(screen.getByRole('button', { name: '取消取帧' }))
  await f.done()
  await waitFor(() =>
    expect(screen.getByRole('button', { name: '换成新画面' })).toBe(document.activeElement),
  )
  expect(f.doc.get(f.frame)?.assetId).toBe('old-frame')
  await f.user.click(screen.getByRole('button', { name: '换成新画面' }))
  await f.done()
  await waitFor(() => expect(f.doc.get(f.frame)?.assetId).toBe('new-frame'))
  expect(f.requests()).toBe(3)
})
it('离开画布取消等待，迟到成功不写入也不提示新画布', async () => {
  const f = setup()
  await f.user.click(screen.getByRole('button', { name: '换成新画面' }))
  act(() => useCanvas.setState({ canvasId: 'other' }))
  await f.done()
  await waitFor(() => expect(useContinueRequests.getState().pending.size).toBe(0))
  expect(f.doc.get(f.frame)?.assetId).toBe('old-frame')
  expect(useCanvas.getState().notice).toBeNull()
})
