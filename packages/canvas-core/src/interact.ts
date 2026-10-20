import {
  type CanvasElement,
  connect,
  elementPorts,
  type PleinDoc,
  type Rect,
  removeEdges,
  setParent,
  topLevel,
  updateElements,
  videoAssetOf,
} from '@plein/doc'
import type { Camera } from './camera'
import type { EdgeLayer } from './edges'
import {
  contains,
  expand,
  fromPoints,
  HANDLE_CURSORS,
  type Handle,
  handlePosition,
  intersects,
  mapRect,
  resizeBox,
  snapMove,
  union,
} from './geometry'
import type { PanState } from './input'
import { HANDLE_PX, type SelectionOverlay } from './overlay'
import {
  canConnect,
  eachPort,
  hitPort,
  PORT_RADIUS,
  type PortRef,
  portUncovered,
  sidePorts,
} from './ports'
import type { Scene, Transient } from './scene'
import type { Selection } from './selection'

/** 端口命中范围：屏幕上至少 10px，便于缩小后也能点中 */
const HIT_PX = 10
/** 按下后移动超过这个距离（屏幕像素）才算拖拽，避免点击误写文档 */
const DRAG_PX = 3
/** 吸附阈值（屏幕像素） */
const SNAP_PX = 6

export interface InteractHost {
  el: HTMLElement
  camera: Camera
  scene: Scene
  doc: PleinDoc
  selection: Selection
  edges: EdgeLayer
  overlay: SelectionOverlay
  pan: PanState
  /** 设置交互预览（局部坐标），不写文档 */
  preview(patches: Map<string, Transient>): void
  /** 写入文档并立即同步到场景，再清掉预览，避免闪回 */
  commit(write: () => void): void
  /** 从端口新拉出的线松手在空白处：外壳弹出节点菜单，新建节点并连上 */
  connectToEmpty?(
    from: PortRef,
    world: { x: number; y: number },
    client: { x: number; y: number },
  ): void
  /** 对象变化导致在途手势失效，由外壳提供简短反馈。 */
  onInterrupted?(): void
}

type Gesture =
  /** picked：从输入端口拾起的已有连线，丢到空白处即删除 */
  | { kind: 'connect'; from: PortRef; picked: string | null }
  | { kind: 'press'; id: string; sx: number; sy: number; wx: number; wy: number; toggled: boolean }
  | { kind: 'move'; ids: string[]; starts: Map<string, Rect>; box: Rect; wx: number; wy: number }
  | {
      kind: 'resize'
      handle: Handle
      ids: string[]
      starts: Map<string, Rect>
      /** 选中里有视频（元素或结果是视频的节点）：始终等比，形状跟视频一致 */
      lock: boolean
      /** 被缩放的 Frame 的直接子元素起始局部坐标：Frame 左上角移动时反向补偿，保持世界位置 */
      kids: Map<string, { parent: string; x: number; y: number }>
      box: Rect
      wx: number
      wy: number
    }
  | { kind: 'marquee'; wx: number; wy: number; base: string[]; restore: string[] }

/**
 * 选择工具的左键交互（空格/抓手/中键留给相机平移）：
 * - 拖缩放手柄 = 缩放选中元素（Shift 等比）
 * - 从端口拖出 = 连线；从已连接的输入端口拖出 = 拾起这条边，丢到空白处即删除
 * - 点元素 = 选中（Shift 增减）；拖元素 = 移动全部选中项，带吸附（Alt 关闭），松手落进 Frame 即归组
 * - 在空白处拖 = 框选
 */
