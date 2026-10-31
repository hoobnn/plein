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

it('同厂商的新平台沿用厂商色，未知平台按 id 稳定取色', () => {
  expect(providerBrand('volc/ark-plan').from).toBe('#3370FF')
  expect(providerBrand('acme/video')).toEqual(providerBrand('acme/video'))
  expect(providerBrand('acme/video').glyph).toBe('V')
})

it('图标是自绘 SVG，带主题描边且不带外部图片引用', () => {
  const html = renderToStaticMarkup(<ProviderIcon provider="volc/ark" size={24} />)
  expect(html).toContain('<svg')
  expect(html).toContain('width="24"')
  expect(html).toContain('var(--line-strong)')
  expect(html).not.toContain('<image')
  expect(html).not.toContain('href=')
})
