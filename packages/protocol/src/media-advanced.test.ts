import { expect, it } from 'vite-plus/test'
import { MediaDeriveRequest } from './media'
const assetId = 'a'.repeat(64)
it('区域修补保留真实像素矩形，默认从0秒起；片段替换必须指定独立替换素材', () => {
  expect(
    MediaDeriveRequest.parse({
      op: 'repair-region',
      assetId,
      left: 2,
      top: 3,
      width: 40,
      height: 20,
    }),
  ).toMatchObject({ start: 0, left: 2, top: 3, width: 40, height: 20 })
  expect(
    MediaDeriveRequest.parse({
      op: 'replace-range',
      assetId,
      replacementAssetId: 'b'.repeat(64),
      start: 1,
      end: 2,
    }),
  ).toMatchObject({ replacementStart: 0, start: 1, end: 2 })
  expect(
    MediaDeriveRequest.safeParse({ op: 'replace-range', assetId, start: 1, end: 2 }).success,
  ).toBe(false)
})
it.each([{ left: 0 }, { top: -1 }, { width: 1.5 }, { height: 0 }, { start: Infinity }])(
  '拒绝不合法区域参数 %s',
  (patch) => {
    expect(
      MediaDeriveRequest.safeParse({
        op: 'repair-region',
        assetId,
        left: 2,
        top: 3,
        width: 40,
        height: 20,
        ...patch,
      }).success,
    ).toBe(false)
  },
)

it('加工来源只保留确定的输入资产，限制未知参数、非有限数值和过大区间数组', async () => {
  const { MediaDerivationOrigin, derivationAssets } = await import('./media')
  const origin = {
    version: 1,
    op: 'replace-range',
    source: { assetId, kind: 'video', name: '原视频' },
    params: {
      replacementAssetId: 'b'.repeat(64),
      start: 0,
      end: 1,
      replacementStart: 0,
      frameRate: 25,
      frames: 25,
      audio: 'source',
      fit: 'contain',
    },
  }
  expect(derivationAssets(origin)).toEqual([assetId, 'b'.repeat(64)])
  expect(derivationAssets({ ...origin, version: 2 })).toEqual([])
  expect(
    derivationAssets({ ...origin, params: { ...origin.params, arbitraryAssetId: 'c'.repeat(64) } }),
  ).toEqual([])
  expect(
    MediaDerivationOrigin.safeParse({
      ...origin,
      params: { ...origin.params, frameRate: Infinity },
    }).success,
  ).toBe(false)
  expect(
    MediaDerivationOrigin.safeParse({
      version: 1,
      op: 'split',
      source: { assetId, kind: 'audio', name: '音频' },
      params: { segments: Array.from({ length: 21 }, () => ({ start: 0, end: 1 })) },
    }).success,
  ).toBe(false)
  expect(
    derivationAssets({
      version: 1,
      op: 'frame',
      source: { assetId, kind: 'video', name: '未知时长' },
      params: { last: true },
    }),
  ).toEqual([assetId])
})
