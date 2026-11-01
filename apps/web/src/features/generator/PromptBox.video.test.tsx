// @vitest-environment happy-dom
import type { Engine } from '@plein/canvas-core'
import { connect, createElement, setParam, type PleinDoc } from '@plein/doc'
import { openDoc } from '@plein/doc/testing'
import { corePlugin } from '@plein/nodes'
import { describeNode } from '@plein/plugin-sdk'
import { PREPARED_INPUT_VERSION, type Catalog, type PreparedInput } from '@plein/protocol'
import { createRef } from 'react'
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
  ['image', false],
  ['video', false],
  ['audio', false],
  ['image', true],
  ['video', true],
  ['audio', true],
] as const)(
  '刚上传的 %s（放大编辑：%s）在刷新期间不引用旧编号，刷新后按实际输入编号插入',
  async (kind, expanded) => {
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
    const port = kind === 'image' ? 'images' : kind === 'video' ? 'videos' : 'audios'
    const sources = ['原素材', '刚上传的素材'].map((name, index) => {
      const source = createElement(doc, {
        kind,
        name,
        assetId: `asset-${index}`,
        x: index * 200,
        y: 200,
        w: 200,
        h: 100,
      })
      connect(doc, [source, kind], [id, port])
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
    await view.user.keyboard('{ArrowDown}{Enter}')
    expect(field().value).toBe('@')
    act(() => view.rerender(<Harness prepared={input(2)} preparing={false} />))
    menu = screen.getByRole('dialog', { name: '引用素材' })
    // 未写入正文的连入素材在 @ 首屏就能选，不必先找分类。
    const ready = within(menu).getByRole('option', { name: /刚上传的素材/ })
    expect(ready.hasAttribute('disabled')).toBe(false)
    expect(ready.textContent).toContain(`@${kind}2`)
    await view.user.click(ready)
    await waitFor(() => expect(field().value).toBe(`@${kind}2 `))
    expect(doc.get(id)?.params?.prompt).toBe(`@${kind}2 `)
    expect(document.activeElement).toBe(field())
  },
)
