// @vitest-environment happy-dom
import type { PreparedInput } from '@plein/protocol'
import { expect, it } from 'vite-plus/test'
import { renderApp, screen } from '../../testing/render'
import { InputDetails } from './InputDetails'

const prepared = (change: Partial<PreparedInput> = {}): PreparedInput => ({
  v: 1,
  nodeId: 'node',
  nodeType: 'plein/image',
  preparedAt: 1,
  status: 'ready',
  inputHash: 'hash',
  params: { prompt: '提示词' },
  model: { ref: 'mock/model', provider: 'mock', title: '测试模型' },
  prompt: '提示词',
  inputs: {},
  refs: [],
  blocked: [],
  notices: [],
  ...change,
})

it('权威送入列表为空时不把被拒引用说成实际参考', () => {
  renderApp(
    <InputDetails
      input={prepared({
        sent: [],
        refs: [
          {
            elementId: 'card',
            name: '角色卡',
            kind: 'character',
            required: false,
            available: ['a'.repeat(64)],
            sent: [],
            reason: 'unsupported',
          },
        ],
        unsent: [
          {
            name: '角色卡',
            reason: 'unsupported',
            message: '当前模式不收参考图',
            origins: ['mention'],
          },
        ],
      })}
    />,
  )
  expect(screen.getByText(/实际送入参考 0 项/)).toBeTruthy()
  expect(screen.queryByText(/实际送入参考 1 项/)).toBeNull()
  expect(screen.getByText('未送入 · 1')).toBeTruthy()
  expect(screen.getByText(/当前模式不收参考图/)).toBeTruthy()
})

it('旧回执没有送入列表时说明无法区分是否送入', () => {
  renderApp(
    <InputDetails
      input={prepared({
        sent: undefined,
        refs: [
          {
            elementId: 'card',
            name: '角色卡',
            kind: 'character',
            required: false,
            available: ['a'.repeat(64)],
            sent: [],
            reason: 'over_limit',
          },
        ],
      })}
    />,
  )
  expect(screen.getByText(/参考 1 项（旧记录未区分是否送入）/)).toBeTruthy()
})

it('有送入列表时列出实际参考文件', () => {
  renderApp(
    <InputDetails
      input={prepared({
        sent: [
          {
            index: 1,
            token: '图1',
            assetId: 'a'.repeat(64),
            name: '参考图A',
            origins: ['edge'],
          },
          {
            index: 2,
            token: '图2',
            assetId: 'b'.repeat(64),
            name: '尾帧B',
            role: 'lastFrame',
            origins: ['edge', 'mention'],
          },
        ],
      })}
    />,
  )
  expect(screen.getByText(/实际送入参考 2 项/)).toBeTruthy()
  expect(screen.getByRole('list', { name: '实际送入的参考素材' }).textContent).toContain('参考图A')
  expect(screen.getByRole('list', { name: '实际送入的参考素材' }).textContent).toContain(
    '尾帧 · 尾帧B',
  )
})
