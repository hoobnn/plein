import { Scene, type Engine } from '@plein/canvas-core'
import { createElement, updateElement } from '@plein/doc'
import { openDoc } from '@plein/doc/testing'
import { afterEach, expect, it, vi } from 'vite-plus/test'
import { api } from '../api/client'
import { splitGrid } from './grid'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
function setup(width = 5, height = 3) {
  const doc = openDoc()
  const source = createElement(doc, {
    kind: 'image',
    assetId: 'source',
    x: 0,
    y: 0,
    w: 320,
    h: 192,
  })
  doc.flush()
  doc.undo.clear()
  const scene = new Scene(doc)
  cleanups.push(() => doc.destroy())
  const engine = { doc, scene } as Engine
  const bitmap = { width, height, close: vi.fn() }
  const draw = vi.fn()
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({ drawImage: draw }),
    toBlob: (done: (blob: Blob) => void) => done(new Blob(['tile'])),
  }
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async () => bitmap),
  )
  vi.stubGlobal('document', { createElement: () => canvas })
  vi.spyOn(api, 'assetBlob').mockResolvedValue(new Blob(['source']))
  let count = 0
  const upload = vi
    .spyOn(api, 'upload')
    .mockImplementation(async () => ({ id: `tile-${++count}` }) as never)
  return { doc, engine, source, bitmap, draw, upload }
}

it('奇数像素分界覆盖全部原图，切片顺序、画布布局和撤销完整', async () => {
  const f = setup()
  const progress = vi.fn()
  const frame = await splitGrid(f.engine, f.source, 'source', 2, 2, progress)
  expect(f.draw.mock.calls.map((call) => call.slice(1))).toEqual([
    [0, 0, 2, 1, 0, 0, 2, 1],
    [2, 0, 3, 1, 0, 0, 3, 1],
    [0, 1, 2, 2, 0, 0, 2, 2],
    [2, 1, 3, 2, 0, 0, 3, 2],
  ])
  expect(progress.mock.calls).toEqual([
    [1, 4],
    [2, 4],
    [3, 4],
    [4, 4],
  ])
  const group = f.doc.get(frame!)!
  const order = (group.params!.shotGroup as { order: string[] }).order
  expect(order.map((id) => f.doc.get(id)?.assetId)).toEqual([
    'tile-1',
    'tile-2',
    'tile-3',
    'tile-4',
  ])
  expect(order.map((id) => [f.doc.get(id)?.w, f.doc.get(id)?.h])).toEqual([
    [160, 80],
    [240, 80],
    [160, 160],
    [240, 160],
  ])
  expect(f.bitmap.close).toHaveBeenCalledOnce()
  f.doc.undo.undo()
  expect([...f.doc.elements()].map((el) => el.id)).toEqual([f.source])
  f.doc.undo.redo()
  expect(f.doc.get(frame!)?.params).toEqual(group.params)
})

it('极小原图提示实际像素要求，不上传空切片或写画布', async () => {
  const f = setup(1, 1)
  await expect(splitGrid(f.engine, f.source, 'source', 2, 2)).rejects.toThrow('图片只有 1×1 像素')
  expect(f.upload).not.toHaveBeenCalled()
  expect([...f.doc.elements()]).toHaveLength(1)
  expect(f.doc.undo.undoStack).toHaveLength(0)
  expect(f.bitmap.close).toHaveBeenCalledOnce()
})

it.each(['deleted', 'changed', 'locked', 'readonly', 'abort', 'upload'] as const)(
  '切图等待中 %s 不写入部分分组，释放解码图片',
  async (change) => {
    const f = setup()
    const controller = new AbortController()
    f.upload.mockImplementationOnce(async () => {
      if (change === 'deleted') f.doc.elementMaps.delete(f.source)
      if (change === 'changed') updateElement(f.doc, f.source, { assetId: 'changed' })
      if (change === 'locked') updateElement(f.doc, f.source, { locked: true })
      if (change === 'readonly') f.doc.readOnly = true
      if (change === 'abort') controller.abort()
      if (change === 'upload') throw new Error('网络中断')
      return { id: 'tile-1' } as never
    })
    await expect(
      splitGrid(f.engine, f.source, 'source', 2, 2, undefined, controller.signal),
    ).rejects.toThrow()
    expect([...f.doc.elements()].filter((el) => el.id !== f.source)).toEqual([])
    expect(f.bitmap.close).toHaveBeenCalledOnce()
    f.doc.readOnly = false
  },
)

it('完成切图按最新文档位置避让同帧新元素，不依赖过期场景索引', async () => {
  const f = setup()
  const blocker = createElement(f.doc, { kind: 'image', x: 400, y: 0, w: 600, h: 400 })
  expect(f.engine.scene.rect(blocker)).toBeUndefined()
  const frame = await splitGrid(f.engine, f.source, 'source', 2, 2)
  const rect = f.doc.worldRect(frame!)!
  expect(rect.y).toBeGreaterThanOrEqual(400)
})
