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

it.each(['delete', 'replace', 'readonly', 'cancel'] as const)(
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
    if (change === 'replace') updateElement(doc, source, { assetId: 'replacement' })
    if (change === 'readonly') doc.readOnly = true
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
