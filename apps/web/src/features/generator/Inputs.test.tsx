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
import { useCatalog } from '../../stores/catalog'
import { act, fireEvent, renderApp, screen, waitFor, within } from '../../testing/render'
import { Inputs } from './Inputs'

vi.mock('../../canvas/import', () => ({ importFiles: vi.fn() }))

describe('多模态参考名称', () => {
  let doc: PleinDoc
  afterEach(() => doc?.destroy())
  function setup(
    options: {
      connected?: boolean
      model?: string
      inputs?: (sources: string[], assets: string[]) => PreparedInput['inputs']
      refs?: (sources: string[], assets: string[]) => PreparedInput['refs']
      sent?: (sources: string[], assets: string[]) => PreparedInput['sent']
      unsent?: (sources: string[], assets: string[]) => PreparedInput['unsent']
      params?: Record<string, unknown>
      requirable?: boolean
      capability?: string
      noMediaPorts?: boolean
    } = {},
  ) {
    doc = openDoc()
    const text = options.capability === 'text.chat'
    const type = text ? 'plein/llm' : 'plein/video'
    const node = {
      type,
      capability: options.capability ?? 'video.generate',
      defaults: {},
      inputs: [
        ...(text ? [{ id: 'prompt', label: '输入', type: 'text', multiple: true }] : []),
        ...(options.noMediaPorts
          ? []
          : [
              { id: 'images', label: '图片', type: 'image', multiple: true },
              ...(text
                ? []
                : [
                    { id: 'videos', label: '视频', type: 'video', multiple: true },
                    { id: 'audios', label: '音频', type: 'audio', multiple: true },
                  ]),
            ]),
      ],
      outputs: [],
      // 模型字段必须真的能从参数表里选出来，顶部计数才知道该对照哪个模型的上限
      paramsSchema: {
        properties: {
          model: { type: 'string', widget: 'model' },
          ...(options.requirable ? { requiredRefs: { type: 'array' } } : {}),
        },
      },
    } as unknown as NodeInfo
    const id = createElement(doc, {
      kind: 'node',
      nodeType: type,
      ports: { inputs: node.inputs, outputs: [] },
      x: 0,
      y: 0,
      w: 160,
      h: 90,
      params: {
        mode: 'reference',
        prompt: '参考',
        model: options.model ?? 'minimax/api:MiniMax-H3',
        ...options.params,
      },
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
      if (options.connected !== false && node.inputs.some((p) => p.type === kind))
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
        inputs: options.inputs?.(sources, assets) ?? inputs,
        refs: options.refs?.(sources, assets) ?? [],
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

  it('文生视频模式下连了素材：显示警告并只给当前模型支持的切换入口', async () => {
    const f = setup({ params: { mode: 'text', model: 'minimax/api:MiniMax-H3' } })
    const warning = screen.getByTestId('mode-mismatch')
    expect(warning.textContent).toContain('4 项')
    expect(warning.className).toContain('text-warning')
    await f.user.click(within(warning).getByRole('button', { name: '切换为图生视频' }))
    act(() => doc.flush())
    expect(doc.get(f.id)?.params?.mode).toBe('image')
    // 已切走：文生视频的警告消失
    expect(screen.queryByTestId('mode-mismatch')).toBeNull()
  })

  it('其他模式或没连素材时不显示文生视频警告', () => {
    setup()
    expect(screen.queryByTestId('mode-mismatch')).toBeNull()
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

  it('服务端标明首尾帧用途时徽标写「首帧」「尾帧」，不显示平台编号', () => {
    setup({
      sent: (sources, assets) => [
        {
          index: 1,
          token: '@图片1',
          role: 'firstFrame',
          assetId: assets[0]!,
          elementId: sources[0]!,
          name: '首帧图',
          origins: ['edge'],
        },
        {
          index: 2,
          token: '@图片2',
          role: 'lastFrame',
          assetId: assets[1]!,
          elementId: sources[1]!,
          name: '尾帧图',
          origins: ['edge'],
        },
      ],
    })
    const groups = within(screen.getByLabelText('实际送入的参考素材')).getAllByRole('group')
    const badges = groups.slice(0, 2).map((group) => group.querySelector('[data-token]')!)
    expect(badges.map((badge) => badge.textContent)).toEqual(['首帧', '尾帧'])
    // token 仍保留原值，只是不再显示成平台编号
    expect(badges.map((badge) => badge.getAttribute('data-token'))).toEqual(['@图片1', '@图片2'])
    expect(screen.queryByText('@图片1')).toBeNull()
    expect(screen.queryByText('@图片2')).toBeNull()
  })

  it.each([
    ['image', ['首帧', '图片2']],
    ['lastFrame', ['尾帧', '图片2']],
    ['frames', ['首帧', '尾帧']],
  ] as const)('服务端没给 sent 时 %s 模式按图片位置标注首尾帧', (mode, expected) => {
    setup({ params: { mode } })
    const groups = within(screen.getByLabelText('实际送入的参考素材')).getAllByRole('group')
    const images = groups
      .filter((group) => ['asset0', 'asset1'].includes(group.getAttribute('data-asset-id')!))
      .map((group) => group.querySelector('[data-token]')!)
    expect(images.map((badge) => badge.textContent)).toEqual(expected)
    expect(images.every((badge) => badge.getAttribute('data-token') !== 'image1')).toBe(true)
  })

  it.each([
    ['minimax/api:MiniMax-H3', ['图片1', '图片2']],
    ['volc/ark:doubao-seedance-2-0-260128', ['@图片1', '@图片2']],
  ] as const)('服务端没给 sent 时图片徽标沿用平台编号（%s）', (model, expected) => {
    setup({ model })
    const groups = within(screen.getByLabelText('实际送入的参考素材')).getAllByRole('group')
    const images = groups
      .filter((group) => ['asset0', 'asset1'].includes(group.getAttribute('data-asset-id')!))
      .map((group) => group.querySelector('[data-token]')!)
    expect(images.map((badge) => badge.textContent)).toEqual(expected)
    expect(images.map((badge) => badge.getAttribute('data-token'))).toEqual(expected)
  })

  it('文本节点按服务端清单显示参考区，并列出不支持的 @ 引用', () => {
    setup({
      capability: 'text.chat',
      sent: () => [],
      unsent: (sources, assets) => [
        {
          elementId: sources[0]!,
          assetId: assets[0]!,
          name: '林夏',
          reason: 'unsupported',
          message: '当前节点不送参考图，仅保留引用名称',
          origins: ['mention'],
        },
      ],
    })
    expect(screen.getByText(/送入 0 项/)).toBeTruthy()
    // 服务端明确给了空 sent 时不能退回按连线显示，否则等于谎报已送入
    expect(
      within(screen.getByLabelText('实际送入的参考素材')).queryAllByRole('group'),
    ).toHaveLength(0)
    expect(screen.getByText('未送入 · 1')).toBeTruthy()
    expect(screen.getByText('当前节点不送参考图，仅保留引用名称')).toBeTruthy()
  })

  it('顶部计数按图片/视频/音频分开，各自对比模型上限；未声明的只写数量', () => {
    useCatalog.setState({
      catalog: {
        providers: [
          {
            id: 'minimax/api',
            enabled: true,
            configured: true,
            models: [
              {
                id: 'MiniMax-H3',
                title: 'MiniMax-H3',
                capabilities: ['video.generate'],
                limits: { references: { max: 30 }, referenceMedia: { video: 3, audio: 3 } },
              },
            ],
          },
        ],
      },
    } as never)
    try {
      // 连了 2 图、1 视频、1 音频，服务端 sent 只包含图片
      setup()
      expect(screen.getByText('送入 4 项（图片 2/30 · 视频 1/3 · 音频 1/3）')).toBeTruthy()
      // 模型没声明任何上限：只写各类数量
      act(() => useCatalog.setState({ catalog: null }))
      expect(screen.getByText('送入 4 项（图片 2 · 视频 1 · 音频 1）')).toBeTruthy()
    } finally {
      useCatalog.setState({ catalog: null })
    }
  })

  it('没有媒体端口的节点也显示服务端报告的未送入引用', () => {
    setup({
      capability: 'text.chat',
      noMediaPorts: true,
      sent: () => [],
      unsent: (sources, assets) => [
        {
          elementId: sources[0]!,
          assetId: assets[0]!,
          name: '林夏',
          reason: 'unsupported',
          message: '当前节点不送参考图，仅保留引用名称',
          origins: ['mention'],
        },
      ],
    })
    expect(screen.getByLabelText('参考素材')).toBeTruthy()
    expect(screen.getByText('未送入 · 1')).toBeTruthy()
    expect(screen.getByText('当前节点不送参考图，仅保留引用名称')).toBeTruthy()
  })

  it('已删除元素的残留 id 不在参考面板上显示为必需', async () => {
    const f = setup({
      requirable: true,
      params: { requiredRefs: ['deleted-card'] },
      sent: (_sources, assets) => [
        {
          index: 1,
          token: '图片1',
          assetId: assets[0]!,
          elementId: 'deleted-card',
          name: '已删除角色',
          origins: ['mention', 'role'],
        },
      ],
    })
    await f.user.click(screen.getByRole('button', { name: '管理参考 1' }))
    expect(screen.getByRole('button', { name: '设为必需参考' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '取消必需参考' })).toBeNull()
  })

  it('图片与方舟长编号移出缩略图裁切区域并完整显示', () => {
    setup({
      model: 'volc/ark:doubao-seedance-2-0-260128',
      sent: (sources, assets) => [
        {
          index: 10,
          token: '图片10',
          assetId: assets[0]!,
          elementId: sources[0]!,
          name: '素材0',
          origins: ['edge'],
        },
        {
          index: 10,
          token: '@图片10',
          assetId: assets[1]!,
          elementId: sources[1]!,
          name: '素材1',
          origins: ['edge'],
        },
      ],
    })
    const tokens = [
      ...within(screen.getByLabelText('实际送入的参考素材'))
        .getAllByRole('group')
        .map((group) => group.querySelector('[data-token]')!),
    ]
    expect(tokens.map((token) => token.textContent)).toEqual([
      '图片10',
      '@图片10',
      '@视频1',
      '@音频1',
    ])
    for (const token of tokens) {
      expect(token.closest('button')).toBeNull()
      expect(token.closest('.overflow-hidden')).toBeNull()
    }
  })

  it('@-only 视频和音频保留名称与 @ 来源，并按媒体类型打开查看器', async () => {
    const f = setup({
      connected: false,
      sent: () => [],
      inputs: (sources, assets) => ({
        videos: [{ type: 'video', assetId: assets[2]!, source: sources[2] }],
        audios: [{ type: 'audio', assetId: assets[3]!, source: sources[3] }],
      }),
      refs: (sources, assets) => [
        {
          elementId: sources[2]!,
          name: '素材2',
          kind: 'other',
          media: 'video',
          required: false,
          available: [assets[2]!],
          sent: [assets[2]!],
        },
        {
          elementId: sources[3]!,
          name: '素材3',
          kind: 'other',
          media: 'audio',
          required: false,
          available: [assets[3]!],
          sent: [assets[3]!],
        },
      ],
    })
    const groups = within(screen.getByLabelText('实际送入的参考素材')).getAllByRole('group')
    expect(groups.map((group) => group.getAttribute('data-asset-id'))).toEqual(['asset2', 'asset3'])
    for (const [index, name] of ['素材2', '素材3'].entries()) {
      expect(within(groups[index]!).getByText(name)).toBeTruthy()
      expect(within(groups[index]!).getByText('@')).toBeTruthy()
      expect(within(groups[index]!).queryByText('连线')).toBeNull()
    }
    await f.user.click(screen.getByRole('button', { name: '预览「素材2」' }))
    expect(useCanvas.getState().viewer).toMatchObject({
      assetId: 'asset2',
      kind: 'video',
      name: '素材2',
    })
    await f.user.click(screen.getByRole('button', { name: '预览「素材3」' }))
    expect(useCanvas.getState().viewer).toMatchObject({
      assetId: 'asset3',
      kind: 'audio',
      name: '素材3',
    })
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
