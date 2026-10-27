import { defaultKeymap } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { EditorState } from '@codemirror/state'
import { EditorView, drawSelection, keymap } from '@codemirror/view'
import type { Engine } from '@plein/canvas-core'
import { currentResult, elementMedia, type Rect } from '@plein/doc'
import { ANIMATIC_TYPE, SEQUENCE_TYPE } from '@plein/nodes'
import { useCanvas } from '../stores/canvas'
import { yCollab, ySyncAnnotation, yUndoManagerKeymap } from 'y-codemirror.next'
import * as Y from 'yjs'
import { renderMarkdown } from './markdown'
import { createPlayer } from './player'
import { assetUrls } from '../api/client'
import { clipOverlay } from './occlusion'
import { editorViewport } from './editorViewport'

interface Preview {
  node: HTMLDivElement
  content: HTMLDivElement
  text: string | undefined
  width: number
}

interface Active {
  id: string
  node: HTMLElement
  /** 播放器正在放的素材：节点切换结果版本时据此换片 */
  assetId?: string
  /** 正文编辑必须仍绑定当前可编辑节点及其原始 Y.Text。 */
  valid?(): boolean
  /** 挂到页面后调用 */
  focus?(): void
  layout?(rect: Rect, viewport: Rect): void
  dispose(): void
}

export interface OverlayOptions {
  /** 原文件 URL（播放器用） */
  originalUrl(assetId: string): string
  /** 协作光标；本地演示时为空 */
  awareness?: unknown
}

/** Markdown 元素的最小高度：空正文也留出一行 */
const MD_MIN_H = 64

function place(node: HTMLElement, r: Rect) {
  node.style.transform = `translate(${r.x}px, ${r.y}px)`
  node.style.width = `${r.w}px`
  node.style.height = `${r.h}px`
}

const editorTheme = EditorView.theme(
  {
    '&': { height: '100%', fontSize: '14px', color: 'var(--ink)', backgroundColor: 'transparent' },
    '&.cm-focused': { outline: 'none' },
    '.cm-scroller': {
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      lineHeight: '1.6',
    },
    '.cm-content': { padding: '16px 0', caretColor: 'var(--accent)' },
    '.cm-line': { padding: '0 16px' },
    '.cm-cursor': { borderLeftColor: 'var(--accent)' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
      backgroundColor: 'var(--accent-soft) !important',
    },
  },
  // 颜色全部取 CSS 令牌，明暗主题共用一套
)

/**
 * DOM 覆盖层：挂在跟随相机变换的容器里，按世界坐标定位。
 * - 视口内的 Markdown 元素渲染正文（只读，不接收指针事件），高度随正文自适应；
 * - 双击 Markdown 进入编辑（CodeMirror 绑定 Y.Text，协作实时同步）；
 * - 双击视频 / 音频（或结果是视频 / 音频的节点）显示播放器。
 * 点击画布其他位置、按 Esc 或选中别的元素时退出。
 */
export class CanvasOverlays {
  private previews = new Map<string, Preview>()
  private viewport: Rect | undefined
  private previewSizer: ResizeObserver
  private active: Active | null = null
  /** 隐藏的量高节点：按元素宽度排版正文，量出自适应高度 */
  private measurer: HTMLDivElement
  /** 已量过的宽度 + 正文，没变就不再量 */
  private fitted = new Map<string, string>()
  private disposers: Array<() => void> = []

