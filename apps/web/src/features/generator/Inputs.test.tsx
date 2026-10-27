// @vitest-environment happy-dom
import { connect, createElement, inputEdges, type PleinDoc } from '@plein/doc'
import { openDoc } from '@plein/doc/testing'
import type { PreparedInput } from '@plein/protocol'
import { afterEach, expect, it } from 'vite-plus/test'
import { useDocVersion } from '../../canvas/hooks'
import { upstreams, type NodeInfo } from '../../canvas/nodes'
import { act, renderApp, screen, within } from '../../testing/render'
import { mediaTestEngine } from '../../shell/media-tools/testEngine'
import { Inputs } from './Inputs'

let doc: PleinDoc
afterEach(() => doc?.destroy())
function setup() {
  doc = openDoc()
  const node = {
    type: 'plein/video',
    capability: 'video.generate',
    defaults: {},
    inputs: [
      { id: 'images', label: '图片', type: 'image', multiple: true },
      { id: 'videos', label: '视频', type: 'video', multiple: true },
      { id: 'audios', label: '音频', type: 'audio', multiple: true },
    ],
    outputs: [],
  } as unknown as NodeInfo
  const id = createElement(doc, {
    kind: 'node',
    nodeType: 'plein/video',
    ports: { inputs: node.inputs, outputs: [] },
    x: 0,
    y: 0,
    w: 160,
    h: 90,
    params: { mode: 'reference', prompt: '参考' },
  })
  for (const [i, kind] of (['image', 'image', 'video', 'audio'] as const).entries()) {
    const source = createElement(doc, {
      kind,
      name: `素材${i}`,
      assetId: `asset${i}`,
      x: i * 200,
      y: 150,
      w: 160,
      h: 90,
    })
    connect(
      doc,
      [source, kind],
      [id, kind === 'image' ? 'images' : kind === 'video' ? 'videos' : 'audios'],
    )
  }
  const engine = mediaTestEngine(doc)
  function Harness() {
    useDocVersion(doc)
    const ups = upstreams(engine, id, null)
    const inputs = Object.fromEntries(
      node.inputs.map((port) => [
        port.id,
        (ups.get(port.id) ?? []).flatMap((u) => (u.value ? [u.value] : [])),
      ]),
    )
    const prepared = { inputs, refs: [] } as unknown as PreparedInput
    return <Inputs engine={engine} el={doc.get(id)!} node={node} ups={ups} prepared={prepared} />
  }
  return { ...renderApp(<Harness />), id, engine }
}

it('多模态引用按类型编号并插入提示词，重排真实连线后显示最终顺序', async () => {
  const f = setup()
  for (const token of ['@image1', '@image2', '@video1', '@audio1'])
    await f.user.click(screen.getByRole('button', { name: token }))
  expect(doc.get(f.id)?.params?.prompt).toBe('参考 @image1 @image2 @video1 @audio1 ')
  const before = inputEdges(doc, f.id, 'images').map((edge) => edge.from[0])
  await f.user.click(screen.getByRole('button', { name: '管理参考 2' }))
  await f.user.click(screen.getByRole('button', { name: '向前移动参考 2' }))
  act(() => doc.flush())
  expect(inputEdges(doc, f.id, 'images').map((edge) => edge.from[0])).toEqual(before.reverse())
  const groups = within(screen.getByLabelText('实际送入的参考素材')).getAllByRole('group')
  expect(groups.map((g) => g.getAttribute('data-asset-id'))).toEqual([
    'asset1',
    'asset0',
    'asset2',
    'asset3',
  ])
})
