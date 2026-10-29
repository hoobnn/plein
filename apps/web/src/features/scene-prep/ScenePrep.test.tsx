// @vitest-environment happy-dom
import type { Engine } from '@plein/canvas-core'
import {
  appendShotPlan,
  createElement,
  registerContinuitySubject,
  setParam,
  type PleinDoc,
} from '@plein/doc'
import { node, openDoc } from '@plein/doc/testing'
import { Shot } from '@plein/nodes'
import { afterEach, expect, it, vi } from 'vite-plus/test'
import { useCanvas } from '../../stores/canvas'
import { renderApp, resetStoreAfterEach, screen, waitFor, within } from '../../testing/render'
import { saveCardToLibrary } from '../library/canvas'
import { useLibrary } from '../library/store'
import { ScenePrep } from './ScenePrep'

vi.mock('../library/canvas', async (original) => ({
  ...(await original<typeof import('../library/canvas')>()),
  saveCardToLibrary: vi.fn(),
}))

resetStoreAfterEach(useLibrary)

const docs: PleinDoc[] = []
afterEach(() => {
  docs.splice(0).forEach((doc) => doc.destroy())
  vi.mocked(saveCardToLibrary).mockReset()
})

function fixture(
  views: unknown[] = [{ id: 'door', name: '门口', description: '从楼梯口看向水箱' }],
) {
  const doc = openDoc()
  docs.push(doc)
  const sceneId = createElement(
    doc,
    node({
      id: 'scene',
      nodeType: 'plein/scene',
      name: '天台',
      params: { description: '雨后的旧城天台', sceneViews: views },
    }),
  )
  const boardId = createElement(
    doc,
    node({
      id: 'board',
      nodeType: 'plein/storyboard',
      name: '第一集',
      params: {
        shots: [
          Shot.parse({
            id: 'shot-two',
            no: 2,
            description: '林夏穿过天台',
            characters: ['天台'],
            assetBindings: { 天台: { elementId: sceneId } },
            imagePrompt: '@天台/门口',
          }),
        ],
      },
    }),
  )
  const engine = {
    doc,
    onStateChange: () => () => {},
    selection: { onChange: () => () => {}, set: vi.fn() },
    zoomToFit: vi.fn(),
  } as unknown as Engine
  useCanvas.setState({ engine, canvasId: 'canvas', scenePrep: sceneId })
  return { doc, engine, sceneId, boardId }
}

it('镜头行展示走位并打开对应工作台', async () => {
  const { doc, boardId } = fixture()
  const scope = { canvasId: 'canvas', boardId }
  const subjectId = registerContinuitySubject(doc, {
    scope,
    kind: 'character',
    label: '林夏',
  })!
  appendShotPlan(doc, {
    scope,
    shotId: 'shot-two',
    expectedHeads: [],
    userId: 'local',
    content: {
      start: { [subjectId]: { worldPosition: '水箱旁', pose: '扶着水箱' } },
      end: { [subjectId]: { worldPosition: '楼梯口', pose: '扶着水箱' } },
      inherits: [],
    },
  })
  const { user } = renderApp(<ScenePrep />)
  const dialog = await screen.findByRole('dialog', { name: '场景准备：天台' })
  expect(within(dialog).getByRole('region', { name: '视角：门口' })).toBeDefined()
  expect(within(dialog).getByText('林夏 · 水箱旁 → 楼梯口 · 姿势：扶着水箱')).toBeDefined()

  await user.click(within(dialog).getByRole('button', { name: /第一集 · 镜头 2/ }))
  expect(useCanvas.getState().scenePrep).toBeNull()
  expect(useCanvas.getState().shotWorkbench).toEqual({ boardId, shotId: 'shot-two' })
})

it('没有命名视角时先保存场景卡，再打开资产库编辑', async () => {
  const { engine, sceneId } = fixture([])
  vi.spyOn(useLibrary.getState(), 'load').mockResolvedValue()
  vi.mocked(saveCardToLibrary).mockResolvedValue({
    item: { id: 'lib-scene', kind: 'scene', name: '天台' } as never,
    created: true,
  })
  const { user } = renderApp(<ScenePrep />)
  const dialog = await screen.findByRole('dialog', { name: '场景准备：天台' })
  expect(within(dialog).getByText('还没有命名视角')).toBeDefined()

  await user.click(within(dialog).getByRole('button', { name: '编辑视角' }))
  await waitFor(() => expect(useLibrary.getState().open).toBe('scene'))
  expect(saveCardToLibrary).toHaveBeenCalledWith(
    engine,
    expect.objectContaining({ id: sceneId }),
    null,
    expect.anything(),
    { canvasId: 'canvas', current: expect.any(Function) },
  )
  expect(useLibrary.getState().focus).toBe('lib-scene')
  expect(useCanvas.getState().scenePrep).toBeNull()
})

it('已关联资产库的场景加载后直接编辑最新关联条目', async () => {
  const { doc, sceneId } = fixture()
  setParam(doc, sceneId, 'libraryId', 'lib-old')
  useLibrary.setState({
    items: [
      { id: 'lib-old', kind: 'scene', name: '旧场景' },
      { id: 'lib-new', kind: 'scene', name: '新场景' },
    ] as never,
  })
  vi.spyOn(useLibrary.getState(), 'load').mockImplementation(async () => {
    // 模拟等待列表时协作者更新了卡片关联。
    setParam(doc, sceneId, 'libraryId', 'lib-new')
  })
  const { user } = renderApp(<ScenePrep />)
  const dialog = await screen.findByRole('dialog', { name: '场景准备：天台' })
  await user.click(within(dialog).getByRole('button', { name: '编辑视角' }))

  await waitFor(() => expect(useLibrary.getState().open).toBe('scene'))
  expect(useLibrary.getState().focus).toBe('lib-new')
})

it('资产库加载失败时提示并保留场景准备', async () => {
  const { sceneId } = fixture()
  vi.spyOn(useLibrary.getState(), 'load').mockImplementation(async () => {
    useLibrary.setState({ error: '网络不可用' })
  })
  const { user } = renderApp(<ScenePrep />)
  const dialog = await screen.findByRole('dialog', { name: '场景准备：天台' })
  await user.click(within(dialog).getByRole('button', { name: '编辑视角' }))

  await waitFor(() => expect(useCanvas.getState().notice).toBe('打不开场景编辑：网络不可用'))
  expect(useCanvas.getState().scenePrep).toBe(sceneId)
  expect(useLibrary.getState().open).toBeNull()
  expect(saveCardToLibrary).not.toHaveBeenCalled()
})

it('关联条目已删除时提示，不隐式新建条目', async () => {
  const { doc, sceneId } = fixture()
  setParam(doc, sceneId, 'libraryId', 'lib-deleted')
  vi.spyOn(useLibrary.getState(), 'load').mockResolvedValue()
  const { user } = renderApp(<ScenePrep />)
  const dialog = await screen.findByRole('dialog', { name: '场景准备：天台' })
  await user.click(within(dialog).getByRole('button', { name: '编辑视角' }))

  await waitFor(() =>
    expect(useCanvas.getState().notice).toBe('打不开场景编辑：关联的资产库条目已删除'),
  )
  expect(useCanvas.getState().scenePrep).toBe(sceneId)
  expect(saveCardToLibrary).not.toHaveBeenCalled()
})