  constructor(
    private engine: Engine,
    private root: HTMLElement,
    private host: HTMLElement,
    private opts: OverlayOptions,
  ) {
    this.previewSizer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const id = (entry.target as HTMLElement).dataset.markdownId
        if (!id || this.previews.get(id)?.content !== entry.target) continue
        this.fitted.delete(id)
        this.fit(id)
      }
    })
    this.measurer = document.createElement('div')
    this.measurer.className = 'plein-md plein-md-preview'
    this.measurer.style.visibility = 'hidden'
    this.measurer.setAttribute('aria-hidden', 'true')
    root.appendChild(this.measurer)
    this.disposers.push(
      engine.onStateChange(() => {
        const active = this.active
        if (!active?.valid || active.valid()) return
        // Yjs 可能正在派发正文事件，等本次更新结束再销毁 CodeMirror。
        queueMicrotask(() => {
          if (this.active === active && !active.valid?.()) this.deactivate()
        })
      }),
      engine.onViewChange(({ content }) => this.sync(content)),
      engine.camera.onInsetsChange(() => this.sync(false)),
      engine.onMove(() => {
        const next = engine.camera.viewRect
        const prev = this.viewport
        if (
          !prev ||
          next.x !== prev.x ||
          next.y !== prev.y ||
          next.w !== prev.w ||
          next.h !== prev.h
        )
          this.sync(false)
      }),
      engine.onActivate((id) => {
        const el = engine.scene.get(id)
        // 序列与样片的双击由 CanvasView 打开编辑器，播放仅走封面按钮。
        if (el?.nodeType === SEQUENCE_TYPE || el?.nodeType === ANIMATIC_TYPE) return
        this.activate(id)
      }),
      useCanvas.subscribe((state, previous) => {
        if (state.sequence && state.sequence !== previous.sequence) this.deactivate()
      }),
      engine.selection.onChange(() => {
        if (this.active && !engine.selection.has(this.active.id)) this.deactivate()
      }),
    )
    const onPointerDown = () => this.deactivate()
    host.addEventListener('pointerdown', onPointerDown, true)
    this.disposers.push(() => host.removeEventListener('pointerdown', onPointerDown, true))
    const fullscreen = () => this.sync()
    document.addEventListener('fullscreenchange', fullscreen)
    this.disposers.push(() => document.removeEventListener('fullscreenchange', fullscreen))
    this.sync()
  }

  get activeId() {
    return this.active?.id ?? null
  }

  get stats() {
    return {
      fittedEntries: this.fitted.size,
      fittedCharacters: [...this.fitted.values()].reduce((sum, key) => sum + key.length, 0),
    }
  }

  /** content 为 false：更新几何和交互范围，已有正文与量高结果可复用 */
  sync(content = true) {
    if (this.active?.valid && !this.active.valid()) {
      this.deactivate()
      return
    }
    const { engine } = this
    const viewport = engine.camera.viewRect
    this.viewport = viewport
    const show = engine.highDetail
    const want = new Set<string>()
    if (show) {
      for (const id of engine.visibleIds) {
        if (id !== this.active?.id && engine.scene.get(id)?.kind === 'markdown') want.add(id)
      }
    }
    // 量高结果含完整正文，只保留当前预览和编辑项，离开视口后随预览释放。
    for (const id of this.fitted.keys()) {
      if (!want.has(id) && id !== this.active?.id) this.fitted.delete(id)
    }
    for (const [id, p] of this.previews) {
      if (!want.has(id)) {
        this.previewSizer.unobserve(p.content)
        p.node.remove()
        this.previews.delete(id)
      }
    }
    for (const id of want) {
      const el = engine.scene.get(id)!
      const rect = engine.scene.rect(id)
      if (!rect) continue
      let p = this.previews.get(id)
      if (p && !content) {
        const resized = p.width !== rect.w
        place(p.node, rect)
        p.width = rect.w
        clipOverlay(p.node, engine.scene, id, rect, 0, viewport)
        if (resized) this.fit(id)
        continue
      }
      if (!p) {
        const node = document.createElement('div')
        node.className = 'plein-md plein-md-preview'
        node.addEventListener(
          'wheel',
          (event) => {
            if (event.defaultPrevented) return
            const scroll = (event.target as Element).closest<HTMLElement>('[data-plein-scroll]')
            if (
              scroll &&
              !event.ctrlKey &&
              !event.metaKey &&
              (event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) &&
              scroll.scrollWidth > scroll.clientWidth
            ) {
              if (event.shiftKey && Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
                const unit =
                  event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? scroll.clientWidth : 1
                scroll.scrollLeft += event.deltaY * unit
                event.preventDefault()
              }
              event.stopPropagation()
              return
            }
            // DOM 预览与画布宿主是兄弟层，未消费的滚轮需要转交给画布输入。
            const canvasEvent = new WheelEvent('wheel', event)
            this.host.dispatchEvent(canvasEvent)
            if (canvasEvent.defaultPrevented) event.preventDefault()
            event.stopPropagation()
          },
          { passive: false },
        )
        node.addEventListener('keydown', (event) => {
          if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return
          const scroll = (event.target as Element).closest<HTMLElement>('[data-plein-scroll]')
          if (!scroll) return
          const selection = window.getSelection()
          if (
            (event.metaKey || event.ctrlKey) &&
            !event.altKey &&
            !event.shiftKey &&
            event.key.toLowerCase() === 'a'
          ) {
            selection?.selectAllChildren(scroll)
            event.preventDefault()
          } else if (
            event.key === 'Escape' &&
            selection &&
            !selection.isCollapsed &&
            scroll.contains(selection.anchorNode) &&
            scroll.contains(selection.focusNode)
          ) {
            selection.collapseToEnd()
            event.preventDefault()
          }
        })
        const content = document.createElement('div')
        content.className = 'plein-md-content'
        content.dataset.markdownId = id
        node.appendChild(content)
        this.root.appendChild(node)
        p = { node, content, text: undefined, width: rect.w }
        this.previews.set(id, p)
        this.previewSizer.observe(content)
      }
      place(p.node, rect)
      p.width = rect.w
      if (p.text !== el.text) {
        p.text = el.text
        p.content.innerHTML = renderMarkdown(el.text ?? '')
      }
      clipOverlay(p.node, engine.scene, id, rect, 0, viewport)
      this.fit(id)
    }
    if (this.active) {
      this.follow()
      if (!this.active) return
      this.fit(this.active.id)
      const rect = engine.scene.rect(this.active.id)
      if (rect) {
        place(this.active.node, rect)
        this.active.layout?.(rect, viewport)
        clipOverlay(this.active.node, engine.scene, this.active.id, rect, 0, viewport)
      } else this.deactivate()
    }
  }

  /** Markdown 高度跟随正文：宽度不变，按渲染后的实际高度写回文档 */
  private fit(id: string) {
    const el = this.engine.scene.get(id)
    if (el?.kind !== 'markdown') return
    const text = el.text ?? ''
    const key = `${el.w}\n${text}`
    if (this.fitted.get(id) === key) return
    this.fitted.set(id, key)
    const preview = this.previews.get(id)
    if (preview) {
      const style = getComputedStyle(preview.node)
      const height =
        preview.content.offsetHeight +
        parseFloat(style.paddingTop) +
        parseFloat(style.paddingBottom)
      this.engine.fitContent(id, el.w, Math.max(MD_MIN_H, Math.ceil(height)))
      return
    }
    const m = this.measurer
    m.style.width = `${el.w}px`
    m.innerHTML = renderMarkdown(text)
    this.engine.fitContent(id, el.w, Math.max(MD_MIN_H, Math.ceil(m.offsetHeight)))
  }

  /** 节点切到别的结果版本时，播放器跟着换成那一版；新版本不是音视频就退出 */
  private follow() {
    const a = this.active
    const el = a?.assetId ? this.engine.scene.get(a.id) : undefined
    if (!a || el?.kind !== 'node') return
    const v = currentResult(el)?.value
    if (v?.type !== 'video' && v?.type !== 'audio') return this.deactivate()
    if (v.assetId === a.assetId) return
    a.dispose()
    a.node.remove()
    this.active = null
    this.activate(a.id)
  }

  activate(id: string) {
    if (useCanvas.getState().sequence) return
    if (this.active?.id === id) return
    this.deactivate()
    const el = this.engine.scene.get(id)
    if (!el || el.locked) return
    // 音视频素材、当前结果是音视频的节点：双击就地播放
    const m = elementMedia(el)
    if (el.kind === 'markdown') this.active = this.openEditor(id)
    else if (m && m.kind !== 'image') this.active = this.openPlayer(id, m.kind, m.assetId)
    if (this.active) {
      this.active.node.dataset.pleinActive = ''
      let composing = false
      this.active.node.addEventListener(
        'compositionstart',
        () => {
          composing = true
        },
        true,
      )
      this.active.node.addEventListener(
        'compositionend',
        () => {
          composing = false
        },
        true,
      )
      // Esc 退出；其余按键留给编辑器 / 播放器
      this.active.node.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          if (e.isComposing || e.keyCode === 229 || composing) {
            e.stopPropagation()
            return
          }
          if (e.defaultPrevented) return
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
    this.previewSizer.disconnect()
    for (const d of this.disposers) d()
    for (const p of this.previews.values()) p.node.remove()
    this.previews.clear()
    this.fitted.clear()
    this.measurer.remove()
  }

  private openEditor(id: string): Active | null {
    const doc = this.engine.doc
    const element = doc.elementMaps.get(id)
    const ytext = doc.getText(id)
    const valid = () =>
      !doc.readOnly &&
      !doc.ydoc.isDestroyed &&
      doc.elementMaps.get(id) === element &&
      element?.get('kind') === 'markdown' &&
      !element.get('locked') &&
      doc.getText(id) === ytext
    if (!ytext || !valid()) return null
    const node = document.createElement('div')
    node.className = 'plein-md-editor'
    const undoManager = new Y.UndoManager(ytext)
    let scrollFrame = 0
    const view = new EditorView({
      parent: node,
      doc: ytext.toString(),
      extensions: [
        EditorState.transactionFilter.of((transaction) =>
          !transaction.docChanged || transaction.annotation(ySyncAnnotation) || valid()
            ? transaction
            : [],
        ),
        yCollab(ytext, this.opts.awareness ?? null, { undoManager }),
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
    view.dom.style.position = 'absolute'
    let layoutKey = ''
    return {
      id,
      node,
      valid,
      focus: () => view.focus(),
      layout: (rect, viewport) => {
        const { zoom, insets } = this.engine.camera
        const area = editorViewport(rect, viewport, insets, zoom)
        const key = JSON.stringify(area)
        if (key === layoutKey) return
        layoutKey = key
        view.dom.style.visibility = area ? '' : 'hidden'
        if (area)
          Object.assign(view.dom.style, {
            left: `${area.x}px`,
            top: `${area.y}px`,
            width: `${area.w}px`,
            height: `${area.h}px`,
          })
        view.requestMeasure()
      },
      dispose() {
        cancelAnimationFrame(scrollFrame)
        view.destroy()
        undoManager.destroy()
      },
    }
  }

  private openPlayer(id: string, kind: 'video' | 'audio', assetId: string): Active {
    const player = createPlayer(
      kind,
      this.opts.originalUrl(assetId),
      kind === 'video' ? { poster: assetUrls.variant(assetId, 'poster') } : {},
    )
    // 续镜「从当前画面」靠它找到正在播的那一个
    player.node.dataset.playerEl = id
    return { id, assetId, ...player }
  }
}
