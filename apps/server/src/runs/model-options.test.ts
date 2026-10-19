import { expect, it } from 'vite-plus/test'
import { modelOptionsProblem } from './model-options'

it('未声明专属参数 schema 的模型也拒绝无效参数容器', () => {
  for (const value of [null, [], false, 0, 'broken'])
    expect(modelOptionsProblem(undefined, value)).toContain('参数格式')
  expect(modelOptionsProblem(undefined, {})).toBeUndefined()
  expect(modelOptionsProblem(undefined, { custom: false })).toBeUndefined()
})
