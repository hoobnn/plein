// @vitest-environment happy-dom
import {
  addSourceUnit,
  captureSourceSnapshot,
  connect,
  createElement,
  markSourceRead,
  sourceMapOf,
} from '@plein/doc'
import { expect, it } from 'vite-plus/test'
import { mockFetch } from '../../testing/fetch'
import { act, fireEvent, renderApp, screen, waitFor, within } from '../../testing/render'
import { StoryboardEditor } from './StoryboardEditor'
import { storyboardFixture } from './testing'

function assetCard(doc: ReturnType<typeof storyboardFixture>['doc'], name: string) {
  return createElement(doc, {
    kind: 'node',
    nodeType: 'plein/scene',
    name,
    params: {},
    ports: {
      inputs: [{ id: 'references', label: '参考图', type: 'image', multiple: true }],
      outputs: [],
    },
    x: 0,
    y: 0,
    w: 200,
    h: 160,
  })
}

it('缺失项定位到表格字段，修复后计数与行徽标即时刷新，折叠不写入文档', async () => {
  const f = storyboardFixture({ count: 1 })
  f.write([{ ...f.read()[0]!, description: '', dialogue: [] }])
  act(f.flush)
  const app = renderApp(<StoryboardEditor />)
  const before = f.read()
  await app.user.click(screen.getByRole('button', { name: '准备 1 项' }))
  const panel = screen.getByRole('region', { name: '逐镜准备清单' })
  const row = screen.getByRole('row', { name: '镜头 01' })
  expect(row.querySelector('[data-shot-prep-count]')?.textContent).toBe('1')

  await app.user.click(within(panel).getByRole('button', { name: /镜头 01/ }))
  expect(within(panel).queryByRole('button', { name: '定位准备项：填写画面描述' })).toBeNull()
  await app.user.click(screen.getByRole('button', { name: '准备 1 项' }))
  await app.user.click(screen.getByRole('button', { name: '准备 1 项' }))
  expect(
    within(screen.getByRole('region', { name: '逐镜准备清单' })).queryByRole('button', {
      name: '定位准备项：填写画面描述',
    }),
  ).toBeNull()
  await app.user.click(
    within(screen.getByRole('region', { name: '逐镜准备清单' })).getByRole('button', {
      name: /镜头 01/,
    }),
  )
  await app.user.click(screen.getByRole('button', { name: '定位准备项：填写画面描述' }))
  const input = screen.getByRole<HTMLTextAreaElement>('textbox', { name: '画面' })
  expect(document.activeElement).toBe(input)
  fireEvent.change(input, { target: { value: '补全画面' } })
  fireEvent.blur(input)
  act(f.flush)
  expect(screen.getByRole('button', { name: '准备就绪' })).toBeDefined()
  expect(row.querySelector('[data-shot-prep-count]')).toBeNull()
  expect(f.read()).toEqual([{ ...before[0]!, description: '补全画面', edited: true }])
})

it('卡片缺失项会展开镜头并聚焦绑定，参考图缺失直接打开对应资产卡', async () => {
  const f = storyboardFixture({ count: 1 })
  f.write([{ ...f.read()[0]!, characters: ['林夏'], dialogue: [] }])
  act(f.flush)
  const app = renderApp(<StoryboardEditor />)
  await app.user.click(screen.getByRole('button', { name: '详细卡片' }))
  await app.user.click(screen.getByRole('button', { name: '收起全部镜头' }))
  await app.user.click(screen.getByRole('button', { name: '准备 1 项' }))
  await app.user.click(screen.getByRole('button', { name: '定位准备项：「林夏」尚未绑定资产卡' }))
  const binding = screen.getByRole('combobox', { name: '出场资产绑定：林夏' })
  expect(document.activeElement).toBe(binding)
  expect(screen.getByRole('button', { name: '收起镜头 1' })).toBeDefined()
  expect(f.read()[0]?.assetBindings).toBeUndefined()

  const character = createElement(f.doc, {
    kind: 'node',
    nodeType: 'plein/character',
    name: '林夏',
    params: {},
    x: 0,
    y: 0,
    w: 200,
    h: 160,
  })
  act(f.flush)
  await app.user.click(screen.getByRole('button', { name: '准备 1 项' }))
  await app.user.click(screen.getByRole('button', { name: '定位准备项：角色卡「林夏」缺少参考图' }))
  expect(f.engine.selection.set).toHaveBeenCalledWith([character])
  expect(f.engine.zoomToFit).toHaveBeenCalledWith([character])
})

