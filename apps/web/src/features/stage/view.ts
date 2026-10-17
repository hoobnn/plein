import {
  aspectRatio,
  type StageCamera,
  type StageScene,
  STAGE_SNAPSHOT_SIDE,
  verticalFov,
} from '@plein/nodes'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { TransformControls } from 'three/addons/controls/TransformControls.js'
import { blockKey, buildBlock, buildFigure, disposeTree, updateBlock, updateFigure } from './figure'
import { stageCameraBounds, stageGround } from './constraints'

export type StageMode = 'shot' | 'free'
export type StageTool = 'move' | 'rotate'

export interface StageViewEvents {
  /** 点选了人物 / 场景件，或点空白处取消（null） */
  onSelect(id: string | null): void
  /** 拖动结束：某个对象的新位置与朝向 */
  onMove(id: string, at: { x: number; z: number; facing: number }): void
  /** 机位视角下拖动画面结束：新的机位 */
  onCamera(camera: StageCamera): void
}

/** 背景和地面：和主题无关，取景框里看到的就是截出来的样子 */
const SNAPSHOT_BG = 0xdfe1e5
const FLOOR = 0xcfd2d7

const round = (n: number, step = 0.01) => Math.round(n / step) * step
const deg = THREE.MathUtils.radToDeg
const sameCamera = (a: StageCamera, b: StageCamera | undefined) =>
  (['x', 'y', 'z', 'tx', 'ty', 'tz', 'focal'] as const).every((key) => a[key] === b?.[key])

/**
 * 3D 构图视口：一个 WebGL 上下文，只在打开构图时存在，关闭即销毁，不影响画布。
 * 场景数据由外部给（setScene），这里按 id 对账更新网格；拖动、取景的结果经回调交回去写文档。
 */
export class StageView {
  private renderer: THREE.WebGLRenderer
  private scene = new THREE.Scene()
  /** 机位：截图就用它 */
  private shot = new THREE.PerspectiveCamera(35, 16 / 9, 0.05, 200)
  /** 自由视角用的编辑相机 */
  private free = new THREE.PerspectiveCamera(45, 1, 0.05, 400)
  private orbit: OrbitControls
  private gizmo: TransformControls
  private shotHelper: THREE.CameraHelper
  private grid: THREE.GridHelper
  private floor: THREE.Mesh
  private objects = new Map<string, THREE.Group>()
  private data: StageScene | null = null
  private mode: StageMode = 'shot'
  private selected: string | null = null
  private dragging = false
  private orbitInteracting = false
  private pendingCamera = false
  private orbitPosition = new THREE.Vector3()
  private orbitTarget = new THREE.Vector3()
  private frame = 0
  private size = { w: 1, h: 1 }
  private observer: ResizeObserver
  /** 刚拖完操纵手柄：这次松开不算点选 */
  private dragged = false
  private down: { x: number; y: number } | null = null
  private raycaster = new THREE.Raycaster()

