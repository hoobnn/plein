import {
  bringToFront,
  type ClipboardData,
  deleteElements,
  duplicateElements,
  exportElements,
  groupElements,
  importElements,
  isClipboardData,
  moveElements,
  type PleinDoc,
  sendToBack,
} from '@plein/doc'
import { Application, Container, Graphics } from 'pixi.js'
import { Camera } from './camera'
import { EdgeLayer } from './edges'
import { union } from './geometry'
import { attachInput, isEditableTarget, type PanState } from './input'
import { attachInteractions } from './interact'
import type { PortRef } from './ports'
import { SelectionOverlay } from './overlay'
import { type RenderContext, RendererRegistry } from './renderers'
import { Scene, type Transient } from './scene'
import { Selection } from './selection'
import { type CanvasTheme, theme } from './theme'
import { ElementViews } from './views'

export type Tool = 'select' | 'hand'

export interface EngineOptions extends RenderContext {
  host: HTMLElement
  doc: PleinDoc
  /** DOM 覆盖层，跟随相机变换 */
  overlay?: HTMLElement
  background?: number
  /** 初始配色，默认暗色；之后用 setTheme 切换 */
  theme?: CanvasTheme
  /** 默认 WebGL；WebGPU 待基准与兼容性验证后再切默认 */
  renderer?: 'webgl' | 'webgpu'
  renderers?: RendererRegistry
}

/** 引擎对外的运行时状态快照，供 UI 外壳展示 */
export interface EngineState {
  tool: Tool
  zoom: number
  selection: number
  canUndo: boolean
  canRedo: boolean
}

/** 画布上的一个位置：世界坐标 + 视口坐标（clientX / clientY，弹菜单用） */
export interface CanvasPoint {
  world: { x: number; y: number }
  client: { x: number; y: number }
}

/** 需要外壳弹出菜单的画布事件 */
export type CanvasMenuEvent =
  /** 双击空白处：新建节点 */
  | ({ kind: 'create' } & CanvasPoint)
  /** 从端口拉线到空白处：新建节点并连上 */
  | ({ kind: 'connect'; from: PortRef } & CanvasPoint)
  /** 右键：target 为空表示空白处 */
  | ({ kind: 'context'; target: string | null } & CanvasPoint)

/** 粘贴时相对上一次的位移 */
const PASTE_OFFSET = 24

/**
 * 画布引擎：GPU 渲染 + DOM 覆盖层。
 * 场景（Scene）从文档维护世界坐标与空间索引；显示树只为视口内元素创建内容。
 * 对外只暴露工具、选中、相机与命令，不暴露 Pixi 对象。
 */
export class Engine {
  readonly camera = new Camera()
  readonly selection = new Selection()
  readonly scene: Scene
  private app = new Application()
  private world = new Container({ sortableChildren: true })
  private grid = new Graphics()
  private views: ElementViews
  private edges: EdgeLayer
  private overlay: SelectionOverlay
  private pan: PanState = { space: false, hand: false }
  private toolValue: Tool = 'select'
  private viewDirty = true
  private listeners = new Set<() => void>()
  private viewListeners = new Set<() => void>()
  private activateListeners = new Set<(id: string) => void>()
  private menuListeners = new Set<(e: CanvasMenuEvent) => void>()
  /** 元素内容或几何变化，需要通知覆盖层 */
  private contentDirty = false
  private disposers: Array<() => void> = []
  private pasteCount = 0
  private lastClipboard: string | null = null

  constructor(private opts: EngineOptions) {
    this.scene = new Scene(opts.doc)
    this.views = new ElementViews(this.scene, opts.renderers ?? new RendererRegistry(), {
      assetUrl: opts.assetUrl,
    })
    this.edges = new EdgeLayer(this.scene, this.camera, this.selection)
    this.overlay = new SelectionOverlay(this.scene, this.selection, this.camera)
  }

  get doc() {
    return this.opts.doc
  }