it('同名台词逐句报告失效 speaker 并定位到对应选择器', async () => {
  const f = storyboardFixture({ count: 1 })
  const speaker = createElement(f.doc, {
    kind: 'node',
    nodeType: 'plein/character',
    name: '甲',
    params: {},
    x: 0,
    y: 0,
    w: 200,
    h: 160,
  })
  f.write([
    {
      ...f.read()[0]!,
      characters: ['甲'],
      assetBindings: { 甲: { elementId: speaker } },
      dialogue: [
        { id: 'a', character: '甲', line: '第一句', speaker: { elementId: speaker } },
        { id: 'b', character: '甲', line: '第二句', speaker: { elementId: 'deleted' } },
      ],
    },
  ])
  act(f.flush)
  const before = f.read()
  const app = renderApp(<StoryboardEditor />)
  await app.user.click(screen.getByRole('button', { name: '准备 2 项' }))
  await app.user.click(
    screen.getByRole('button', {
      name: '定位准备项：第 2 句台词：「甲」的绑定已失效或不唯一，请重新选择',
    }),
  )
  const line = document.querySelector<HTMLElement>('[data-dialogue-id="b"]')!
  const select = within(line).getByRole('combobox', { name: '说话人绑定：甲' })
  expect(document.activeElement).toBe(select)
  expect(f.read()).toEqual(before)
})

it('提示词缺失从表格展开对应卡片字段并聚焦', async () => {
  const f = storyboardFixture({ count: 1 })
  f.write([{ ...f.read()[0]!, imagePrompt: '', dialogue: [] }])
  act(f.flush)
  const app = renderApp(<StoryboardEditor />)
  await app.user.click(screen.getByRole('button', { name: '准备 1 项' }))
  await app.user.click(screen.getByRole('button', { name: '定位准备项：填写分镜图提示词' }))
  const input = screen.getByRole('textbox', { name: '分镜图提示词' })
  await waitFor(() => expect(document.activeElement).toBe(input))
  expect(screen.queryByRole('dialog', { name: '镜头最终提示词' })).toBeNull()
})

it('场景与缺失筛选只改显示，全选仅保留当前可见镜头', async () => {
  const f = storyboardFixture()
  const first = { ...f.read()[0]!, characters: ['教室'], dialogue: [] }
  const second = { ...f.read()[1]!, characters: ['办公室'], imagePrompt: '' }
  f.write([first, second])
  const classroom = assetCard(f.doc, '教室')
  const office = assetCard(f.doc, '办公室')
  const image = createElement(f.doc, {
    kind: 'image',
    assetId: 'scene-reference',
    x: 0,
    y: 0,
    w: 100,
    h: 80,
  })
  connect(f.doc, [image, 'image'], [classroom, 'references'])
  connect(f.doc, [image, 'image'], [office, 'references'])
  act(f.flush)
  const before = f.read()
  const app = renderApp(<StoryboardEditor />)
  expect(screen.getAllByRole('row', { name: /^镜头 \d/ })).toHaveLength(2)

  await app.user.selectOptions(screen.getByRole('combobox', { name: '按场景筛选' }), [
    `asset:${classroom}`,
  ])
  expect(screen.getByRole('row', { name: '镜头 01' })).toBeDefined()
  expect(screen.queryByRole('row', { name: '镜头 02' })).toBeNull()
  expect(screen.getByText('作用于全部镜头（含未显示）')).toBeDefined()
  await app.user.click(screen.getByRole('checkbox', { name: '全选镜头' }))
  expect(screen.getByRole('checkbox', { name: '选择镜头 1' })).toHaveProperty('checked', true)
  expect(screen.getByText('作用于选中的 1 个镜头')).toBeDefined()

  await app.user.selectOptions(screen.getByRole('combobox', { name: '按场景筛选' }), [
    `asset:${office}`,
  ])
  await app.user.click(screen.getByRole('checkbox', { name: '全选镜头' }))
  expect(screen.getByRole('checkbox', { name: '选择镜头 2' })).toHaveProperty('checked', true)
  await app.user.selectOptions(screen.getByRole('combobox', { name: '按场景筛选' }), [''])
  expect(screen.getByRole('checkbox', { name: '选择镜头 1' })).toHaveProperty('checked', false)

  await app.user.click(screen.getByRole('checkbox', { name: '全选镜头' }))
  await app.user.click(screen.getByRole('checkbox', { name: '只看有缺失的镜头' }))
  expect(screen.getByText('作用于选中的 2 个镜头，其中 1 个可见')).toBeDefined()
  expect(screen.queryByRole('row', { name: '镜头 01' })).toBeNull()
  expect(screen.getByRole('row', { name: '镜头 02' })).toBeDefined()
  expect(f.read()).toEqual(before)
})

