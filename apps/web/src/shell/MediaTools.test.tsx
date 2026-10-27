// @vitest-environment happy-dom
import { createElement, type PleinDoc } from '@plein/doc'
import { openDoc } from '@plein/doc/testing'
import { afterEach, expect, it } from 'vite-plus/test'
import { act, renderApp, screen, waitFor } from '../testing/render'
import { mockFetch } from '../testing/fetch'
import { useCanvas } from '../stores/canvas'
import { MediaTools } from './MediaTools'
import { mediaTestEngine } from './media-tools/testEngine'

let doc: PleinDoc
let serial = 0
afterEach(() => doc?.destroy())
function setup(kind: 'audio' | 'video') {
  doc = openDoc()
  const assetId = `media-${++serial}`
  const source = createElement(
    doc,
    kind === 'audio'
      ? { kind, assetId, x: 0, y: 0, w: 160, h: 90 }
      : {
          kind: 'node',
          nodeType: 'plein/video',
          x: 0,
          y: 0,
          w: 160,
          h: 90,
          adopted: 'second',
          results: [
            {
              id: 'first',
              runId: 'one',
              port: 'video',
              at: 1,
              value: { type: 'video', assetId: 'old' },
            },
            { id: 'second', runId: 'two', port: 'video', at: 2, value: { type: 'video', assetId } },
          ],
        },
  )
  const engine = mediaTestEngine(doc)
  useCanvas.setState({ engine, canvasId: 'canvas' })
  const bodies: Record<string, unknown>[] = []
  let release: (() => void) | undefined
  let hold = false
  mockFetch(async (request) => {
    const path = new URL(request.url).pathname
    if (path === '/api/media/caps')
      return Response.json({ ffmpeg: true, subtitles: true, rubberband: true })
    if (path === `/api/assets/${assetId}/meta`)
      return Response.json({ id: assetId, kind, width: 160, height: 90, duration: 9 })
    if (path === '/api/media/derive') {
      const body = (await request.json()) as Record<string, unknown>
      bodies.push(body)
      if (hold)
        await new Promise<void>((resolve) => {
          release = resolve
        })
      const count = body.op === 'split' ? (body.segments as unknown[]).length : 1
      return Response.json({
        assets: Array.from({ length: count }, (_, i) => ({
          id: `made-${serial}-${bodies.length}-${i}`,
          kind,
          width: 100,
          height: 56,
          name: '产物',
        })),
      })
    }
  })
  const view = renderApp(<MediaTools engine={engine} target={{ elId: source, assetId, kind }} />)
  const open = async (name: string) => {
    await view.user.click(screen.getByRole('button', { name: '媒体工具' }))
    if (!screen.queryByRole('button', { name: '开始加工' }))
      await view.user.click(await screen.findByRole('button', { name }))
  }
  return {
    ...view,
    source,
    assetId,
    bodies,
    open,
    hold: () => {
      hold = true
    },
    release: () => release?.(),
  }
}

it('生成视频裁剪绑定采用候选，提交精确像素且不改原节点，单步撤销产物', async () => {
  const f = setup('video')
  const before = doc.get(f.source)
  await f.open('裁剪')
  for (const [label, value] of [
    ['左', '11'],
    ['上', '7'],
    ['宽', '100'],
    ['高', '56'],
  ]) {
    const input = screen.getByRole('textbox', { name: label })
    await f.user.clear(input)
    await f.user.type(input, value!)
  }
  await f.user.click(screen.getByRole('button', { name: '开始加工' }))
  await waitFor(() => expect([...doc.elements()]).toHaveLength(2))
  expect(f.bodies).toEqual([
    { op: 'crop', assetId: f.assetId, left: 11, top: 7, width: 100, height: 56 },
  ])
  expect(doc.get(f.source)).toEqual(before)
  act(() => {
    doc.undo.undo()
  })
  expect([...doc.elements()]).toHaveLength(1)
  expect(doc.get(f.source)).toEqual(before)
})

it('加工中切换采用候选时丢弃迟到产物并说明下一步', async () => {
  const f = setup('video')
  await f.open('裁剪')
  f.hold()
  await f.user.click(screen.getByRole('button', { name: '开始加工' }))
  await waitFor(() => expect(f.bodies).toHaveLength(1))
  act(() => {
    doc.mutable(f.source)!.set('adopted', 'first')
  })
  f.release()
  await waitFor(() => expect(useCanvas.getState().notice).toContain('素材已变化'))
  expect([...doc.elements()]).toHaveLength(1)
  expect(doc.get(f.source)?.adopted).toBe('first')
})

it('音频切点与区间先预览再加工，无效计划保留文本且不发请求', async () => {
  const f = setup('audio')
  await f.open('手动切分')
  await f.user.selectOptions(screen.getByRole('combobox', { name: '分段方式' }), 'cuts')
  await f.user.type(screen.getByRole('textbox', { name: '音频切点' }), '1.2, 4.5')
  expect(screen.getByLabelText('切分区间预览').textContent).toContain('将生成 3 段')
  expect(f.bodies).toHaveLength(0)
  await f.user.click(screen.getByRole('button', { name: '开始加工' }))
  await waitFor(() => expect([...doc.elements()]).toHaveLength(4))
  expect(f.bodies[0]).toEqual({
    op: 'split',
    assetId: f.assetId,
    segments: [
      { start: 0, end: 1.2 },
      { start: 1.2, end: 4.5 },
      { start: 4.5, end: 9 },
    ],
  })
  await f.open('手动切分')
  await f.user.selectOptions(screen.getByRole('combobox', { name: '分段方式' }), 'ranges')
  const ranges = screen.getByRole('textbox', { name: '音频区间' })
  await f.user.clear(ranges)
  await f.user.type(ranges, '0 - 1\n2 - 4')
  expect(screen.getByLabelText('切分区间预览').textContent).toContain('将生成 2 段')
  await f.user.click(screen.getByRole('button', { name: '开始加工' }))
  await waitFor(() => expect([...doc.elements()]).toHaveLength(6))
  await f.open('手动切分')
  await f.user.selectOptions(screen.getByRole('combobox', { name: '分段方式' }), 'cuts')
  const cuts = screen.getByRole('textbox', { name: '音频切点' })
  await f.user.clear(cuts)
  await f.user.type(cuts, '3, 1')
  await f.user.click(screen.getByRole('button', { name: '开始加工' }))
  expect(f.bodies).toHaveLength(2)
  expect((cuts as HTMLTextAreaElement).value).toBe('3, 1')
  expect(useCanvas.getState().notice).toContain('切点需严格递增')
})
