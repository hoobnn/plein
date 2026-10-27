// @vitest-environment happy-dom
import type { Engine } from '@plein/canvas-core'
import { createDoc, createElement, setParam } from '@plein/doc'
import { shotPresets, styleNode, videoNode } from '@plein/nodes'
import { describeNode } from '@plein/plugin-sdk'
import type { Catalog } from '@plein/protocol'
import { afterEach, expect, it, vi } from 'vite-plus/test'
import { useDocVersion } from '../../canvas/hooks'
import { findNode } from '../../canvas/nodes'
import { useCanvas } from '../../stores/canvas'
import { act, renderApp, screen, within } from '../../testing/render'
import { ShotPresets } from './ShotPresets'

const docs: ReturnType<typeof createDoc>[] = []
afterEach(() => docs.splice(0).forEach((doc) => doc.destroy()))

it('选择预设保留正文，手改提示冲突与已改动，风格卡显式保存', async () => {
  const doc = createDoc()
  docs.push(doc)
  const id = createElement(doc, {
    kind: 'node',
    nodeType: 'plein/video',
    x: 0,
    y: 0,
    w: 200,
    h: 100,
    params: { prompt: '女孩在街口回头' },
  })
  const engine = {
    doc,
    selection: { set: vi.fn() },
    scene: { rect: (id: string) => doc.worldRect(id) },
  } as unknown as Engine
  useCanvas.setState({ engine, canvasId: 'canvas' })
  const catalog = {
    nodes: [describeNode(videoNode, 'plein/core'), describeNode(styleNode, 'plein/core')],
    prompts: shotPresets,
    providers: [],
  } as unknown as Catalog
  function Subject() {
    useDocVersion(doc)
    return (
      <ShotPresets
        engine={engine}
        el={doc.get(id)!}
        node={findNode(catalog, 'plein/video')!}
        catalog={catalog}
        promptKey="prompt"
      />
    )
  }
  const { user } = renderApp(<Subject />)
  await user.click(screen.getByText('镜头与风格'))
  const choose = async (slot: string, option: string) => {
    await user.click(screen.getByRole('button', { name: new RegExp(`^${slot}`) }))
    await user.click(
      within(screen.getByRole('dialog', { name: slot })).getByRole('button', {
        name: new RegExp(`^${option}`),
      }),
    )
  }
  await user.click(screen.getByRole('button', { name: /^运镜/ }))
  const moves = screen.getByRole('dialog', { name: '运镜' })
  await user.click(within(moves).getByRole('button', { name: '缓慢' }))
  await user.click(within(moves).getByRole('button', { name: /^推近/ }))
  await choose('景别', '中景')
  await choose('光影', '霓虹夜景')
  await choose('风格', '赛博朋克')
  expect(doc.get(id)?.params?.prompt).toBe(
    '女孩在街口回头\n镜头：缓慢推近主体，中景，膝盖以上，夜景霓虹灯光。\n风格：赛博朋克，冷暖撞色霓虹，雨夜反光。',
  )
  act(() => {
    setParam(doc, id, 'prompt', '女孩在街口回头，镜头推近她的脸')
    doc.flush()
  })
  await choose('运镜', '固定机位')
  expect(screen.getByTestId('shot-presets').textContent).toContain('和「固定机位」冲突')
  act(() => {
    setParam(
      doc,
      id,
      'prompt',
      String(doc.get(id)?.params?.prompt).replace('镜头不动', '镜头不动，雨丝很密'),
    )
    doc.flush()
  })
  expect(screen.getByRole('button', { name: /^运镜/ }).textContent).toContain('已改动')
  await user.click(screen.getByRole('button', { name: /^风格/ }))
  await user.click(
    within(screen.getByRole('dialog', { name: '风格' })).getByRole('button', {
      name: /存为风格卡/,
    }),
  )
  const card = [...doc.elements()].find((el) => el.nodeType === 'plein/style')
  expect(card).toMatchObject({
    name: '赛博朋克',
    params: { description: '赛博朋克，冷暖撞色霓虹，雨夜反光' },
  })
  expect(engine.selection.set).toHaveBeenLastCalledWith([card!.id])
})