  async init() {
    if (this.opts.theme) Object.assign(theme, this.opts.theme)
    const { host, background = theme.background } = this.opts
    await this.app.init({
      resizeTo: host,
      background,
      antialias: true,
      autoDensity: true,
      resolution: window.devicePixelRatio,
      preference: this.opts.renderer ?? 'webgl',
    })
    host.appendChild(this.app.canvas)
    this.app.stage.addChild(this.grid, this.world)
    // 连线在元素下，端口、选择叠加层在元素上，靠 zIndex 排序
    this.world.addChild(this.edges.edges, this.views.layer, this.edges.ports, this.overlay.graphics)
    this.views.sync(this.scene.rebuild())
    this.app.ticker.add(() => this.frame())

    this.disposers.push(
      attachInput(host, this.camera, this.pan),
      attachInteractions({
        el: host,
        camera: this.camera,
        scene: this.scene,
        doc: this.doc,
        selection: this.selection,
        edges: this.edges,
        overlay: this.overlay,
        pan: this.pan,
        preview: (patches) => this.preview(patches),
        commit: (write) => this.commit(write),
        connectToEmpty: (from, world, client) =>
          this.emitMenu({ kind: 'connect', from, world, client }),
      }),
      this.camera.onChange(() => this.syncCamera()),
      this.selection.onChange(() => {
        this.overlay.markDirty()
        this.edges.markDirty()
        this.emit()
      }),
      this.doc.subscribe((change) => {
        const update = this.scene.apply(change)
        this.views.sync(update)
        this.selection.prune((id) => this.scene.has(id))
        this.edges.markDirty()
        this.overlay.markDirty()
        this.viewDirty = true
        this.contentDirty = true
        this.emit()
      }),
      this.attachShortcuts(),
      this.attachActivate(),
      this.attachContextMenu(),
    )

    const onResize = () => this.camera.setViewport(this.app.screen.width, this.app.screen.height)
    this.app.renderer.on('resize', onResize)
    this.disposers.push(() => this.app.renderer.off('resize', onResize))
    onResize()
  }

  // ── 状态 ────────────────────────────────────────────

  get tool() {
    return this.toolValue
  }

  setTool(tool: Tool) {
    if (tool === this.toolValue) return
    this.toolValue = tool
    this.pan.hand = tool === 'hand'
    this.opts.host.style.cursor = tool === 'hand' ? 'grab' : ''
    this.emit()
  }

  get state(): EngineState {
    return {
      tool: this.toolValue,
      zoom: this.camera.zoom,
      selection: this.selection.size,
      canUndo: this.doc.undo.canUndo(),
      canRedo: this.doc.undo.canRedo(),
    }
  }

