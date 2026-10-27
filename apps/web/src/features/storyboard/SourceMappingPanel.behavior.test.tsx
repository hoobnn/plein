// @vitest-environment happy-dom
import type { Engine } from '@plein/canvas-core'
import { captureSourceSnapshot, connect, createElement, setText } from '@plein/doc'
import { node, openDoc } from '@plein/doc/testing'
import type { Shot } from '@plein/nodes'
import * as Y from 'yjs'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { useCanvas } from '../../stores/canvas'
import { useSession } from '../../stores/session'
import { renderApp, screen, waitFor, fireEvent, within } from '../../testing/render'
import { SourceMappingPanel } from './SourceMappingPanel'

const shots: Shot[] = [
  { id: 'one', no: 1, description: '她回头', dialogue: [], imagePrompt: '' } as unknown as Shot,
  { id: 'two', no: 2, description: '他点头', dialogue: [], imagePrompt: '' } as unknown as Shot,
]

const docs: ReturnType<typeof openDoc>[] = []
afterEach(() => {
  for (const doc of docs.splice(0)) doc.destroy()
})

/**
 * 建一个分镜板，剧本输入连到一段中文原文。
 * 只建文档，不动全局 store；协作者那份文档要走这条。
 */
function seed(text = '甲：回来。\n乙：回来。', ydoc?: Y.Doc) {
  const doc = openDoc(ydoc)
  docs.push(doc)
  const board = createElement(
    doc,
    node({
      nodeType: 'plein/storyboard',
      ports: {
        inputs: [{ id: 'script', label: '剧本', type: 'text', multiple: true }],
        outputs: [],
      },
      params: { shots: [{ id: 'one', description: '她回头', dialogue: [] }] },
    }),
  )
  const source = createElement(doc, {
    kind: 'markdown',
    x: 0,
    y: 0,
    w: 200,
    h: 200,
    text,
    name: '剧本',
  })
  connect(doc, [source, 'text'], [board, 'script'])
  return { doc, board, source }
}

/** 我这一侧的文档：同时把它挂到全局 store 上，面板才允许写入。 */
function fixture(text = '甲：回来。\n乙：回来。', ydoc?: Y.Doc) {
  const seeded = seed(text, ydoc)
  const engine = { doc: seeded.doc } as unknown as Engine
  useCanvas.setState({ engine, canvasId: 'canvas-a', storyboard: seeded.board })
  useSession.setState({
    status: 'ready',
    info: { principal: { id: 'me', role: 'owner' } } as never,
  })
  return { ...seeded, engine }
}

function render(engine: Engine, boardId: string) {
  return renderApp(
    <SourceMappingPanel
      engine={engine}
      boardId={boardId}
      shots={shots}
      onLocateShot={() => {}}
      onLocateSource={() => {}}
    />,
  )
}

/** 文档里真正的关联记录：断言的是文档，不是界面上的文字。 */
function linksOf(doc: ReturnType<typeof openDoc>, boardId: string) {
  const record = doc.get(boardId)!.production!.sourceMap!
  return record.links.map((link) => ({
    unitId: link.unitId,
    shotId: link.shotId,
    treatment: link.treatment,
  }))
}

/**
 * 固定原文并加一条标注，返回这条标注的 id。
 * 文档变更后必须 flush，面板才会重算已读、范围与关联。
 */
async function addUnit(
  user: ReturnType<typeof render>['user'],
  doc: ReturnType<typeof openDoc>,
  start = 0,
  end = 4,
): Promise<string> {
  await user.click(screen.getByRole('button', { name: '固定为新版本' }))
  const textarea = (await screen.findByLabelText('固定原文')) as HTMLTextAreaElement
  await waitFor(() => expect(textarea.value.length).toBeGreaterThan(0))
  textarea.setSelectionRange(start, end)
  fireEvent.select(textarea)
  await waitFor(() => expect(screen.getByText(`范围 ${start}–${end}`)).toBeTruthy())
  await user.selectOptions(screen.getByLabelText('原文标注类型'), 'dialogue')
  await user.click(screen.getByRole('button', { name: '将选中原文加入标注' }))
  doc.flush()
  await waitFor(() =>
    expect(screen.getByRole('list', { name: '原文标注' }).children.length).toBe(1),
  )
  const li = screen.getByRole('list', { name: '原文标注' }).children[0] as HTMLElement
  return li.getAttribute('data-unit-id')!
}