it('选中项被筛掉后，本地补齐仍只写完整选择且按钮保持所选范围', async () => {
  const f = storyboardFixture()
  f.write([
    {
      ...f.read()[0]!,
      characters: ['教室'],
      dialogue: [],
      imagePrompt: '',
      motionPrompt: '',
    },
    { ...f.read()[1]!, characters: ['办公室'], imagePrompt: '', motionPrompt: '' },
  ])
  assetCard(f.doc, '教室')
  const office = assetCard(f.doc, '办公室')
  act(f.flush)
  const app = renderApp(<StoryboardEditor />)
  await app.user.click(screen.getByRole('checkbox', { name: '选择镜头 1' }))
  await app.user.selectOptions(screen.getByRole('combobox', { name: '按场景筛选' }), [
    `asset:${office}`,
  ])
  const navigation = screen.getByRole('navigation', { name: '镜头制作流程' })
  await app.user.click(within(navigation).getByRole('button', { name: /合成提示词/ }))
  expect(screen.getByText('作用于选中的 1 个镜头，其中 0 个可见')).toBeDefined()
  const compose = screen.getByRole<HTMLButtonElement>('button', { name: '本地补齐所选提示词' })
  expect(compose.disabled).toBe(false)
  await app.user.click(compose)
  expect(f.read()[0]?.imagePrompt).not.toBe('')
  expect(f.read()[0]?.motionPrompt).not.toBe('')
  expect(f.read()[1]?.imagePrompt).toBe('')
  expect(f.read()[1]?.motionPrompt).toBe('')
})

it('场景筛选中添加镜头会退出筛选并聚焦新画面', async () => {
  const f = storyboardFixture({ count: 1 })
  f.write([{ ...f.read()[0]!, characters: ['教室'], dialogue: [] }])
  const classroom = assetCard(f.doc, '教室')
  act(f.flush)
  const app = renderApp(<StoryboardEditor />)
  await app.user.selectOptions(screen.getByRole('combobox', { name: '按场景筛选' }), [
    `asset:${classroom}`,
  ])
  await app.user.click(screen.getByRole('button', { name: '添加镜头' }))
  expect(screen.getAllByRole('row', { name: /^镜头 \d/ })).toHaveLength(2)
  expect(screen.getByRole('combobox', { name: '按场景筛选' })).toHaveProperty('value', '')
  const descriptions = screen.getAllByRole<HTMLTextAreaElement>('textbox', { name: '画面' })
  expect(document.activeElement).toBe(descriptions.at(-1))
  expect(f.read()).toHaveLength(2)
})