  /** 工具、缩放、选中、撤销栈任一变化时通知 */
  onStateChange(fn: () => void) {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  /**
   * 视口内元素集合、细节层级或元素内容变化时通知（不随平移每帧触发），
   * 供 DOM 覆盖层（Markdown 正文、播放器、编辑器）增量更新。
   */
  onViewChange(fn: () => void) {
    this.viewListeners.add(fn)
    return () => {
      this.viewListeners.delete(fn)
    }
  }

  /** 双击元素时通知：打开编辑器、播放器等 */
  onActivate(fn: (id: string) => void) {
    this.activateListeners.add(fn)
    return () => {
      this.activateListeners.delete(fn)
    }
  }

  /** 双击空白、拉线到空白、右键时通知外壳弹菜单 */
  onMenu(fn: (e: CanvasMenuEvent) => void) {
    this.menuListeners.add(fn)
    return () => {
      this.menuListeners.delete(fn)
    }
  }

  get visibleIds(): ReadonlySet<string> {
    return this.views.visibleIds
  }

  /** 是否处于正常细节（缩得很小时为 false，覆盖层应隐藏） */
  get highDetail() {
    return this.views.isHighDetail
  }

  /** 世界坐标转视口坐标（clientX / clientY） */
  worldToClient(x: number, y: number) {
    const r = this.opts.host.getBoundingClientRect()
    const s = this.camera.worldToScreen(x, y)
    return { x: s.x + r.left, y: s.y + r.top }
  }

  /** 屏幕坐标（相对画布宿主）转世界坐标 */
  clientToWorld(clientX: number, clientY: number) {
    const r = this.opts.host.getBoundingClientRect()
    return this.camera.screenToWorld(clientX - r.left, clientY - r.top)
  }

  get stats() {
    return { elements: this.scene.size, visible: this.views.visibleCount, fps: this.app.ticker.FPS }
  }

  // ── 命令 ────────────────────────────────────────────

  undo() {
    this.doc.undo.undo()
  }

  redo() {
    this.doc.undo.redo()
  }

  selectAll() {
    this.selection.set(
      this.scene.children(null).filter((id) => this.scene.get(id)?.locked === false),
    )
  }

  deleteSelection() {
    if (this.selection.size === 0) return
    deleteElements(this.doc, this.selection.values())
  }

  duplicateSelection() {
    if (this.selection.size === 0) return
    this.selection.set(duplicateElements(this.doc, this.selection.values()))
  }

  nudge(dx: number, dy: number) {
    if (this.selection.size === 0) return
    moveElements(this.doc, this.selection.values(), dx, dy)
  }

  /** 用 Frame 包住选中元素（⌘G） */
  groupSelection() {
    if (this.selection.size === 0) return
    const frame = groupElements(this.doc, this.selection.values())
    if (frame) this.selection.set([frame])
  }

  bringToFront() {
    bringToFront(this.doc, this.selection.values())
  }

  sendToBack() {
    sendToBack(this.doc, this.selection.values())
  }

  copy(): ClipboardData | null {
    if (this.selection.size === 0) return null
    this.pasteCount = 0
    return exportElements(this.doc, this.selection.values())
  }

  paste(data: ClipboardData) {
    this.pasteCount++
    const d = PASTE_OFFSET * this.pasteCount
    this.selection.set(importElements(this.doc, data, { dx: d, dy: d }))
  }

  /** 缩放到包住指定元素（默认全部） */
  zoomToFit(ids?: Iterable<string>) {
    const list = ids ? [...ids] : [...this.scene.children(null)]
    const box = union(list.map((id) => this.scene.rect(id)).filter((r) => !!r))
    if (box) this.camera.fit(box)
  }

  /** 切换配色：背景、点阵、全部元素、连线和选择层一起重画 */
  setTheme(next: CanvasTheme) {
    Object.assign(theme, next)
    if (this.app.renderer) this.app.renderer.background.color = next.background
    this.drawGrid()
    this.views.refreshAll()
    this.edges.markDirty()
    this.overlay.markDirty()
    this.contentDirty = true
  }

  zoomTo(zoom: number) {
    this.camera.zoomTo(zoom)
  }

  // ── 内部 ────────────────────────────────────────────

  private emitMenu(e: CanvasMenuEvent) {
    for (const fn of this.menuListeners) fn(e)
  }

  private emit() {
    for (const fn of this.listeners) fn()
  }

  private frame() {
    let notify = this.contentDirty
    this.contentDirty = false
    if (this.viewDirty) {
      this.viewDirty = false
      if (this.views.cull(this.camera.viewRect, this.camera.zoom)) notify = true
    }
    if (notify) for (const fn of this.viewListeners) fn()
    this.edges.update()
    this.overlay.update()
  }

  private preview(patches: Map<string, Transient>) {
    const touched = this.scene.setTransient(patches)
    this.afterTransient(touched)
  }

  private commit(write: () => void) {
    write()
    // 立即同步，保证清掉预览时场景已是新位置
    this.doc.flush()
    this.afterTransient(this.scene.clearTransient())
  }

  private afterTransient(touched: Set<string>) {
    this.views.refresh(touched)
    if (touched.size > 0) this.contentDirty = true
    this.edges.markDirty()
    this.overlay.markDirty()
    this.viewDirty = true
  }

  private syncCamera() {
    const { x, y, zoom } = this.camera
    this.world.position.set(x, y)
    this.world.scale.set(zoom)
    if (this.opts.overlay) this.opts.overlay.style.transform = this.camera.cssTransform
    this.drawGrid()
    this.edges.markDirty()
    this.overlay.markDirty()
    this.viewDirty = true
    this.emit()
  }

  /** 屏幕空间点阵：间距随缩放分级，避免过密 */
  private drawGrid() {
    const { width, height } = this.camera
    const { x, y, zoom } = this.camera
    let step = 24 * zoom
    while (step < 12) step *= 4
    while (step > 96) step /= 4
    const ox = ((x % step) + step) % step
    const oy = ((y % step) + step) % step
    const g = this.grid.clear()
    for (let gx = ox; gx < width; gx += step) {
      for (let gy = oy; gy < height; gy += step) {
        g.circle(gx, gy, 0.9)
      }
    }
    g.fill({ color: theme.grid.color, alpha: theme.grid.alpha })
  }

  private attachActivate() {
    const host = this.opts.host
    const onDblClick = (e: MouseEvent) => {
      if (this.toolValue !== 'select') return
      const p = this.clientToWorld(e.clientX, e.clientY)
      const id = this.scene.hitTest(p.x, p.y)
      const client = { x: e.clientX, y: e.clientY }
      // 双击 Frame 的空白处也算画布空白：在组里新建节点
      if (!id || this.scene.get(id)?.kind === 'frame') {
        this.emitMenu({ kind: 'create', world: p, client })
        return
      }
      this.selection.set([id])
      for (const fn of this.activateListeners) fn(id)
    }
    host.addEventListener('dblclick', onDblClick)
    return () => host.removeEventListener('dblclick', onDblClick)
  }

  private attachContextMenu() {
    const host = this.opts.host
    const onContextMenu = (e: MouseEvent) => {
      e.preventDefault()
      const world = this.clientToWorld(e.clientX, e.clientY)
      const target = this.scene.hitTest(world.x, world.y)
      if (target && !this.selection.has(target)) this.selection.set([target])
      if (!target) this.selection.clear()
      this.emitMenu({ kind: 'context', target, world, client: { x: e.clientX, y: e.clientY } })
    }
    host.addEventListener('contextmenu', onContextMenu)
    return () => host.removeEventListener('contextmenu', onContextMenu)
  }

  private attachShortcuts() {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isEditableTarget(e.target)) return
      const mod = e.metaKey || e.ctrlKey
      const key = e.key.toLowerCase()
      const step = e.shiftKey ? 10 : 1
      let handled = true
      if (mod && key === 'z') e.shiftKey ? this.redo() : this.undo()
      else if (mod && key === 'y') this.redo()
      else if (mod && key === 'a') this.selectAll()
      else if (mod && key === 'd') this.duplicateSelection()
      else if (mod && key === 'g' && !e.shiftKey) this.groupSelection()
      else if (mod && e.key === ']') this.bringToFront()
      else if (mod && e.key === '[') this.sendToBack()
      else if (mod && key === '0') this.zoomTo(1)
      else if (e.shiftKey && e.code === 'Digit1') this.zoomToFit()
      else if (e.shiftKey && e.code === 'Digit2') this.zoomToFit(this.selection.values())
      else if (mod) handled = false
      else if (key === 'delete' || key === 'backspace') this.deleteSelection()
      else if (key === 'escape') this.selection.clear()
      else if (key === 'v') this.setTool('select')
      else if (key === 'h') this.setTool('hand')
      else if (key === 'arrowleft') this.nudge(-step, 0)
      else if (key === 'arrowright') this.nudge(step, 0)
      else if (key === 'arrowup') this.nudge(0, -step)
      else if (key === 'arrowdown') this.nudge(0, step)
      else handled = false
      if (handled) e.preventDefault()
    }

