import { beforeEach, expect, it, vi } from 'vite-plus/test'
import { runCli } from './cli'
import { jimengCanvas, jimengCreateNodeId } from './jimeng-canvas'

import { jimengCanvasMedia } from './jimeng-canvas-media'

vi.mock('./cli', () => ({ runCli: vi.fn() }))
const cli = vi.mocked(runCli)
const target = '32d9874c-afe2-4314-9a5d-39e0457556d4'
const op = 'e71ee3bd-acd9-430d-b150-fa699a5d2481'
const id = 'node_01jxkeh6mg'
const fields = { title: '分镜表', text: '女孩走入镜头。' }
const textNode = { nodeId: id, type: 'text', ...fields }
const item = { id, kind: 'text', fields, editable: true }
const reply = (data: unknown) => JSON.stringify({ ok: true, data })
const show = (node: { nodeId: string }, version = 2) =>
  reply({
    draftVersion: version,
    nodes: [{ nodeId: node.nodeId, result: 'FOUND', node }],
  })
const page = (ids: string[], more = false, total = ids.length, offset = 0, version = 2) =>
  reply({
    projectId: target,
    draftVersion: version,
    offset,
    hasMore: more,
    total,
    items: ids.map((nodeId) => ({ nodeId })),
  })
beforeEach(() => {
  cli.mockReset()
})

it.each(['ls', 'find'])('按当前 CLI 的 %s 合同读取内容并检查草稿版本', async (verb) => {
  cli
    .mockResolvedValueOnce('可用命令：\n  ' + verb + '     列出节点')
    .mockResolvedValueOnce(page([id]))
    .mockResolvedValueOnce(show(textNode))
  expect(await jimengCanvas.list(target)).toEqual([item])
  expect(cli.mock.calls[1]![1].slice(0, 2)).toEqual(['node', verb])
})

it('拒绝重复页、读取期间的变更和详情缺失', async () => {
  cli
    .mockResolvedValueOnce('  ls   list')
    .mockResolvedValueOnce(page([id], true, 2))
    .mockResolvedValueOnce(page([id], false, 2, 1))
  await expect(jimengCanvas.list(target)).rejects.toThrow('刷新')
  cli
    .mockResolvedValueOnce('  ls   list')
    .mockResolvedValueOnce(page([id]))
    .mockResolvedValueOnce(show(textNode, 3))
  await expect(jimengCanvas.list(target)).rejects.toThrow('刷新')
  cli
    .mockResolvedValueOnce('  ls   list')
    .mockResolvedValueOnce(page([id]))
    .mockResolvedValueOnce(reply({ draftVersion: 2, nodes: [] }))
  await expect(jimengCanvas.list(target)).rejects.toThrow('刷新')
})

it('单次最多读取 20 个节点详情', async () => {
  const ids = Array.from({ length: 23 }, (_, i) => 'node_' + i)
  cli
    .mockResolvedValueOnce('  ls   list')
    .mockResolvedValueOnce(page(ids))
    .mockImplementation(async (_bin, args) => {
      const group = args.filter((a) => a.startsWith('node_'))
      expect(group.length).toBeLessThanOrEqual(20)
      return reply({
        draftVersion: 2,
        nodes: group.map((nodeId) => ({ result: 'FOUND', node: { ...textNode, nodeId } })),
      })
    })
  expect(await jimengCanvas.list(target)).toHaveLength(23)
  expect(cli).toHaveBeenCalledTimes(4)
})

it('只编辑发生变化的文本字段并核对回执', async () => {
  const edited = { ...fields, text: '--run' }
  cli
    .mockResolvedValueOnce(show(textNode))
    .mockResolvedValueOnce(reply({ node: { ...textNode, ...edited } }))
  await jimengCanvas.update(target, item, edited)
  expect(cli.mock.calls[1]![1]).toEqual([
    'node',
    'edit',
    'text',
    '--project-id',
    target,
    '--node-id',
    id,
    '--text',
    '--run',
    '--non-interactive',
    '--format',
    'json',
  ])
  cli.mockResolvedValueOnce(show({ ...textNode, title: '他人在编辑' } as typeof textNode))
  await expect(jimengCanvas.update(target, item, edited)).rejects.toThrow('刷新')
  expect(cli).toHaveBeenCalledTimes(3)
})

