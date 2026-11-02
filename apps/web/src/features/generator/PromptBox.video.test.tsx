// @vitest-environment happy-dom
import type { Engine } from '@plein/canvas-core'
import { addResults, connect, createElement, setParam, type PleinDoc } from '@plein/doc'
import { openDoc } from '@plein/doc/testing'
import { corePlugin } from '@plein/nodes'
import { describeNode } from '@plein/plugin-sdk'
import { PREPARED_INPUT_VERSION, type Catalog, type PreparedInput } from '@plein/protocol'
import { createRef } from 'react'
import { applyUpdate, encodeStateAsUpdate } from 'yjs'
import { resolveReferenceBindings } from '@plein/plugin-sdk'
import { afterEach, expect, it } from 'vite-plus/test'
import { useDocVersion } from '../../canvas/hooks'
import { upstreams } from '../../canvas/nodes'
import { useCatalog } from '../../stores/catalog'
import { mockResizeObserver } from '../../testing/browser'
import { act, renderApp, resetStoreAfterEach, screen, waitFor, within } from '../../testing/render'
import { Inputs } from './Inputs'
import { PromptBox } from './PromptBox'

resetStoreAfterEach(useCatalog)
const docs: PleinDoc[] = []
afterEach(() => docs.splice(0).forEach((doc) => doc.destroy()))

it.each([
  ['image', false, 'plein/video'],
  ['video', false, 'plein/video'],
  ['audio', false, 'plein/video'],
  ['image', true, 'plein/video'],
  ['video', true, 'plein/video'],
  ['audio', true, 'plein/video'],
  ['image', false, 'plein/image'],
  ['image', true, 'plein/image'],
] as const)(
  '刚上传的 %s（放大编辑：%s，节点：%s）在刷新期间不引用旧编号，刷新后按素材名称插入',
  async (kind, expanded, nodeType) => {
    mockResizeObserver()
    const doc = openDoc()
    docs.push(doc)
    const node = {
      ...describeNode(
        corePlugin.nodes.find((n) => n.type === nodeType)!,
        'plein/core',
      ),
      executable: true,
    }
    const catalog = { nodes: [node] } as unknown as Catalog
    useCatalog.setState({ catalog })
    const id = createElement(doc, {
      kind: 'node',
      nodeType: node.type,
      ports: { inputs: node.inputs, outputs: node.outputs },
      params: { mode: 'reference', prompt: '' },
      x: 0,
      y: 0,
      w: 200,
      h: 100,
    })
    const port =
      nodeType === 'plein/image'
        ? 'references'
        : kind === 'image'
          ? 'images'
          : kind === 'video'
            ? 'videos'
            : 'audios'
    const sources = ['原素材', '刚上传的素材'].map((name, index) => {
      const source = createElement(doc, {
        kind: nodeType === 'plein/image' ? 'node' : kind,
        ...(nodeType === 'plein/image'
          ? { nodeType, ports: { inputs: node.inputs, outputs: node.outputs } }
          : {}),
        name,
        assetId: `asset-${index}`,
        x: index * 200,
        y: 200,
        w: 200,
        h: 100,
      })
      if (nodeType === 'plein/image')
        addResults(doc, source, [
          {
            id: `result-${index}`,
            runId: 'run',
            at: 1,
            port: 'images',
            value: { type: 'image', assetId: `asset-${index}` },
          },
        ])
      connect(doc, [source, nodeType === 'plein/image' ? 'images' : kind], [id, port])
      return source
    })
    doc.flush()
    const engine = { doc } as Engine
    const ref = createRef<HTMLTextAreaElement>()
    const input = (count: number): PreparedInput => ({
      v: PREPARED_INPUT_VERSION,
      nodeId: id,
      nodeType: node.type,
      preparedAt: 1,
      status: 'ready',
      params: { mode: 'reference' },
      inputs: {
        [port]: sources.slice(0, count).map((source, index) => ({
          type: kind,
          source,
          assetId: `asset-${index}`,
        })),
      },
      refs: [],
      notices: [],
      blocked: [],
    })
    function Harness({ prepared, preparing }: { prepared: PreparedInput; preparing: boolean }) {
      useDocVersion(doc)
      return (
        <>
          <Inputs
            engine={engine}
            el={doc.get(id)!}
            node={node}
            ups={upstreams(engine, id, catalog)}
            prepared={prepared}
            preparing={preparing}
          />
          <PromptBox
            ref={ref}
            engine={engine}
            selfId={id}
            prepared={prepared}
            preparing={preparing}
            value={String(doc.get(id)?.params?.prompt ?? '')}
            presets={[]}
            placeholder=""
            onChange={(value) => {
              setParam(doc, id, 'prompt', value)
              doc.flush()
            }}
            onPreset={() => {}}
          />
        </>
      )
    }
    const view = renderApp(<Harness prepared={input(1)} preparing />)
    // 旧预览漏了新素材时，顶部仍应展示新上传的缩略图，不误报「未送入」。
    expect(screen.getByTitle('预览「刚上传的素材」')).toBeTruthy()
    expect(screen.queryAllByText(/未送入/)).toHaveLength(0)
    if (expanded) await view.user.click(screen.getByRole('button', { name: '放大编辑提示词' }))
    const field = () =>
      expanded
        ? within(screen.getByRole('dialog', { name: '编辑提示词' })).getByRole<HTMLTextAreaElement>(
            'textbox',
            { name: '提示词' },
          )
        : ref.current!
    await view.user.type(field(), '@')
    let menu = await screen.findByRole('dialog', { name: '引用素材' })
    const pending = within(menu).getByRole('option', { name: /刚上传的素材/ })
    expect(pending.hasAttribute('disabled')).toBe(true)
    expect(menu.textContent).not.toContain(`@${kind}1`)
    await view.user.keyboard('{Enter}')
    expect(field().value).toBe('@')
    act(() => view.rerender(<Harness prepared={input(2)} preparing={false} />))
    menu = screen.getByRole('dialog', { name: '引用素材' })
    // 未写入正文的连入素材在 @ 首屏就能选，不必先找分类。
    const ready = within(menu).getByRole('option', { name: /刚上传的素材/ })
    expect(ready.hasAttribute('disabled')).toBe(false)
    expect(ready.textContent).toContain('@刚上传的素材')
    await view.user.click(ready)
    await waitFor(() => expect(field().value).toBe('@刚上传的素材 '))
    expect(doc.get(id)?.params?.prompt).toBe('@刚上传的素材 ')
    expect(
      document.querySelector('[data-testid="mention-highlights"] mark')?.getAttribute('data-state'),
    ).toBe('resolved')
    const reopened = openDoc()
    try {
      applyUpdate(reopened.ydoc, encodeStateAsUpdate(doc.ydoc))
      const saved = reopened.get(id)!
      expect(
        resolveReferenceBindings(
          String(saved.params?.prompt),
          [
            { type: kind, source: sources[1], assetId: 'asset-1' },
            { type: kind, source: sources[0], assetId: 'asset-0' },
          ],
          saved.params,
        ),
      ).toEqual({ prompt: `@${kind}1 ` })
    } finally {
      reopened.destroy()
    }

    expect(document.activeElement).toBe(field())
  },
)

