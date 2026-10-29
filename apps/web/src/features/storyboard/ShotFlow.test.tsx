// @vitest-environment happy-dom
import type { Engine } from '@plein/canvas-core'
import { createDoc, createElement } from '@plein/doc'
import { Shot } from '@plein/nodes'
import { afterEach, expect, it, vi } from 'vite-plus/test'
import { useCanvas } from '../../stores/canvas'
import { useCatalog } from '../../stores/catalog'
import { useSession } from '../../stores/session'
import { mockFetch } from '../../testing/fetch'
import {
  act,
  fireEvent,
  renderApp,
  resetStoreAfterEach,
  screen,
  waitFor,
  within,
} from '../../testing/render'
import { StoryboardEditor } from './StoryboardEditor'
import { storyboardFixture } from './testing'

resetStoreAfterEach(useCatalog)
const docs: ReturnType<typeof createDoc>[] = []
afterEach(() => docs.splice(0).forEach((doc) => doc.destroy()))

it('本地补齐只改所选空字段，保留手写内容，关闭提示词窗口先保存输入且零生成', async () => {
  const doc = createDoc()
  docs.push(doc)
  const board = createElement(doc, {
    kind: 'node',
    nodeType: 'plein/storyboard',
    x: 0,
    y: 0,
    w: 100,
    h: 100,
    params: {
      shots: [
        Shot.parse({
          id: 'one',
          no: 1,
          description: '林夏拿起杯子',
          imagePrompt: '用户手写的首帧',
          characters: ['林夏'],
        }),
        Shot.parse({ id: 'two', no: 2, description: '走向门口' }),
      ],
    },
  })
  createElement(doc, {
    kind: 'node',
    nodeType: 'plein/character',
    name: '林夏',
    x: 0,
    y: 100,
    w: 100,
    h: 100,
  })
  const engine = {
    doc,
    selection: { set: vi.fn(), onChange: vi.fn(() => () => {}) },
    onStateChange: vi.fn(() => () => {}),
    zoomToFit: vi.fn(),
  } as unknown as Engine
  useCanvas.setState({ engine, canvasId: 'canvas', storyboard: board })
  useSession.setState({ info: { principal: { id: 'local', role: 'owner' } } as never })
  useCatalog.setState({ catalog: null })
  const fetch = mockFetch()
  const { user } = renderApp(<StoryboardEditor />)
  const editor = screen.getByRole('dialog', { name: '分镜表' })
  const rows = () =>
    doc.get(board)?.params?.shots as Array<{ imagePrompt: string; motionPrompt: string }>
  const navigation = within(editor).getByRole('navigation', { name: '镜头制作流程' })
  await user.click(within(editor).getByRole('combobox', { name: '镜头 1 运镜预设' }))
  await user.click(screen.getByRole('option', { name: '推近' }))
  await user.click(within(navigation).getByRole('button', { name: /准备资产/ }))
  expect(within(editor).getByRole('article', { name: '林夏素材' }).textContent).toContain('待准备')
  await user.type(within(editor).getByRole('textbox', { name: '全局视觉风格' }), '胶片夜景')
  await user.click(within(navigation).getByRole('button', { name: /合成提示词/ }))
  await user.click(within(editor).getByRole('checkbox', { name: '选择镜头 1' }))
  await user.click(within(editor).getByRole('button', { name: '本地补齐所选提示词' }))
  expect(rows()[0]?.imagePrompt).toBe('用户手写的首帧')
  expect(rows()[0]?.motionPrompt).toContain('推近主体')
  expect(rows()[1]?.imagePrompt).toBe('')
  expect(
    (within(editor).getByRole('button', { name: '本地补齐所选提示词' }) as HTMLButtonElement)
      .disabled,
  ).toBe(true)
  await user.click(within(editor).getByRole('checkbox', { name: '选择镜头 1' }))
  await user.click(within(editor).getByRole('button', { name: '本地补齐全部提示词' }))
  expect(rows()[1]?.imagePrompt).toContain('胶片夜景')
  await user.click(
    within(within(editor).getByRole('row', { name: '镜头 01' })).getByRole('button', {
      name: '查看提示词',
    }),
  )
  const prompts = await screen.findByRole('dialog', { name: '镜头最终提示词' })
  const input = within(prompts).getByRole('textbox', { name: '分镜图提示词' })
  await user.clear(input)
  await user.type(input, '关闭也保留')
  await user.keyboard('{Escape}')
  await waitFor(() => expect(screen.queryByRole('dialog', { name: '镜头最终提示词' })).toBeNull())
  expect(rows()[0]?.imagePrompt).toBe('关闭也保留')
  expect(screen.getByRole('dialog', { name: '分镜表' })).toBe(editor)
  expect(fetch).not.toHaveBeenCalled()
})

it('表格字段在协作者写入后、重绘前失焦，不覆盖远端新内容', () => {
  const f = storyboardFixture({ count: 1 })
  renderApp(<StoryboardEditor />)
  const input = screen.getByRole<HTMLTextAreaElement>('textbox', { name: '画面' })
  fireEvent.change(input, { target: { value: '本机草稿' } })
  f.write([{ ...f.read()[0]!, description: '协作者的新画面' }])
  // 不 flush：模拟文档订阅尚未触发重绘时失焦。
  fireEvent.blur(input)
  expect(f.read()[0]?.description).toBe('协作者的新画面')
  act(f.flush)
  expect(input.value).toBe('本机草稿')
  expect(
    within(input.closest('[data-storyboard-field]') as HTMLElement).getByRole('status').textContent,
  ).toContain('已在其他位置更新')
})