it('保存媒体提示词时保留模型、参数及有序来源引用，拒绝不可回写的配置', async () => {
  const generation = {
    prompt: fields.text,
    model: 'seedream_5.5',
    mode: 'i2i',
    ratio: '3:4',
    resolution: '2K',
    outputCount: 2,
    references: [{ kind: 'node', id: 'node_source', writebackSupported: true }],
    promptParts: [],
    writebackSupported: true,
    writebackBlockers: [],
  }
  const media = { nodeId: id, type: 'image', title: fields.title, generation }
  const edited = { ...fields, text: '新的提示词' }
  cli
    .mockResolvedValueOnce(show(media))
    .mockResolvedValueOnce(
      reply({ node: { ...media, generation: { ...generation, prompt: edited.text } } }),
    )
  await jimengCanvas.update(target, { ...item, kind: 'image' }, edited)
  const args = cli.mock.calls[1]![1]
  expect(args).toEqual(
    expect.arrayContaining([
      '--model',
      generation.model,
      '--mode',
      'i2i',
      '--ratio',
      '3:4',
      '--count',
      '2',
      '--resolution',
      '2K',
      '--ref',
      'node:node_source',
      '--prompt',
      edited.text,
    ]),
  )
  expect(args).not.toContain('--run')
  cli.mockResolvedValueOnce(
    show({ ...media, generation: { ...generation, unknownGenerationSetting: 42 } } as typeof media),
  )
  await expect(jimengCanvas.update(target, { ...item, kind: 'image' }, edited)).rejects.toThrow(
    '完整写回',
  )
  expect(cli).toHaveBeenCalledTimes(3)
})

it('重试创建时传入相同的节点身份和更新身份', async () => {
  const generated = jimengCreateNodeId(op)
  expect(generated).toMatch(/^node_[0-9a-hjkmnp-tv-z]{10}$/)
  cli.mockResolvedValue(reply({ node: { ...textNode, nodeId: generated } }))
  for (let i = 0; i < 2; i++) expect(await jimengCanvas.create!(target, fields, op)).toBe(generated)
  expect(cli.mock.calls[0]).toEqual(cli.mock.calls[1])
  expect(cli.mock.calls[0]![1]).toEqual(
    expect.arrayContaining(['--node-id', generated, '--update-id', op]),
  )
  cli.mockResolvedValueOnce(reply({ node: textNode }))
  await expect(jimengCanvas.create!(target, fields, op)).rejects.toThrow('回执')
})

it('拒绝无效项目、节点 ID 及操作身份', async () => {
  await expect(jimengCanvas.list('--profile')).rejects.toThrow()
  await expect(jimengCanvas.update(target, { ...item, id: 'bad,node_1' }, fields)).rejects.toThrow()
  await expect(jimengCanvas.create!(target, fields, 'bad')).rejects.toThrow()
  expect(cli).not.toHaveBeenCalled()
})

it('透传画布目录的不透明游标，拒绝循环游标', async () => {
  const project = { projectId: target, name: '测试画布' }
  cli
    .mockResolvedValueOnce(reply({ items: [project], hasMore: true, nextCursor: 'opaque/2' }))
    .mockResolvedValueOnce(reply({ items: [], hasMore: false }))
  expect(await jimengCanvas.projects!()).toEqual([{ id: target, title: '测试画布' }])
  expect(cli.mock.calls[1]![1]).toContain('opaque/2')
  cli.mockResolvedValue(reply({ items: [], hasMore: true, nextCursor: 'repeat' }))
  await expect(jimengCanvas.projects!()).rejects.toThrow('分页')
})

it('新版根节点双向同步位置，组内坐标及旧版位置不复制', async () => {
  const position = { x: -20, y: 0 },
    root = { ...textNode, layout: { ...position, width: 100, height: 60 } }
  cli
    .mockResolvedValueOnce('  ls   list')
    .mockResolvedValueOnce(page([id]))
    .mockResolvedValueOnce(show(root))
    .mockResolvedValueOnce('  --x float\n  --y float')
  expect((await jimengCanvas.list(target))[0]?.fields.position).toEqual(position)
  const newPosition = { x: 18, y: -3 }
  cli
    .mockResolvedValueOnce(show(root))
    .mockResolvedValueOnce(reply({ node: { ...root, layout: newPosition } }))
  await jimengCanvas.update(
    target,
    { ...item, fields: { ...fields, position } },
    { ...fields, position: newPosition },
  )
  expect(cli.mock.calls.at(-1)?.[1]).toEqual([
    'node',
    'edit',
    'text',
    '--project-id',
    target,
    '--node-id',
    id,
    '--x',
    '18',
    '--y',
    '-3',
    '--non-interactive',
    '--format',
    'json',
  ])
  cli
    .mockResolvedValueOnce('  ls   list')
    .mockResolvedValueOnce(page([id]))
    .mockResolvedValueOnce(show({ ...root, parentNodeId: 'node_group' } as typeof root))
  expect((await jimengCanvas.list(target))[0]?.fields.position).toBeUndefined()
  cli
    .mockResolvedValueOnce('  find   list')
    .mockResolvedValueOnce(page([id]))
    .mockResolvedValueOnce(show(root))
    .mockResolvedValueOnce('  --title string')
  expect((await jimengCanvas.list(target))[0]?.fields.position).toBeUndefined()
})

