// @vitest-environment happy-dom
import { createElement, updateElement, type PleinDoc } from '@plein/doc'
import { openDoc } from '@plein/doc/testing'
import { afterEach, expect, it, vi } from 'vite-plus/test'
import { mockFetch } from '../../testing/fetch'
import { act, renderApp, screen, waitFor } from '../../testing/render'
import { useCanvas } from '../../stores/canvas'
import { AdvancedVideo } from './AdvancedVideo'
import { mediaTestEngine } from './testEngine'

let doc: PleinDoc
let serial = 0
afterEach(() => doc?.destroy())
function setup(operation: 'replace-range' | 'repair-region') {
  doc = openDoc()
  const assetId = (++serial).toString(16).padStart(64, 'a')
  const replacementAssetId = serial.toString(16).padStart(64, 'b')
  const source = createElement(doc, { kind: 'video', assetId, x: 0, y: 0, w: 160, h: 90 })
  const other = createElement(doc, {
    kind: 'video',
    assetId: replacementAssetId,
    name: '替换视频',
    x: 200,
    y: 0,
    w: 90,
    h: 120,
  })
  const engine = mediaTestEngine(doc)
  useCanvas.setState({ engine, canvasId: 'canvas' })
  const writes: Record<string, unknown>[] = []
  mockFetch(async (request) => {
    const path = new URL(request.url).pathname
    if (path === `/api/assets/${assetId}/meta` || path === `/api/assets/${replacementAssetId}/meta`)
      return Response.json({
        id: path.includes(replacementAssetId) ? replacementAssetId : assetId,
        kind: 'video',
        width: 160,
        height: 90,
        duration: 2,
      })
    if (path === '/api/media/derive') {
      const body = (await request.json()) as Record<string, unknown>
      writes.push(body)
      if (body.end === 1.55)
        return Response.json({ message: '出点必须位于帧边界' }, { status: 400 })
      return Response.json({
        assets: [
          { id: `derived-${serial}`, kind: 'video', width: 160, height: 90, name: '新视频' },
        ],
      })
    }
  })
  const close = vi.fn()
  const view = renderApp(
    <AdvancedVideo
      engine={engine}
      target={{ elId: source, assetId, kind: 'video' }}
      operation={operation}
      onClose={close}
    />,
  )
  const fill = async (label: string, value: string) => {
    const input = screen.getByRole('textbox', { name: label })
    await view.user.clear(input)
    await view.user.type(input, value)
  }
  const choose = async () => {
    await view.user.click(screen.getByRole('combobox', { name: '替换素材' }))
    await view.user.click(screen.getByRole('option', { name: /替换视频/ }))
  }
  return { ...view, source, other, assetId, replacementAssetId, writes, close, fill, choose }
}

it('区域修补提交实际填写范围，创建新视频并保留源文件', async () => {
  const f = setup('repair-region')
  for (const [label, value] of [
    ['左侧像素', '40'],
    ['顶部像素', '30'],
    ['区域宽度', '32'],
    ['区域高度', '20'],
    ['原视频入点（秒）', '0.5'],
    ['原视频出点（秒）', '1.5'],
  ])
    await f.fill(label!, value!)
  expect(screen.getByLabelText('修补区域预览')).toBeDefined()
  await f.user.click(screen.getByRole('button', { name: '生成新视频' }))
  await waitFor(() => expect(f.close).toHaveBeenCalledOnce())
  expect(f.writes).toEqual([
    {
      op: 'repair-region',
      assetId: f.assetId,
      left: 40,
      top: 30,
      width: 32,
      height: 20,
      start: 0.5,
      end: 1.5,
    },
  ])
  expect(doc.get(f.source)?.assetId).toBe(f.assetId)
  expect([...doc.elements()]).toHaveLength(3)
})

it('帧边界错误保留输入，可修正后再次加工', async () => {
  const f = setup('replace-range')
  await f.choose()
  await f.fill('原视频入点（秒）', '0.5')
  await f.fill('原视频出点（秒）', '1.55')
  await f.fill('替换素材起点（秒）', '0.2')
  await f.user.click(screen.getByRole('button', { name: '生成新视频' }))
  expect((await screen.findByRole('alert')).textContent).toContain('帧边界')
  expect(
    (screen.getByRole('textbox', { name: '原视频出点（秒）' }) as HTMLInputElement).value,
  ).toBe('1.55')
  expect(f.close).not.toHaveBeenCalled()
  expect([...doc.elements()]).toHaveLength(2)
  await f.fill('原视频出点（秒）', '1.5')
  await f.user.click(screen.getByRole('button', { name: '生成新视频' }))
  await waitFor(() => expect(f.close).toHaveBeenCalledOnce())
  expect(f.writes[1]).toMatchObject({
    op: 'replace-range',
    replacementAssetId: f.replacementAssetId,
    start: 0.5,
    end: 1.5,
    replacementStart: 0.2,
  })
})

it('确认前替换素材变更后要求重新选择，不提交加工', async () => {
  const f = setup('replace-range')
  await f.choose()
  act(() => {
    updateElement(doc, f.other, { assetId: f.assetId })
    doc.flush()
  })
  expect(screen.getByRole('alert').textContent).toContain('替换素材已变化')
  expect((screen.getByRole('button', { name: '生成新视频' }) as HTMLButtonElement).disabled).toBe(
    true,
  )
  expect(f.writes).toEqual([])
})
