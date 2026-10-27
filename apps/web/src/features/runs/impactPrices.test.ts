import type { ImpactNode } from '@plein/protocol'
import { expect, it } from 'vite-plus/test'
import { impactPrices } from './impactPrices'

const node = (over: Partial<ImpactNode> = {}): ImpactNode => ({
  nodeId: 'node',
  name: '镜头',
  nodeType: 'plein/image',
  impact: 'direct',
  suggest: 'rerun',
  causes: [],
  ...over,
})

it('按币种分别求和，缓存命中不计费，未知价格与零价格不混淆', () => {
  expect(
    impactPrices([
      node({ price: { currency: 'CNY', amount: 2 } }),
      node({ price: { currency: 'USD', amount: 3 } }),
      node({ price: { currency: 'CNY', amount: 4 } }),
      node({ price: { currency: 'USD', amount: 0 } }),
      node({ cached: { resultId: 'existing' }, price: { currency: 'CNY', amount: 100 } }),
      node({ cached: { resultId: 'unknown-cached' } }),
      node(),
    ]),
  ).toEqual({
    prices: [
      { currency: 'CNY', amount: 6 },
      { currency: 'USD', amount: 3 },
    ],
    unknown: 1,
  })
  expect(impactPrices([])).toEqual({ prices: [], unknown: 0 })
})
