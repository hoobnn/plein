// @vitest-environment happy-dom
import { createElement, setResults } from '@plein/doc'
import { openDoc } from '@plein/doc/testing'
import { expect, it, vi } from 'vite-plus/test'
import { renderApp } from '../testing/render'
import { useCanvas } from '../stores/canvas'
import { mediaTestEngine } from '../shell/media-tools/testEngine'
import { CanvasOverlays } from './overlays'

it('采用或删除候选后切换播放器并释放旧媒体，进入序列时停止播放', () => {
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue()
  const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
  const doc = openDoc()
  const id = createElement(doc, {
    kind: 'node',
    nodeType: 'plein/video',
    x: 0,
    y: 0,
    w: 160,
    h: 90,
    adopted: 'a',
    results: ['a', 'b'].map((assetId, i) => ({
      id: assetId,
      runId: 'run',
      at: 2 - i,
      port: 'video',
      value: { type: 'video' as const, assetId },
    })),
  })
  const engine = mediaTestEngine(doc)
  const { container } = renderApp(<div />)
  const overlays = new CanvasOverlays(engine, container, document.createElement('div'), {
    originalUrl: (id) => `/api/assets/${id}`,
  })
  try {
    overlays.activate(id)
    const first = container.querySelector('video')!
    expect(first.getAttribute('src')).toBe('/api/assets/a')
    doc.mutable(id)!.set('adopted', 'b')
    doc.flush()
    overlays.sync()
    expect(first.getAttribute('src')).toBeNull()
    expect(container.querySelector('video')!.getAttribute('src')).toBe('/api/assets/b')
    expect(pause).toHaveBeenCalled()
    doc.mutable(id)!.set('adopted', undefined)
    setResults(
      doc,
      id,
      doc.get(id)!.results!.filter((result) => result.id !== 'b'),
    )
    doc.flush()
    overlays.sync()
    expect(container.querySelector('video')!.getAttribute('src')).toBe('/api/assets/a')
    const last = container.querySelector('video')!
    setResults(doc, id, [])
    doc.flush()
    overlays.sync()
    expect(container.querySelector('video')).toBeNull()
    expect(last.getAttribute('src')).toBeNull()
    doc.mutable(id)!.set('adopted', 'c')
    setResults(doc, id, [
      { id: 'c', runId: 'run', at: 3, port: 'video', value: { type: 'video', assetId: 'c' } },
    ])
    doc.flush()
    overlays.activate(id)
    const playing = container.querySelector('video')!
    useCanvas.setState({ sequence: id })
    expect(container.querySelector('video')).toBeNull()
    expect(playing.getAttribute('src')).toBeNull()
    overlays.activate(id)
    expect(container.querySelector('video')).toBeNull()
    expect([...doc.elements()]).toHaveLength(1)
  } finally {
    overlays.destroy()
    doc.destroy()
  }
})
