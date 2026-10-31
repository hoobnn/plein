import { defaultKeymap } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { EditorState } from '@codemirror/state'
import { EditorView, drawSelection, keymap } from '@codemirror/view'
import type { ElementMap, PleinDoc } from '@plein/doc'
import { yCollab, ySyncAnnotation, yUndoManagerKeymap } from 'y-codemirror.next'
import * as Y from 'yjs'

/**
 * 便签正文在 DOM 覆盖层里的编辑器与预览区交互。
 * 这里的判定都拆成纯函数，方便在快速测试层覆盖权限守卫、滚轮路由和快捷键边界。
 */

/** 编辑窗口主题：颜色全部取 CSS 令牌，明暗主题共用一套；字号行高与预览态同为 14/22。 */
const editorTheme = EditorView.theme({
  '&': {
    height: '100%',
    fontSize: 'var(--text-base)',
    color: 'var(--ink)',
    backgroundColor: 'transparent',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    lineHeight: 'var(--text-base--line-height)',
  },
  '.cm-content': { padding: '16px 0', caretColor: 'var(--accent)' },
  '.cm-line': { padding: '0 16px' },
  '.cm-cursor': { borderLeftColor: 'var(--accent)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
    backgroundColor: 'var(--accent-soft) !important',
  },
})

/** 正文编辑目标：打开时的元素与正文身份，以及「仍然可以编辑」的判定。 */
export interface MarkdownTarget {
  element: ElementMap | undefined
  ytext: Y.Text | undefined
  valid(): boolean
}

/**
 * 记录打开编辑时的元素与 Y.Text 身份。
 * 只读、文档销毁、元素被替换、类型变化、锁定、正文被换掉，任何一项发生都判定目标失效。
 */
export function createMarkdownTarget(doc: PleinDoc, id: string): MarkdownTarget {
  const element = doc.elementMaps.get(id)
  const ytext = doc.getText(id)
  return {
    element,
    ytext,
    valid: () =>
      !doc.readOnly &&
      !doc.ydoc.isDestroyed &&
      doc.elementMaps.get(id) === element &&
      element?.get('kind') === 'markdown' &&
      !element.get('locked') &&
      doc.getText(id) === ytext,
  }
}

/** 便签正文编辑器：CodeMirror 绑定 Y.Text，协作实时同步。 */
export interface MarkdownEditor {
  /** CodeMirror 根节点 */
  dom: HTMLElement
  /** CodeMirror 视图，调用方需要它做布局测量时使用 */
  view: EditorView
  focus(): void
  requestMeasure(): void
  destroy(): void
}

/**
 * 创建绑定到 Y.Text 的正文编辑器。
 * 撤销栈只覆盖这段正文，背景节点不受影响；目标失效后迟到的输入与撤销都不会写回。
 */
export function createMarkdownEditor(options: {
  ytext: Y.Text
  valid(): boolean
  awareness?: unknown
}): MarkdownEditor {
  const { ytext, valid } = options
  const undoManager = new Y.UndoManager(ytext)
  let scrollFrame = 0
  const view = new EditorView({
    doc: ytext.toString(),
    extensions: [
      EditorState.transactionFilter.of((transaction) =>
        !transaction.docChanged || transaction.annotation(ySyncAnnotation) || valid()
          ? transaction
          : [],
      ),
      yCollab(ytext, options.awareness ?? null, { undoManager }),
      // 正文历史直接操作 Y.Text，必须在调用 Yjs UndoManager 之前拦截。
      keymap.of([
        ...yUndoManagerKeymap.map((binding) => ({
          ...binding,
          run: (editor: EditorView) => (valid() ? (binding.run?.(editor) ?? false) : true),
        })),
        ...defaultKeymap,
      ]),
      drawSelection(),
      markdown(),
      EditorView.lineWrapping,
      EditorView.domEventHandlers({
        focus: (_event, editor) => {
          cancelAnimationFrame(scrollFrame)
          scrollFrame = requestAnimationFrame(() => editor.dispatch({ scrollIntoView: true }))
        },
      }),
      EditorView.updateListener.of((update) => {
        if (!update.geometryChanged) return
        cancelAnimationFrame(scrollFrame)
        // 换行高度可能经过多轮测量，按最终布局恢复当前选区。
        scrollFrame = requestAnimationFrame(() => update.view.dispatch({ scrollIntoView: true }))
      }),
      editorTheme,
    ],
  })
  return {
    dom: view.dom,
    view,
    focus: () => view.focus(),
    requestMeasure: () => view.requestMeasure(),
    destroy: () => {
      cancelAnimationFrame(scrollFrame)
      view.destroy()
      undoManager.destroy()
    },
  }
}

/** 组字中的 Escape 不退出编辑：浏览器会同时给出 isComposing 与 keyCode 229 两种信号。 */
export function composingBlocksEscape(input: {
  isComposing: boolean
  keyCode: number
  composing: boolean
}): boolean {
  return input.isComposing || input.keyCode === 229 || input.composing
}

/**
 * 编辑窗口的 Esc 退出。
 * 组字期间只吞掉按键，不退出编辑；组字结束后同一个 Esc 正常退出。
 */
