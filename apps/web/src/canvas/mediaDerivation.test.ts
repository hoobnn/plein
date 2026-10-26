import { type Engine, Scene } from '@plein/canvas-core'
import { createElement, updateElement, type PleinDoc } from '@plein/doc'
import { openDoc } from '@plein/doc/testing'
import type { MediaDerivation } from '@plein/protocol'
import { afterEach, expect, it, vi } from 'vite-plus/test'
import { api } from '../api/client'
import { applyDerivation } from './media'

const docs: PleinDoc[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const doc of docs.splice(0)) doc.destroy()
})
function setup() {
  const doc = openDoc()
  docs.push(doc)
  const source = createElement(doc, { kind: 'image', assetId: 'source', x: 0, y: 0, w: 160, h: 90 })
  const engine = { doc, scene: new Scene(doc), selection: { set: vi.fn() } } as unknown as Engine
  doc.undo.clear()
  return { doc, engine, source }
}
const made = {
  assets: [{ id: 'cropped', kind: 'image', width: 80, height: 90, name: '裁剪.png' }],
} as MediaDerivation
const input = { op: 'crop' as const, assetId: 'source', left: 0, top: 0, width: 80, height: 90 }

it.each(['delete', 'replace', 'identity', 'readonly', 'locked', 'cancel'] as const)(
  '加工传输忽略取消并迟到返回时，%s 不写入或增加撤销记录',
  async (change) => {
    const { doc, engine, source } = setup()
    let release!: (value: MediaDerivation) => void
    const transport = vi.spyOn(api, 'mediaDerive').mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve
        }),
    )
    const controller = new AbortController()
    const pending = applyDerivation(engine, input, source, controller.signal)
    if (change === 'delete') doc.elementMaps.delete(source)
    if (change === 'identity') {
      doc.elementMaps.delete(source)
      createElement(doc, {
        id: source,
        kind: 'image',
        assetId: 'source',
        x: 0,
        y: 0,
        w: 160,
        h: 90,
      })
    }
    if (change === 'replace') updateElement(doc, source, { assetId: 'replacement' })
    if (change === 'readonly') doc.readOnly = true
    if (change === 'locked') updateElement(doc, source, { locked: true })
    if (change === 'cancel') controller.abort()
    const steps = doc.undo.undoStack.length
    release(made)
    await expect(pending).rejects.toThrow(
      change === 'delete' || change === 'replace' ? '素材已变化' : undefined,
    )
    expect([...doc.elements()].some((el) => el.assetId === 'cropped')).toBe(false)
    expect(doc.undo.undoStack).toHaveLength(steps)
    expect(transport).toHaveBeenCalledWith(input, controller.signal)
  },
)
it('已失效或预先取消的请求不发往服务端', async () => {
  const { engine, source } = setup()
  const send = vi.spyOn(api, 'mediaDerive')
  const controller = new AbortController()
  controller.abort()
  await expect(applyDerivation(engine, input, source, controller.signal)).rejects.toThrow()
  await expect(applyDerivation(engine, { ...input, assetId: 'old' }, source)).rejects.toThrow(
    '素材已变化',
  )
  expect(send).not.toHaveBeenCalled()
})
it('有效加工返回新卡片但不接管选择，产物单独撤销且保留期间的编辑', async () => {
  const { doc, engine, source } = setup()
  let release!: (value: MediaDerivation) => void
  vi.spyOn(api, 'mediaDerive').mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve
      }),
  )
  const pending = applyDerivation(engine, input, source)
  updateElement(doc, source, { name: '新名称' })
  release(made)
  const result = await pending
  expect(result.created).toHaveLength(1)
  expect(engine.selection.set).not.toHaveBeenCalled()
  expect(doc.get(result.created[0]!)).toMatchObject({ assetId: 'cropped', w: 80, h: 90 })
  doc.undo.undo()
  expect(doc.get(result.created[0]!)).toBeUndefined()
  expect(doc.get(source)?.name).toBe('新名称')
  doc.undo.redo()
  expect(doc.get(result.created[0]!)?.assetId).toBe('cropped')
})

it.each(['inside', 'nested', 'moved'] as const)(
  '加工产物在 %s 分组内保持归属和世界位置，撤销重做后随父级移动',
  async (mode) => {
    const doc = openDoc()
    docs.push(doc)
    const outer = createElement(doc, { kind: 'frame', x: 100, y: 200, w: 1400, h: 900 })
    const parent =
      mode === 'nested'
        ? createElement(doc, { kind: 'frame', parentId: outer, x: 50, y: 50, w: 1000, h: 700 })
        : outer
    const source = createElement(doc, {
      kind: 'image',
      assetId: 'source',
      parentId: parent,
      x: 100,
      y: 200,
      w: 160,
      h: 90,
    })
    const engine = { doc, scene: new Scene(doc) } as unknown as Engine
    let release!: (value: MediaDerivation) => void
    vi.spyOn(api, 'mediaDerive').mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve
        }),
    )
    const pending = applyDerivation(engine, input, source)
    if (mode === 'moved') updateElement(doc, outer, { x: 2000, y: 1000 })
    const sourceRect = doc.worldRect(source)!
    release(made)
    const { created } = await pending
    const result = created[0]!
    expect(doc.get(result)?.parentId).toBe(parent)
    const rect = doc.worldRect(result)!
    expect(rect).toEqual({ x: sourceRect.x + sourceRect.w + 80, y: sourceRect.y, w: 80, h: 90 })
    doc.undo.undo()
    expect(doc.get(result)).toBeUndefined()
    doc.undo.redo()
    expect(doc.get(result)?.parentId).toBe(parent)
    expect(doc.worldRect(result)).toEqual(rect)
    updateElement(doc, outer, { x: doc.get(outer)!.x + 200 })
    expect(doc.worldRect(result)).toEqual({ ...rect, x: rect.x + 200 })
  },
)
it('音视频分离按每张卡片最终范围归组，超出分组的音频留在根层且保留相对位置', async () => {
  const doc = openDoc()
  docs.push(doc)
  const frame = createElement(doc, { kind: 'frame', x: 100, y: 100, w: 450, h: 600 })
  const source = createElement(doc, {
    kind: 'video',
    assetId: 'source',
    parentId: frame,
    x: 50,
    y: 200,
    w: 160,
    h: 90,
  })
  const engine = { doc, scene: new Scene(doc) } as unknown as Engine
  vi.spyOn(api, 'mediaDerive').mockResolvedValue({
    assets: [
      { id: 'silent', kind: 'video', width: 160, height: 90, name: '画面.mp4' },
      { id: 'sound', kind: 'audio', name: '声音.wav' },
    ],
  } as MediaDerivation)
  const { created } = await applyDerivation(engine, { op: 'separate', assetId: 'source' }, source)
  expect(created).toHaveLength(2)
  expect(doc.get(created[0]!)?.parentId).toBe(frame)
  expect(doc.get(created[1]!)?.parentId).toBeNull()
  const a = doc.worldRect(created[0]!)!,
    b = doc.worldRect(created[1]!)!
  expect(b.x - a.x - a.w).toBe(16)
  expect(Math.abs(a.y + a.h / 2 - (b.y + b.h / 2))).toBeLessThanOrEqual(1)
})
