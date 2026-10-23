import { type Engine, Scene, type ViewChange } from '@plein/canvas-core'
import {
  addResults,
  adoptResult,
  clearShotGroup,
  createElement,
  makeShotGroup,
  moveShot,
  type NodeResult,
  setParent,
} from '@plein/doc'
import { box, node, openDoc } from '@plein/doc/testing'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import { ShotBadges } from './shotBadges'

class Element {
  children: Element[] = []
  parent: Element | null = null
  className = ''
  textContent = ''
  dataset: Record<string, string> = {}
  style: Record<string, string> = {}
  offsetWidth = 16
  offsetHeight = 16
  inert = false

  appendChild(child: Element) {
    child.parent = this
    this.children.push(child)
    return child
  }

  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this)
    this.parent = null
  }

  matches() {
    return false
  }

  querySelectorAll() {
    return []
  }
}

const cleanups: Array<() => void> = []
beforeEach(() => {
  vi.stubGlobal('document', { createElement: () => new Element() })
})
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function fixture() {
  const doc = openDoc()
  const frame = createElement(doc, box({ kind: 'frame', x: 100, y: 200, w: 400, h: 300 }))
  const a = createElement(doc, box({ parentId: frame, assetId: 'a', x: 20, y: 30 }))
  const b = createElement(doc, box({ parentId: frame, assetId: 'b', x: 140, y: 30 }))
  const candidate = createElement(doc, node({ parentId: frame, x: 20, y: 150 }))
  const other = createElement(doc, box({ kind: 'frame', x: 900, y: 200, w: 400, h: 300 }))
  const c = createElement(doc, box({ parentId: other, assetId: 'c', x: 20, y: 30 }))
  const cover = createElement(doc, box({ assetId: 'cover', x: 5000, y: 0 }))
  makeShotGroup(doc, frame)
  makeShotGroup(doc, other)
  doc.flush()
  const scene = new Scene(doc)
  const stopScene = doc.subscribe((change) => scene.apply(change))
  const listeners = new Set<(change: ViewChange) => void>()
  const state = {
    doc,
    scene,
    visibleIds: new Set([a, b, c, candidate]),
    highDetail: true,
    onViewChange: (callback: (change: ViewChange) => void) => {
      listeners.add(callback)
      return () => listeners.delete(callback)
    },
  }
  const root = new Element()
  const badges = new ShotBadges(state as unknown as Engine, root as unknown as HTMLElement)
  const view = (content = false) => {
    for (const callback of listeners) callback({ content })
  }
  const commit = () => {
    doc.flush()
    view(true)
  }
  cleanups.push(() => {
    badges.destroy()
    stopScene()
    doc.destroy()
  })
  return {
    doc,
    scene,
    state,
    root,
    badges,
    listeners,
    view,
    commit,
    frame,
    a,
    b,
    candidate,
    other,
    c,
    cover,
    badge: (id: string) => root.children.find((child) => child.dataset.shotBadge === id),
  }
}