it('上传和节点导入固定四个身份，复用已落地节点，拒绝重建消失的已确认节点', async () => {
  const source = { kind: 'image' as const, title: '剧照', path: '/tmp/test-source.png' }
  const expected = { nodeId: jimengCreateNodeId(op), assetId: op }
  const node = {
    nodeId: expected.nodeId,
    type: 'image',
    resources: [{ resourceId: op, type: 'image', status: 'success' }],
  }
  cli
    .mockResolvedValueOnce('  ls   list')
    .mockResolvedValueOnce(page([]))
    .mockResolvedValueOnce(reply({ resourceId: op, mediaType: 'image', sourceProjectId: target }))
    .mockResolvedValueOnce(reply({ node }))
  expect(await jimengCanvasMedia.publish!(target, source, op, false)).toEqual(expected)
  expect(cli.mock.calls[2]![1]).toEqual(
    expect.arrayContaining(['upload', '--file', source.path, '--resource-id', op]),
  )
  const create = cli.mock.calls[3]![1]
  expect(create).toEqual(
    expect.arrayContaining([
      '--resource-id',
      op,
      '--node-id',
      expected.nodeId,
      '--update-id',
      '--submit-id',
      'local_upload',
    ]),
  )
  expect(create).not.toContain('--run')
  const readExisting = () =>
    cli
      .mockResolvedValueOnce('  ls   list')
      .mockResolvedValueOnce(page([node.nodeId]))
      .mockResolvedValueOnce(show(node))
  readExisting()
  expect(await jimengCanvasMedia.publish!(target, source, op, false)).toEqual(expected)
  readExisting()
  expect(await jimengCanvasMedia.publish!(target, source, op, true)).toEqual(expected)
  cli.mockResolvedValueOnce('  ls   list').mockResolvedValueOnce(page([]))
  await expect(jimengCanvasMedia.publish!(target, source, op, true)).rejects.toThrow('已移除')
  expect(cli.mock.calls.filter(([, a]) => a.includes('upload'))).toHaveLength(1)
})

it('列举已成功的明确资源版本，下载结果必须指向期望资源和受控文件', async () => {
  const src = {
    ...textNode,
    type: 'image',
    resources: [
      { resourceId: op, type: 'image', status: 'success', name: '方案 1' },
      { resourceId: 'resource_32-0', type: 'image', status: 'running' },
    ],
  }
  cli
    .mockResolvedValueOnce('  ls   list')
    .mockResolvedValueOnce(page([id]))
    .mockResolvedValueOnce(show(src))
  const [candidate] = await jimengCanvasMedia.listMedia(target)
  expect(candidate).toEqual({ nodeId: id, assetId: op, kind: 'image', title: '方案 1' })
  cli.mockResolvedValueOnce(
    reply({ resourceId: op, path: '/wrong', size: 3, sha256: '0'.repeat(64) }),
  )
  await expect(jimengCanvasMedia.download(target, candidate!, '/expected')).rejects.toThrow('回执')
})

