import { expect, it } from 'vite-plus/test'
import {
  boundReferenceTokens,
  referenceAliases,
  resolveReferenceBindings,
} from './reference-bindings'

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

it('文件名引用保留可读正文，提交时随来源的新结果和实际顺序映射', () => {
  const name = '产品 图_2026.11.01.png'
  const saved = { [`referenceNameBinding:${encodeURIComponent(name)}:${a.source}`]: a }
  const prompt = `@${name} 向前移动，保持 @${name} 的构图`
  expect(resolveReferenceBindings(prompt, [b, { ...a, assetId: 'new-result' }], saved)).toEqual({
    prompt: '@image2 向前移动，保持 @image2 的构图',
  })
  expect(resolveReferenceBindings(prompt, [b], saved).error).toContain(name)
  expect(prompt).toContain(name)
  expect(boundReferenceTokens(`\\@${name} mail@${name} @@${name}`, saved)).toEqual([])
})

it('同名不同来源的绑定不猜测，数字形式的真实文件名也能引用', () => {
  expect(
    resolveReferenceBindings('@产品图', [a, b], {
      'referenceNameBinding:产品图:a': a,
      'referenceNameBinding:产品图:b': b,
    }).error,
  ).toBeTruthy()
  expect(
    resolveReferenceBindings('@image1', [{ ...a, assetId: 'new' }], {
      'referenceNameBinding:image1:a': a,
    }),
  ).toEqual({ prompt: '@image1' })
})
