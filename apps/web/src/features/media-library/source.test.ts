import type { CanvasElement } from '@plein/doc'
import type { MediaSource } from '@plein/protocol'
import { describe, expect, it } from 'vite-plus/test'
import { referencesAsset, sourceHint } from './source'

const node = (over: Partial<CanvasElement> = {}) =>
  ({
    id: 'node_1',
    kind: 'image',
    name: '海鸟',
    assetId: 'asset_1',
    x: 0,
    y: 0,
    w: 100,
    h: 100,
    ...over,
  }) as CanvasElement

const source = (over: Partial<MediaSource> & { id: string; label: string }): MediaSource => ({
  type: 'canvas',
  locator: 'node',
  projectId: 'pj_1',
  canvasId: 'cv_1',
  nodeId: 'node_1',
  resultId: null,
  createdAt: 1,
  adopted: false,
  locatable: true,
  ...over,
})

describe('节点对素材的引用复核', () => {
  it('资产、生成结果、交付物和参数里的引用都算这份素材', () => {
    expect(referencesAsset(node({ assetId: 'asset_1' }), 'asset_1')).toBe(true)
    expect(
      referencesAsset(
        node({
          assetId: 'other',
          results: [{ value: { assetId: 'asset_1' } }] as CanvasElement['results'],
        }),
        'asset_1',
      ),
    ).toBe(true)
    expect(
      referencesAsset(
        node({
          assetId: 'other',
          deliveries: [{ assetId: 'asset_1' }] as CanvasElement['deliveries'],
        }),
        'asset_1',
      ),
    ).toBe(true)
    expect(
      referencesAsset(
        node({ assetId: 'other', params: { reference: { assetId: 'asset_1' } } as never }),
        'asset_1',
      ),
    ).toBe(true)
  })

  it('换了素材或只剩无关参数时不再算这份素材', () => {
    expect(referencesAsset(node({ assetId: 'other' }), 'asset_1')).toBe(false)
    expect(
      referencesAsset(
        node({ assetId: 'other', params: { prompt: '无关文字' } as never }),
        'asset_1',
      ),
    ).toBe(false)
  })
})

describe('同名来源的额外标识', () => {
  it('只有同名且目的地不同的来源才需要标识', () => {
    const only = [source({ id: 's1', label: '海鸟' })]
    expect(sourceHint(only[0]!, only)).toBe('')
  })

  it('同名但画布或节点不同时给出可区分的标识', () => {
    const a = source({ id: 's1', label: '海鸟', canvasId: 'cv_1', nodeId: 'node_1' })
    const b = source({ id: 's2', label: '海鸟', canvasId: 'cv_2', nodeId: 'node_2' })
    expect(sourceHint(a, [a, b])).toBe('画布 cv_1 · 元素 node_1')
    expect(sourceHint(b, [a, b])).toBe('画布 cv_2 · 元素 node_2')
  })

  it('尾部相同的标识继续加长，避免两个来源看起来一样', () => {
    const a = source({ id: 's1', label: '海鸟', canvasId: 'cv_aaaaaa', nodeId: 'node_aaaaaa' })
    const b = source({ id: 's2', label: '海鸟', canvasId: 'cv_baaaaa', nodeId: 'node_baaaaa' })
    expect(sourceHint(a, [a, b])).not.toBe(sourceHint(b, [a, b]))
  })

  it('不可定位的来源不需要标识', () => {
    const a = source({ id: 's1', label: '海鸟', locatable: false })
    expect(sourceHint(a, [a])).toBe('')
  })
})