it.each([
  {
    model: 'minimax/api:MiniMax-H3',
    provider: 'minimax/api',
    video: '视频1',
    audio: '音频1',
  },
  {
    model: 'volc/ark:doubao-seedance-2-0-260128',
    provider: 'volc/ark',
    video: '@video1',
    audio: '@audio1',
  },
])('编辑器按媒体类型显示 $provider 的视频与音频徽标', (item) => {
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
  const text = '动作 @舞.mp4，配乐 @歌.mp3'
  const id = createElement(doc, {
    kind: 'node',
    nodeType: 'plein/video',
    ports: { inputs: node.inputs, outputs: node.outputs },
    params: { mode: 'reference', prompt: text, model: item.model },
    x: 0,
    y: 0,
    w: 200,
    h: 100,
  })
  const range = (token: string, kind: 'video' | 'audio') => ({
    start: text.indexOf(token),
    end: text.indexOf(token) + token.length,
    text: token,
    name: token.slice(1),
    indices: [1],
    kind,
  })
  const prepared: PreparedInput = {
    v: PREPARED_INPUT_VERSION,
    nodeId: id,
    nodeType: 'plein/video',
    preparedAt: 1,
    status: 'ready',
    model: { ref: item.model, provider: item.provider, title: item.model },
    params: { mode: 'reference' },
    inputs: {
      videos: [{ type: 'video', assetId: 'video-asset' }],
      audios: [{ type: 'audio', assetId: 'audio-asset' }],
    },
    refs: [],
    sent: [],
    promptReferences: [range('@舞.mp4', 'video'), range('@歌.mp3', 'audio')],
    notices: [],
    blocked: [],
  }
  renderApp(
    <PromptBox
      ref={createRef<HTMLTextAreaElement>()}
      engine={{ doc } as Engine}
      selfId={id}
      prepared={prepared}
      value={text}
      presets={[]}
      placeholder=""
      onChange={() => {}}
      onPreset={() => {}}
    />,
  )
  expect(
    [...document.querySelectorAll('.plein-mention-badge')].map((badge) => badge.textContent),
  ).toEqual([item.video, item.audio])
})

it('两个离线协作者分配同一别名后合并并重开，冲突引用被阻断', () => {
  const first = openDoc()
  const second = openDoc()
  const reopened = openDoc()
  try {
    const id = createElement(first, {
      kind: 'node',
      nodeType: 'plein/video',
      params: {},
      x: 0,
      y: 0,
      w: 100,
      h: 100,
    })
    applyUpdate(second.ydoc, encodeStateAsUpdate(first.ydoc))
    const a = { type: 'image' as const, assetId: 'a', source: 'one' }
    const b = { type: 'image' as const, assetId: 'b', source: 'two' }
    setParam(first, id, 'referenceBinding:image1:one:a', a)
    setParam(second, id, 'referenceBinding:image1:two:b', b)
    applyUpdate(first.ydoc, encodeStateAsUpdate(second.ydoc))
    applyUpdate(second.ydoc, encodeStateAsUpdate(first.ydoc))
    applyUpdate(reopened.ydoc, encodeStateAsUpdate(first.ydoc))
    expect(second.get(id)?.params).toEqual(first.get(id)?.params)
    expect(
      Object.keys(reopened.get(id)?.params ?? {}).filter((key) =>
        key.startsWith('referenceBinding:'),
      ),
    ).toHaveLength(2)
    expect(resolveReferenceBindings('@image1', [a, b], reopened.get(id)?.params).error).toBeTruthy()
  } finally {
    first.destroy()
    second.destroy()
    reopened.destroy()
  }
})