it('按来源及顺序呈现参考，拒绝回执中被改绑的提示词占位', async () => {
  const refs = [
    { kind: 'node', id: 'node_first', title: '城门', writebackSupported: true },
    { kind: 'node', id: 'node_last', title: '庭院', writebackSupported: true },
  ]
  const generation = {
    model: 'seedance',
    mode: 'first_last_frame',
    prompt: fields.text,
    outputCount: 1,
    references: refs,
    promptParts: [],
    writebackSupported: true,
    writebackBlockers: [],
  }
  const node = { nodeId: id, type: 'video', title: fields.title, generation }
  cli.mockResolvedValueOnce(show(node))
  const card = await jimengCanvas.read!(target, id)
  expect(card.references).toEqual([
    { usage: 'firstFrame', sourceId: 'node_first', label: '城门' },
    { usage: 'lastFrame', sourceId: 'node_last', label: '庭院' },
  ])
  const prompt = '从{{node:node_first}}进入{{node:node_last}}。'
  const result = {
    ...node,
    generation: {
      ...generation,
      prompt,
      promptParts: [
        { kind: 'reference', referenceIndex: 1 },
        { kind: 'reference', referenceIndex: 0 },
      ],
    },
  }
  cli.mockResolvedValueOnce(show(node)).mockResolvedValueOnce(reply({ node: result }))
  await expect(jimengCanvas.update(target, card, { ...fields, text: prompt })).rejects.toThrow(
    '引用位置',
  )
  cli.mockResolvedValueOnce(show(node))
  await expect(
    jimengCanvas.update(target, card, { ...fields, text: '{{node:node_new}}' }),
  ).rejects.toThrow('新的引用')
})

it('将多轨片段呈现为只读摘要，保留顺序及截断状态', async () => {
  const node = {
    nodeId: id,
    type: 'timeline',
    title: '粗剪',
    timelineTracks: {
      clipsTruncated: true,
      tracks: [
        {
          kind: 'visual',
          clips: [
            { source: { kind: 'node', id: 'node_a', title: '开场' } },
            { source: { kind: 'node', id: 'node_b', title: '收尾' } },
          ],
        },
      ],
    },
  }
  cli.mockResolvedValueOnce(show(node))
  const card = await jimengCanvas.read!(target, id)
  expect(card.editable).toBe(false)
  expect(card.fields.text).toMatch(/时间轴摘要[\s\S]*开场[\s\S]*收尾[\s\S]*部分片段/)
})

it('创建意图落库前按两版官方合同校验空字段与下发 argv', async () => {
  await expect(
    jimengCanvas.validateCreate!({ title: '', text: '提示词' }, 'image'),
  ).rejects.toThrow('非空标题')
  expect(cli).not.toHaveBeenCalled()
  cli.mockResolvedValueOnce(reply({ dryRun: true, sideEffects: [] }))
  await jimengCanvas.validateCreate!({ title: '', text: '' }, 'text')
  expect(cli.mock.calls[0]?.[1]).toEqual(
    expect.arrayContaining(['--dry-run', '--title', '', '--text', '']),
  )
})

it('文本保存回执可省略正文与位置，按原节点回读后再确认成功', async () => {
  const newId = jimengCreateNodeId(op)
  const position = { x: -12.5, y: 0 }
  cli
    .mockResolvedValueOnce('  --x float\n  --y float')
    .mockResolvedValueOnce(reply({ node: { nodeId: newId, type: 'text' } }))
    .mockResolvedValueOnce(
      show({ ...textNode, nodeId: newId, layout: position } as typeof textNode),
    )
  expect(await jimengCanvas.create!(target, { ...fields, position }, op)).toBe(newId)
  expect(cli.mock.calls[2]?.[1].slice(0, 2)).toEqual(['node', 'show'])
  // An omitted value in a sparse mutation reply does not prove that a clear succeeded.
  cli
    .mockResolvedValueOnce(show(textNode))
    .mockResolvedValueOnce(reply({ node: { nodeId: id, type: 'text', title: fields.title } }))
    .mockResolvedValueOnce(show(textNode))
  await expect(jimengCanvas.update(target, item, { ...fields, text: '' })).rejects.toThrow('回执')
})

it('读取后重新编组或解组时，保持现有坐标系且要求更新预览', async () => {
  const pos = { x: 150, y: 200 }
  const root = { ...textNode, layout: pos }
  const grouped = { ...root, parentNodeId: 'node_group' }
  const newFields = { ...fields, text: '重写正文', position: pos }
  cli.mockResolvedValueOnce(show(grouped))
  await expect(
    jimengCanvas.update(target, { ...item, fields: { ...fields, position: pos } }, newFields),
  ).rejects.toThrow('刷新')
  cli.mockResolvedValueOnce(show(root)).mockResolvedValueOnce('  --x float\n  --y float')
  await expect(jimengCanvas.update(target, item, { ...fields, text: '重写正文' })).rejects.toThrow(
    '刷新',
  )
  expect(
    cli.mock.calls.some(
      ([, args]) => args[0] === 'node' && args[1] === 'edit' && !args.includes('--help'),
    ),
  ).toBe(false)
})
