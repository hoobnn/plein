import { expect, type Page, test } from './fixtures'
import { newProject, waitEngine } from './canvas'

type Engine = import('../packages/canvas-core/src/engine').Engine
const pageErrors = new WeakMap<Page, string[]>()
test.beforeEach(({ page }) => {
  const errors: string[] = []
  pageErrors.set(page, errors)
  page.on('pageerror', (error) => errors.push(error.message))
})
test.afterEach(({ page }) => expect(pageErrors.get(page)).toEqual([]))
const restore = (page: Page) => page.getByRole('button', { name: '还原', exact: true })
const read = (page: Page) =>
  page.evaluate(() => ({
    nodes: [...window.__plein.engine.doc.elements()],
    edges: [...window.__plein.engine.doc.edges()],
  }))
async function setup(page: Page) {
  await newProject(page)
  const ids = await page.evaluate(() => {
    const a = window.__plein.addNode({
      type: 'plein/text',
      name: '整理来源',
      params: { text: '保留正文' },
      x: 400,
      y: 300,
    })
    const b = window.__plein.addNode({
      type: 'plein/image',
      name: '整理目标',
      params: {},
      x: 400,
      y: 300,
    })
    if (!window.__plein.connect([a, 'text'], [b, 'prompt'])) throw new Error('连接失败')
    const engine = window.__plein.engine as unknown as Engine
    engine.selection.clear()
    engine.doc.flush()
    engine.doc.undo.stopCapturing()
    engine.zoomToFit()
    return { a, b }
  })
  const before = await read(page)
  await page.getByRole('button', { name: '整理画布', exact: true }).click()
  await expect(restore(page)).toBeVisible()
  await expect.poll(() => read(page)).not.toEqual(before)
  return { ids, before, arranged: await read(page) }
}
test('还原本地整理保留同伴刚更新的名称和连线', { tag: '@core' }, async ({ page, context }) => {
  const f = await setup(page)
  const peerContext = await context.browser()!.newContext()
  try {
    const peer = await peerContext.newPage()
    await peer.goto(page.url())
    await waitEngine(peer)
    await expect(peer.getByTestId('sync-status')).toHaveAttribute('data-sync', 'connected')
    await peer.evaluate((id) => {
      const engine = window.__plein.engine as unknown as Engine
      engine.doc.ydoc.transact(
        () => engine.doc.mutable(id)!.set('name', '同伴的新名称'),
        engine.doc.origin,
      )
      engine.doc.flush()
    }, f.ids.a)
    await expect
      .poll(async () => (await read(page)).nodes.find((el) => el.id === f.ids.a)?.name)
      .toBe('同伴的新名称')
    await expect(restore(page)).toBeEnabled()
    await restore(page).click()
    const expected = {
      ...f.before,
      nodes: f.before.nodes.map((el) => (el.id === f.ids.a ? { ...el, name: '同伴的新名称' } : el)),
    }
    await expect.poll(() => read(page)).toEqual(expected)
    await expect.poll(() => read(peer)).toEqual(expected)
  } finally {
    await peerContext.close()
  }
})