  constructor(
    private host: HTMLElement,
    private events: StageViewEvents,
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    const canvas = this.renderer.domElement
    canvas.className = 'stage-canvas'
    host.appendChild(canvas)

    const hemi = new THREE.HemisphereLight(0xffffff, 0x9a9ea6, 1.6)
    const sun = new THREE.DirectionalLight(0xffffff, 1.9)
    sun.position.set(4, 9, 6)
    sun.castShadow = true
    sun.shadow.mapSize.set(2048, 2048)
    sun.shadow.camera.left = -12
    sun.shadow.camera.right = 12
    sun.shadow.camera.top = 12
    sun.shadow.camera.bottom = -12
    sun.shadow.bias = -0.0005
    sun.shadow.radius = 4
    this.scene.add(hemi, sun)

    this.floor = new THREE.Mesh(
      new THREE.PlaneGeometry(100, 100),
      new THREE.MeshStandardMaterial({ color: FLOOR, roughness: 1 }),
    )
    this.floor.rotation.x = -Math.PI / 2
    this.floor.receiveShadow = true
    this.scene.add(this.floor)
    this.grid = new THREE.GridHelper(40, 40, 0x8c929c, 0xa9aeb6)
    ;(this.grid.material as THREE.Material).transparent = true
    ;(this.grid.material as THREE.Material).opacity = 0.35
    this.grid.position.y = 0.002
    this.scene.add(this.grid)

    this.shotHelper = new THREE.CameraHelper(this.shot)
    this.shotHelper.visible = false
    const frustum = new THREE.Color(0x4d8dff)
    this.shotHelper.setColors(frustum, frustum, frustum, new THREE.Color(0x8c929c), frustum)
    this.scene.add(this.shotHelper)
    this.free.position.set(7, 6, 10)

    this.orbit = new OrbitControls(this.shot, canvas)
    this.orbit.enableDamping = true
    this.orbit.dampingFactor = 0.12
    // 防止极端滚轮输入使半径溢出，或缩到相机与目标重合。
    this.orbit.minDistance = 0.25
    this.orbit.maxDistance = 100
    this.orbit.addEventListener('start', () => {
      this.orbitInteracting = true
    })
    this.orbit.addEventListener('end', () => {
      this.orbitInteracting = false
      if (this.mode === 'shot') this.pendingCamera = true
    })

    this.gizmo = new TransformControls(this.shot, canvas)
    this.gizmo.setSize(0.8)
    this.gizmo.showY = false
    this.gizmo.addEventListener('dragging-changed', (e) => {
      this.dragging = Boolean(e.value)
      if (this.dragging) this.dragged = true
      this.orbit.enabled = !this.dragging
      if (!this.dragging) this.commitMove()
    })
    this.scene.add(this.gizmo.getHelper())

    canvas.addEventListener('pointerdown', this.onDown)
    canvas.addEventListener('pointerup', this.onUp)
    this.observer = new ResizeObserver(() => this.resize())
    this.observer.observe(host)
    this.scene.background = new THREE.Color(SNAPSHOT_BG)
    this.resize()
    this.loop()
  }

  /** 按场景数据对账：新的建、没了的删、变了的更新 */
  setScene(next: StageScene) {
    const cameraChanged = !sameCamera(next.camera, this.data?.camera)
    this.data = next
    const keep = new Set<string>()
    for (const f of next.figures) {
      keep.add(f.id)
      let obj = this.objects.get(f.id)
      if (!obj || obj.userData.kind !== 'figure' || obj.userData.color !== f.color) {
        if (obj) this.remove(f.id)
        obj = buildFigure(f)
        obj.userData = { ...obj.userData, id: f.id, kind: 'figure', color: f.color }
        this.add(f.id, obj)
      } else if (!this.isDragging(f.id)) updateFigure(obj, f)
    }
    for (const b of next.blocks) {
      keep.add(b.id)
      let obj = this.objects.get(b.id)
      if (!obj || obj.userData.key !== blockKey(b)) {
        if (obj) this.remove(b.id)
        obj = buildBlock(b)
        obj.userData = { ...obj.userData, id: b.id, kind: 'block' }
        this.add(b.id, obj)
      } else if (!this.isDragging(b.id)) updateBlock(obj, b)
    }
    for (const id of [...this.objects.keys()]) if (!keep.has(id)) this.remove(id)
    if (!(this.mode === 'shot' && this.orbitBusy() && !cameraChanged)) {
      if (cameraChanged && this.mode === 'shot') {
        this.stopOrbit()
        this.pendingCamera = false
      }
      this.applyCamera(next.camera)
    }
    this.shot.aspect = aspectRatio(next.aspect)
    this.shot.fov = verticalFov(next.camera.focal, this.shot.aspect)
    this.shot.updateProjectionMatrix()
    this.shotHelper.update()
    this.attachGizmo()
    this.resize()
  }

  setSelected(id: string | null) {
    this.selected = id
    for (const [oid, obj] of this.objects) this.highlight(obj, oid === id)
    this.attachGizmo()
  }

  setMode(mode: StageMode) {
    if (mode === this.mode) return
    this.finishCamera()
    this.stopOrbit()
    this.mode = mode
    const cam = mode === 'shot' ? this.shot : this.free
    this.orbit.object = cam
    this.gizmo.camera = cam
    if (mode === 'shot' && this.data) this.applyCamera(this.data.camera)
    else this.orbit.target.copy(this.data ? this.targetOf(this.data.camera) : new THREE.Vector3())
    this.orbit.update()
    this.shotHelper.visible = mode === 'free'
    this.resize()
  }

  setTool(tool: StageTool) {
    this.gizmo.setMode(tool === 'move' ? 'translate' : 'rotate')
    this.gizmo.showX = tool === 'move'
    this.gizmo.showZ = tool === 'move'
    this.gizmo.showY = tool === 'rotate'
  }

