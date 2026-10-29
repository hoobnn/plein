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
import { useLibrary } from '../library/store'
import { ScenePrep } from './ScenePrep'

resetStoreAfterEach(useLibrary)

const docs: PleinDoc[] = []
afterEach(() => docs.splice(0).forEach((doc) => doc.destroy()))

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
  useCanvas.setState({ engine, scenePrep: sceneId })
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

it('没有命名视角时可去编辑；未关联资产库条目的场景只选中定位', async () => {
  const { doc, engine, sceneId } = fixture([])
  const before = doc.get(sceneId)?.params
  const { user } = renderApp(<ScenePrep />)
  const dialog = await screen.findByRole('dialog', { name: '场景准备：天台' })
  expect(within(dialog).getByText('还没有命名视角')).toBeDefined()

  await user.click(within(dialog).getByRole('button', { name: '编辑视角' }))
  expect(engine.selection.set).toHaveBeenCalledWith([sceneId])
  expect(engine.zoomToFit).toHaveBeenCalledWith([sceneId])
  expect(useCanvas.getState().scenePrep).toBeNull()
  expect(doc.get(sceneId)?.params).toEqual(before)
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