export function attachInteractions(host: InteractHost) {
  const { el, camera, scene, doc, selection, edges, overlay, pan } = host
  let gesture: Gesture | null = null
  let pointer: number | null = null
  let selecting = false
  const bases = new Map<string, CanvasElement>()
  let edgeBase: ReturnType<PleinDoc['getEdge']>
  const geometryKeys = ['x', 'y', 'w', 'h', 'parentId', 'locked'] as const

  const valid = () => {
    for (const [id, base] of bases) {
      const now = doc.get(id)
      if (!now || geometryKeys.some((key) => now[key] !== base[key])) return false
    }
    return (
      gesture?.kind !== 'connect' || !gesture.picked || doc.getEdge(gesture.picked) === edgeBase
    )
  }
  const capture = (g: Gesture) => {
    bases.clear()
    edgeBase = g.kind === 'connect' && g.picked ? doc.getEdge(g.picked) : undefined
    const ids =
      g.kind === 'press'
        ? [g.id, ...editableTops()]
        : g.kind === 'move'
          ? g.ids
          : g.kind === 'resize'
            ? [...g.ids, ...g.kids.keys()]
            : g.kind === 'connect'
              ? [g.from.elementId, ...(edgeBase ? [edgeBase.to[0]] : [])]
              : []
    for (const id of ids) {
      const element = doc.get(id)
      if (element) bases.set(id, element)
      for (const parent of doc.ancestors(id)) bases.set(parent.id, parent)
    }
  }

  const release = () => {
    const id = pointer
    pointer = null
    if (id !== null && el.hasPointerCapture(id)) el.releasePointerCapture(id)
  }
  const cancel = (restoreSelection = true) => {
    const g = gesture
    gesture = null
    bases.clear()
    edgeBase = undefined
    release()
    if (!g) return
    host.preview(new Map())
    edges.setPreview(null)
    overlay.setGuides([])
    overlay.setMarquee(null)
    if (restoreSelection && g.kind === 'marquee')
      selection.set(g.restore.filter((id) => doc.has(id)))
    el.style.cursor = pan.space || pan.hand ? 'grab' : ''
  }
  const commit = (write: () => void) => {
    if (doc.readOnly) return
    doc.undo.stopCapturing()
    try {
      host.commit(() => doc.ydoc.transact(write, doc.origin))
    } finally {
      doc.undo.stopCapturing()
    }
  }
  const cancelReadOnlyEdit = () => {
    if (!doc.readOnly || !gesture || gesture.kind === 'press' || gesture.kind === 'marquee')
      return false
    cancel(false)
    return true
  }
  const interrupt = () => {
    if (!gesture) return
    cancel(false)
    host.onInterrupted?.()
  }

  const toWorld = (e: PointerEvent) => {
    const rect = el.getBoundingClientRect()
    return camera.screenToWorld(e.clientX - rect.left, e.clientY - rect.top)
  }
  const portRadius = () => Math.max(PORT_RADIUS * 1.5, HIT_PX / camera.zoom)

  const portCandidates = (x: number, y: number) => {
    const out: Array<[CanvasElement, Rect]> = []
    const front = scene.hitTest(x, y, (id) => scene.get(id)?.kind !== 'frame')
    for (const id of scene.query(expand({ x, y, w: 0, h: 0 }, portRadius()))) {
      const e = scene.get(id)
      const r = scene.rect(id)
      if (
        e &&
        r &&
        edges.portsVisible(e) &&
        (!front || front === id || scene.drawOrder(front) < scene.drawOrder(id))
      )
        out.push([e, r])
    }
    // 距离相同时 hitPort 取后者，按实际绘制顺序让最上层端口优先。
    out.sort(([a], [b]) => scene.drawOrder(a.id) - scene.drawOrder(b.id))
    return out
  }
  /** 光标下或贴近边缘（端口那一圈）的有端口元素，悬停时显示它的端口 */
  const nearElement = (x: number, y: number) => {
    const hit = scene.hitTest(x, y)
    if (hit && elementPorts(scene.get(hit)!)) return hit
    const reach = portRadius() * 1.5
    for (const id of scene.query(expand({ x, y, w: 0, h: 0 }, reach))) {
      const e = scene.get(id)
      if (e && e.kind !== 'frame' && elementPorts(e)) return id
    }
    return null
  }

  const findPortAt = (x: number, y: number, filter?: (p: PortRef) => boolean) =>
    hitPort(
      portCandidates(x, y),
      x,
      y,
      portRadius(),
      (ref) => portUncovered(scene, ref) && (!filter || filter(ref)),
    )

  /** 同一连接点上的全部端口 */
  const portsOf = (ref: PortRef) => {
    const e = scene.get(ref.elementId)
    return e ? sidePorts(e, ref) : [ref]
  }

  /**
   * 连线的两端：每侧只有一个连接点，落在对方的连接点或卡片上都行，
   * 再从两侧端口里挑一对类型兼容的，目标优先还没连线的（或可多连的）。
   */
  const resolve = (from: PortRef, x: number, y: number, picked?: string | null) => {
    const froms = portsOf(from)
    const fits = (p: PortRef) => froms.some((f) => canConnect(f, p))
    const port = findPortAt(x, y, fits)
    const id =
      port?.elementId ?? scene.hitTest(x, y, (i) => scene.get(i)?.kind !== 'frame') ?? undefined
    const e = id ? scene.get(id) : undefined
    const r = id ? scene.rect(id) : undefined
    if (!e || !r) return null
    const pairs: Array<{ from: PortRef; target: PortRef }> = []
    eachPort(e, r, (p) => {
      const f = froms.find((f) => canConnect(f, p))
      if (f) pairs.push({ from: f, target: p })
    })
    // 同一输出连接点同时提供视频和尾帧等类型时，优先节点声明里的主输出。
    if (from.side === 'out') pairs.sort((a, b) => froms.indexOf(a.from) - froms.indexOf(b.from))
    const taken = (p: PortRef) =>
      p.side === 'in' &&
      !p.port.multiple &&
      [...doc.edges()].some(
        (edge) => edge.id !== picked && edge.to[0] === p.elementId && edge.to[1] === p.port.id,
      )
    return pairs.find((p) => !taken(p.target)) ?? pairs[0] ?? null
  }

  const handleAt = (x: number, y: number): Handle | null => {
    if (doc.readOnly || selection.size === 0 || !overlay.showHandles()) return null
    const box = overlay.selectionBox()
    if (!box) return null
    const tol = HANDLE_PX / camera.zoom
    return (
      overlay.handles().find((h) => {
        const p = handlePosition(box, h)
        return Math.abs(p.x - x) <= tol && Math.abs(p.y - y) <= tol
      }) ?? null
    )
  }

  /** 可编辑（未锁定）的顶层选中元素 */
  const editableTops = () =>
    doc.readOnly
      ? []
      : topLevel(doc, selection.values()).filter((id) => scene.get(id)?.locked === false)

  const parentOrigin = (id: string) => {
    const p = scene.parent(id)
    return (p && scene.rect(p)) || { x: 0, y: 0 }
  }

  // ── 按下 ────────────────────────────────────────────

  const onPointerDown = (e: PointerEvent) => {
    if (pointer !== null || e.button !== 0 || pan.space || pan.hand) return
    doc.flush()
    const w = toWorld(e)

    // 端口优先于缩放手柄：单端口节点的端口正好在边的中点手柄上
    const handle = findPortAt(w.x, w.y) ? null : handleAt(w.x, w.y)
    if (handle) {
      const ids = editableTops()
      const starts = new Map(ids.map((id) => [id, scene.rect(id)!]))
      const kids = new Map<string, { parent: string; x: number; y: number }>()
      for (const id of ids) {
        if (scene.get(id)?.kind !== 'frame') continue
        for (const c of scene.children(id)) {
          const r = scene.localRect(c)
          if (r) kids.set(c, { parent: id, x: r.x, y: r.y })
        }
      }
      const box = union(starts.values())
      const lock = ids.some((id) => videoAssetOf(scene.get(id)) !== undefined)
      if (box) gesture = { kind: 'resize', handle, ids, starts, lock, kids, box, wx: w.x, wy: w.y }
    } else if (startConnect(w.x, w.y)) {
      // 连线手势已建立
    } else {
      const id = scene.hitTest(w.x, w.y)
      if (id) {
        let toggled = false
        if (e.shiftKey) {
          selection.toggle(id)
          toggled = !selection.has(id)
        } else if (!selection.has(id)) {
          selection.set([id])
        }
        gesture = { kind: 'press', id, sx: e.clientX, sy: e.clientY, wx: w.x, wy: w.y, toggled }
      } else {
        const restore = selection.values()
        const base = e.shiftKey ? restore : []
        if (!e.shiftKey) selection.clear()
        gesture = { kind: 'marquee', wx: w.x, wy: w.y, base, restore }
      }
    }
    if (gesture) {
      capture(gesture)
      pointer = e.pointerId
      el.setPointerCapture(e.pointerId)
    }
  }

  const startConnect = (x: number, y: number) => {
    if (doc.readOnly) return false
    const port = findPortAt(x, y)
    if (!port) return false
    let from = port
    let picked: string | null = null
    if (port.side === 'in' && portsOf(port).length === 1 && !port.port.multiple) {
      // 只有一个单连输入端口且已有连线：拾起它，改从上游输出端口继续拖
      const existing = [...doc.edges()].find(
        (edge) => edge.to[0] === port.elementId && edge.to[1] === port.port.id,
      )
      const srcPort = existing && edges.port(existing.from[0], existing.from[1], 'out')
      if (existing && srcPort) {
        from = srcPort
        picked = existing.id
      }
    }
    gesture = { kind: 'connect', from, picked }
    edges.setPreview({ from, x, y, target: null, picked })
    return true
  }

  // ── 移动 ────────────────────────────────────────────

  const onPointerMove = (e: PointerEvent) => {
    if (pointer !== null && pointer !== e.pointerId) return
    if (cancelReadOnlyEdit()) return
    if (gesture && !valid()) {
      interrupt()
      return
    }
    const w = toWorld(e)
    if (!gesture) {
      if (pan.space || pan.hand) return
      edges.setHoverElement(doc.readOnly ? null : nearElement(w.x, w.y))
      const port = doc.readOnly ? null : findPortAt(w.x, w.y)
      const handle = port ? null : handleAt(w.x, w.y)
      edges.setHover(port)
      el.style.cursor = handle ? HANDLE_CURSORS[handle] : port ? 'crosshair' : ''
      return
    }
    switch (gesture.kind) {
      case 'connect': {
        const r = resolve(gesture.from, w.x, w.y, gesture.picked)
        edges.setPreview({
          from: r?.from ?? gesture.from,
          x: w.x,
          y: w.y,
          target: r?.target ?? null,
          picked: gesture.picked,
        })
        break
      }
      case 'press': {
        if (gesture.toggled || Math.hypot(e.clientX - gesture.sx, e.clientY - gesture.sy) < DRAG_PX)
          break
        const ids = editableTops()
        const starts = new Map(ids.map((id) => [id, scene.localRect(id)!]))
        const box = union(ids.map((id) => scene.rect(id)!))
        gesture = box ? { kind: 'move', ids, starts, box, wx: gesture.wx, wy: gesture.wy } : null
        if (gesture) dragMove(gesture, w.x, w.y, e.altKey)
        break
      }
      case 'move':
        dragMove(gesture, w.x, w.y, e.altKey)
        break
      case 'resize': {
        const { handle, ids, starts, kids, box, lock } = gesture
        const next = resizeBox(box, handle, w.x - gesture.wx, w.y - gesture.wy, lock || e.shiftKey)
        const patches = new Map<string, Transient>()
        const shift = new Map<string, { dx: number; dy: number }>()
        for (const id of ids) {
          const start = starts.get(id)!
          const r = mapRect(start, box, next)
          const o = parentOrigin(id)
          patches.set(id, { x: r.x - o.x, y: r.y - o.y, w: r.w, h: r.h })
          shift.set(id, { dx: r.x - start.x, dy: r.y - start.y })
        }
        for (const [c, k] of kids) {
          const s = shift.get(k.parent)!
          patches.set(c, { x: k.x - s.dx, y: k.y - s.dy })
        }
        host.preview(patches)
        break
      }
      case 'marquee': {
        const rect = fromPoints(gesture.wx, gesture.wy, w.x, w.y)
        overlay.setMarquee(rect)
        selecting = true
        try {
          selection.set([...gesture.base.filter((id) => doc.has(id)), ...marqueeHits(rect)])
        } finally {
          selecting = false
        }
        break
      }
    }
  }

  const dragMove = (
    g: Extract<Gesture, { kind: 'move' }>,
    x: number,
    y: number,
    noSnap: boolean,
  ) => {
    let dx = x - g.wx
    let dy = y - g.wy
    const moved = { ...g.box, x: g.box.x + dx, y: g.box.y + dy }
    if (!noSnap) {
      const moving = new Set(g.ids)
      const targets = scene
        .query(camera.viewRect)
        .filter((id) => !moving.has(id) && !g.ids.some((m) => scene.isAncestor(m, id)))
        .map((id) => scene.rect(id)!)
      const snap = snapMove(moved, targets, SNAP_PX / camera.zoom)
      dx += snap.dx
      dy += snap.dy
      overlay.setGuides(snap.guides)
    } else {
      overlay.setGuides([])
    }
    const patches = new Map<string, Transient>()
    for (const id of g.ids) {
      const s = g.starts.get(id)!
      patches.set(id, { x: s.x + dx, y: s.y + dy })
    }
    host.preview(patches)
  }

  /** 框选命中：普通元素相交即选中，Frame 需完整框住；已选 Frame 的后代不重复选 */
  const marqueeHits = (rect: Rect) => {
    const hits = scene.query(rect).filter((id) => {
      const r = scene.rect(id)!
      return scene.get(id)?.kind === 'frame' ? contains(rect, r) : intersects(rect, r)
    })
    const set = new Set(hits)
    return hits.filter((id) => {
      for (let p = scene.parent(id); p !== null; p = scene.parent(p)) if (set.has(p)) return false
      return true
    })
  }

  // ── 松开 ────────────────────────────────────────────

  const onPointerUp = (e: PointerEvent) => {
    if (pointer !== e.pointerId) return
    doc.flush()
    if (pointer !== e.pointerId) return
    if (cancelReadOnlyEdit()) return
    if (!valid()) {
      interrupt()
      return
    }
    const w = toWorld(e)
    const g = gesture
    gesture = null
    bases.clear()
    edgeBase = undefined
    release()
    if (!g) return

    switch (g.kind) {
      case 'connect': {
        const r = resolve(g.from, w.x, w.y, g.picked)
        edges.setPreview(null)
        if (r) {
          const [out, inp] = r.from.side === 'out' ? [r.from, r.target] : [r.target, r.from]
          const old = g.picked && [...doc.edges()].find((edge) => edge.id === g.picked)
          if (
            old &&
            old.from[0] === out.elementId &&
            old.from[1] === out.port.id &&
            old.to[0] === inp.elementId &&
            old.to[1] === inp.port.id
          )
            break
          commit(() => {
            if (g.picked) removeEdges(doc, [g.picked])
            connect(doc, [out.elementId, out.port.id], [inp.elementId, inp.port.id])
          })
        } else if (g.picked) {
          commit(() => removeEdges(doc, [g.picked!]))
        } else if (!scene.hitTest(w.x, w.y)) {
          host.connectToEmpty?.(g.from, w, { x: e.clientX, y: e.clientY })
        }
        break
      }
      case 'press':
        // 在多选中点了其中一个且没拖动：只留它
        if (!g.toggled && !e.shiftKey && selection.size > 1) selection.set([g.id])
        break
      case 'move': {
        overlay.setGuides([])
        const patches = g.ids.map((id) => ({ id, ...scene.localRect(id)! }))
        commit(() => {
          updateElements(doc, patches)
          regroup(g.ids)
        })
        break
      }
      case 'resize': {
        const patches = [...g.ids, ...g.kids.keys()].map((id) => ({ id, ...scene.localRect(id)! }))
        commit(() => {
          updateElements(doc, patches)
        })
        break
      }
      case 'marquee':
        overlay.setMarquee(null)
        selection.set([
          ...g.base.filter((id) => doc.has(id)),
          ...marqueeHits(fromPoints(g.wx, g.wy, w.x, w.y)),
        ])
        break
    }
  }

  /** 拖动结束后按元素中心所在的最内层 Frame 归组；拖出 Frame 则回到外层 */
  const regroup = (ids: string[]) => {
    const moving = new Set(ids)
    const byTarget = new Map<string | null, string[]>()
    for (const id of ids) {
      const r = doc.worldRect(id)
      if (!r) continue
      const frame = scene.hitTest(
        r.x + r.w / 2,
        r.y + r.h / 2,
        (f) =>
          scene.get(f)?.kind === 'frame' &&
          !moving.has(f) &&
          ![...moving].some((m) => scene.isAncestor(m, f)),
      )
      const current = doc.effectiveParent(doc.get(id)!)
      if (frame === current) continue
      const list = byTarget.get(frame)
      if (list) list.push(id)
      else byTarget.set(frame, [id])
    }
    for (const [target, list] of byTarget) setParent(doc, list, target)
  }

  const onPointerLeave = () => edges.setHoverElement(null)
  const onCancel = (e: PointerEvent) => {
    if (e.pointerId === pointer) cancel()
  }
  const onKeyDown = (e: KeyboardEvent) => {
    if (
      gesture &&
      e.key === 'Escape' &&
      !e.defaultPrevented &&
      !e.isComposing &&
      e.keyCode !== 229
    ) {
      e.preventDefault()
      cancel()
    }
  }
  const onBlur = () => cancel()
  const offCamera = camera.onChange(() => cancel())
  const offSelection = selection.onChange(() => {
    if (gesture && !selecting) {
      if (valid()) cancel(false)
      else interrupt()
    }
  })
  const offDoc = doc.subscribe(() => {
    if (!cancelReadOnlyEdit() && gesture && !valid()) interrupt()
  })

  el.addEventListener('pointerdown', onPointerDown)
  el.addEventListener('pointerleave', onPointerLeave)
  el.addEventListener('pointermove', onPointerMove)
  el.addEventListener('pointerup', onPointerUp)
  el.addEventListener('pointercancel', onCancel)
  el.addEventListener('lostpointercapture', onCancel)
  window.addEventListener('blur', onBlur)
  window.addEventListener('keydown', onKeyDown)

  return {
    cancelEditing() {
      if (gesture && gesture.kind !== 'marquee') cancel(false)
      edges.setHover(null)
      edges.setHoverElement(null)
    },
    dispose() {
      offCamera()
      offSelection()
      offDoc()
      cancel(false)
      el.removeEventListener('pointerdown', onPointerDown)
      el.removeEventListener('pointerleave', onPointerLeave)
      el.removeEventListener('pointermove', onPointerMove)
      el.removeEventListener('pointerup', onPointerUp)
      el.removeEventListener('pointercancel', onCancel)
      el.removeEventListener('lostpointercapture', onCancel)
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('keydown', onKeyDown)
    },
  }
}
