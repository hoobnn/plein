import {
  AUDIO_SIZE,
  arrangeElements,
  bringToFront,
  type ClipboardData,
  deleteElements,
  exportElements,
  fitElementSize,
  groupElements,
  importElements,
  isClipboardData,
  type ImportOptions,
  moveElements,
  type PleinDoc,
  type Rect,
  sendToBack,
  ungroupElements,
} from '@plein/doc'
import { Application, Container } from 'pixi.js'
import { Camera } from './camera'
import { EdgeLayer } from './edges'
import { union } from './geometry'
import { DotGrid } from './grid'
import {
  attachInput,
  isControlTarget,
  isEditableTarget,
  isOverlayTarget,
  type PanState,
} from './input'
import { attachInteractions } from './interact'
import type { PortRef } from './ports'
import { HighlightLayer } from './highlight'
import { SelectionOverlay } from './overlay'
import { type RenderContext, RendererRegistry } from './renderers'
import { Scene, type Transient } from './scene'
import { Selection } from './selection'
import { type CanvasTheme, theme } from './theme'
import { ElementViews } from './views'
import { previewTextures } from './textures'

export type Tool = 'select' | 'hand'

export interface EngineOptions extends Omit<RenderContext, 'initialDetail' | 'textures'> {
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
  clipboard?: {
    copy(doc: PleinDoc, ids: Iterable<string>): ClipboardData
    paste(doc: PleinDoc, data: ClipboardData, opts: ImportOptions): string[]
  }
}

/** 引擎对外的运行时状态快照，供 UI 外壳展示 */
export interface EngineState {
  tool: Tool
  zoom: number
  selection: number
  canUndo: boolean
  canRedo: boolean
  edgesHidden: boolean
}

/** onViewChange 的通知内容 */
export interface ViewChange {
  /** 元素内容或几何变了（否则只是视口内的元素集合或细节层级变了） */
  content: boolean
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

/** 一次整理的结果：外壳据此弹“保留 / 还原” */
export interface ArrangeResult {
  /** 整理整个画布，或只整理选中的元素 */
  scope: 'canvas' | 'selection'
  /** 移动或收放的元素数 */
  count: number
  /** 整理仍是撤销栈顶时撤销它并返回 true；之后又有别的修改时不动，返回 false */
  revert(): boolean
  /** 整理已不在撤销栈顶（被撤销或有了新的修改） */
  stale(): boolean
}

/** 连续缩放时线宽允许的偏差，超过才重画连线和选择层 */
const STROKE_ZOOM_SLACK = 0.1
/** 镜头过渡（flyTo）时长 */
const FLIGHT_MS = 560

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
  private grid = new DotGrid()
  private views: ElementViews
  private textureOwner = previewTextures.createOwner()
  private edges: EdgeLayer
  private overlay: SelectionOverlay
  private highlight: HighlightLayer
  /** 进行中的镜头过渡（flyTo） */
  private flight: {
    from: { x: number; y: number; zoom: number }
    to: { x: number; y: number; zoom: number }
    start: number
  } | null = null
  /** 动画自身更新相机时不取消自己；其他来源的导航立即接管。 */
  private advancingFlight = false
  private pan: PanState = { space: false, hand: false }
  private toolValue: Tool = 'select'
  private viewDirty = true
  /** 画面有变化、下一帧要渲染；静止时不重画，省 GPU 和电量 */
  private renderDirty = true
  private previewRevision = 0
  private renderedPreviewRevision = 0
  /** 相机变了、还没应用到显示树：同一帧里的多次滚轮 / 拖动只处理一次 */
  private cameraDirty = true
  /** 上次应用时的缩放：只平移时状态不用通知 */
  private appliedZoom = Number.NaN
  /** 连线和选择层按这个缩放画的线宽；缩放过程中差得不多就先不重画，停下再画准 */
  private strokeZoom = Number.NaN
  private listeners = new Set<() => void>()
  private viewListeners = new Set<(change: ViewChange) => void>()
  private moveListeners = new Set<() => void>()
  /** 宿主在视口里的位置，尺寸变化时更新；坐标换算每帧都要用，不能每次读布局 */
  private hostRect: DOMRect | null = null
  private activateListeners = new Set<(id: string) => void>()
  private menuListeners = new Set<(e: CanvasMenuEvent) => void>()
  private arrangeListeners = new Set<(r: ArrangeResult) => void>()
  /** 元素内容或几何变化，需要通知覆盖层 */
  private contentDirty = false
  private disposers: Array<() => void> = []
  private pasteCount = 0
  private lastClipboard: string | null = null

