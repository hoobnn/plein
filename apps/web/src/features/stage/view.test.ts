// @vitest-environment happy-dom
import { defaultStageScene, StageBlock, STAGE_BLOCKS } from '@plein/nodes'
import * as THREE from 'three'
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import type { TransformControls } from 'three/addons/controls/TransformControls.js'
import { afterEach, beforeEach, expect, it, vi } from 'vite-plus/test'
import { mockResizeObserver } from '../../testing/browser'
import { StageView } from './view'

const boundary = vi.hoisted(() => ({
  render: vi.fn(),
  setTarget: vi.fn(),
  dispose: vi.fn(),
  loseContext: vi.fn(),
  orbit: null as OrbitControls | null,
  gizmo: null as TransformControls | null,
  scene: null as THREE.Scene | null,
}))
// 仅替换 GPU 渲染和 PNG 编码；场景、几何、控制器与视口生命周期保持真实。
vi.mock('three', async (importOriginal) => ({
  ...(await importOriginal<typeof import('three')>()),
  WebGLRenderer: class {
    domElement = document.createElement('canvas')
    shadowMap = {}
    setPixelRatio() {}
    setSize(width: number, height: number) {
      this.domElement.width = width
      this.domElement.height = height
    }
    setRenderTarget = boundary.setTarget
    render(scene: THREE.Scene) {
      boundary.scene = scene
      boundary.render()
    }
    readRenderTargetPixels() {}
    dispose = boundary.dispose
    forceContextLoss = boundary.loseContext
  },
}))
vi.mock('three/addons/controls/OrbitControls.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('three/addons/controls/OrbitControls.js')>()
  return {
    OrbitControls: class extends actual.OrbitControls {
      constructor(...args: ConstructorParameters<typeof actual.OrbitControls>) {
        super(...args)
        boundary.orbit = this
      }
    },
  }
})
vi.mock('three/addons/controls/TransformControls.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('three/addons/controls/TransformControls.js')>()
  return {
    TransformControls: class extends actual.TransformControls {
      constructor(...args: ConstructorParameters<typeof actual.TransformControls>) {
        super(...args)
        boundary.gizmo = this
      }
    },
  }
})
const views: StageView[] = []
beforeEach(() => {
  boundary.render.mockReset()
  boundary.setTarget.mockReset()
  boundary.dispose.mockReset()
  boundary.loseContext.mockReset()
  mockResizeObserver()
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    () =>
      ({
        createImageData: (width: number, height: number) => ({
          data: new Uint8ClampedArray(width * height * 4),
        }),
        putImageData() {},
      }) as unknown as ReturnType<HTMLCanvasElement['getContext']>,
  )
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) =>
    callback(new Blob(['png'])),
  )
})
afterEach(() => {
  for (const view of views.splice(0)) view.dispose()
  document.body.replaceChildren()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
function setup() {
  const host = document.createElement('div')
  document.body.append(host)
  const events = {
    onSelect: vi.fn(),
    onMove: vi.fn(),
    onCamera: vi.fn(),
    readOnly: vi.fn(() => false),
  }
  const view = new StageView(host, events)
  views.push(view)
  const scene = defaultStageScene()
  view.setScene(scene)
  view.setSelected(scene.figures[0]!.id)
  return { view, events, scene, host }
}

it('PNG 等待期间已恢复手柄和渲染目标，继续编辑与切视角不会被迟到编码覆盖', async () => {
  const { view, scene } = setup()
  let finish!: BlobCallback
  vi.mocked(HTMLCanvasElement.prototype.toBlob).mockImplementationOnce((callback) => {
    finish = callback
  })
  const helper = boundary.gizmo!.getHelper()
  const visible = helper.visible
  const run = view.snapshot()
  expect(boundary.setTarget).toHaveBeenLastCalledWith(null)
  expect(helper.visible).toBe(visible)
  expect(boundary.gizmo!.object).toBeDefined()
  const updated = { ...scene, figures: [{ ...scene.figures[0]!, pose: 'sit' as const }] }
  view.setScene(updated)
  view.setMode('free')
  const object = boundary.gizmo!.object
  const camera = boundary.orbit!.object
  finish(new Blob(['png']))
  await expect(run).resolves.toBeInstanceOf(Blob)
  expect(boundary.gizmo!.object).toBe(object)
  expect(boundary.orbit!.object).toBe(camera)
})

it('渲染或编码失败都释放临时目标，保留手柄并可重试', async () => {
  const { view } = setup()
  boundary.render.mockImplementationOnce(() => {
    throw new Error('render failed')
  })
  await expect(view.snapshot()).rejects.toThrow('render failed')
  expect(boundary.setTarget).toHaveBeenLastCalledWith(null)
  expect(boundary.gizmo!.getHelper().visible).toBe(true)
  vi.mocked(HTMLCanvasElement.prototype.toBlob).mockImplementationOnce((callback) => callback(null))
  await expect(view.snapshot()).rejects.toThrow('截图失败')
  expect(boundary.gizmo!.object).toBeDefined()
  await expect(view.snapshot()).resolves.toBeInstanceOf(Blob)
})

for (const rendered of [false, true]) {
  it.each(['object', 'camera'] as const)(
    `%s 松手前转只读（回送=${rendered}）不提交旧手势，可恢复编辑`,
    (gesture) => {
      const { view, events, scene } = setup()
      const gizmo = boundary.gizmo!
      const orbit = boundary.orbit!
      const move = () => {
        if (gesture === 'object') {
          gizmo.object!.position.x = 9
          gizmo.dispatchEvent({ type: 'dragging-changed', value: false })
        } else {
          orbit.object.position.x = 9
          orbit.target.x = 2
          orbit.dispatchEvent({ type: 'end' })
          view.finishCamera()
        }
      }
      events.readOnly.mockReturnValue(true)
      if (rendered) view.setReadOnly(true)
      // 禁用回送已摘下手柄；迟到事件仍必须拒绝写入。
      if (gesture === 'object' && !gizmo.object)
        gizmo.dispatchEvent({ type: 'dragging-changed', value: false })
      else move()
      expect(events.onMove).not.toHaveBeenCalled()
      expect(events.onCamera).not.toHaveBeenCalled()
      events.readOnly.mockReturnValue(false)
      view.setReadOnly(false)
      view.setScene(scene)
      move()
      if (gesture === 'object')
        expect(events.onMove).toHaveBeenCalledWith('fig-1', expect.objectContaining({ x: 9 }))
      else expect(events.onCamera).toHaveBeenCalledWith(expect.objectContaining({ x: 9, tx: 2 }))
    },
  )
}

it('切视角前确认待提交机位，重复确认不写两次，自由视角沿用目标', () => {
  const { view, events, scene } = setup()
  const orbit = boundary.orbit!
  orbit.object.position.set(2, 3, 4)
  orbit.target.set(1, 1.5, -1)
  orbit.dispatchEvent({ type: 'end' })
  view.setMode('free')
  expect(events.onCamera).toHaveBeenCalledWith({
    ...scene.camera,
    x: 2,
    y: 3,
    z: 4,
    tx: 1,
    ty: 1.5,
    tz: -1,
  })
  view.finishCamera()
  expect(events.onCamera).toHaveBeenCalledTimes(1)
  expect(view.viewAsCamera()).toMatchObject({ tx: 1, ty: 1.5, tz: -1 })
})

it('关闭视口销毁上下文并移除画布', () => {
  const { view, host } = setup()
  expect(host.querySelector('canvas')).not.toBeNull()
  view.dispose()
  views.splice(views.indexOf(view), 1)
  expect(host.querySelector('canvas')).toBeNull()
  expect(boundary.dispose).toHaveBeenCalledTimes(1)
  expect(boundary.loseContext).toHaveBeenCalledTimes(1)
})

it('首帧渲染失败在构造内部释放 RAF、观察器和 GPU，重试只保留一个视口', () => {
  const host = document.createElement('div')
  document.body.append(host)
  const events = { onSelect: vi.fn(), onMove: vi.fn(), onCamera: vi.fn() }
  const frames = vi.spyOn(window, 'requestAnimationFrame')
  const cancel = vi.spyOn(window, 'cancelAnimationFrame')
  const disconnect = vi.spyOn(ResizeObserver.prototype, 'disconnect')
  boundary.render.mockImplementationOnce(() => {
    throw new Error('首帧失败')
  })
  expect(() => new StageView(host, events)).toThrow('首帧失败')
  expect(host.querySelector('canvas')).toBeNull()
  expect(cancel).toHaveBeenCalledWith(frames.mock.results[0]!.value)
  expect(disconnect).toHaveBeenCalledTimes(1)
  expect(boundary.dispose).toHaveBeenCalledTimes(1)
  expect(boundary.loseContext).toHaveBeenCalledTimes(1)
  const view = new StageView(host, events)
  views.push(view)
  expect(host.querySelectorAll('canvas')).toHaveLength(1)
})

it('真实手柄的越界位置经过地面限制才交给文档', () => {
  const { events } = setup()
  const gizmo = boundary.gizmo!
  gizmo.object!.position.set(999, 10, -999)
  gizmo.dispatchEvent({ type: 'dragging-changed', value: false })
  expect(events.onMove).toHaveBeenCalledWith('fig-1', { x: 50, z: -50, facing: 0 })
  expect(gizmo.object!.position.y).toBe(0)
})

it('混合场景件修改尺寸重建后手柄仍指向新几何，删除释放旧对象', async () => {
  const { view, scene } = setup()
  const blocks = STAGE_BLOCKS.map(({ id }, index) =>
    StageBlock.parse({ id: `block-${index}`, kind: id }),
  )
  view.setScene({ ...scene, blocks })
  for (const block of blocks) {
    view.setSelected(block.id)
    const previous = boundary.gizmo!.object!
    expect(previous.children.length).toBeGreaterThan(0)
    const resized = blocks.map((item) =>
      item.id === block.id ? { ...item, w: 4, facing: 90 } : item,
    )
    view.setScene({ ...scene, blocks: resized })
    const current = boundary.gizmo!.object!
    expect(current).not.toBe(previous)
    expect(current.userData.id).toBe(block.id)
    expect(previous.parent).toBeNull()
  }
  await expect(view.snapshot()).resolves.toBeInstanceOf(Blob)
  view.setScene(scene)
  expect(boundary.gizmo!.object).toBeUndefined()
})
