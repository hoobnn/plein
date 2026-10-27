// @vitest-environment happy-dom
import { describe, expect, it } from 'vite-plus/test'
import { createElement } from '@plein/doc'
import { openDoc } from '@plein/doc/testing'
import * as Y from 'yjs'
import {
  attachEditorEscape,
  createMarkdownEditor,
  createMarkdownTarget,
  type MarkdownEditor,
} from './markdownOverlay'

/** 打开一个绑定 Y.Text 的正文编辑器。 */
function setup(text = '便签原始正文') {
  const ydoc = new Y.Doc()
  const ytext = ydoc.getText('note')
  ytext.insert(0, text)
  const background = ydoc.getText('background')
  background.insert(0, '不参与便签撤销')
  const guard = { valid: true }
  const editor = createMarkdownEditor({ ytext, valid: () => guard.valid })
  const host = document.createElement('div')
  host.appendChild(editor.dom)
  document.body.appendChild(host)
  const content = editor.dom.querySelector('.cm-content') as HTMLElement
  return { ydoc, ytext, background, editor, host, content, guard }
}

/** 键入一段文字：等价真实输入产生的一次正文变更。 */
function type(editor: MarkdownEditor, text: string) {
  const at = editor.view.state.doc.length
  editor.view.dispatch({ changes: { from: at, to: at, insert: text } })
}

/**
 * 触发一次按键。
 * Shift 组合在真实浏览器里给出大写字母与对应 keyCode，这里照搬，避免被当成普通字母。
 */
function press(target: HTMLElement, key: string, options: KeyboardEventInit = {}) {
  const shifted = options.shiftKey && key.length === 1 ? key.toUpperCase() : key
  const event = new KeyboardEvent('keydown', {
    key: shifted,
    bubbles: true,
    cancelable: true,
    ...options,
  })
  if (options.shiftKey && key.length === 1) {
    Object.defineProperty(event, 'keyCode', { value: shifted.charCodeAt(0) })
  }
  target.dispatchEvent(event)
  return event
}

/** 选中编辑器里的全部正文，让复制剪切拿到完整内容。 */
function selectAll(editor: MarkdownEditor, content: HTMLElement) {
  window.getSelection()!.selectAllChildren(content)
  document.dispatchEvent(new Event('selectionchange'))
  editor.view.dispatch({ selection: { anchor: 0, head: editor.view.state.doc.length } })
}

/** 在编辑器上派发一次剪贴板事件，返回事件拿到的纯文本。 */
function clipboard(content: HTMLElement, type: 'copy' | 'cut' | 'paste', text?: string) {
  const data = new DataTransfer()
  if (text !== undefined) data.setData('text/plain', text)
  const event = new ClipboardEvent(type, { bubbles: true, cancelable: true, clipboardData: data })
  content.dispatchEvent(event)
  return { event, data }
}

