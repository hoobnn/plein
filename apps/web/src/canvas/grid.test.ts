import { Scene, type Engine } from '@plein/canvas-core'
import {
  createDoc,
  createElement,
  deleteElements,
  groupShots,
  updateElement,
  type PleinDoc,
} from '@plein/doc'
import { openDoc } from '@plein/doc/testing'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { api } from '../api/client'
import { useCanvas } from '../stores/canvas'
import { splitGrid } from './grid'
import { beginImport } from './importProgress'

describe('像素与来源边界', () => {
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
})

describe('上传结束时的异步边界', () => {
  const initial = useCanvas.getState()
  const docs: PleinDoc[] = []
  afterEach(() => {
    useCanvas.getState().notify(null)
    useCanvas.setState(initial, true)
    docs.splice(0).forEach((doc) => doc.destroy())
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  function fixture() {
    const doc = createDoc()
    docs.push(doc)
    const source = createElement(doc, {
      kind: 'image',
      assetId: 'source',
      x: 100,
      y: 100,
      w: 400,
      h: 240,
    })
    doc.undo.stopCapturing()
    doc.undo.clear()
    const engine = { doc, scene: { rect: (id: string) => doc.worldRect(id) } } as unknown as Engine
    const bitmap = { width: 960, height: 540, close: vi.fn() }
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue(bitmap))
    vi.stubGlobal('document', {
      createElement: () => ({
        width: 0,
        height: 0,
        getContext: () => ({ drawImage: vi.fn() }),
        toBlob: (done: (blob: Blob) => void) => done(new Blob(['tile'], { type: 'image/png' })),
      }),
    })
    vi.spyOn(api, 'assetBlob').mockResolvedValue(new Blob(['image'], { type: 'image/png' }))
    let release!: () => void
    let entered!: () => void
    const accepted = new Promise<void>((resolve) => (entered = resolve))
    const gate = new Promise<void>((resolve) => (release = resolve))
    let uploads = 0
    vi.spyOn(api, 'upload').mockImplementation(async () => {
      const index = ++uploads
      if (index === 4) {
        entered()
        await gate
      }
      return { id: `tile-${index}` } as never
    })
    return { doc, source, engine, bitmap, release: () => release(), accepted }
  }

  it.each(['deleted', 'replaced', 'readonly', 'locked'] as const)(
    '切图上传期间 %s 时拒绝迟到写入并释放位图',
    async (change) => {
      const f = fixture()
      const pending = splitGrid(f.engine, f.source, 'source', 2, 2)
      await f.accepted
      if (change === 'deleted') deleteElements(f.doc, [f.source])
      if (change === 'replaced') f.doc.mutable(f.source)!.set('assetId', 'replacement')
      if (change === 'readonly') f.doc.readOnly = true
      if (change === 'locked') f.doc.mutable(f.source)!.set('locked', true)
      const rejected = expect(pending).rejects.toThrow(
        change === 'deleted'
          ? '来源元素已删除'
          : change === 'replaced'
            ? '来源图片已变化'
            : '只读或已锁定',
      )
      f.release()
      await rejected
      expect([...f.doc.elements()].filter((el) => el.kind === 'frame')).toEqual([])
      expect([...f.doc.elements()].filter((el) => el.assetId?.startsWith('tile-'))).toEqual([])
      expect(f.bitmap.close).toHaveBeenCalledOnce()
    },
  )

  it('切换画布取消切图，旧文档不产生迟到分组', async () => {
    const f = fixture()
    useCanvas.setState({ engine: f.engine, canvasId: 'old-canvas' })
    const batch = beginImport(f.engine, 4)
    const pending = splitGrid(f.engine, f.source, 'source', 2, 2, batch.progress, batch.signal)
    await f.accepted
    useCanvas.setState({ engine: null, canvasId: 'new-canvas', importing: null })
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    f.release()
    await rejected
    expect(batch.signal.aborted).toBe(true)
    expect([...f.doc.elements()].map((el) => el.id)).toEqual([f.source])
    expect(f.bitmap.close).toHaveBeenCalledOnce()
    expect(useCanvas.getState().importing).toBeNull()
    expect(useCanvas.getState().notice).toBeNull()
  })

  it('切图使用上传后的布局避让，完整分组可单步撤销与重做', async () => {
    const f = fixture()
    const pending = splitGrid(f.engine, f.source, 'source', 2, 2)
    await f.accepted
    f.doc.mutable(f.source)!.set('x', 1000)
    const blocker = createElement(f.doc, { kind: 'markdown', x: 1520, y: 100, w: 400, h: 240 })
    f.doc.undo.stopCapturing()
    f.release()
    const frame = (await pending)!
    const box = f.doc.worldRect(frame)!,
      obstacle = f.doc.worldRect(blocker)!
    expect(box.x).toBeGreaterThanOrEqual(f.doc.worldRect(f.source)!.x + 440)
    expect(
      box.x < obstacle.x + obstacle.w &&
        box.x + box.w > obstacle.x &&
        box.y < obstacle.y + obstacle.h &&
        box.y + box.h > obstacle.y,
    ).toBe(false)
    expect(groupShots(f.doc, frame)).toHaveLength(4)
    f.doc.undo.undo()
    expect([...f.doc.elements()].map((el) => el.id).sort()).toEqual([f.source, blocker].sort())
    expect(f.doc.get(f.source)?.x).toBe(1000)
    f.doc.undo.redo()
    expect(groupShots(f.doc, frame)).toHaveLength(4)
  })
})
