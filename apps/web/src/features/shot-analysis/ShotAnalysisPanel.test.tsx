// @vitest-environment happy-dom
import type { Engine } from '@plein/canvas-core'
import { addResults, connect, createDoc, createElement, type PleinDoc } from '@plein/doc'
import type { ShotAnalysisManifest } from '@plein/nodes'
import { afterEach, expect, it, vi } from 'vite-plus/test'
import { useCanvas } from '../../stores/canvas'
import { useSession } from '../../stores/session'
import { act, renderApp, screen, waitFor } from '../../testing/render'
import { mockFetch } from '../../testing/fetch'
import { ShotAnalysisPanel } from './ShotAnalysisPanel'

const docs: PleinDoc[] = []
afterEach(() => {
  for (const doc of docs.splice(0)) doc.destroy()
})

function manifest(suffix: string): ShotAnalysisManifest {
  return {
    version: 1,
    source: { assetId: 'a'.repeat(64), kind: 'video', mime: 'video/mp4' },
    timeBasis: 'first-video-frame',
    firstVideoPts: 0,
    duration: 2,
    algorithm: {
      name: 'ffmpeg-scene',
      version: 1,
      threshold: 0.3,
      minSceneSeconds: 0.4,
      manual: true,
    },
    scenes: [0, 1].map((index) => ({
      id: `${suffix}-scene-${index + 1}`,
      start: index,
      end: index + 1,
      frame: {
        assetId: (index ? 'c' : 'b').repeat(64),
        kind: 'image',
        mime: 'image/jpeg',
        at: index + 0.5,
        actualAt: index,
        actualEnd: index + 1,
      },
      clip: { assetId: (index ? 'e' : 'd').repeat(64), kind: 'video', mime: 'video/mp4' },
    })),
    audio: { assetId: 'f'.repeat(64), kind: 'audio', mime: 'audio/mp4' },
    notes: [],
  }
}

function fixture() {
  const doc = createDoc()
  docs.push(doc)
  const id = createElement(doc, {
    id: 'analysis',
    kind: 'node',
    nodeType: 'plein/shot-analysis',
    ports: { inputs: [{ id: 'video', label: '视频', type: 'video' }], outputs: [] },
    x: 0,
    y: 0,
    w: 100,
    h: 80,
  })
  addResults(doc, id, [
    {
      id: 'report-old',
      port: 'analysis',
      runId: 'run-old',
      at: 1,
      value: { type: 'json', value: manifest('old') },
    },
  ])
  addResults(doc, id, [
    {
      id: 'report-new',
      port: 'analysis',
      runId: 'run-new',
      at: 2,
      value: { type: 'json', value: manifest('new') },
    },
  ])
  const source = createElement(doc, {
    kind: 'video',
    assetId: 'a'.repeat(64),
    x: 0,
    y: 100,
    w: 100,
    h: 80,
  })
  connect(doc, [source, 'video'], [id, 'video'])
  const engine = { doc, selection: { set: vi.fn() } } as unknown as Engine
  useCanvas.setState({ engine, canvasId: 'canvas', shotAnalysis: id })
  useSession.setState({ info: { principal: { id: 'local', role: 'owner' } } as never })
  return { doc, engine, id }
}

it('历史清单只预览不自动采用，锁定后处理与采用均只读', async () => {
  const { doc, engine, id } = fixture()
  const { user } = renderApp(<ShotAnalysisPanel engine={engine} id={id} onClose={vi.fn()} />)
  const panel = screen.getByRole('dialog', { name: '本地拉片' })
  expect(panel.querySelectorAll('video')).toHaveLength(2)
  expect(doc.get(id)?.adopted).toBe('report-new')
  await user.click(screen.getByRole('combobox', { name: '拉片清单版本' }))
  await user.click(await screen.findByRole('option', { name: /^清单 2 ·/ }))
  await waitFor(() => expect(panel.querySelectorAll('video')).toHaveLength(2))
  expect(doc.get(id)?.adopted).toBe('report-new')
  act(() => {
    doc.mutable(id)!.set('locked', true)
    doc.flush()
  })
  await waitFor(() => expect(panel.textContent).toContain('当前只读'))
  expect(
    (screen.getByRole('button', { name: '按这些切点处理' }) as HTMLButtonElement).disabled,
  ).toBe(true)
  expect((screen.getByRole('button', { name: '采用此清单' }) as HTMLButtonElement).disabled).toBe(
    true,
  )
  expect(doc.get(id)?.adopted).toBe('report-new')
})

