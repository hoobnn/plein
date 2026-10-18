import type { Engine } from '@plein/canvas-core'
import { createDoc, createElement, deleteElements, setParent, updateElement } from '@plein/doc'
import { expect, it } from 'vite-plus/test'
import { mediaIn, mediaSelectionKey, selectionSeed } from './canvas'

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)
const V = 'c'.repeat(64)
const setup = () => {
  const doc = createDoc(undefined, { schedule: () => {} })
  let selected: string[] = []
  const engine = { doc, selection: { values: () => selected } } as unknown as Engine
  const image = (name: string, assetId: string) =>
    createElement(doc, { kind: 'image', name, assetId, x: 0, y: 0, w: 200, h: 150 })
  return {
    doc,
    engine,
    image,
    select: (ids: string[]) => {
      selected = ids
    },
  }
}

it('重复资产只预填一次，改名保留菜单身份但使用最新名称', () => {
  const { doc, engine, image, select } = setup()
  const a = image('水杯', A)
  const duplicate = image('同图副本', A)
  select([a, duplicate])
  const expected = mediaIn(engine, [a, duplicate])
  expect(expected).toHaveLength(1)
  expect(selectionSeed(engine, expected)).toEqual({ name: '水杯', images: [A], videos: [] })
  updateElement(doc, a, { name: '改名水杯' })
  expect(mediaSelectionKey(mediaIn(engine, [a, duplicate]))).toBe(mediaSelectionKey(expected))
  expect(selectionSeed(engine, expected)?.name).toBe('改名水杯')
})

it('选区、素材顺序、当前结果或目标存在状态变化时拒绝旧菜单', () => {
  const { doc, engine, image, select } = setup()
  const a = image('水杯', A)
  const b = image('桌子', B)
  select([a, b])
  const expected = mediaIn(engine, [a, b])
  select([b, a])
  expect(selectionSeed(engine, expected)).toBeNull()
  select([a])
  expect(selectionSeed(engine, expected)).toBeNull()
  select([a, b])
  updateElement(doc, a, { assetId: B })
  expect(selectionSeed(engine, expected)).toBeNull()
  updateElement(doc, a, { assetId: A })
  deleteElements(doc, [a])
  expect(selectionSeed(engine, expected)).toBeNull()
})

it('Frame 后代去重并保留图片和视频的类型，空输入不打开空表单', () => {
  const { doc, engine, image, select } = setup()
  const frame = createElement(doc, { kind: 'frame', x: 0, y: 0, w: 600, h: 400 })
  const a = image('水杯', A)
  setParent(doc, [a], frame)
  const video = createElement(doc, { kind: 'video', assetId: V, x: 0, y: 0, w: 200, h: 150 })
  select([frame, a, video])
  const expected = mediaIn(engine, [frame, a, video])
  expect(expected).toHaveLength(2)
  expect(selectionSeed(engine, expected)).toEqual({ name: undefined, images: [A], videos: [V] })
  expect(selectionSeed(engine, [])).toBeNull()
})
