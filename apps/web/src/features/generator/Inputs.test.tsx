// @vitest-environment happy-dom
import type { Engine } from '@plein/canvas-core'
import { connect, createElement, inputEdges, type PleinDoc } from '@plein/doc'
import { openDoc } from '@plein/doc/testing'
import { corePlugin } from '@plein/nodes'
import { describeNode } from '@plein/plugin-sdk'
import type { PreparedInput } from '@plein/protocol'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { useDocVersion } from '../../canvas/hooks'
import { importFiles } from '../../canvas/import'
import { upstreams, type NodeInfo } from '../../canvas/nodes'
import { mediaTestEngine } from '../../shell/media-tools/testEngine'
import { useCanvas } from '../../stores/canvas'
import { act, fireEvent, renderApp, screen, waitFor, within } from '../../testing/render'
import { Inputs } from './Inputs'

vi.mock('../../canvas/import', () => ({ importFiles: vi.fn() }))

describe('多模态参考名称', () => {
  let doc: PleinDoc
  afterEach(() => doc?.destroy())
  function setup(
    options: {
      sent?: (sources: string[], assets: string[]) => PreparedInput['sent']
      unsent?: (sources: string[], assets: string[]) => PreparedInput['unsent']
    } = {},
  ) {
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
      params: { mode: 'reference', prompt: '参考', model: 'minimax/api:MiniMax-H3' },
    })
    const sources: string[] = []
    const assets: string[] = []
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
      sources.push(source)
      assets.push(`asset${i}`)
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
      const prepared = {
        inputs,
        refs: [],
        ...(options.sent ? { sent: options.sent(sources, assets) } : {}),
        ...(options.unsent ? { unsent: options.unsent(sources, assets) } : {}),
      } as unknown as PreparedInput
      return <Inputs engine={engine} el={doc.get(id)!} node={node} ups={ups} prepared={prepared} />
    }
    return { ...renderApp(<Harness />), id, engine, sources, assets }
  }

  it('多模态引用按素材名称插入提示词，重排真实连线后显示最终顺序', async () => {
    const f = setup()
    for (const token of ['@素材0', '@素材1', '@素材2', '@素材3'])
      await f.user.click(screen.getByRole('button', { name: token }))
    expect(doc.get(f.id)?.params?.prompt).toBe('参考 @素材0 @素材1 @素材2 @素材3 ')
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

  it('服务端 sent 之外的参考视频和音频也留在顶部唯一列表，并按类型编号', () => {
    setup({
      sent: (sources, assets) => [
        {
          index: 1,
          token: '图片1',
          assetId: assets[0]!,
          elementId: sources[0]!,
          name: '素材0',
          origins: ['edge'],
        },
        {
          index: 2,
          token: '图片2',
          assetId: assets[1]!,
          elementId: sources[1]!,
          name: '素材1',
          origins: ['edge'],
        },
      ],
    })
    const groups = within(screen.getByLabelText('实际送入的参考素材')).getAllByRole('group')
    expect(groups.map((g) => g.getAttribute('data-asset-id'))).toEqual([
      'asset0',
      'asset1',
      'asset2',
      'asset3',
    ])
    expect(groups.map((g) => g.querySelector('[data-token]')?.getAttribute('data-token'))).toEqual([
      '图片1',
      '图片2',
      '视频1',
      '音频1',
    ])
    expect(screen.getByRole('button', { name: '管理参考 3' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '管理参考 4' })).toBeTruthy()
  })

  it('未送入的连线条目保留预览、替换、排序与断开入口', async () => {
    const f = setup({
      sent: (sources, assets) => [
        {
          index: 1,
          token: '图片1',
          assetId: assets[0]!,
          elementId: sources[0]!,
          name: '素材0',
          origins: ['edge'],
        },
      ],
      unsent: (sources, assets) => [
        {
          elementId: sources[1]!,
          assetId: assets[1]!,
          name: '素材1',
          reason: 'not_sent',
          message: '「素材1」已连线，但未送入当前模型',
          origins: ['edge'],
        },
      ],
    })
    await f.user.click(screen.getByText('未送入 · 1'))
    expect(screen.getByRole('button', { name: '预览未送入参考「素材1」' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '替换未送入参考「素材1」' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '上传替换未送入参考「素材1」' })).toBeTruthy()
    const order = () => inputEdges(doc, f.id, 'images').map((edge) => edge.from[0])
    expect(order()).toEqual([f.sources[0], f.sources[1]])
    await f.user.click(screen.getByRole('button', { name: '向前移动未送入参考「素材1」' }))
    act(() => doc.flush())
    expect(order()).toEqual([f.sources[1], f.sources[0]])
    await f.user.click(screen.getByRole('button', { name: '断开未送入参考「素材1」' }))
    act(() => doc.flush())
    expect(order()).toEqual([f.sources[0]])
  })

  it('从画布替换参考时，正文同步换成新图片名', async () => {
    const f = setup()
    await f.user.click(screen.getByRole('button', { name: '@素材0' }))
    let replacement = ''
    act(() => {
      replacement = createElement(doc, {
        kind: 'image',
        name: '新版产品.png',
        assetId: 'new',
        x: 0,
        y: 0,
        w: 100,
        h: 100,
      })
      doc.flush()
    })
    await f.user.click(screen.getByTitle('管理参考 1：素材0'))
    await f.user.click(screen.getByRole('button', { name: '替换参考 1' }))
    await f.user.click(screen.getByRole('combobox', { name: '替换参考素材' }))
    await f.user.click(screen.getByRole('option', { name: /新版产品\.png/ }))
    await waitFor(() => expect(doc.get(f.id)?.params?.prompt).toBe('参考 @新版产品.png '))
    expect(inputEdges(doc, f.id, 'images')[0]!.from[0]).toBe(replacement)
  })
})

