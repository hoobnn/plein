// @vitest-environment happy-dom
import type { Engine } from '@plein/canvas-core'
import { createElement, setParam, type PleinDoc } from '@plein/doc'
import { openDoc } from '@plein/doc/testing'
import { corePlugin } from '@plein/nodes'
import { describeNode, referenceBindings } from '@plein/plugin-sdk'
import { PREPARED_INPUT_VERSION, type Catalog, type PreparedInput } from '@plein/protocol'
import { createRef } from 'react'
import { afterEach, expect, it } from 'vite-plus/test'
import { useDocVersion } from '../../canvas/hooks'
import { useCatalog } from '../../stores/catalog'
import { mockResizeObserver } from '../../testing/browser'
import { act, renderApp, resetStoreAfterEach, screen, waitFor, within } from '../../testing/render'
import { PromptBox } from './PromptBox'

resetStoreAfterEach(useCatalog)
const docs: PleinDoc[] = []
afterEach(() => docs.splice(0).forEach((doc) => doc.destroy()))

it('别名撞车时按选中项的完整身份绑定，不会绑到另一个来源', async () => {
  mockResizeObserver()
  const doc = openDoc()
  docs.push(doc)
  const node = {
    ...describeNode(
      corePlugin.nodes.find((n) => n.type === 'plein/video')!,
      'plein/core',
    ),
    executable: true,
  }
  useCatalog.setState({ catalog: { nodes: [node] } as unknown as Catalog })
  const clip = createElement(doc, {
    id: 'clip',
    kind: 'node',
    nodeType: 'plein/video',
    name: '镜头',
    x: 0,
    y: 0,
    w: 200,
    h: 100,
    ports: {
      inputs: [],
      outputs: [
        { id: 'video', label: '视频', type: 'video' },
        { id: 'lastFrame', label: '尾帧', type: 'image' },
      ],
    },
    params: {},
  })
  const frameElement = createElement(doc, {
    id: 'frame-el',
    kind: 'image',
    name: '镜头·尾帧',
    assetId: 'frame-asset',
    x: 300,
    y: 0,
    w: 200,
    h: 100,
  })
  const selfId = createElement(doc, {
    kind: 'node',
    nodeType: node.type,
    ports: { inputs: node.inputs, outputs: node.outputs },
    params: { mode: 'reference', prompt: '' },
    x: 0,
    y: 200,
    w: 200,
    h: 100,
  })
  const prepared = {
    v: PREPARED_INPUT_VERSION,
    nodeId: selfId,
    nodeType: node.type,
    preparedAt: 1,
    status: 'ready',
    params: { mode: 'reference' },
    inputs: {
      videos: [{ type: 'video', assetId: 'clip-asset', source: clip, sourcePort: 'video' }],
      images: [{ type: 'image', assetId: 'tail-asset', source: clip, sourcePort: 'lastFrame' }],
    },
    refs: [],
    notices: [],
    blocked: [],
    sent: [],
  } as unknown as PreparedInput
  const engine = { doc } as Engine
  const ref = createRef<HTMLTextAreaElement>()
  function Harness() {
    useDocVersion(doc)
    return (
      <PromptBox
        ref={ref}
        engine={engine}
        selfId={selfId}
        prepared={prepared}
        value={String(doc.get(selfId)?.params?.prompt ?? '')}
        presets={[]}
        placeholder=""
        onChange={(value) => {
          setParam(doc, selfId, 'prompt', value)
          doc.flush()
        }}
        onPreset={() => {}}
      />
    )
  }
  const rendered = renderApp(<Harness />)
  const field = screen.getByRole<HTMLTextAreaElement>('textbox', { name: '提示词' })
  field.focus()
  field.setSelectionRange(field.value.length, field.value.length)
  await rendered.user.type(field, '@')
  const menu = await screen.findByRole('dialog', { name: '引用素材' })
  const search = within(menu).getByRole<HTMLInputElement>('textbox', { name: '搜索引用素材' })
  await rendered.user.type(search, '尾帧')
  const tail = await waitFor(() => within(menu).getByTitle(/@镜头·尾帧#2/))
  await rendered.user.click(tail)
  await waitFor(() => expect(field.value).toContain('@镜头·尾帧#2'))
  act(() => doc.flush())
  expect(referenceBindings(doc.get(selfId)!.params)['镜头·尾帧#2']).toMatchObject({
    source: clip,
    sourcePort: 'lastFrame',
  })
  expect(referenceBindings(doc.get(selfId)!.params)['镜头·尾帧']).toBeUndefined()

  // 另一个真实名为「镜头·尾帧」的素材仍按它自己的身份绑定。
  field.focus()
  field.setSelectionRange(field.value.length, field.value.length)
  await rendered.user.type(field, '@')
  const menu2 = await screen.findByRole('dialog', { name: '引用素材' })
  const search2 = within(menu2).getByRole<HTMLInputElement>('textbox', { name: '搜索引用素材' })
  await rendered.user.type(search2, '尾帧')
  const imageOption = await waitFor(() => within(menu2).getByTitle(/镜头·尾帧 · 图片/))
  await rendered.user.click(imageOption)
  await waitFor(() => expect(field.value).toContain('@镜头·尾帧'))
  act(() => doc.flush())
  expect(referenceBindings(doc.get(selfId)!.params)['镜头·尾帧']).toMatchObject({
    source: frameElement,
  })
})
