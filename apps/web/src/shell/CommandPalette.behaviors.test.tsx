// @vitest-environment happy-dom
import type { Engine } from '@plein/canvas-core'
import { createDoc, createElement } from '@plein/doc'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { useCanvas } from '../stores/canvas'
import { mockFetch } from '../testing/fetch'
import { renderApp, screen, waitFor } from '../testing/render'
import { CommandPalette } from './CommandPalette'

const docs: ReturnType<typeof createDoc>[] = []
afterEach(() => docs.splice(0).forEach((doc) => doc.destroy()))

/** 两个选中的节点，供「打组」使用 */
function setup(selection: string[] = []) {
  const doc = createDoc()
  docs.push(doc)
  const a = createElement(doc, {
    kind: 'node',
    nodeType: 'plein/text',
    name: '甲',
    x: 0,
    y: 0,
    w: 200,
    h: 100,
  })
  const b = createElement(doc, {
    kind: 'node',
    nodeType: 'plein/text',
    name: '乙',
    x: 300,
    y: 0,
    w: 200,
    h: 100,
  })
  const engine = {
    doc,
    selection: { values: () => (selection.length ? selection : [a, b]), set: vi.fn() },
    camera: { viewRect: { x: 0, y: 0, w: 1000, h: 800 } },
  } as unknown as Engine
  useCanvas.setState({ engine })
  return { ...renderApp(<CommandPalette canvasId="canvas-1" />), doc, a, b, engine }
}

describe('命令面板的行为', () => {
  it('对选区打组后能撤销回去', async () => {
    mockFetch((request) => {
      const path = new URL(request.url).pathname
      if (path === '/api/capabilities') return Response.json([])
      return undefined
    })
    const { user, doc } = setup()
    await user.keyboard('{Control>}k{/Control}')
    await screen.findByRole('combobox')
    await user.type(screen.getByRole('combobox'), '打组')
    await waitFor(() => expect(screen.getAllByRole('option').length).toBeGreaterThan(0))
    await user.keyboard('{Enter}')

    // 打完组多了一个 Frame
    await waitFor(() =>
      expect([...doc.elements()].filter((e) => e.kind === 'frame')).toHaveLength(1),
    )
    // 撤销后 Frame 消失，节点还在
    doc.undo.undo()
    expect([...doc.elements()].filter((e) => e.kind === 'frame')).toHaveLength(0)
    expect([...doc.elements()].filter((e) => e.kind === 'node')).toHaveLength(2)
  })

  it('执行插件能力后，提示里的「撤销」整次撤回', async () => {
    let undone = false
    mockFetch((request) => {
      const path = new URL(request.url).pathname
      if (path === '/api/capabilities')
        return Response.json([
          {
            name: 'mock.note',
            title: '贴一张便签（Mock）',
            description: '在旁边贴一张便签',
            effect: 'edit',
            plugin: 'Mock 平台',
            palette: 'selection',
          },
        ])
      if (path.endsWith('/capabilities/mock.note'))
        return Response.json({ result: JSON.stringify({ note: '旁边贴了便签' }), undo: 'undo-1' })
      if (path === '/api/capability-calls/undo-1/undo') {
        undone = true
        return Response.json({})
      }
      return undefined
    })
    const { user } = setup()
    await user.keyboard('{Control>}k{/Control}')
    await waitFor(() => expect(document.body.textContent).toBeTruthy())
    await screen.findByRole('combobox')
    await user.type(screen.getByRole('combobox'), '便签')
    await waitFor(() => expect(screen.getAllByRole('option').length).toBeGreaterThan(0))
    await user.keyboard('{Enter}')

    // 提示条出现了，带一个「撤销」动作
    await waitFor(() => expect(useCanvas.getState().notice).toContain('旁边贴了便签'))
    const action = useCanvas.getState().noticeAction
    expect(action?.label).toBe('撤销')
    expect(undone).toBe(false)
    // 点「撤销」整次撤回
    action!.run()
    await waitFor(() => expect(undone).toBe(true))
  })
})