  constructor(private opts: EngineOptions) {
    this.scene = new Scene(opts.doc)
    this.views = new ElementViews(this.scene, opts.renderers ?? new RendererRegistry(), {
      assetUrl: opts.assetUrl,
      textures: this.textureOwner,
      onContentSize: (id, w, h) => this.fitMedia(id, w, h),
      invalidate: () => {
        this.previewRevision++
        this.requestRender()
      },
    })
    this.edges = new EdgeLayer(this.scene, this.camera, this.selection)
    this.overlay = new SelectionOverlay(this.scene, this.selection, this.camera)
    this.highlight = new HighlightLayer(this.scene, this.camera)
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
    this.app.stage.addChild(this.grid.display, this.world)
    // 连线在元素下，端口、选择叠加层在元素上，靠 zIndex 排序
    this.world.addChild(
      this.edges.edges,
      this.edges.flow,
      this.views.layer,
      this.edges.ports,
      this.highlight.graphics,
      this.overlay.graphics,
    )
    this.views.sync(this.scene.rebuild())
    // 不用 Pixi 默认的每帧渲染，改为在 frame() 里按需渲染
    this.app.ticker.remove(this.app.render, this.app)
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
      this.camera.onChange(() => {
        if (!this.advancingFlight) this.flight = null
        this.cameraDirty = true
      }),
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

    const onResize = () => {
      this.camera.setViewport(this.app.screen.width, this.app.screen.height)
      this.requestRender()
    }
    this.app.renderer.on('resize', onResize)
    this.disposers.push(() => this.app.renderer.off('resize', onResize))
    // resizeTo 只听窗口 resize；宿主随侧栏展开收起变宽变窄时也要跟上
    const observer = new ResizeObserver(() => {
      this.hostRect = null
      this.app.resize()
    })
    const onWindowResize = () => {
      this.hostRect = null
    }
    window.addEventListener('resize', onWindowResize)
    window.addEventListener('scroll', onWindowResize, { capture: true, passive: true })
    this.disposers.push(() => {
      window.removeEventListener('resize', onWindowResize)
      window.removeEventListener('scroll', onWindowResize, { capture: true })
    })
    // 用户自己动镜头时中断过渡动画
    const stopFlight = () => {
      this.flight = null
    }
    host.addEventListener('wheel', stopFlight, { passive: true })
    host.addEventListener('pointerdown', stopFlight)
    this.disposers.push(() => {
      host.removeEventListener('wheel', stopFlight)
      host.removeEventListener('pointerdown', stopFlight)
    })
    observer.observe(host)
    this.disposers.push(() => observer.disconnect())
    onResize()
    this.syncCamera()
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
      edgesHidden: this.edgesHidden,
    }
  }

  /** 重画全部元素：加载失败的预览图（服务断开时）会重新加载 */
  reloadMedia() {
    this.views.refreshAll()
    this.requestRender()
  }

  /** 引擎之外改了会影响状态的东西（如文档转为只读）时，让外壳重新读取 */
  refreshState() {
    this.emit()
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
   * content 为 false 表示只有元素进出视口：已显示的元素不用重画。
   */
  onViewChange(fn: (change: ViewChange) => void) {
    this.viewListeners.add(fn)
    return () => {
      this.viewListeners.delete(fn)
    }
  }

  /**
   * 相机或元素几何（含拖动预览）变化后、本帧绘制前通知，每帧至少一次、最多一次。
   * 浮在元素旁的 DOM 面板用它直接改位置，不必走 React 重渲染。
   */
  onMove(fn: () => void) {
    this.moveListeners.add(fn)
    return () => {
      this.moveListeners.delete(fn)
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

  /** 整理画布完成时通知（工具栏按钮和 ⌥⇧F 都走这里） */
  onArrange(fn: (r: ArrangeResult) => void) {
    this.arrangeListeners.add(fn)
    return () => {
      this.arrangeListeners.delete(fn)
    }
  }

  /** 素材元素按内容自适应尺寸（Markdown 由覆盖层量出正文高度后调用） */
  fitContent(id: string, w: number, h: number) {
    fitElementSize(this.doc, id, Math.round(w), Math.round(h))
  }

  /** 图片、视频按预览的真实比例校正，保留当前长边；音频固定尺寸 */
  private fitMedia(id: string, pw: number, ph: number) {
    const el = this.doc.get(id)
    if (!el) return
    if (el.kind === 'audio') return this.fitContent(id, AUDIO_SIZE.w, AUDIO_SIZE.h)
    if ((el.kind !== 'image' && el.kind !== 'video') || pw <= 0 || ph <= 0) return
    const long = Math.max(el.w, el.h)
    const k = long / Math.max(pw, ph)
    this.fitContent(id, pw * k, ph * k)
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
    const r = this.host()
    const s = this.camera.worldToScreen(x, y)
    return { x: s.x + r.left, y: s.y + r.top }
  }

  /** 屏幕坐标（相对画布宿主）转世界坐标 */
  clientToWorld(clientX: number, clientY: number) {
    const r = this.host()
    return this.camera.screenToWorld(clientX - r.left, clientY - r.top)
  }

  get stats() {
    return {
      elements: this.scene.size,
      visible: this.views.visibleCount,
      fps: this.app.ticker?.FPS ?? 0,
      ...this.views.stats,
      textures: previewTextures.stats,
      previewRevision: this.previewRevision,
      renderedPreviewRevision: this.renderedPreviewRevision,
    }
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
    const data = (this.opts.clipboard?.copy ?? exportElements)(this.doc, this.selection.values())
    this.selection.set(
      (this.opts.clipboard?.paste ?? importElements)(this.doc, data, { dx: 24, dy: 24 }),
    )
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

  /** 解组选中的 Frame（⇧⌘G），选中原来的子元素 */
  ungroupSelection() {
    const frames = this.selection.values().filter((id) => this.scene.get(id)?.kind === 'frame')
    if (frames.length === 0) return
    const kids = frames.flatMap((id) => ungroupElements(this.doc, id))
    this.selection.set(kids)
  }

  /**
   * 整理画布（⌥⇧F）：按连线拓扑自动布局，作为单独的一个撤销步。
   * 不传 ids 时整理整个画布。没有可移动的元素时返回 null。
   */
  arrange(ids?: Iterable<string>): ArrangeResult | null {
    if (this.doc.readOnly) return null
    const count = arrangeElements(this.doc, ids)
    if (count === 0) return null
    // 通知界面适配视口前先让场景读到新位置，否则会按整理前的包围盒缩放。
    this.doc.flush()
    const undo = this.doc.undo
    const item = undo.undoStack.at(-1)
    const stale = () => undo.undoStack.at(-1) !== item
    const result: ArrangeResult = {
      scope: ids ? 'selection' : 'canvas',
      count,
      stale,
      revert: () => {
        if (stale()) return false
        undo.undo()
        return true
      },
    }
    for (const fn of this.arrangeListeners) fn(result)
    return result
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
    return (this.opts.clipboard?.copy ?? exportElements)(this.doc, this.selection.values())
  }

  paste(data: ClipboardData) {
    this.pasteCount++
    const d = PASTE_OFFSET * this.pasteCount
    this.selection.set(
      (this.opts.clipboard?.paste ?? importElements)(this.doc, data, { dx: d, dy: d }),
    )
  }

  /** 缩放到包住指定元素（默认全部） */
  zoomToFit(ids?: Iterable<string>) {
    this.doc.flush()
    const list = ids ? [...ids] : [...this.scene.children(null)]
    const box = union(list.map((id) => this.scene.rect(id)).filter((r) => !!r))
    if (box) this.camera.fit(box)
  }

  /** 切换配色：背景、点阵、全部元素、连线和选择层一起重画 */
  setTheme(next: CanvasTheme) {
    Object.assign(theme, next)
    if (this.app.renderer) this.app.renderer.background.color = next.background
    this.grid.setTheme()
    this.cameraDirty = true
    this.requestRender()
    this.views.refreshAll()
    this.edges.markDirty()
    this.overlay.markDirty()
    this.contentDirty = true
  }

  zoomTo(zoom: number) {
    this.camera.zoomTo(zoom)
  }

  private edgesHidden = false

  /** 隐藏连线（只留选中 / 悬停元素的线） */
  setEdgesHidden(hidden: boolean) {
    if (hidden === this.edgesHidden) return
    this.edgesHidden = hidden
    this.edges.setHidden(hidden)
    this.emit()
  }

  /** 全部顶层元素的外包矩形；空画布为 null（小地图用） */
  contentBounds(): Rect | null {
    return union([...this.scene.children(null)].map((id) => this.scene.rect(id)).filter((r) => !!r))
  }

  /** 在视口中央弹出节点选择器（Tab） */
  openCreateMenu() {
    const r = this.opts.host.getBoundingClientRect()
    const client = { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    this.emitMenu({ kind: 'create', world: this.clientToWorld(client.x, client.y), client })
  }

  // ── 内部 ────────────────────────────────────────────

  private emitMenu(e: CanvasMenuEvent) {
    for (const fn of this.menuListeners) fn(e)
  }

  private emit() {
    for (const fn of this.listeners) fn()
  }

  private host() {
    this.hostRect ??= this.opts.host.getBoundingClientRect()
    return this.hostRect
  }

  /**
   * 镜头平滑移动到包住这些元素（中心线性插值、缩放按对数插值，看起来是匀速推拉），
   * 到达后高亮它们。用户一滚轮或按下指针就中断。系统要求减少动态效果时直接跳过去。
   */
  flyTo(ids: Iterable<string>) {
    this.doc.flush()
    const list = [...ids]
    const box = union(list.map((id) => this.scene.rect(id)).filter((r) => !!r))
    if (!box) return
    const to = this.camera.fitTarget(box, 96)
    const reduce =
      typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduce) {
      this.camera.lookAt(to.x, to.y, to.zoom)
      this.flash(list)
      return
    }
    this.flight = {
      from: { ...this.camera.center, zoom: this.camera.zoom },
      to,
      start: performance.now(),
    }
    this.flightIds = list
  }

  private flightIds: string[] = []

  private stepFlight(now: number) {
    const f = this.flight
    if (!f) return
    const t = Math.min(1, (now - f.start) / FLIGHT_MS)
    const e = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2
    const zoom = Math.exp(Math.log(f.from.zoom) + (Math.log(f.to.zoom) - Math.log(f.from.zoom)) * e)
    this.advancingFlight = true
    try {
      this.camera.lookAt(
        f.from.x + (f.to.x - f.from.x) * e,
        f.from.y + (f.to.y - f.from.y) * e,
        zoom,
      )
    } finally {
      this.advancingFlight = false
    }
    if (t >= 1) {
      this.flight = null
      this.flash(this.flightIds)
    }
  }

  /** 高亮一组元素（智能体刚改过的），光晕扩散后淡出 */
  flash(ids: Iterable<string>) {
    this.highlight.flash(ids)
  }

  /** 请求下一帧渲染（显示树被引擎之外改动时用） */
  requestRender() {
    this.renderDirty = true
  }

  private redrawStrokes() {
    this.strokeZoom = this.camera.zoom
    this.edges.markDirty()
    this.overlay.markDirty()
  }

  private frame() {
    if (this.flight) this.stepFlight(performance.now())
    // 缩放停下来的那一帧：按最终缩放把线宽画准
    if (!this.cameraDirty && this.strokeZoom !== this.camera.zoom) this.redrawStrokes()
    const moved = this.cameraDirty || this.contentDirty
    // 宿主可能因页面布局变化移动而尺寸不变：每个有变化的帧重新量一次
    if (moved) this.hostRect = null
    if (moved || this.viewDirty) this.renderDirty = true
    if (this.cameraDirty) this.syncCamera()
    const content = this.contentDirty
    let notify = content
    this.contentDirty = false
    if (this.viewDirty) {
      this.viewDirty = false
      if (this.views.cull(this.camera.viewRect, this.camera.zoom)) notify = true
    }
    if (notify) for (const fn of this.viewListeners) fn({ content })
    if (moved) for (const fn of this.moveListeners) fn()
    if (this.edges.update()) this.renderDirty = true
    if (this.overlay.update()) this.renderDirty = true
    if (this.highlight.update()) this.renderDirty = true
    if (this.renderDirty) {
      this.renderDirty = false
      this.app.render()
      this.renderedPreviewRevision = this.previewRevision
    }
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

  /** 把相机应用到显示树和 DOM 覆盖层；每帧最多一次 */
  private syncCamera() {
    this.cameraDirty = false
    const { x, y, zoom } = this.camera
    this.world.position.set(x, y)
    this.world.scale.set(zoom)
    if (this.opts.overlay) this.opts.overlay.style.transform = this.camera.cssTransform
    this.grid.update(this.camera)
    if (zoom !== this.appliedZoom) {
      this.appliedZoom = zoom
      this.emit()
    }
    // 线宽按缩放反算：平移时世界坐标里的图形不变；连续缩放时线宽偏差超过一成才重画
    if (Math.abs(zoom / this.strokeZoom - 1) > STROKE_ZOOM_SLACK || Number.isNaN(this.strokeZoom))
      this.redrawStrokes()
    this.edges.cameraMoved()
    this.viewDirty = true
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
      if (e.defaultPrevented || e.isComposing) return
      if (isEditableTarget(e.target)) {
        // 输入框里的 Esc：退出输入框，焦点回到画布，再按一次才是取消选中。
        // 输入框自己处理过的（关掉候选、取消编辑）不再管；输入法组字时的 Esc 是撤销组字
        if (e.key === 'Escape' && !isOverlayTarget(e.target)) (e.target as HTMLElement).blur()
        return
      }
      const mod = e.metaKey || e.ctrlKey
      if (!mod && e.key !== 'Escape' && isControlTarget(e.target)) return
      const key = e.key.toLowerCase()
      const step = e.shiftKey ? 10 : 1
      let handled = true
      if (mod && key === 'z') {
        if (e.shiftKey) this.redo()
        else this.undo()
      } else if (mod && key === 'y') this.redo()
      else if (mod && key === 'a') this.selectAll()
      else if (mod && key === 'd') this.duplicateSelection()
      else if (mod && key === 'g' && !e.shiftKey) this.groupSelection()
      else if (mod && key === 'g') this.ungroupSelection()
      // ⌥ 会改变 e.key（Mac 上 ⌥⇧F 是 Ï），按物理键判断
      else if (e.altKey && e.shiftKey && e.code === 'KeyF') this.arrange()
      else if (mod && e.key === ']') this.bringToFront()
      else if (mod && e.key === '[') this.sendToBack()
      else if (mod && key === '0') this.zoomTo(1)
      else if (mod && (e.key === '=' || e.key === '+')) this.zoomTo(this.camera.zoom * 1.25)
      else if (mod && (e.key === '-' || e.key === '_')) this.zoomTo(this.camera.zoom / 1.25)
      else if (e.shiftKey && e.code === 'Digit1') this.zoomToFit()
      else if (e.shiftKey && e.code === 'Digit2') this.zoomToFit(this.selection.values())
      else if (mod) handled = false
      else if (key === 'delete' || key === 'backspace') this.deleteSelection()
      else if (key === 'escape') this.selection.clear()
      else if (key === 'tab' && !e.shiftKey) this.openCreateMenu()
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
    this.textureOwner.dispose()
    this.edges.destroy()
    this.overlay.destroy()
    this.grid.destroy()
    this.app.destroy(true, { children: true })
  }
}
