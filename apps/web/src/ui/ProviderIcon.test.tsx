import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vite-plus/test'
import { ProviderIcon, providerBrand } from './ProviderIcon'

it('已知平台使用各自的品牌色，方舟与豆包区分开', () => {
  expect(providerBrand('volc/ark').from).toBe('#3370FF')
  expect(providerBrand('aliyun/bailian').from).toBe('#FF6A00')
  expect(providerBrand('minimax/api').from).toBe('#E7336B')
  expect(providerBrand('plein/compatible').from).toBe('#6B7280')
  expect(providerBrand('plein/mock').from).toBe('#9CA3AF')
  // 豆包带青色渐变，不会和方舟的纯蓝混淆
  expect(providerBrand('doubao/speech').to).toBeDefined()
  expect(providerBrand('volc/ark').to).toBeUndefined()
})

it('同厂商的新平台沿用厂商色和 logo，未知平台按 id 稳定取色', () => {
  expect(providerBrand('volc/ark-plan').logo).toBe(providerBrand('volc/ark').logo)
  expect(providerBrand('acme/video')).toEqual(providerBrand('acme/video'))
  expect(providerBrand('acme/video').glyph).toBe('V')
})

it('有 logo 的平台用品牌色 mask，并垫品牌色浅底和主题描边', () => {
  const html = renderToStaticMarkup(<ProviderIcon provider="doubao/speech" size={28} />)
  expect(html).toContain('width:28px')
  expect(html).toContain('mask-image')
  expect(html).toContain('linear-gradient(135deg, #1E6FFF, #12C8C8)')
  expect(html).toContain('color-mix(in srgb, #1E6FFF 14%, transparent)')
  expect(html).toContain('var(--line-strong)')
})

it('没有 logo 的平台继续画彩色字母块，未知平台也不会引用外部图片', () => {
  const compatible = renderToStaticMarkup(<ProviderIcon provider="plein/compatible" size={24} />)
  expect(compatible).toContain('<svg')
  expect(compatible).toContain('fill="#6B7280"')
  expect(compatible).toContain('兼')
  expect(compatible).not.toContain('mask-image')

  const unknown = renderToStaticMarkup(<ProviderIcon provider="acme/video" />)
  expect(unknown).toContain('<svg')
  expect(unknown).not.toContain('<image')
  expect(unknown).not.toContain('href=')
})