  /** 自由视角下「把机位放到这里」：当前编辑相机的位置和看向的点 */
  viewAsCamera(): StageCamera {
    this.stopOrbit()
    const t = this.orbit.target
    return stageCameraBounds({
      ...(this.data?.camera ?? { focal: 35 }),
      x: this.free.position.x,
      y: this.free.position.y,
      z: this.free.position.z,
      tx: t.x,
      ty: t.y,
      tz: t.z,
    })
  }

  /**
   * 截图：只渲染机位看到的场景，去掉网格、操纵手柄、机位框和选中高亮，
   * 背景固定，长边 STAGE_SNAPSHOT_SIDE 像素
   */
  async snapshot(): Promise<Blob> {
    const aspect = this.shot.aspect
    const w = aspect >= 1 ? STAGE_SNAPSHOT_SIDE : Math.round(STAGE_SNAPSHOT_SIDE * aspect)
    const h = aspect >= 1 ? Math.round(STAGE_SNAPSHOT_SIDE / aspect) : STAGE_SNAPSHOT_SIDE
    const canvas = document.createElement('canvas')
    const target = new THREE.WebGLRenderTarget(w, h, {
      samples: 4,
      colorSpace: THREE.SRGBColorSpace,
    })
    const hidden = [this.grid, this.shotHelper, this.gizmo.getHelper()]
    const was = hidden.map((o) => o.visible)
    for (const o of hidden) o.visible = false
    for (const obj of this.objects.values()) this.highlight(obj, false)
    try {
      this.renderer.setRenderTarget(target)
      this.renderer.render(this.scene, this.shot)
      const pixels = new Uint8Array(w * h * 4)
      this.renderer.readRenderTargetPixels(target, 0, 0, w, h, pixels)
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d')!
      const image = ctx.createImageData(w, h)
      // WebGL 的行从下往上，翻过来
      for (let y = 0; y < h; y++)
        image.data.set(pixels.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4)
      ctx.putImageData(image, 0, 0)
    } finally {
      this.renderer.setRenderTarget(null)
      target.dispose()
      hidden.forEach((o, i) => (o.visible = was[i]!))
      this.setSelected(this.selected)
    }
    // 像素已复制到独立画布：异步编码不占用取景的渲染目标，也不保留临时隐藏状态。
    const blob = await new Promise<Blob | null>((ok) => canvas.toBlob(ok, 'image/png'))
    if (!blob) throw new Error('截图失败')
    return blob
  }

  dispose() {
    cancelAnimationFrame(this.frame)
    this.observer.disconnect()
    const canvas = this.renderer.domElement
    canvas.removeEventListener('pointerdown', this.onDown)
    canvas.removeEventListener('pointerup', this.onUp)
    this.gizmo.detach()
    this.gizmo.dispose()
    this.orbit.dispose()
    for (const id of [...this.objects.keys()]) this.remove(id)
    disposeTree(this.floor)
    this.grid.dispose()
    this.shotHelper.dispose()
    this.renderer.dispose()
    this.renderer.forceContextLoss()
    canvas.remove()
  }

  private loop = () => {
    this.frame = requestAnimationFrame(this.loop)
    this.orbitPosition.copy(this.orbit.object.position)
    this.orbitTarget.copy(this.orbit.target)
    this.orbit.update()
    // 控制器在最小距离附近可能因浮点抖动一直报告 change，以实际移动量判断缓动收尾。
    if (
      this.pendingCamera &&
      !this.orbitInteracting &&
      this.orbit.object.position.distanceToSquared(this.orbitPosition) < 1e-10 &&
      this.orbit.target.distanceToSquared(this.orbitTarget) < 1e-10
    )
      this.finishCamera()
    this.renderer.render(this.scene, this.mode === 'shot' ? this.shot : this.free)
  }

  /** 截图、关闭或切视角前，确认当前所见机位；正常拖动则等缓动结束再写一次。 */
  finishCamera() {
    if (this.mode !== 'shot' || !this.pendingCamera) return
    this.stopOrbit()
    this.pendingCamera = false
    const camera = this.cameraData()
    if (!sameCamera(camera, this.data?.camera)) {
      // 文档订阅稍后才回送：先记住已提交机位，避免旧回送打断紧接着的下一次操作。
      if (this.data) this.data = { ...this.data, camera }
      this.events.onCamera(camera)
    }
  }