describe('参考预览与上传竞态', () => {
  const docs: PleinDoc[] = []
  afterEach(() => docs.splice(0).forEach((doc) => doc.destroy()))
  function setup(single = false) {
    const doc = openDoc()
    docs.push(doc)
    const node = {
      ...describeNode(
        corePlugin.nodes.find((n) => n.type === (single ? 'plein/image-edit' : 'plein/image'))!,
        'plein/core',
      ),
      executable: true,
    }
    const target = createElement(doc, {
      kind: 'node',
      nodeType: node.type,
      name: '目标',
      params: {},
      ports: { inputs: node.inputs, outputs: node.outputs },
      x: 0,
      y: 0,
      w: 200,
      h: 100,
    })
    const sources = ['左景', '右景', '替代参考'].map((name) =>
      createElement(doc, { kind: 'image', name, assetId: name, x: 0, y: 0, w: 200, h: 100 }),
    )
    if (!single)
      for (const id of sources.slice(0, 2)) connect(doc, [id, 'image'], [target, 'references'])
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
    return { doc, target, sources, ...renderApp(<Harness />) }
  }
  it('参考预览只打开候选，重排与替换真实连线顺序一致', async () => {
    const f = setup()
    await f.user.click(screen.getByTitle('预览「左景」'))
    expect(useCanvas.getState().viewer).toMatchObject({ assetId: '左景', name: '左景' })
    await f.user.click(screen.getByRole('button', { name: '管理参考 2' }))
    await f.user.click(screen.getByRole('button', { name: '向前移动参考 2' }))
    act(() => f.doc.flush())
    expect(inputEdges(f.doc, f.target, 'references').map((e) => e.from[0])).toEqual([
      f.sources[1],
      f.sources[0],
    ])
    expect(screen.getByRole('group', { name: '参考 1：右景' })).toBeTruthy()
    await f.user.click(screen.getByRole('button', { name: '管理参考 1' }))
    await f.user.click(screen.getByRole('button', { name: '替换参考 1' }))
    await f.user.click(screen.getByRole('combobox', { name: '替换参考素材' }))
    await f.user.click(screen.getByRole('option', { name: /替代参考/ }))
    act(() => f.doc.flush())
    expect(inputEdges(f.doc, f.target, 'references').map((e) => e.from[0])).toEqual([
      f.sources[2],
      f.sources[0],
    ])
    expect(f.doc.get(f.target)?.run).toBeUndefined()
  })
  it('单输入上传期间新增参考不覆盖，上传素材保留并解释原因', async () => {
    const f = setup(true)
    let finish!: (result: Awaited<ReturnType<typeof importFiles>>) => void
    vi.mocked(importFiles).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    await f.user.click(screen.getByRole('button', { name: '上传参考' }))
    await f.user.click(screen.getByRole('button', { name: '原图' }))
    const file = document.querySelector<HTMLInputElement>('input[type="file"]')!
    fireEvent.change(file, {
      target: { files: [new File(['image'], '新素材.png', { type: 'image/png' })] },
    })
    await waitFor(() => expect(importFiles).toHaveBeenCalled())
    const uploaded = createElement(f.doc, {
      kind: 'image',
      assetId: 'uploaded',
      x: 0,
      y: 0,
      w: 200,
      h: 100,
    })
    act(() => {
      connect(f.doc, [f.sources[0]!, 'image'], [f.target, 'image'])
      f.doc.flush()
    })
    await act(async () => {
      finish({ created: [uploaded], skipped: [] })
      await Promise.resolve()
    })
    await waitFor(() => expect(useCanvas.getState().notice).toContain('没有覆盖新参考'))
    expect(inputEdges(f.doc, f.target, 'image').map((e) => e.from[0])).toEqual([f.sources[0]])
    expect(f.doc.get(uploaded)?.assetId).toBe('uploaded')
  })
})