describe('来源映射面板', () => {
  it('关联所选镜头：文档里写下 unitId、shotId 与覆盖处理，界面随之显示已映射', async () => {
    const { engine, board, doc } = fixture()
    const { user } = render(engine, board)
    const unitId = await addUnit(user, doc)
    await user.click(screen.getByRole('button', { name: '我已核对本版原文' }))
    doc.flush()

    await user.selectOptions(screen.getByLabelText('关联或定位镜头'), 'one')
    await user.selectOptions(screen.getByLabelText('覆盖处理'), 'compress')
    // 真正点「关联所选镜头」：只在下拉框里选不算关联
    await user.click(screen.getByRole('button', { name: '关联所选镜头' }))
    doc.flush()

    await waitFor(() => expect(linksOf(doc, board)).toHaveLength(1))
    expect(linksOf(doc, board)[0]).toEqual({ unitId, shotId: 'one', treatment: 'compress' })

    const li = screen.getByRole('list', { name: '原文标注' }).children[0] as HTMLElement
    await waitFor(() => expect(li.textContent).toContain('已映射'))
    expect(li.textContent).toContain('压缩')
  })

  it('双向定位：镜头对应原文能回到原文范围，定位镜头能回调镜头 id', async () => {
    const { engine, board, doc } = fixture()
    const onLocateShot = vi.fn()
    const view = renderApp(
      <SourceMappingPanel
        engine={engine}
        boardId={board}
        shots={shots}
        onLocateShot={onLocateShot}
        onLocateSource={() => {}}
      />,
    )
    const { user } = view
    await addUnit(user, doc)
    await user.selectOptions(screen.getByLabelText('关联或定位镜头'), 'one')
    await user.click(screen.getByRole('button', { name: '关联所选镜头' }))
    doc.flush()
    await waitFor(() => expect(linksOf(doc, board)).toHaveLength(1))

    // 镜头 → 原文：面板里的「镜头对应原文」入口能把选区拉回原文
    const region = screen.getByRole('region', { name: '镜头对应原文' })
    await user.click(within(region).getByRole('button'))
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('固定原文')))

    // 原文 → 镜头：标注里的「定位镜头 1」要回调镜头 id
    const li = screen.getByRole('list', { name: '原文标注' }).children[0] as HTMLElement
    await user.click(within(li).getByRole('button', { name: '定位镜头 1' }))
    expect(onLocateShot).toHaveBeenCalledWith('one')
  })

  it('改编提案写进文档，重新挂载面板（刷新）后仍在', async () => {
    const { engine, board, doc } = fixture()
    const view = render(engine, board)
    const { user } = view
    await addUnit(user, doc)
    await user.selectOptions(screen.getByLabelText('关联或定位镜头'), 'one')
    await user.click(screen.getByRole('button', { name: '关联所选镜头' }))
    await user.click(screen.getByRole('button', { name: '我已核对本版原文' }))
    doc.flush()

    await user.type(screen.getByLabelText('新增改编提案'), '新增等待动作，尚待人工判断')
    await user.click(screen.getByRole('button', { name: '保存改编提案' }))
    doc.flush()
    await waitFor(() =>
      expect(screen.getByRole('list', { name: '改编提案' }).textContent).toContain(
        '新增等待动作，尚待人工判断',
      ),
    )
    expect(doc.get(board)!.production!.sourceMap!.proposals.map((p) => p.note)).toEqual([
      '新增等待动作，尚待人工判断',
    ])

    // 刷新：面板状态全在文档里，重挂载后仍在
    view.unmount()
    render(engine, board)
    await waitFor(() =>
      expect(screen.getByRole('list', { name: '原文标注' }).textContent).toContain('已映射'),
    )
    expect(screen.getByText('已显式核对本版原文')).toBeTruthy()
    expect(screen.getByRole('list', { name: '改编提案' }).textContent).toContain(
      '新增等待动作，尚待人工判断',
    )
  })

  it('协作者固定新版后，已选原文范围仍属于原固定版本（两份真实 Yjs 文档）', async () => {
    const ydocA = new Y.Doc()
    const ydocB = new Y.Doc()
    const { engine, board, source, doc } = fixture('甲：回来。\n乙：回来。', ydocA)
    const { user } = render(engine, board)

    await user.click(screen.getByRole('button', { name: '固定为新版本' }))
    const textarea = (await screen.findByLabelText('固定原文')) as HTMLTextAreaElement
    await waitFor(() => expect(textarea.value).toBe('甲：回来。\n乙：回来。'))
    const snapshotId = doc.get(board)!.production!.sourceMap!.snapshots[0]!.id

    // 我这边在原固定版本上选中第二句
    textarea.setSelectionRange(6, 11)
    fireEvent.select(textarea)
    await waitFor(() => expect(screen.getByText('范围 6–11')).toBeTruthy())

    // 协作者在另一份真实文档里改了来源并固定新版
    Y.applyUpdate(ydocB, Y.encodeStateAsUpdate(ydocA))
    const peerDoc = openDoc(ydocB)
    docs.push(peerDoc)
    expect(peerDoc.get(board)).toBeTruthy()
    setText(peerDoc, source, '另一部故事，与原来的内容和范围不同。')
    peerDoc.flush()
    const peerSnapshot = captureSourceSnapshot(peerDoc, board, {
      canvasId: 'canvas-a',
      elementId: source,
      port: 'text',
      expectedText: '另一部故事，与原来的内容和范围不同。',
    })
    expect(peerSnapshot).toBeTruthy()

    // 协作者的变更同步回来：我这边还在看原固定版本
    Y.applyUpdate(ydocA, Y.encodeStateAsUpdate(ydocB))
    doc.flush()
    await waitFor(() =>
      expect(screen.getByLabelText('固定原文版本')).toHaveProperty('options.length', 2),
    )
    expect(textarea.value).toBe('甲：回来。\n乙：回来。')

    // 选区加入的标注必须归属原快照，摘录也来自原文
    await user.selectOptions(screen.getByLabelText('原文标注类型'), 'dialogue')
    await user.click(screen.getByRole('button', { name: '将选中原文加入标注' }))
    doc.flush()
    await waitFor(() => expect(doc.get(board)!.production!.sourceMap!.units).toHaveLength(1))
    const unit = doc.get(board)!.production!.sourceMap!.units[0]!
    expect(unit.snapshotId).toBe(snapshotId)
    const snapshot = doc
      .get(board)!
      .production!.sourceMap!.snapshots.find((s) => s.id === unit.snapshotId)!
    expect(snapshot.text.slice(unit.start, unit.end)).toBe('乙：回来。')
  })

  it('固定原文后可显式声明已读，标注范围与镜头关联写入文档', async () => {
    const { engine, board, doc } = fixture()
    const { user } = render(engine, board)

    await user.click(screen.getByRole('button', { name: '固定为新版本' }))
    const textarea = (await screen.findByLabelText('固定原文')) as HTMLTextAreaElement
    await waitFor(() => expect(textarea.value).toBe('甲：回来。\n乙：回来。'))
    expect(screen.getByText('未读：尚未声明核对本版原文')).toBeTruthy()

    await user.click(screen.getByRole('button', { name: '我已核对本版原文' }))
    doc.flush()
    await waitFor(() => expect(screen.getByText('已显式核对本版原文')).toBeTruthy())

    // 选中原文前 4 个字作为标注范围
    textarea.setSelectionRange(0, 4)
    fireEvent.select(textarea)
    await user.selectOptions(screen.getByLabelText('原文标注类型'), 'dialogue')
    await user.click(screen.getByRole('button', { name: '将选中原文加入标注' }))
    doc.flush()
    await waitFor(() => expect(screen.getByText('范围 0–4')).toBeTruthy())

    await user.selectOptions(screen.getByLabelText('关联或定位镜头'), 'one')
    doc.flush()
    await waitFor(() => expect(screen.getByText(/本版 \d+ 个人工标注/).textContent).toContain('1'))
  })

  it('来源被修改后只提示仍查看固定旧版，固定原文内容保持不变', async () => {
    const { engine, board, source, doc } = fixture()
    const { user } = render(engine, board)
    await user.click(screen.getByRole('button', { name: '固定为新版本' }))
    const textarea = (await screen.findByLabelText('固定原文')) as HTMLTextAreaElement
    await waitFor(() => expect(textarea.value).toBe('甲：回来。\n乙：回来。'))

    setText(doc, source, '修订后的原文')
    doc.flush()
    await waitFor(() =>
      expect(screen.getByText('来源已修改：当前仍查看固定旧版，请复核后固定新版本')).toBeTruthy(),
    )
    expect(textarea.value).toBe('甲：回来。\n乙：回来。')
  })

  it('只读成员不能固定或写入，提示当前不可写', async () => {
    const { engine, board } = fixture()
    useSession.setState({
      status: 'ready',
      info: { principal: { id: 'viewer', role: 'viewer' } } as never,
    })
    render(engine, board)
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '固定为新版本' })).toHaveProperty('disabled', true),
    )
  })
})
