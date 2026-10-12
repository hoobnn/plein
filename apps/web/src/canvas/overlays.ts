import { defaultKeymap } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { EditorView, drawSelection, keymap } from '@codemirror/view'
import type { Engine } from '@plein/canvas-core'
import { currentResult, type Rect } from '@plein/doc'
import { yCollab } from 'y-codemirror.next'
import * as Y from 'yjs'
import { renderMarkdown } from './markdown'

interface Preview {
  node: HTMLDivElement
  text: string | undefined
}

interface Active {
  id: string
  node: HTMLElement
  /** 挂到页面后调用 */
  focus?(): void
  dispose(): void
}

export interface OverlayOptions {
  /** 原文件 URL（播放器用） */
  originalUrl(assetId: string): string
  /** 协作光标；本地演示时为空 */
  awareness?: unknown
}

function place(node: HTMLElement, r: Rect) {
  node.style.transform = `translate(${r.x}px, ${r.y}px)`
  node.style.width = `${r.w}px`
  node.style.height = `${r.h}px`
}

const editorTheme = EditorView.theme(
  {
    '&': { height: '100%', fontSize: '14px', backgroundColor: 'transparent' },
    '&.cm-focused': { outline: 'none' },
    '.cm-scroller': {
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      lineHeight: '1.6',
    },
    '.cm-content': { padding: '16px 0', caretColor: 'var(--color-accent)' },
    '.cm-line': { padding: '0 16px' },
    '.cm-cursor': { borderLeftColor: 'var(--color-accent)' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
      backgroundColor: 'rgb(232 213 181 / 0.2) !important',
    },
  },
  { dark: true },
)

/**
 * DOM 覆盖层：挂在跟随相机变换的容器里，按世界坐标定位。
 * - 视口内的 Markdown 元素渲染正文（只读，不接收指针事件）；
 * - 双击 Markdown 进入编辑（CodeMirror 绑定 Y.Text，协作实时同步）；
 * - 双击视频 / 音频（或结果是视频 / 音频的节点）显示播放器。
 * 点击画布其他位置、按 Esc 或选中别的元素时退出。
 */
export class CanvasOverlays {
  private previews = new Map<string, Preview>()
  private active: Active | null = null
  private disposers: Array<() => void> = []

  constructor(
    private engine: Engine,
    private root: HTMLElement,
    private host: HTMLElement,
    private opts: OverlayOptions,
  ) {
    this.disposers.push(
      engine.onViewChange(() => this.sync()),
      engine.onActivate((id) => this.activate(id)),
      engine.selection.onChange(() => {
        if (this.active && !engine.selection.has(this.active.id)) this.deactivate()
      }),
    )
    const onPointerDown = () => this.deactivate()
    host.addEventListener('pointerdown', onPointerDown, true)
    this.disposers.push(() => host.removeEventListener('pointerdown', onPointerDown, true))
    this.sync()
  }

  get activeId() {
    return this.active?.id ?? null
  }

  sync() {
    const { engine } = this
    const show = engine.highDetail
    const want = new Set<string>()
    if (show) {
      for (const id of engine.visibleIds) {
        if (id !== this.active?.id && engine.scene.get(id)?.kind === 'markdown') want.add(id)
      }
    }
    for (const [id, p] of this.previews) {
      if (!want.has(id)) {
        p.node.remove()
        this.previews.delete(id)
      }
    }
    for (const id of want) {
      const el = engine.scene.get(id)!
      const rect = engine.scene.rect(id)
      if (!rect) continue
      let p = this.previews.get(id)
      if (!p) {
        const node = document.createElement('div')
        node.className = 'plein-md plein-md-preview'
        this.root.appendChild(node)
        p = { node, text: undefined }
        this.previews.set(id, p)
      }
      place(p.node, rect)
      if (p.text !== el.text) {
        p.text = el.text
        p.node.innerHTML = renderMarkdown(el.text ?? '')
      }
    }
    if (this.active) {
      const rect = engine.scene.rect(this.active.id)
      if (rect) place(this.active.node, rect)
      else this.deactivate()
    }
  }

  activate(id: string) {
    if (this.active?.id === id) return
    this.deactivate()
    const el = this.engine.scene.get(id)
    if (!el || el.locked) return
    if (el.kind === 'markdown') this.active = this.openEditor(id)
    else if ((el.kind === 'video' || el.kind === 'audio') && el.assetId) {
      this.active = this.openPlayer(id, el.kind, el.assetId)
    } else if (el.kind === 'node') {
      // 节点的当前结果是视频 / 音频时，双击就地播放
      const v = currentResult(el)?.value
      if (v?.type === 'video' || v?.type === 'audio')
        this.active = this.openPlayer(id, v.type, v.assetId)
    }
    if (this.active) {
      this.active.node.dataset.pleinActive = ''
      // Esc 退出；其余按键留给编辑器 / 播放器
      this.active.node.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          this.deactivate()
        }
      })
      this.root.appendChild(this.active.node)
      this.sync()
      this.active.focus?.()
    }
  }

  deactivate() {
    if (!this.active) return
    const a = this.active
    this.active = null
    a.dispose()
    a.node.remove()
    this.host.focus?.()
    this.sync()
  }

  destroy() {
    this.deactivate()
    for (const d of this.disposers) d()
    for (const p of this.previews.values()) p.node.remove()
    this.previews.clear()
  }

  private openEditor(id: string): Active | null {
    const ytext = this.engine.doc.getText(id)
    if (!ytext || this.engine.doc.readOnly) return null
    const node = document.createElement('div')
    node.className = 'plein-md-editor'
    const undoManager = new Y.UndoManager(ytext)
    const view = new EditorView({
      parent: node,
      doc: ytext.toString(),
      extensions: [
        yCollab(ytext, this.opts.awareness ?? null, { undoManager }),
        keymap.of(defaultKeymap),
        drawSelection(),
        markdown(),
        EditorView.lineWrapping,
        editorTheme,
      ],
    })
    return {
      id,
      node,
      focus: () => view.focus(),
      dispose() {
        view.destroy()
        undoManager.destroy()
      },
    }
  }

  private openPlayer(id: string, kind: 'video' | 'audio', assetId: string): Active {
    const node = document.createElement('div')
    node.className = `plein-player plein-player-${kind}`
    const media = document.createElement(kind)
    media.src = this.opts.originalUrl(assetId)
    media.controls = true
    media.autoplay = true
    media.preload = 'metadata'
    node.appendChild(media)
    return {
      id,
      node,
      dispose() {
        media.pause()
        media.removeAttribute('src')
        media.load()
      },
    }
  }
}