    // 复制粘贴走原生事件，才能同步读写系统剪贴板
    const onCopy = (e: ClipboardEvent, cut: boolean) => {
      if (isEditableTarget(e.target)) return
      const data = this.copy()
      if (!data || !e.clipboardData) return
      const text = JSON.stringify(data)
      this.lastClipboard = text
      e.clipboardData.setData('text/plain', text)
      e.preventDefault()
      if (cut) this.deleteSelection()
    }
    const onPaste = (e: ClipboardEvent) => {
      if (isEditableTarget(e.target)) return
      const text = e.clipboardData?.getData('text/plain')
      if (!text) return
      let data: unknown
      try {
        data = JSON.parse(text)
      } catch {
        return
      }
      if (!isClipboardData(data)) return
      // 外部新复制的内容从原位附近开始偏移
      if (text !== this.lastClipboard) {
        this.lastClipboard = text
        this.pasteCount = 0
      }
      e.preventDefault()
      this.paste(data)
    }
    const copy = (e: ClipboardEvent) => onCopy(e, false)
    const cut = (e: ClipboardEvent) => onCopy(e, true)

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('copy', copy)
    window.addEventListener('cut', cut)
    window.addEventListener('paste', onPaste)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('copy', copy)
      window.removeEventListener('cut', cut)
      window.removeEventListener('paste', onPaste)
    }
  }

  destroy() {
    this.disposers.forEach((d) => {
      d()
    })
    this.views.destroy()
    this.edges.destroy()
    this.overlay.destroy()
    this.app.destroy(true, { children: true })
  }
}
