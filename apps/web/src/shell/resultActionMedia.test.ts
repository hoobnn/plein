import type { CanvasElement } from '@plein/doc'
import { expect, it } from 'vite-plus/test'
import { resultActionMedia } from './resultActionMedia'

const assetId = 'a'.repeat(64)
const source = {
  version: 1 as const,
  bundleAssetId: 'b'.repeat(64),
  manifestAssetId: 'c'.repeat(64),
  dependencyAssetIds: [],
  rendererIdentity: 'hyperframes:shown',
}
it('结果操作使用实际候选来源，即使当前采用项的媒体哈希相同也不替换manifest', () => {
  const current = { ...source, manifestAssetId: 'd'.repeat(64) }
  const node = {
    id: 'node',
    kind: 'node',
    adopted: 'adopted',
    params: { compositionSource: current },
    results: [{ id: 'adopted', value: { type: 'video', assetId, compositionSource: current } }],
  } as unknown as CanvasElement
  expect(
    resultActionMedia(node, { assetId, kind: 'video', compositionSource: source })
      .compositionSource,
  ).toEqual(source)
  expect(resultActionMedia(node, { assetId, kind: 'video' }).compositionSource).toBeUndefined()
})
it('仅普通同素材元素可从params补来源，显式无效来源保留错误状态', () => {
  const video = {
    id: 'video',
    kind: 'video',
    assetId,
    params: { compositionSource: source },
  } as unknown as CanvasElement
  expect(resultActionMedia(video, { assetId, kind: 'video' }).compositionSource).toEqual(source)
  expect(
    resultActionMedia(video, { assetId: 'e'.repeat(64), kind: 'video' }).compositionSource,
  ).toBeUndefined()
  expect(
    resultActionMedia(video, { assetId, kind: 'video', compositionSource: { version: 99 } })
      .compositionSourceInvalid,
  ).toBe(true)
})
