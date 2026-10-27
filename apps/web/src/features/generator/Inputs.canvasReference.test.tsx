// @vitest-environment happy-dom
import type { Engine } from '@plein/canvas-core'
import { connect, createElement, inputEdges, type PleinDoc } from '@plein/doc'
import { openDoc } from '@plein/doc/testing'
import { corePlugin } from '@plein/nodes'
import { describeNode } from '@plein/plugin-sdk'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { useDocVersion } from '../../canvas/hooks'
import { upstreams, type NodeInfo } from '../../canvas/nodes'
import { useCanvas } from '../../stores/canvas'
import { act, renderApp, screen, waitFor } from '../../testing/render'
import { Inputs } from './Inputs'

const docs: PleinDoc[] = []
afterEach(() => docs.splice(0).forEach((doc) => doc.destroy()))

const node = {
  ...describeNode(
    corePlugin.nodes.find((n) => n.type === 'plein/video')!,
    'plein/core',
  ),
  executable: true,
} as unknown as NodeInfo

/** 目标节点带图片口（可多接），画布上另有一张可接的图 */
function setup() {
  const doc = openDoc()
  docs.push(doc)
  const target = createElement(doc, {
    kind: 'node',
    nodeType: 'plein/video',
    name: '目标',
    params: {},
    ports: { inputs: node.inputs, outputs: node.outputs },
    x: 0,
    y: 0,
    w: 200,
    h: 100,
  })
  const image = createElement(doc, {
    kind: 'image',
    name: '画布中的人物图',
    assetId: 'a1',
    x: 0,
    y: 200,
    w: 100,
    h: 100,
  })
  const engine = {
    doc,
    selection: { set: vi.fn() },
    zoomToFit: vi.fn(),
    scene: { rect: (id: string) => doc.worldRect(id) },
  } as unknown as Engine
  useCanvas.setState({ engine, canvasId: 'c' })
  function Harness() {
    useDocVersion(doc)
    return (
      <Inputs
        engine={engine}
        el={doc.get(target)!}
        node={node}
        ups={upstreams(engine, target, null)}
      />
    )
  }
  return { doc, target, image, engine, ...renderApp(<Harness />) }
}

describe('画布参考的接入与撤销', () => {
  it('搜索到画布素材后点选会真的接上连线，撤销后连线消失', async () => {
    const f = setup()
    await f.user.click(screen.getByRole('button', { name: '画布参考' }))
    await f.user.type(screen.getByLabelText('搜索画布参考'), '人物图')
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(1))
    await f.user.click(screen.getAllByRole('option')[0]!)

    // 真的产生了连线
    await waitFor(() => expect(inputEdges(f.doc, f.target, 'images')).toHaveLength(1))
    expect(inputEdges(f.doc, f.target, 'images')[0]!.from[0]).toBe(f.image)
    // 弹层随之关闭
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '画布参考' })).toBeNull())

    // 撤销后连线消失
    act(() => {
      f.doc.undo.undo()
      f.doc.flush()
    })
    expect(inputEdges(f.doc, f.target, 'images')).toHaveLength(0)
  })

  it('已经接过的同一个输出不再重复出现在候选里', async () => {
    const f = setup()
    // 先手动接上
    act(() => {
      f.doc.undo.stopCapturing()
      connect(f.doc, [f.image, 'image'], [f.target, 'images'])
      f.doc.flush()
    })
    await f.user.click(screen.getByRole('button', { name: '画布参考' }))
    await f.user.type(screen.getByLabelText('搜索画布参考'), '人物图')
    await waitFor(() => expect(screen.queryByRole('option', { name: /画布中的人物图/ })).toBeNull())
    expect(screen.getByText('没有匹配的可用素材')).toBeTruthy()
  })
})