  /** 清掉控制器剩余的缓动量，并保留当前画面的位置和目标。 */
  private stopOrbit() {
    const position = this.orbit.object.position.clone()
    const target = this.orbit.target.clone()
    const damping = this.orbit.enableDamping
    this.orbit.enableDamping = false
    this.orbit.update()
    this.orbit.object.position.copy(position)
    this.orbit.target.copy(target)
    this.orbit.update()
    this.orbit.enableDamping = damping
  }

  /** 机位视角按画幅留出取景框，自由视角铺满 */
  private resize() {
    const w = Math.max(1, this.host.clientWidth)
    const h = Math.max(1, this.host.clientHeight)
    let cw = w
    let ch = h
    if (this.mode === 'shot') {
      const a = this.shot.aspect
      const pad = 24
      cw = Math.max(1, Math.min(w - pad * 2, (h - pad * 2) * a))
      ch = Math.max(1, cw / a)
    }
    if (cw === this.size.w && ch === this.size.h) return
    this.size = { w: cw, h: ch }
    this.renderer.setSize(Math.round(cw), Math.round(ch))
    this.free.aspect = cw / ch
    this.free.updateProjectionMatrix()
  }

  private targetOf(c: StageCamera) {
    return new THREE.Vector3(c.tx, c.ty, c.tz)
  }

  private applyCamera(c: StageCamera) {
    this.shot.position.set(c.x, c.y, c.z)
    this.shot.lookAt(this.targetOf(c))
    if (this.mode === 'shot') {
      this.orbit.target.copy(this.targetOf(c))
      this.orbit.update()
    }
  }

  private cameraData(): StageCamera {
    const t = this.orbit.target
    const p = this.shot.position
    return stageCameraBounds({
      focal: this.data?.camera.focal ?? 35,
      x: p.x,
      y: p.y,
      z: p.z,
      tx: t.x,
      ty: t.y,
      tz: t.z,
    })
  }

  private orbitBusy() {
    return this.orbitInteracting || this.pendingCamera
  }

  private isDragging(id: string) {
    return this.dragging && this.selected === id
  }

  private add(id: string, obj: THREE.Group) {
    this.objects.set(id, obj)
    this.scene.add(obj)
    this.highlight(obj, id === this.selected)
  }

  private remove(id: string) {
    const obj = this.objects.get(id)
    if (!obj) return
    if (this.gizmo.object === obj) this.gizmo.detach()
    this.scene.remove(obj)
    disposeTree(obj)
    this.objects.delete(id)
  }

  private attachGizmo() {
    const obj = this.selected ? this.objects.get(this.selected) : undefined
    if (obj && this.gizmo.object !== obj) this.gizmo.attach(obj)
    else if (!obj && this.gizmo.object) this.gizmo.detach()
  }

  /** 选中的对象微微发亮；截图前关掉 */
  private highlight(obj: THREE.Object3D, on: boolean) {
    obj.traverse((o) => {
      if (o instanceof THREE.Mesh && o.material instanceof THREE.MeshStandardMaterial)
        o.material.emissive.setHex(on ? 0x2a4a8a : 0x000000)
    })
  }

  private commitMove() {
    const obj = this.gizmo.object
    const id = obj?.userData.id as string | undefined
    if (!obj || !id) return
    // 拖动只在地面上：高度固定在 0，只绕竖直轴转
    obj.position.y = 0
    obj.position.x = stageGround(obj.position.x)
    obj.position.z = stageGround(obj.position.z)
    const facing = round(((deg(obj.rotation.y) + 540) % 360) - 180, 1)
    this.events.onMove(id, { x: round(obj.position.x), z: round(obj.position.z), facing })
  }

  private onDown = (e: PointerEvent) => {
    this.down = { x: e.clientX, y: e.clientY }
  }

  private onUp = (e: PointerEvent) => {
    const d = this.down
    this.down = null
    const dragged = this.dragged
    this.dragged = false
    if (!d || dragged || this.dragging || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) return
    const rect = this.renderer.domElement.getBoundingClientRect()
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    )
    this.raycaster.setFromCamera(ndc, this.mode === 'shot' ? this.shot : this.free)
    const hits = this.raycaster.intersectObjects([...this.objects.values()], true)
    let o: THREE.Object3D | null = hits[0]?.object ?? null
    while (o && !o.userData.id) o = o.parent
    this.events.onSelect((o?.userData.id as string | undefined) ?? null)
  }
}
