import type { Engine } from '../packages/canvas-core/src/engine'
import type { Transient } from '../packages/canvas-core/src/scene'
import { expect, test } from './fixtures'
import { newProject, settle } from './canvas'

/** 真实 DOM 覆盖层在连续几何预览中复用正文，文档变更后仍刷新语义。 */
test('连续拖动预览跟随卡片和便签，分数尺寸不触发引用与参考图全图扫描', async ({ page }) => {
  await newProject(page)
  await page
    .locator('canvas')
    .first()
    .evaluate((canvas) => {
      const data = new DataTransfer()
      data.setData('text/plain', '## 便签跟随\n\n拖动过程中保留这段正文。')
      canvas.dispatchEvent(
        new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }),
      )
    })
  const ids = await page.evaluate(() => {
    const engine = window.__plein.engine as unknown as Engine
    const note = [...engine.doc.elements()].find((el) => el.kind === 'markdown')!.id
    const character = window.__plein.addNode({
      type: 'plein/character',
      name: '预览角色',
      params: {},
      x: 450,
      y: 0,
    })
    const text = window.__plein.addNode({
      type: 'plein/text',
      name: '预览文本',
      params: { text: '@预览角色 在清晨出门。' },
      x: 0,
      y: 0,
    })
    engine.doc.ydoc.transact(() => {
      engine.doc.mutable(note)!.set('x', 0)
      engine.doc.mutable(note)!.set('y', 350)
      // CSS 会规范化这个数字；失效判断必须使用原始尺寸，不能回读 CSS 字符串。
      engine.doc.mutable(character)!.set('w', 319.3333333333333)
      engine.doc.mutable(text)!.set('w', 319.3333333333333)
    }, engine.doc.origin)
    engine.doc.flush()
    engine.zoomToFit([note, character, text])
    return { note, character, text }
  })
  // 文档变更后的过期查询有防抖；等它完成，避免混入纯预览计数。
  await (await page.waitForResponse((response) => response.url().endsWith('/stale'))).finished()
  await settle(page, ids.text)
  await expect(page.locator('.plein-node-body mark')).toHaveAttribute('data-state', 'resolved')
  await expect(page.locator('.plein-md-preview:not([aria-hidden])')).toContainText('便签跟随')
  const result = await page.evaluate(async (ids) => {
    const engine = window.__plein.engine as unknown as Engine
    const preview = (patches: Map<string, Transient>) =>
      (engine as unknown as { preview(p: Map<string, Transient>): void }).preview(patches)
    const { doc } = engine
    const elements = doc.elements
    const edges = doc.edges
    const scans = { elements: 0, edges: 0 }
    // 连线需要随位置重画；单独计数，检测覆盖层是否又额外遍历全部边。
    const edgeLayer = (engine as unknown as { edges: { drawEdges(): void } }).edges
    const drawEdges = edgeLayer.drawEdges
    let edgeDraws = 0
    edgeLayer.drawEdges = function () {
      edgeDraws++
      return drawEdges.call(this)
    }
    const original = Object.values(ids).map((id) => doc.get(id)!)
    const card = [...document.querySelectorAll<HTMLElement>('.plein-node')].find(
      (el) => el.querySelector('.plein-node-title')?.textContent === '预览文本',
    )!
    const note = document.querySelector<HTMLElement>('.plein-md-preview:not([aria-hidden])')!
    const body = card.querySelector('.plein-node-body')!
    const noteContent = note.querySelector('.plein-md-content')!
    const content = noteContent.firstChild
    const first = body.firstChild
    doc.elements = function* () {
      scans.elements++
      yield* elements.call(this)
    }
    doc.edges = function* () {
      scans.edges++
      yield* edges.call(this)
    }
    try {
      for (let i = 1; i <= 50; i++) {
        preview(new Map(original.map((el) => [el.id, { x: el.x + i, y: el.y + i / 2 }])))
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        )
      }
      const text = original.find((el) => el.id === ids.text)!
      const markdown = original.find((el) => el.id === ids.note)!
      const at = engine.worldToClient(text.x + 50, text.y + 25)
      const noteAt = engine.worldToClient(markdown.x + 50, markdown.y + 25)
      const result = {
        scans: { ...scans, edgeDraws },
        sameBody: body.firstChild === first,
        sameNote: noteContent.firstChild === content,
        card: { x: card.getBoundingClientRect().x, y: card.getBoundingClientRect().y },
        at,
        note: { x: note.getBoundingClientRect().x, y: note.getBoundingClientRect().y },
        noteAt,
        documentUnchanged: original.every(
          (el) => doc.get(el.id)?.x === el.x && doc.get(el.id)?.y === el.y,
        ),
      }
      preview(new Map())
      return result
    } finally {
      doc.elements = elements
      doc.edges = edges
      edgeLayer.drawEdges = drawEdges
    }
  }, ids)
  expect(result.scans.elements).toBe(0)
  expect(result.scans.edges).toBe(result.scans.edgeDraws)
  expect(result.scans.edgeDraws).toBe(50)
  expect(result.sameBody).toBe(true)
  expect(result.sameNote).toBe(true)
  expect(result.documentUnchanged).toBe(true)
  expect(result.card.x).toBeCloseTo(result.at.x, 1)
  expect(result.card.y).toBeCloseTo(result.at.y, 1)
  expect(result.note.x).toBeCloseTo(result.noteAt.x, 1)
  expect(result.note.y).toBeCloseTo(result.noteAt.y, 1)
  await test.info().attach('preview-cost', {
    body: JSON.stringify(result),
    contentType: 'application/json',
  })
  await page.evaluate((ids) => {
    const engine = window.__plein.engine as unknown as Engine
    engine.doc.ydoc.transact(
      () => engine.doc.mutable(ids.character)!.set('name', '已改名角色'),
      engine.doc.origin,
    )
    engine.doc.flush()
    engine.selection.set([ids.text])
  }, ids)
  await expect(page.locator('.plein-node-title').filter({ hasText: '已改名角色' })).toHaveCount(1)
  await expect(page.locator('.plein-node-body mark')).toHaveAttribute('data-state', 'missing')
  await expect(
    page
      .locator('.plein-node')
      .filter({ has: page.locator('.plein-node-title', { hasText: '预览文本' }) }),
  ).toHaveAttribute('data-selected', 'true')
})

test('几何预览跨过尺寸阈值时仍更新生成卡片预设，取消后恢复', async ({ page }) => {
  await newProject(page)
  const id = await page.evaluate(() =>
    window.__plein.addNode({ type: 'plein/image', name: '预设尺寸', params: {}, x: 0, y: 0 }),
  )
  await page.evaluate((id) => (window.__plein.engine as unknown as Engine).zoomToFit([id]), id)
  await settle(page, id)
  const card = page
    .locator('.plein-node')
    .filter({ has: page.locator('.plein-node-title', { hasText: '预设尺寸' }) })
  const preview = async (small: boolean) =>
    page.evaluate(
      ({ id, small }) => {
        const engine = window.__plein.engine as unknown as {
          preview(p: Map<string, Transient>): void
        }
        engine.preview(small ? new Map([[id, { w: 120, h: 120 }]]) : new Map())
      },
      { id, small },
    )
  await expect(card.locator('.plein-node-tries')).toHaveCount(1)
  await preview(true)
  await expect(card.locator('.plein-node-tries')).toHaveCount(0)
  await expect(card).toHaveCSS('width', '120px')
  await preview(false)
  await expect(card.locator('.plein-node-tries')).toHaveCount(1)
})