it('卸载清单暂停并清空片段源，不依赖真实媒体解码', () => {
  const { engine, id } = fixture()
  const { unmount } = renderApp(<ShotAnalysisPanel engine={engine} id={id} onClose={vi.fn()} />)
  const videos = [...screen.getByRole('dialog', { name: '本地拉片' }).querySelectorAll('video')]
  const spies = videos.map((video) => ({
    pause: vi.spyOn(video, 'pause').mockImplementation(() => {}),
    load: vi.spyOn(video, 'load').mockImplementation(() => {}),
  }))
  unmount()
  for (const [index, video] of videos.entries()) {
    expect(spies[index]!.pause).toHaveBeenCalledOnce()
    expect(video.hasAttribute('src')).toBe(false)
    expect(spies[index]!.load).toHaveBeenCalledOnce()
  }
})

it('非法短切点就地说明且零请求，所选清单素材显式入画布', async () => {
  const { doc, engine, id } = fixture()
  const fetch = mockFetch()
  const { user } = renderApp(<ShotAnalysisPanel engine={engine} id={id} onClose={vi.fn()} />)
  const cuts = screen.getByRole('textbox', { name: '切点（秒数或时间码，逗号分隔；留空表示整段）' })
  await user.clear(cuts)
  await user.type(cuts, '0.01')
  await user.click(screen.getByLabelText('提取视频片段'))
  await user.click(screen.getByRole('button', { name: '按这些切点处理' }))
  expect(screen.getByRole('alert').textContent).toContain('每段必须至少 1/30 秒')
  expect(fetch).not.toHaveBeenCalled()
  const adopted = doc.get(id)?.adopted
  await user.click(screen.getByRole('button', { name: '全选镜头' }))
  await user.click(screen.getByRole('button', { name: '放入关键帧' }))
  await user.click(screen.getByRole('button', { name: '放入视频片段' }))
  await user.click(screen.getByRole('button', { name: '放入原音轨' }))
  expect(
    [...doc.elements()]
      .filter((el) => el.params?.shotAnalysisOrigin)
      .map((el) => el.kind)
      .sort(),
  ).toEqual(['audio', 'image', 'image', 'video', 'video'])
  expect(doc.get(id)?.adopted).toBe(adopted)
  expect(doc.get(id)?.params).not.toHaveProperty('manifest')
  expect(fetch).not.toHaveBeenCalled()
})

it('开始响应晚回不重置用户已选择的历史清单', async () => {
  const { doc, engine, id } = fixture()
  let release!: () => void
  let entered!: () => void
  const accepted = new Promise<void>((resolve) => (entered = resolve))
  const gate = new Promise<void>((resolve) => (release = resolve))
  mockFetch((request) => {
    const path = new URL(request.url).pathname
    if (request.method === 'GET' && path === `/api/canvases/canvas/nodes/${id}/input`)
      return Response.json({
        status: 'ready',
        inputHash: 'frozen',
        params: doc.get(id)?.params ?? {},
        inputs: { video: [{ type: 'video', assetId: 'a'.repeat(64) }] },
      })
    if (request.method === 'POST' && path === `/api/canvases/canvas/nodes/${id}/run`) {
      entered()
      return gate.then(() => Response.json({ runId: 'new-run' }, { status: 202 }))
    }
  })
  const { user } = renderApp(<ShotAnalysisPanel engine={engine} id={id} onClose={vi.fn()} />)
  await user.click(screen.getByRole('button', { name: '按这些切点处理' }))
  await accepted
  await user.click(screen.getByRole('combobox', { name: '拉片清单版本' }))
  await user.click(await screen.findByRole('option', { name: /^清单 2 ·/ }))
  release()
  await waitFor(() =>
    expect(
      (screen.getByRole('button', { name: '按这些切点处理' }) as HTMLButtonElement).disabled,
    ).toBe(false),
  )
  expect(screen.getByRole('combobox', { name: '拉片清单版本' }).textContent).toContain('清单 2')
  expect(doc.get(id)?.adopted).toBe('report-new')
})