describe('分镜组角标刷新', () => {
  it('只显示可见图片，编号保留整组顺序并使用场景世界坐标', () => {
    const f = fixture()
    f.state.visibleIds.delete(f.a)
    f.view()
    expect(f.root.children.map((child) => [child.dataset.shotBadge, child.textContent])).toEqual([
      [f.b, '2'],
      [f.c, '1'],
    ])
    expect(f.badge(f.b)?.style.transform).toBe('translate(248px, 238px)')
    expect(f.badge(f.c)?.style.transform).toBe('translate(928px, 238px)')
    expect(f.badge(f.candidate)).toBeUndefined()
  })

  it('连续几何预览跟随移动与遮挡，复用角标且不再扫描文档', () => {
    const f = fixture()
    const badge = f.badge(f.a)!
    const scans = vi.spyOn(f.doc, 'elements')
    for (let step = 1; step <= 30; step++) {
      f.scene.setTransient(new Map([[f.frame, { x: 100 + step, y: 200 + step }]]))
      f.view()
      expect(f.badge(f.a)).toBe(badge)
      expect(badge.style.transform).toBe(`translate(${128 + step}px, ${238 + step}px)`)
      expect(badge.textContent).toBe('1')
    }
    f.scene.setTransient(
      new Map([
        [f.frame, { x: 130, y: 230 }],
        [f.cover, { x: 158, y: 268 }],
      ]),
    )
    f.view()
    expect(badge.style.clipPath).toBe('path("M0,0Z")')
    expect(badge.inert).toBe(true)
    f.scene.clearTransient()
    f.view()
    expect(badge.style.transform).toBe('translate(128px, 238px)')
    expect(badge.style.clipPath).toBe('')
    expect(badge.inert).toBe(false)
    expect(scans).not.toHaveBeenCalled()
  })

  it('重排只在引擎内容通知时重新编号，同一文档通知不额外同步一次', () => {
    const f = fixture()
    const scans = vi.spyOn(f.doc, 'elements')
    moveShot(f.doc, f.frame, f.b, 0)
    scans.mockClear()
    f.doc.flush()
    expect(scans).not.toHaveBeenCalled()
    expect(f.badge(f.a)?.textContent).toBe('1')
    f.view(true)
    expect(f.badge(f.a)?.textContent).toBe('2')
    expect(f.badge(f.b)?.textContent).toBe('1')
    const refreshed = scans.mock.calls.length
    expect(refreshed).toBeGreaterThan(0)
    for (let frame = 0; frame < 20; frame++) f.view()
    expect(scans).toHaveBeenCalledTimes(refreshed)
  })

  it('移组后刷新两组编号，取消分镜组移除对应角标', () => {
    const f = fixture()
    setParent(f.doc, [f.b], f.other)
    f.commit()
    expect(f.badge(f.a)?.textContent).toBe('1')
    expect(f.badge(f.c)?.textContent).toBe('1')
    expect(f.badge(f.b)?.textContent).toBe('2')
    const rect = f.scene.rect(f.b)!
    expect(f.badge(f.b)?.style.transform).toBe(`translate(${rect.x + 8}px, ${rect.y + 8}px)`)
    clearShotGroup(f.doc, f.other)
    f.commit()
    expect(f.root.children.map((child) => child.dataset.shotBadge)).toEqual([f.a])
  })

  it('采用图片候选才加入编号，改用视频候选时撤下角标', () => {
    const f = fixture()
    const image: NodeResult = {
      id: 'image-result',
      port: 'out',
      runId: 'image-run',
      at: 1,
      value: { type: 'image', assetId: 'generated-image' },
    }
    const video: NodeResult = {
      id: 'video-result',
      port: 'out',
      runId: 'video-run',
      at: 2,
      value: { type: 'video', assetId: 'generated-video' },
    }
    addResults(f.doc, f.candidate, [video, image])
    f.commit()
    expect(f.badge(f.candidate)).toBeUndefined()
    adoptResult(f.doc, f.candidate, image.id)
    f.commit()
    expect(f.badge(f.candidate)?.textContent).toBe('3')
    adoptResult(f.doc, f.candidate, video.id)
    f.commit()
    expect(f.badge(f.candidate)).toBeUndefined()
  })

  it('低细节时内容变化也使编号失效，恢复显示时使用新顺序', () => {
    const f = fixture()
    f.state.highDetail = false
    f.view()
    expect(f.root.children).toHaveLength(0)
    moveShot(f.doc, f.frame, f.b, 0)
    f.commit()
    f.state.highDetail = true
    f.view()
    expect(f.badge(f.a)?.textContent).toBe('2')
    expect(f.badge(f.b)?.textContent).toBe('1')
  })

  it('销毁后取消订阅并移除所有角标，后续通知不再挂载 DOM', () => {
    const f = fixture()
    expect(f.listeners.size).toBe(1)
    f.badges.destroy()
    expect(f.listeners.size).toBe(0)
    expect(f.root.children).toHaveLength(0)
    moveShot(f.doc, f.frame, f.b, 0)
    f.commit()
    expect(f.root.children).toHaveLength(0)
  })
})
