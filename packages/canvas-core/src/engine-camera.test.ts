import { createElement, type PleinDoc, type Rect } from '@plein/doc'
import { node, openDoc } from '@plein/doc/testing'
import { afterEach, describe, expect, it } from 'vite-plus/test'
import type { Engine } from './engine'
import { contains } from './geometry'
import { initEngine } from './testing'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

async function setup(build: (doc: PleinDoc) => void = () => {}) {
  const doc = openDoc()
  build(doc)
  doc.flush()
  const fixture = await initEngine(doc)
  cleanups.push(() => doc.destroy(), fixture.cleanup)
  return { doc, ...fixture }
}

const view = ({ camera }: Engine) => ({ x: camera.x, y: camera.y, zoom: camera.zoom })
const flying = (engine: Engine) => !!(engine as unknown as { flight: unknown }).flight
const inView = (engine: Engine, r: Rect) => contains(engine.camera.viewRect, r)

describe('平滑定位被其他镜头命令接管', () => {
  const actions: Array<[string, (engine: Engine, latest: string) => void]> = [
    ['fit', (engine, latest) => engine.zoomToFit([latest])],
    ['zoom', (engine) => engine.zoomTo(0.5)],
    [
      'center',
      (engine, latest) => {
        const r = engine.doc.worldRect(latest)!
        engine.camera.centerOn(r.x + r.w / 2, r.y + r.h / 2)
      },
    ],
  ]

  it.each(actions)('平滑定位中 %s 立即接管镜头，旧动画后续帧不再拉回', async (name, act) => {
    let ids = { home: '', far: '', latest: '' }
    const { engine, tick } = await setup((doc) => {
      ids = {
        home: createElement(doc, node({ x: 0, y: 0 })),
        far: createElement(doc, node({ x: 4000, y: -2500 })),
        latest: createElement(doc, node({ x: -3000, y: 2000 })),
      }
    })
    engine.zoomToFit([ids.home])
    engine.flyTo([ids.far])
    // 先走一帧，确认动画自身推动的镜头变化不会把自己取消
    tick(1100)
    expect(flying(engine)).toBe(true)
    const before = view(engine)
    act(engine, ids.latest)
    expect(flying(engine)).toBe(false)
    const expected = view(engine)
    expect(expected).not.toEqual(before)
    // 越过 560ms 动画时长的多帧，镜头保持接管后的位置
    for (const at of [1300, 1700, 2400]) {
      tick(at)
      expect(view(engine)).toEqual(expected)
    }
    if (name === 'zoom') expect(engine.camera.zoom).toBe(0.5)
    else expect(inView(engine, engine.doc.worldRect(ids.latest)!)).toBe(true)
    expect(inView(engine, engine.doc.worldRect(ids.far)!)).toBe(false)
  })
})

describe('新建元素尚未派发变更时立即定位', () => {
  const actions: Array<[string, (engine: Engine, id: string) => void]> = [
    ['zoomToFit', (engine, id) => engine.zoomToFit([id])],
    ['flyTo', (engine, id) => engine.flyTo([id])],
  ]

  it.each(actions)('新建节点后立即 %s 可定位尚未逐帧提交的元素', async (_name, act) => {
    const { doc, engine, tick } = await setup((doc) => {
      createElement(doc, node({ x: 0, y: 0 }))
    })
    engine.zoomToFit()
    const id = createElement(doc, node({ x: -3000, y: -2000 }))
    // 变更仍在等待逐帧派发，场景里还没有它
    expect(engine.scene.rect(id)).toBeUndefined()
    act(engine, id)
    tick(1000 + 600)
    expect(flying(engine)).toBe(false)
    expect(engine.scene.rect(id)).toEqual(doc.worldRect(id))
    expect(inView(engine, doc.worldRect(id)!)).toBe(true)
  })
})

it('连续平滑定位取最后目标，滚轮和中键在首帧之前立即接管', async () => {
  let ids: string[] = []
  const { engine, tick, host } = await setup((doc) => {
    ids = [0, 4000, -3000].map((x) => createElement(doc, node({ x, y: x / 2 })))
  })
  engine.flyTo([ids[1]!])
  engine.flyTo([ids[2]!])
  tick(1700)
  expect(inView(engine, engine.doc.worldRect(ids[2]!)!)).toBe(true)
  for (const type of ['wheel', 'pointerdown']) {
    engine.flyTo([ids[1]!])
    const event = new Event(type, { cancelable: true })
    for (const [key, value] of Object.entries({
      button: 1,
      pointerId: 1,
      clientX: 100,
      clientY: 100,
      deltaX: 0,
      deltaY: 160,
      deltaMode: 0,
    }))
      Object.defineProperty(event, key, { value })
    host.dispatchEvent(event)
    const manual = view(engine)
    tick(2500)
    expect(flying(engine)).toBe(false)
    expect(view(engine)).toEqual(manual)
    const cancel = new Event('pointercancel')
    Object.defineProperty(cancel, 'pointerId', { value: 1 })
    host.dispatchEvent(cancel)
  }
})
