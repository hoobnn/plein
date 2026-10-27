import type { Engine } from '@plein/canvas-core'
import { afterEach, beforeEach, expect, it, vi } from 'vite-plus/test'
import { ApiError } from '../../api/client'
import { useCanvas } from '../../stores/canvas'
import { promptDialog } from '../../ui/Dialog'
import { useTemplates } from './store'
import { saveAsTemplate } from './actions'

vi.mock('../../ui/Dialog', () => ({ promptDialog: vi.fn() }))
vi.mock('../../canvas/groups', () => ({
  templateData: () => ({ plein: 1, elements: [], edges: [] }),
}))
const initialCanvas = useCanvas.getState()
const initialTemplates = useTemplates.getState()
let selected: string[]
let present: Set<string>
let confirm: (name: string | null) => void
const doc = {
  readOnly: false,
  has: (id: string) => present.has(id),
  get: (id: string) => (present.has(id) ? { kind: id === 'frame' ? 'frame' : 'node' } : undefined),
}
const group = vi.fn(() => {
  selected = ['frame']
})
const notify = vi.fn()
const save = vi.fn(async () => ({
  id: 'tpl_test',
  title: '模板',
  createdAt: 1,
  data: { plein: 1 as const, elements: [], edges: [] },
}))
const engine = {
  doc,
  selection: { values: () => selected },
  groupSelection: group,
} as unknown as Engine

beforeEach(() => {
  selected = ['a', 'b']
  present = new Set(['a', 'b', 'other', 'frame'])
  doc.readOnly = false
  group.mockClear()
  notify.mockClear()
  save.mockClear()
  vi.mocked(promptDialog)
    .mockReset()
    .mockImplementation(
      () =>
        new Promise((resolve) => {
          confirm = resolve
        }),
    )
  useCanvas.setState({ ...initialCanvas, engine, canvasId: 'original', notify }, true)
  useTemplates.setState({ ...initialTemplates, save }, true)
})
afterEach(() => {
  useCanvas.setState(initialCanvas, true)
  useTemplates.setState(initialTemplates, true)
})

it.each(['selection', 'deleted', 'readonly', 'canvas', 'engine'] as const)(
  '确认等待期间 %s 变化不能存入错误目标',
  async (change) => {
    const operation = saveAsTemplate(engine, null, '模板')
    if (change === 'selection') selected = ['other']
    if (change === 'deleted') present.delete('a')
    if (change === 'readonly') doc.readOnly = true
    if (change === 'canvas') useCanvas.setState({ canvasId: 'other' })
    if (change === 'engine') useCanvas.setState({ engine: null })
    confirm('模板')
    await operation
    expect(group).not.toHaveBeenCalled()
    expect(save).not.toHaveBeenCalled()
    if (change === 'canvas' || change === 'engine') expect(notify).not.toHaveBeenCalled()
    else expect(notify).toHaveBeenCalledOnce()
  },
)

it('选区仅调整顺序仍可保存，明确指定的分组不受其他选区影响', async () => {
  const operation = saveAsTemplate(engine, null, '模板')
  selected = ['b', 'a']
  confirm('模板')
  await operation
  expect(group).toHaveBeenCalledOnce()
  expect(save).toHaveBeenCalledOnce()
  save.mockClear()
  group.mockClear()
  const explicit = saveAsTemplate(engine, 'frame', '分组')
  selected = ['other']
  confirm('分组')
  await explicit
  expect(group).not.toHaveBeenCalled()
  expect(save).toHaveBeenCalledOnce()
})

it('取消不打组不提交，已删除的指定分组也不打开确认框', async () => {
  const operation = saveAsTemplate(engine, null, '模板')
  confirm(null)
  await operation
  expect(group).not.toHaveBeenCalled()
  expect(save).not.toHaveBeenCalled()
  vi.mocked(promptDialog).mockClear()
  present.delete('frame')
  await saveAsTemplate(engine, 'frame', '分组')
  expect(promptDialog).not.toHaveBeenCalled()
})

it('保存等待时离开原画布，晚到的失败不提示在新画布', async () => {
  let reject!: (error: Error) => void
  save.mockReturnValueOnce(
    new Promise((_, fail) => {
      reject = fail
    }),
  )
  const operation = saveAsTemplate(engine, 'frame', '分组')
  confirm('分组')
  await Promise.resolve()
  expect(save).toHaveBeenCalledOnce()
  useCanvas.setState({ canvasId: 'other' })
  reject(new Error('旧画布保存失败'))
  await operation
  expect(notify).not.toHaveBeenCalled()
})

it('服务端校验失败给出可操作的说法，原样透出其它失败原因', async () => {
  vi.mocked(promptDialog).mockResolvedValue('模板')
  save.mockRejectedValueOnce(new ApiError(400, 'invalid', 'Too big: expected string'))
  await saveAsTemplate(engine, 'frame', '分组')
  expect(notify).toHaveBeenCalledWith('模板内容不合法，请检查后重试')
  save.mockRejectedValueOnce(new ApiError(503, 'template_failed', '模板保存测试失败'))
  await saveAsTemplate(engine, 'frame', '分组')
  expect(notify).toHaveBeenLastCalledWith('模板保存测试失败')
})

it('模板名长度上限与服务端一致，输入框就限制住', async () => {
  vi.mocked(promptDialog).mockResolvedValue('模板')
  await saveAsTemplate(engine, 'frame', '分组')
  expect(vi.mocked(promptDialog).mock.calls[0]![0]).toMatchObject({ maxLength: 60 })
})

it('多选保存失败后已打好的分组被保留，从分组重试不再重复打组', async () => {
  vi.mocked(promptDialog).mockResolvedValue('模板')
  save.mockRejectedValueOnce(new Error('模板保存测试失败'))
  await saveAsTemplate(engine, null, '模板')
  expect(group).toHaveBeenCalledOnce()
  expect(save).toHaveBeenCalledOnce()
  // 失败后画布上留下的是那个分组；从分组直接重试时按分组保存，不再新建
  save.mockResolvedValueOnce({
    id: 'tpl_test',
    title: '模板',
    createdAt: 1,
    data: { plein: 1 as const, elements: [], edges: [] },
  })
  await saveAsTemplate(engine, 'frame', '模板')
  expect(group).toHaveBeenCalledOnce()
  expect(save).toHaveBeenCalledTimes(2)
})
