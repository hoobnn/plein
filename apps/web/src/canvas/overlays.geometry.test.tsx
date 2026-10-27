// @vitest-environment happy-dom
import { createElement } from '@plein/doc'
import { openDoc } from '@plein/doc/testing'
import { imageNode, textNode, characterNode } from '@plein/nodes'
import { describeNode } from '@plein/plugin-sdk'
import { expect, it, vi } from 'vite-plus/test'
import { mockResizeObserver } from '../testing/browser'
import { renderApp, resetStoreAfterEach } from '../testing/render'
import { mediaTestEngine } from '../shell/media-tools/testEngine'
import { useCatalog } from '../stores/catalog'
import { NodeCards } from './nodeCards'
import { CanvasOverlays } from './overlays'

resetStoreAfterEach(useCatalog)
it('连续小数尺寸几何预览复用卡片与便签正文，不扫描全图；语义更新仍刷新', () => {
  mockResizeObserver()
  useCatalog.setState({
    catalog: {
      plugins: [],
      providers: [],
      elements: [],
      defaultModels: {},
      templates: [],
      prompts: [],
      nodes: [imageNode, textNode, characterNode].map((n) => ({
        ...describeNode(n, 'plein/core'),
        executable: true,
      })),
    },
  })
  const doc = openDoc()
  const add = (data: Parameters<typeof createElement>[1]) => createElement(doc, data)
  const character = add({
    kind: 'node',
    nodeType: 'plein/character',
    name: '角色',
    x: 400,
    y: 0,
    w: 319.3333333333333,
    h: 180,
    params: {},
  })
  const text = add({
    kind: 'node',
    nodeType: 'plein/text',
    name: '文本',
    x: 0,
    y: 0,
    w: 319.3333333333333,
    h: 180,
    params: { text: '@角色 在清晨出门。' },
  })
  const note = add({
    kind: 'markdown',
    text: '## 便签跟随\n\n正文内容',
    x: 0,
    y: 300,
    w: 319.3333333333333,
    h: 100,
  })
  doc.flush()
  const engine = mediaTestEngine(doc)
  Object.assign(engine, {
    visibleIds: [character, text, note],
    highDetail: true,
    fitContent: vi.fn(),
  })
  const f = renderApp(<div />)
  const cards = new NodeCards(engine, f.container, {
    canvasId: null,
    play: vi.fn(),
    run: vi.fn(),
    cancel: vi.fn(),
    applyPreset: vi.fn(),
    thumbUrl: (id) => `/assets/${id}`,
  })
  const overlays = new CanvasOverlays(engine, f.container, document.createElement('div'), {
    originalUrl: (id) => `/assets/${id}`,
  })
  try {
    const body = f.container.querySelector('.plein-node-body mark')!
    expect(body.getAttribute('data-state')).toBe('resolved')
    const content = f.container.querySelector('.plein-md-content')!
    const first = content.firstChild
    const elements = vi.spyOn(doc, 'elements'),
      edges = vi.spyOn(doc, 'edges')
    for (let i = 0; i < 50; i++) {
      engine.scene.setTransient(
        new Map([
          [text, { x: i, y: i / 2 }],
          [note, { x: i, y: 300 + i / 2 }],
        ]),
      )
      cards.sync(false)
      overlays.sync(false)
    }
    expect(elements).not.toHaveBeenCalled()
    expect(edges).not.toHaveBeenCalled()
    expect(f.container.querySelector('.plein-node-body mark')).toBe(body)
    expect(content.firstChild).toBe(first)
    expect(doc.get(text)!.x).toBe(0)
    expect(content.parentElement!.style.transform).toBe('translate(49px, 324.5px)')
    doc.mutable(character)!.set('name', '改名角色')
    doc.flush()
    cards.sync()
    expect(f.container.querySelector('.plein-node-body mark')!.getAttribute('data-state')).toBe(
      'missing',
    )
  } finally {
    cards.destroy()
    overlays.destroy()
    doc.destroy()
  }
})

it('预览尺寸跨过阈值时更新生成卡片预设，取消后恢复', () => {
  const descriptor = { ...describeNode(imageNode, 'plein/core'), executable: true }
  useCatalog.setState({
    catalog: {
      plugins: [],
      providers: [],
      elements: [],
      defaultModels: {},
      templates: [],
      nodes: [descriptor],
      prompts: [{ id: 'p', title: '预设', template: '画面', plugin: 'plein/core' }],
    },
  })
  const doc = openDoc()
  const id = createElement(doc, {
    kind: 'node',
    nodeType: imageNode.type,
    x: 0,
    y: 0,
    w: 320,
    h: 180,
    params: {},
  })
  doc.flush()
  const engine = mediaTestEngine(doc)
  Object.assign(engine, { visibleIds: [id], highDetail: true })
  const f = renderApp(<div />)
  const cards = new NodeCards(engine, f.container, {
    canvasId: null,
    play: vi.fn(),
    run: vi.fn(),
    cancel: vi.fn(),
    applyPreset: vi.fn(),
    thumbUrl: (id) => `/assets/${id}`,
  })
  try {
    expect(f.container.querySelector('.plein-node-tries')).toBeTruthy()
    engine.scene.setTransient(new Map([[id, { w: 120, h: 120 }]]))
    cards.sync(false)
    expect(f.container.querySelector('.plein-node-tries')).toBeNull()
    expect(f.container.querySelector<HTMLElement>('.plein-node')!.style.width).toBe('120px')
    engine.scene.clearTransient()
    cards.sync(false)
    expect(f.container.querySelector('.plein-node-tries')).toBeTruthy()
    expect(doc.get(id)!.w).toBe(320)
  } finally {
    cards.destroy()
    doc.destroy()
  }
})