describe('便签正文编辑器', () => {
  it('撤销与重做只回退正文，不动背景节点', () => {
    const f = setup()
    type(f.editor, '，追加文字')
    expect(f.ytext.toString()).toBe('便签原始正文，追加文字')
    f.background.insert(0, '背景改动')
    press(f.content, 'z', { ctrlKey: true })
    expect(f.ytext.toString()).toBe('便签原始正文')
    press(f.content, 'z', { ctrlKey: true })
    expect(f.ytext.toString()).toBe('便签原始正文')
    expect(f.background.toString()).toBe('背景改动不参与便签撤销')
    press(f.content, 'z', { ctrlKey: true, shiftKey: true })
    expect(f.ytext.toString()).toBe('便签原始正文，追加文字')
  })

  it('复制与剪切只带走正文，撤销重做各自还原', () => {
    const f = setup()
    selectAll(f.editor, f.content)
    const copied = clipboard(f.content, 'copy')
    expect(copied.event.defaultPrevented).toBe(true)
    expect(copied.data.getData('text/plain')).toBe('便签原始正文')
    const cut = clipboard(f.content, 'cut')
    expect(cut.data.getData('text/plain')).toBe('便签原始正文')
    expect(f.ytext.toString()).toBe('')
    press(f.content, 'z', { ctrlKey: true })
    expect(f.ytext.toString()).toBe('便签原始正文')
    press(f.content, 'z', { ctrlKey: true, shiftKey: true })
    expect(f.ytext.toString()).toBe('')
  })

  it('粘贴只写入正文，撤销重做各自还原', () => {
    const f = setup()
    selectAll(f.editor, f.content)
    clipboard(f.content, 'paste', '便签粘贴的新正文')
    expect(f.ytext.toString()).toBe('便签粘贴的新正文')
    press(f.content, 'z', { ctrlKey: true })
    expect(f.ytext.toString()).toBe('便签原始正文')
    press(f.content, 'z', { ctrlKey: true, shiftKey: true })
    expect(f.ytext.toString()).toBe('便签粘贴的新正文')
  })

  it('只读后迟到的输入与撤销都不改正文', () => {
    const f = setup()
    type(f.editor, '，追加文字')
    f.guard.valid = false
    type(f.editor, '，只读不应写入')
    expect(f.ytext.toString()).toBe('便签原始正文，追加文字')
    press(f.content, 'z', { ctrlKey: true })
    expect(f.ytext.toString()).toBe('便签原始正文，追加文字')
    press(f.content, 'z', { ctrlKey: true, shiftKey: true })
    expect(f.ytext.toString()).toBe('便签原始正文，追加文字')
  })
})

describe('便签编辑目标失效', () => {
  for (const change of ['delete', 'kind', 'element', 'text', 'lock'] as const) {
    it(`${change} 之后旧撤销不写回正文`, () => {
      const doc = openDoc()
      const id = createElement(doc, {
        kind: 'markdown',
        text: '正文原始内容',
        x: 0,
        y: 0,
        w: 360,
        h: 64,
      })
      const target = createMarkdownTarget(doc, id)
      const editor = createMarkdownEditor({ ytext: target.ytext!, valid: target.valid })
      const host = document.createElement('div')
      host.appendChild(editor.dom)
      document.body.appendChild(host)
      const content = editor.dom.querySelector('.cm-content') as HTMLElement
      type(editor, '，已保存的编辑')
      expect(target.ytext!.toString()).toBe('正文原始内容，已保存的编辑')
      const element = doc.mutable(id)!
      if (change === 'delete') doc.elementMaps.delete(id)
      else if (change === 'kind') element.set('kind', 'node')
      else if (change === 'lock') element.set('locked', true)
      else if (change === 'element') doc.elementMaps.set(id, element.clone())
      else {
        element.set('text', target.ytext!.clone())
        const next = doc.getText(id)!
        next.delete(0, next.length)
        next.insert(0, '替换后的新正文')
      }
      expect(target.valid()).toBe(false)
      const before = doc.getText(id)?.toString() ?? null
      press(content, 'z', { ctrlKey: true })
      expect(doc.getText(id)?.toString() ?? null).toBe(before)
      expect(editor.view.state.doc.toString()).not.toBe('正文原始内容')
    })
  }
})

describe('组字中的 Escape', () => {
  it('组字期间不退出编辑，组字结束后正常退出', () => {
    const node = document.createElement('div')
    document.body.appendChild(node)
    let exited = 0
    attachEditorEscape(node, () => {
      exited += 1
    })
    node.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: 'zhong' }))
    press(node, 'Escape')
    expect(exited).toBe(0)
    node.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中' }))
    press(node, 'Escape')
    expect(exited).toBe(1)
  })

  it('浏览器给出 keyCode 229 时同样不退出', () => {
    const node = document.createElement('div')
    document.body.appendChild(node)
    let exited = 0
    attachEditorEscape(node, () => {
      exited += 1
    })
    const event = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    })
    Object.defineProperty(event, 'keyCode', { value: 229 })
    node.dispatchEvent(event)
    expect(exited).toBe(0)
    press(node, 'Escape')
    expect(exited).toBe(1)
  })
})
