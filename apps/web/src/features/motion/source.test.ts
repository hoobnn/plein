import type { Engine } from '@plein/canvas-core'
import { createDoc, createElement, deleteElements, setParam, updateElement } from '@plein/doc'
import { MotionParams, motionNode, MOTION_TYPE } from '@plein/nodes'
import { describeNode } from '@plein/plugin-sdk'
import type { Catalog } from '@plein/protocol'
import { beforeEach, expect, it, vi } from 'vite-plus/test'
import { request } from '../../api/client'
import { useCanvas } from '../../stores/canvas'
import { useCatalog } from '../../stores/catalog'
import { applyMotionHistory, watchMotionHistory } from './history'
import { copyMotionSource, resumeMotionSource } from './source'

vi.mock('../../api/client', () => ({ request: vi.fn() }))
const source = {
  version: 1 as const,
  bundleAssetId: 'a'.repeat(64),
  manifestAssetId: 'b'.repeat(64),
  dependencyAssetIds: [],
  rendererIdentity: 'hyperframes:test',
}
const params = MotionParams.parse({ title: '旧源工程', template: 'character' })
const inputs = { image: 'c'.repeat(64), video: 'd'.repeat(64) }
const setup = () => {
  const doc = createDoc(undefined, { schedule: () => {} })
  const off = watchMotionHistory(doc)
  const id = createElement(doc, {
    kind: 'video',
    assetId: 'e'.repeat(64),
    params: { compositionSource: source },
    x: 0,
    y: 0,
    w: 320,
    h: 200,
  })
  const engine = { doc, selection: { set: vi.fn() }, zoomToFit: vi.fn() } as unknown as Engine
  useCanvas.setState({ engine, canvasId: 'canvas', motion: null })
  doc.undo.clear()
  return {
    engine,
    doc,
    id,
    dispose() {
      off()
      doc.destroy()
      useCanvas.setState({ engine: null, canvasId: null, motion: null })
    },
  }
}
beforeEach(() => {
  vi.mocked(request).mockReset()
  useCatalog.setState({
    catalog: { nodes: [describeNode(motionNode, 'plein/core')] } as unknown as Catalog,
  })
})

it('普通视频恢复旧版参数和两类素材连线，一个本地撤销删除整个副本并保留原视频', async () => {
  const s = setup()
  try {
    vi.mocked(request).mockResolvedValue({ params, inputs })
    const original = JSON.stringify(s.doc.get(s.id))
    const id = (await resumeMotionSource(s.engine, s.id, 'canvas', new AbortController().signal))!
    expect(request).toHaveBeenCalledWith(
      `/api/motion/source/${source.manifestAssetId}`,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    expect(s.doc.get(id)).toMatchObject({ nodeType: MOTION_TYPE, params })
    expect([...s.doc.edges()].map((edge) => edge.to)).toEqual([
      [id, 'image'],
      [id, 'video'],
    ])
    expect(s.doc.undo.undoStack).toHaveLength(1)
    expect(JSON.stringify(s.doc.get(s.id))).toBe(original)
    expect(useCanvas.getState().motion).toBe(id)
    applyMotionHistory(s.doc, id, 'undo')
    s.doc.flush()
    expect([...s.doc.elements()]).toHaveLength(1)
    expect([...s.doc.edges()]).toHaveLength(0)
    expect(JSON.stringify(s.doc.get(s.id))).toBe(original)
  } finally {
    s.dispose()
  }
})

it.each(['readonly', 'canvas', 'deleted', 'asset', 'source', 'replaced', 'aborted'] as const)(
  '迟到源读取不写入失效目标：%s',
  async (mode) => {
    const s = setup()
    try {
      let done!: (value: unknown) => void
      vi.mocked(request).mockImplementation(
        () =>
          new Promise((resolve) => {
            done = resolve
          }) as never,
      )
      const abort = new AbortController()
      const restoring = resumeMotionSource(s.engine, s.id, 'canvas', abort.signal)
      if (mode === 'readonly') s.doc.readOnly = true
      if (mode === 'canvas') useCanvas.setState({ canvasId: 'another' })
      if (mode === 'deleted' || mode === 'replaced') deleteElements(s.doc, [s.id])
      if (mode === 'replaced')
        createElement(s.doc, {
          id: s.id,
          kind: 'video',
          assetId: 'e'.repeat(64),
          params: { compositionSource: source },
          x: 0,
          y: 0,
          w: 320,
          h: 200,
        })
      if (mode === 'asset') updateElement(s.doc, s.id, { assetId: 'f'.repeat(64) })
      if (mode === 'source')
        setParam(s.doc, s.id, 'compositionSource', { ...source, manifestAssetId: 'f'.repeat(64) })
      if (mode === 'aborted') abort.abort()
      done({ params, inputs })
      expect(await restoring).toBeUndefined()
      expect([...s.doc.elements()].some((element) => element.nodeType === MOTION_TYPE)).toBe(false)
    } finally {
      s.dispose()
    }
  },
)

it('只读、无效来源或缺失节点不创建任何副本', async () => {
  const s = setup()
  try {
    s.doc.readOnly = true
    expect(copyMotionSource(s.engine, s.id, { params, inputs })).toBeUndefined()
    expect(
      await resumeMotionSource(s.engine, s.id, 'canvas', new AbortController().signal),
    ).toBeUndefined()
    expect(request).not.toHaveBeenCalled()
    s.doc.readOnly = false
    setParam(s.doc, s.id, 'compositionSource', { version: 99 })
    await expect(
      resumeMotionSource(s.engine, s.id, 'canvas', new AbortController().signal),
    ).rejects.toThrow()
    expect([...s.doc.elements()]).toHaveLength(1)
  } finally {
    s.dispose()
  }
})

it('懒加载之前的点击快照失效时，不读取或恢复后来被替换的来源', async () => {
  const s = setup()
  try {
    const clicked = { target: s.doc.elementMaps.get(s.id), assetId: 'e'.repeat(64), source }
    setParam(s.doc, s.id, 'compositionSource', { ...source, manifestAssetId: 'f'.repeat(64) })
    expect(
      await resumeMotionSource(s.engine, s.id, 'canvas', new AbortController().signal, clicked),
    ).toBeUndefined()
    expect(request).not.toHaveBeenCalled()
  } finally {
    s.dispose()
  }
})