export function attachEditorEscape(node: HTMLElement, onExit: () => void): void {
  let composing = false
  node.addEventListener(
    'compositionstart',
    () => {
      composing = true
    },
    true,
  )
  node.addEventListener(
    'compositionend',
    () => {
      composing = false
    },
    true,
  )
  node.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return
    if (
      composingBlocksEscape({ isComposing: event.isComposing, keyCode: event.keyCode, composing })
    ) {
      event.stopPropagation()
      return
    }
    if (event.defaultPrevented) return
    event.preventDefault()
    onExit()
  })
}

/** 预览区滚轮输入。 */
export interface PreviewWheelInput {
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  deltaX: number
  deltaY: number
  deltaMode: number
  clientWidth: number
  scrollWidth: number
}

/** 预览区滚轮的归属与手动横向滚动量。 */
export interface PreviewWheelDecision {
  /** 滚动区吸收这次滚轮，不再转交画布 */
  consumed: boolean
  /** 需要手动横向滚动的像素增量 */
  scrollLeft?: number
}

/**
 * 滚轮路由：斜向滚动按主方向分流，Shift 优先横向。
 * Ctrl / Meta 保留给画布缩放，未被滚动区消费的滚轮一律转交画布宿主。
 */
export function previewWheelDecision(input: PreviewWheelInput): PreviewWheelDecision {
  const horizontal = input.shiftKey || Math.abs(input.deltaX) > Math.abs(input.deltaY)
  if (input.ctrlKey || input.metaKey || !horizontal) return { consumed: false }
  if (input.scrollWidth <= input.clientWidth) return { consumed: false }
  // Shift 把竖向滚轮转成横向滚动；纯横向滚轮交给浏览器原生处理。
  if (input.shiftKey && Math.abs(input.deltaY) > Math.abs(input.deltaX)) {
    const unit = input.deltaMode === 1 ? 16 : input.deltaMode === 2 ? input.clientWidth : 1
    return { consumed: true, scrollLeft: input.deltaY * unit }
  }
  return { consumed: true }
}

/** 预览区按键要触发的动作。 */
export type PreviewKeyAction = 'select-all' | 'collapse' | 'none'

/**
 * 预览区快捷键：全选只覆盖当前滚动区，Esc 先取消文本选择。
 * 组字中的按键不参与这些快捷键。
 */
export function previewKeyAction(input: {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  composing: boolean
  /** 选区落在滚动区内且不是折叠状态 */
  selectionInside: boolean
}): PreviewKeyAction {
  if (input.composing) return 'none'
  if (input.metaKey || input.ctrlKey) {
    if (!input.altKey && !input.shiftKey && input.key.toLowerCase() === 'a') return 'select-all'
    return 'none'
  }
  if (input.key === 'Escape' && input.selectionInside) return 'collapse'
  return 'none'
}

/**
 * 预览区的滚轮与键盘交互。
 * 滚轮区自己横向滚动，竖向与缩放类滚轮转交画布宿主；全选与 Esc 只作用于当前滚动区。
 */
export function attachPreviewInteractions(node: HTMLElement, host: HTMLElement): void {
  node.addEventListener(
    'wheel',
    (event) => {
      if (event.defaultPrevented) return
      const scroll = (event.target as Element).closest<HTMLElement>('[data-plein-scroll]')
      const decision = previewWheelDecision({
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        deltaMode: event.deltaMode,
        clientWidth: scroll?.clientWidth ?? 0,
        scrollWidth: scroll?.scrollWidth ?? 0,
      })
      if (scroll && decision.consumed) {
        if (decision.scrollLeft !== undefined) {
          scroll.scrollLeft += decision.scrollLeft
          event.preventDefault()
        }
        event.stopPropagation()
        return
      }
      // DOM 预览与画布宿主是兄弟层，未消费的滚轮需要转交给画布输入。
      const canvasEvent = new WheelEvent('wheel', event)
      host.dispatchEvent(canvasEvent)
      if (canvasEvent.defaultPrevented) event.preventDefault()
      event.stopPropagation()
    },
    { passive: false },
  )
  node.addEventListener('keydown', (event) => {
    if (event.defaultPrevented) return
    const scroll = (event.target as Element).closest<HTMLElement>('[data-plein-scroll]')
    if (!scroll) return
    const selection = window.getSelection()
    const selectionInside = Boolean(
      selection &&
      !selection.isCollapsed &&
      scroll.contains(selection.anchorNode) &&
      scroll.contains(selection.focusNode),
    )
    const action = previewKeyAction({
      key: event.key,
      metaKey: event.metaKey,
      ctrlKey: event.ctrlKey,
      altKey: event.altKey,
      shiftKey: event.shiftKey,
      composing: event.isComposing || event.keyCode === 229,
      selectionInside,
    })
    if (action === 'select-all') {
      selection?.selectAllChildren(scroll)
      event.preventDefault()
    } else if (action === 'collapse') {
      selection?.collapseToEnd()
      event.preventDefault()
    }
  })
}
