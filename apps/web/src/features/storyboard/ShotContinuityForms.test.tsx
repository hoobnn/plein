// @vitest-environment happy-dom
import type { Engine } from '@plein/canvas-core'
import {
  addResults,
  createDoc,
  createElement,
  registerContinuitySubject,
  setParam,
  type PleinDoc,
} from '@plein/doc'
import { Shot } from '@plein/nodes'
import { afterEach, expect, it, vi } from 'vite-plus/test'
import { useCanvas } from '../../stores/canvas'
import { useCatalog } from '../../stores/catalog'
import { useSession } from '../../stores/session'
import { mockFetch } from '../../testing/fetch'
import { act, fireEvent, renderApp, screen, waitFor, within } from '../../testing/render'
import { resetStoreAfterEach } from '../../testing/render'
import { ShotObservationForm } from './ShotObservationForm'
import { StoryboardEditor } from './StoryboardEditor'

resetStoreAfterEach(useCatalog)

const docs: PleinDoc[] = []
afterEach(() => {
  for (const doc of docs.splice(0)) doc.destroy()
})

function fixture() {
  const doc = createDoc()
  docs.push(doc)
  const board = createElement(doc, {
    x: 0,
    y: 0,
    w: 100,
    h: 80,
    id: 'board',
    kind: 'node',
    nodeType: 'plein/storyboard',
    params: {
      shots: [
        Shot.parse({
          id: 'one',
          no: 1,
          description: '原画面',
          motionPrompt: '原运动',
          lighting: '原光影',
        }),
      ],
    },
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
  return { doc, engine, board }
}

it('连续性计划保存后，状态层和控制层 Esc 均只关顶层且零提交', async () => {
  const { doc, board } = fixture()
  const fetch = mockFetch()
  const { user } = renderApp(<StoryboardEditor />)
  const editor = screen.getByRole('dialog', { name: '分镜表' })
  await user.click(within(editor).getByRole('button', { name: '详细卡片' }))
  await user.click(within(editor).getByRole('button', { name: '目的与起止状态' }))
  const state = await screen.findByRole('dialog', { name: '镜头目的与起止计划' })
  await user.click(within(state).getByText('添加可选主体', { exact: true }))
  await user.selectOptions(within(state).getByLabelText('主体类型'), 'prop')
  await user.type(within(state).getByRole('textbox', { name: '主体名称' }), '红信封')
  await user.click(within(state).getByRole('button', { name: '添加主体' }))
  await user.type(within(state).getByRole('textbox', { name: '镜头目的' }), '建立持有关系')
  await user.click(within(state).getByRole('button', { name: '保存计划新版本' }))
  const continuity = doc.get(board)?.production?.continuity
  expect(continuity?.subjects.map((subject) => subject.label)).toEqual(['红信封'])
  expect(continuity?.plans[0]?.content.intent).toBe('建立持有关系')
  await user.keyboard('{Escape}')
  await waitFor(() =>
    expect(screen.queryByRole('dialog', { name: '镜头目的与起止计划' })).toBeNull(),
  )
  expect(screen.getByRole('dialog', { name: '分镜表' })).toBe(editor)

  await user.click(within(editor).getByRole('button', { name: '镜头 1 控制' }))
  const controls = await screen.findByRole('dialog', { name: '镜头控制' })
  await user.type(within(controls).getByRole('textbox', { name: '相机运动' }), '缓慢推近')
  await user.click(within(controls).getByRole('button', { name: '生成提示词草稿' }))
  expect(
    (within(controls).getByRole('textbox', { name: '建议运动提示词' }) as HTMLTextAreaElement)
      .value,
  ).toContain('相机运动：缓慢推近')
  await user.keyboard('{Escape}')
  await waitFor(() => expect(screen.queryByRole('dialog', { name: '镜头控制' })).toBeNull())
  expect(screen.getByRole('dialog', { name: '分镜表' })).toBe(editor)
  expect(doc.get(board)?.params?.shots).toEqual([
    expect.objectContaining({ motionPrompt: '原运动' }),
  ])
  expect(fetch).not.toHaveBeenCalled()
})

it('候选观察按 result 隔离，并用给定回放证据控制区间与声音项', async () => {
  const { doc, engine, board } = fixture()
  const node = createElement(doc, {
    x: 0,
    y: 0,
    w: 100,
    h: 80,
    id: 'video',
    kind: 'node',
    nodeType: 'plein/video',
    params: { source: { storyboard: board, shot: 'one', role: 'video' } },
  })
  const assetId = 'a'.repeat(64)
  addResults(doc, node, [
    { id: 'old-result', runId: 'old-run', port: 'video', at: 1, value: { type: 'video', assetId } },
  ])
  registerContinuitySubject(doc, {
    scope: { canvasId: 'canvas', boardId: board },
    kind: 'prop',
    label: '红信封',
  })
  const props = {
    engine,
    canvasId: 'canvas',
    boardId: board,
    shotId: 'one',
    phase: 'start' as const,
    frameAssetId: 'f'.repeat(64),
  }
  const { user, rerender } = renderApp(<ShotObservationForm {...props} node={doc.get(node)!} />)
  const form = () => screen.getByRole('region', { name: '起始候选观察' })
  expect(
    (within(form()).getByRole('option', { name: '实际回放区间' }) as HTMLOptionElement).disabled,
  ).toBe(true)
  await user.type(within(form()).getByRole('textbox', { name: '起始观察备注' }), '色块无法判断')
  await user.click(within(form()).getByRole('button', { name: '保存独立观察' }))
  expect(within(form()).getByRole('list', { name: '起始当前候选观察' }).textContent).toContain(
    '无法判断',
  )
  act(() => {
    addResults(doc, node, [
      {
        id: 'new-result',
        runId: 'new-run',
        port: 'video',
        at: 2,
        value: { type: 'video', assetId },
      },
    ])
    doc.flush()
    rerender(
      <ShotObservationForm
        {...props}
        node={doc.get(node)!}
        playback={{ assetId, start: 0, end: 1, duration: 3, audible: false }}
      />,
    )
  })
  await waitFor(() =>
    expect(
      within(form()).getByRole('list', { name: '起始当前候选观察' }).querySelectorAll('li'),
    ).toHaveLength(0),
  )
  expect(form().textContent).toContain('历史候选观察（1）')
  expect(
    (within(form()).getByRole('option', { name: '实际回放区间' }) as HTMLOptionElement).disabled,
  ).toBe(false)
  await user.selectOptions(within(form()).getByLabelText('起始检查范围'), 'interval')
  await user.click(within(form()).getByRole('checkbox', { name: '动作回看' }))
  expect(
    (within(form()).getByRole('checkbox', { name: '声音回听' }) as HTMLInputElement).disabled,
  ).toBe(true)
  await user.click(
    within(form()).getByRole('checkbox', {
      name: '我已在所示回放区间检查所选项目；未知和推测仍保留',
    }),
  )
  await user.click(within(form()).getByRole('button', { name: '保存独立观察' }))
  const saved = doc
    .get(board)
    ?.production?.continuity?.observations.find(
      (observation) => observation.target.resultId === 'new-result',
    )
  expect(saved?.evidence).toMatchObject({
    kind: 'interval',
    start: 0,
    end: 1,
    playback: { completed: true, audible: false },
  })
})

it('镜头控制只采用勾选字段，保留原文、其他镜头和展开节点且零提交', async () => {
  const { doc, board } = fixture()
  const sibling = Shot.parse({
    id: 'two',
    no: 2,
    description: '其他镜头',
    motionPrompt: '不得覆盖',
  })
  setParam(doc, board, 'shots', [...(doc.get(board)!.params!.shots as unknown[]), sibling])
  const video = createElement(doc, {
    id: 'expanded',
    kind: 'node',
    nodeType: 'plein/video',
    x: 0,
    y: 100,
    w: 100,
    h: 80,
    params: { prompt: '节点手改', source: { storyboard: board, shot: 'one', role: 'video' } },
  })
  const before = doc.get(video)?.params
  const fetch = mockFetch()
  const { user } = renderApp(<StoryboardEditor />)
  const editor = screen.getByRole('dialog', { name: '分镜表' })
  await user.click(within(editor).getByRole('button', { name: '详细卡片' }))
  await user.click(within(editor).getByRole('button', { name: '镜头 1 控制' }))
  const controls = await screen.findByRole('dialog', { name: '镜头控制' })
  await user.type(within(controls).getByLabelText('相机运动'), '缓慢横移')
  await user.type(within(controls).getByLabelText('主体动作'), '保持姿态')
  await user.type(within(controls).getByLabelText('光源位置'), '左后方')
  await user.click(within(controls).getByRole('button', { name: '生成提示词草稿' }))
  const proposal = within(controls).getByLabelText('建议运动提示词')
  await user.type(proposal, '；用户补充节奏')
  await user.click(within(controls).getByRole('button', { name: '采用勾选字段' }))
  await waitFor(() => expect(screen.queryByRole('dialog', { name: '镜头控制' })).toBeNull())
  const rows = doc.get(board)!.params!.shots as Array<Record<string, unknown>>
  expect(rows[0]).toMatchObject({
    description: '原画面',
    imagePrompt: '',
    motionPrompt: '原运动；相机运动：缓慢横移；主体动作：保持姿态；用户补充节奏',
    lighting: '原光影；光源位置：左后方',
  })
  expect(rows[1]).toEqual(sibling)
  expect(doc.get(video)?.params).toEqual(before)
  expect(fetch).not.toHaveBeenCalled()
})

it('同帧目标变化拒绝旧控制草稿，实时只读禁用操作', async () => {
  const { doc, board } = fixture()
  const { user } = renderApp(<StoryboardEditor />)
  await user.click(screen.getByRole('button', { name: '详细卡片' }))
  await user.click(screen.getByRole('button', { name: '镜头 1 控制' }))
  const controls = await screen.findByRole('dialog', { name: '镜头控制' })
  await user.type(within(controls).getByLabelText('相机运动'), '缓慢横移')
  await user.click(within(controls).getByRole('button', { name: '生成提示词草稿' }))
  act(() => {
    setParam(doc, board, 'shots', [
      Shot.parse({ id: 'one', no: 1, motionPrompt: '协作者的新运动' }),
    ])
    fireEvent.click(within(controls).getByRole('button', { name: '采用勾选字段' }))
    doc.flush()
  })
  expect(
    within(controls)
      .getAllByRole('alert')
      .map((alert) => alert.textContent)
      .join(' '),
  ).toContain('草稿未写入')
  expect((doc.get(board)!.params!.shots as Array<{ motionPrompt: string }>)[0]!.motionPrompt).toBe(
    '协作者的新运动',
  )
  act(() => {
    doc.meta.set('schemaVersion', doc.schemaVersion + 1)
    doc.flush()
  })
  expect(
    (within(controls).getByRole('button', { name: '生成提示词草稿' }) as HTMLButtonElement)
      .disabled,
  ).toBe(true)
  expect(
    (within(controls).getByRole('button', { name: '采用勾选字段' }) as HTMLButtonElement).disabled,
  ).toBe(true)
})