it('原文覆盖建议定位到对应标注的原文范围', async () => {
  const f = storyboardFixture({ count: 1 })
  f.write([{ ...f.read()[0]!, dialogue: [] }])
  f.doc.mutable(f.board)!.set('ports', {
    inputs: [{ id: 'script', label: '剧本', type: 'text', multiple: true }],
    outputs: [{ id: 'shots', label: '分镜', type: 'json' }],
  })
  const source = createElement(f.doc, {
    kind: 'markdown',
    name: '剧本',
    text: '尚未关联的原文段落。',
    x: 0,
    y: 0,
    w: 200,
    h: 100,
  })
  connect(f.doc, [source, 'text'], [f.board, 'script'])
  const snapshotId = captureSourceSnapshot(f.doc, f.board, {
    canvasId: 'canvas',
    elementId: source,
    port: 'text',
    expectedText: '尚未关联的原文段落。',
  })!
  addSourceUnit(f.doc, f.board, { snapshotId, start: 0, end: 5, kind: 'event' })
  markSourceRead(f.doc, f.board, snapshotId)
  act(f.flush)
  const app = renderApp(<StoryboardEditor />)
  await app.user.click(screen.getByRole('button', { name: '准备 1 项' }))
  await app.user.click(
    screen.getByRole('button', { name: '定位准备项：原文段落尚未关联镜头，建议核对' }),
  )
  const original = await screen.findByRole<HTMLTextAreaElement>('textbox', { name: '固定原文' })
  expect(screen.getByTestId('storyboard-current-mode').textContent).toBe('当前：剧情来源')
  await waitFor(() => expect(document.activeElement).toBe(original))
  expect(original.selectionEnd).toBeGreaterThan(0)
})

it('准备项可切换到非默认原文快照并定位选区', async () => {
  const f = storyboardFixture({ count: 1 })
  f.write([{ ...f.read()[0]!, dialogue: [] }])
  f.doc.mutable(f.board)!.set('ports', {
    inputs: [{ id: 'script', label: '剧本', type: 'text', multiple: true }],
    outputs: [{ id: 'shots', label: '分镜', type: 'json' }],
  })
  const texts = ['第一来源的非默认段落。', '第二来源的非默认段落。']
  const snapshots = texts.map((text, index) => {
    const source = createElement(f.doc, {
      kind: 'markdown',
      name: `剧本 ${index + 1}`,
      text,
      x: index * 200,
      y: 0,
      w: 180,
      h: 100,
    })
    connect(f.doc, [source, 'text'], [f.board, 'script'])
    return captureSourceSnapshot(f.doc, f.board, {
      canvasId: 'canvas',
      elementId: source,
      port: 'text',
      expectedText: text,
    })!
  })
  const record = sourceMapOf(f.doc, f.board)
  const active = new Set(record.sources.map((source) => source.activeSnapshotId))
  const defaultId = record.snapshots
    .filter((snapshot) => active.has(snapshot.id))
    .sort((a, b) => a.capturedAt - b.capturedAt || a.id.localeCompare(b.id))
    .at(-1)?.id
  const targetIndex = snapshots[0] === defaultId ? 1 : 0
  const targetId = snapshots[targetIndex]!
  const targetText = texts[targetIndex]!
  addSourceUnit(f.doc, f.board, { snapshotId: targetId, start: 0, end: 4, kind: 'event' })
  markSourceRead(f.doc, f.board, targetId)
  act(f.flush)
  const app = renderApp(<StoryboardEditor />)
  await app.user.click(screen.getByRole('button', { name: '准备 1 项' }))
  await app.user.click(
    screen.getByRole('button', { name: '定位准备项：原文段落尚未关联镜头，建议核对' }),
  )
  const original = await screen.findByRole<HTMLTextAreaElement>('textbox', { name: '固定原文' })
  const version = screen.getByLabelText<HTMLSelectElement>('固定原文版本')
  await waitFor(() => {
    expect(version.value).toBe(targetId)
    expect(original.value).toBe(targetText)
    expect(document.activeElement).toBe(original)
  })
  expect(original.selectionEnd).toBeGreaterThan(0)
})

it('人工审核待办定位到已有镜头的审核视图', async () => {
  storyboardFixture({ count: 1, expanded: true })
  mockFetch(async (request) => {
    if (new URL(request.url).pathname.endsWith('/jobs/latest'))
      return Response.json({ jobs: [], groups: [] })
  })
  const app = renderApp(<StoryboardEditor />)
  await app.user.click(screen.getByRole('button', { name: '准备 3 项' }))
  await app.user.click(screen.getByRole('button', { name: '定位准备项：已有节点待人工审核' }))
  expect(await screen.findByRole('table', { name: '逐镜审核' })).toBeDefined()
  expect(screen.getByTestId('storyboard-current-mode').textContent).toBe('当前：审核镜头')
  expect(screen.getByRole('row', { name: /镜头 01/ })).toBeDefined()
})
