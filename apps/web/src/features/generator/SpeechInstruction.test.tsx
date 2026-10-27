// @vitest-environment happy-dom
import { createElement } from '@plein/doc'
import { openDoc } from '@plein/doc/testing'
import { expect, it } from 'vite-plus/test'
import { useDocVersion } from '../../canvas/hooks'
import { act, renderApp, screen } from '../../testing/render'
import { SpeechInstruction } from './SpeechInstruction'

it('显式清空长语气指令保留台词，可撤销重做且不提交生成', async () => {
  const doc = openDoc()
  const instruction = `低声哭腔：${'quiet'.repeat(160)}`
  const id = createElement(doc, {
    kind: 'node',
    nodeType: 'plein/speech',
    x: 0,
    y: 0,
    w: 100,
    h: 80,
    params: { instruction, text: '保留台词。' },
  })
  doc.undo.clear()
  function Harness() {
    useDocVersion(doc)
    const value = String(doc.get(id)!.params!.instruction)
    return (
      <>
        <textarea aria-label="台词" readOnly value={String(doc.get(id)!.params!.text)} />
        {value && (
          <SpeechInstruction
            doc={doc}
            nodeId={id}
            instruction={value}
            focusPrompt={() => {
              screen.getByRole('textbox', { name: '台词' }).focus()
            }}
          />
        )}
      </>
    )
  }
  try {
    const { user } = renderApp(<Harness />)
    expect(screen.getByTitle(instruction).textContent).toContain(instruction)
    await user.click(screen.getByRole('button', { name: '清空语气指令' }))
    act(() => doc.flush())
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: '台词' }))
    expect(doc.get(id)!.params).toMatchObject({ instruction: '', text: '保留台词。' })
    expect(screen.queryByRole('button')).toBeNull()
    act(() => {
      doc.undo.undo()
      doc.flush()
    })
    expect(screen.getByRole('button', { name: '清空语气指令' })).toBeDefined()
    act(() => {
      doc.undo.redo()
      doc.flush()
    })
    expect(screen.queryByRole('button')).toBeNull()
  } finally {
    doc.destroy()
  }
})
