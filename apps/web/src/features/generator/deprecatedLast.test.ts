import { expect, it } from 'vite-plus/test'
import { deprecatedLast } from './deprecatedLast'

it('弃用模型稳定置后，保留旧画布可选条目且不修改目录原数组', () => {
  const models = [
    { id: 'current-a' },
    { id: 'deprecated-a', deprecated: true as const },
    { id: 'current-b' },
    { id: 'deprecated-b', deprecated: true as const },
  ]

  expect(deprecatedLast(models).map((model) => model.id)).toEqual([
    'current-a',
    'current-b',
    'deprecated-a',
    'deprecated-b',
  ])
  expect(models.map((model) => model.id)).toEqual([
    'current-a',
    'deprecated-a',
    'current-b',
    'deprecated-b',
  ])
})
