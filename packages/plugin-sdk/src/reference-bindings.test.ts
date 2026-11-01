import { expect, it } from 'vite-plus/test'
import { referenceAliases, resolveReferenceBindings } from './reference-bindings'

const a = { type: 'image' as const, assetId: 'asset-a', source: 'source-a' }
const b = { type: 'image' as const, assetId: 'asset-b', source: 'source-b' }
const bindings = { 'image1:source-a:asset-a': a, 'image2:source-b:asset-b': b }
it('重排后别名保持身份，执行时映射到实际编号且一次替换不会串号', () => {
  expect(referenceAliases([b, a], bindings).map((item) => item.token)).toEqual(['image2', 'image1'])
  expect(resolveReferenceBindings('@image1 看向 @image2', [b, a], bindings)).toEqual({
    prompt: '@image2 看向 @image1',
  })
})
it('删除、替换、同资产不同来源以及旧画布未知身份均阻断', () => {
  for (const items of [[b], [{ ...a, assetId: 'replacement' }], [{ ...a, source: 'replacement' }]])
    expect(resolveReferenceBindings('@image1', items, bindings).error).toBeTruthy()
  expect(resolveReferenceBindings('@image1', [a], undefined).error).toContain('重新选择')
  expect(resolveReferenceBindings('无编号引用', [a], undefined)).toEqual({ prompt: '无编号引用' })
})
it('协作中的同别名冲突不会静默覆盖，重新打开后仍阻断', () => {
  const merged = JSON.parse(JSON.stringify({ 'image1:a': a, 'image1:b': b }))
  expect(resolveReferenceBindings('@image1', [a, b], merged).error).toBeTruthy()
  expect(referenceAliases([a, b], merged).map((item) => item.token)).toEqual(['image2', 'image3'])
})
