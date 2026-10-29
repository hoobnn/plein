// @vitest-environment happy-dom
import { deleteElements, setParam, updateElement } from '@plein/doc'
import { expect, it } from 'vite-plus/test'
import { act, fireEvent, renderApp, screen } from '../../testing/render'
import { StoryboardSync } from './StoryboardSync'
import { expandedNodes } from './model'
import { storyboardFixture } from './testing'

function setup() {
  const f = storyboardFixture({ count: 1, expanded: true })
  const nodes = expandedNodes(f.engine, f.board).get('shot-1')!
  const image = nodes.find((el) => (el.params!.source as { role: string }).role === 'image')!.id
  f.write([{ ...f.read()[0]!, imagePrompt: '计划更新' }])
  f.flush()
  const app = renderApp(
    <StoryboardSync engine={f.engine} boardId={f.board} shotIds={['shot-1']} onClose={() => {}} />,
  )
  const snapshot = () =>
    [...f.doc.elements()]
      .filter((el) => el.id !== f.board)
      .map((el) => ({ id: el.id, params: el.params }))
  return { ...f, ...app, nodes, image, snapshot }
}

for (const label of ['同步计划改动', '不同步，按节点现状']) {
  it.each(['plan', 'actual', 'readonly', 'node-delete', 'shot-delete'] as const)(
    `${label} 前同帧 %s 拒绝过期操作，核对后可重试`,
    async (change) => {
      const f = setup()
      const button = screen.getByRole('button', { name: label })
      f.doc.undo.stopCapturing()
      if (change === 'plan') f.write([{ ...f.read()[0]!, imagePrompt: '同帧新计划' }])
      else if (change === 'actual') setParam(f.doc, f.image, 'prompt', '同帧手改')
      else if (change === 'readonly') f.doc.readOnly = true
      else if (change === 'node-delete') deleteElements(f.doc, [f.image])
      else f.write([])
      const before = f.snapshot()
      fireEvent.click(button)
      expect(f.snapshot()).toEqual(before)
      expect(screen.getByRole('alert').textContent).toContain(
        change === 'readonly' ? '只读' : '差异已变化',
      )
      act(f.flush)
      if (change === 'readonly' || change.endsWith('delete')) {
        expect(screen.getByRole<HTMLButtonElement>('button', { name: label }).disabled).toBe(true)
        if (change === 'readonly') {
          f.doc.readOnly = false
          act(() => {
            updateElement(f.doc, f.board, { name: '恢复可写' })
            f.flush()
          })
        } else act(() => f.engine.undo())
      }
      await f.user.click(screen.getByRole('button', { name: label }))
      act(f.flush)
      expect(screen.getByText('没有待处理的差异')).toBeDefined()
      expect(screen.queryByRole('alert')).toBeNull()
      expect(f.doc.get(f.image)?.params?.prompt).toBe(
        change === 'actual'
          ? '同帧手改'
          : label === '不同步，按节点现状'
            ? '分镜图1 景别：中景'
            : change === 'plan'
              ? '同帧新计划 景别：中景'
              : '计划更新 景别：中景',
      )
    },
  )

  it(`${label} 独立撤销，不撤回同帧的无关改名`, async () => {
    const f = setup()
    const before = f.snapshot()
    f.doc.undo.stopCapturing()
    updateElement(f.doc, f.board, { name: '同步前改名' })
    await f.user.click(screen.getByRole('button', { name: label }))
    const after = f.snapshot()
    expect(after).not.toEqual(before)
    act(() => f.engine.undo())
    expect(f.snapshot()).toEqual(before)
    expect(f.doc.get(f.board)!.name).toBe('同步前改名')
    act(() => f.engine.redo())
    expect(f.snapshot()).toEqual(after)
    expect(f.doc.get(f.board)!.name).toBe('同步前改名')
  })
}

it('手改空台词在计划改台词时显示当前值和计划值；计划未变的音色不重报，同步保留手改', async () => {
  const f = setup()
  const speech = f.nodes.find((el) => (el.params!.source as { role: string }).role === 'speech')!
  act(() => {
    setParam(f.doc, speech.id, 'text', '')
    setParam(f.doc, speech.id, 'voice', { provider: 'custom-provider', voiceId: 'custom-voice' })
    const shot = f.read()[0]!
    f.write([
      { ...shot, dialogue: shot.dialogue.map((line) => ({ ...line, line: `${line.line}（改）` })) },
    ])
    f.flush()
  })
  expect(screen.getAllByText('（空）').length).toBeGreaterThan(0)
  expect(screen.queryByText('custom-voice（custom-provider）')).toBeNull()
  expect(screen.getAllByText('你改过')).toHaveLength(1)
  await f.user.click(screen.getByRole('button', { name: '同步计划改动' }))
  expect(f.doc.get(speech.id)!.params).toMatchObject({
    text: '',
    voice: { provider: 'custom-provider', voiceId: 'custom-voice' },
  })
  expect(f.doc.get(f.image)!.params!.prompt).toContain('计划更新')
})
