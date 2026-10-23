import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { loadMediaCompositionSources } from './composition'

const source = {
  version: 1,
  bundleAssetId: 'a'.repeat(64),
  manifestAssetId: 'b'.repeat(64),
  dependencyAssetIds: [],
  rendererIdentity: 'fixture',
}
afterEach(() => vi.restoreAllMocks())

describe('素材的明确源版本身份', () => {
  it('普通素材无来源，多个冻结源保留独立身份，相同 manifest 去重', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch')
    fetch.mockResolvedValueOnce(Response.json({ sources: [] }))
    expect(await loadMediaCompositionSources('asset', new AbortController().signal)).toEqual([])
    const second = { ...source, manifestAssetId: 'c'.repeat(64) }
    fetch.mockResolvedValueOnce(
      Response.json({
        sources: [
          { title: '甲', compositionSource: source },
          { title: '乙', compositionSource: second },
          { title: '甲副本', compositionSource: source },
        ],
      }),
    )
    const values = await loadMediaCompositionSources('asset', new AbortController().signal)
    expect(values.map((entry) => entry.compositionSource.manifestAssetId)).toEqual([
      source.manifestAssetId,
      second.manifestAssetId,
    ])
  })

  it('读取失败或源引用损坏时抛错，不降级为无来源素材', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch')
    fetch.mockResolvedValueOnce(Response.json({ message: '来源读取失败' }, { status: 503 }))
    await expect(
      loadMediaCompositionSources('asset', new AbortController().signal),
    ).rejects.toThrow('来源读取失败')
    fetch.mockResolvedValueOnce(
      Response.json({
        sources: [{ title: '坏源', compositionSource: { ...source, manifestAssetId: 'missing' } }],
      }),
    )
    await expect(
      loadMediaCompositionSources('asset', new AbortController().signal),
    ).rejects.toThrow('素材源工程身份不合法')
  })
})
