import { expect, type Page, test } from '@playwright/test'
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
for (const width of [1440, 320])
  test(`${width}px 整理提示在只读时明确禁用还原，恢复可写后可以还原`, async ({
    page,
  }, testInfo) => {
    const f = await setup(page)
    await page.setViewportSize({ width, height: 900 })
    const readonly = (value: boolean) =>
      page.evaluate((value) => {
        const engine = window.__plein.engine as unknown as Engine
        engine.doc.readOnly = value
        engine.refreshState()
      }, value)
    await readonly(true)
    await expect(restore(page)).toBeDisabled({ timeout: 1500 })
    await expect(page.getByText('当前只读，暂时无法还原', { exact: true })).toBeVisible()
    await expect
      .poll(() =>
        restore(page).evaluate((el) => {
          const r = el.closest('[role="status"]')!.getBoundingClientRect()
          return r.left >= 4 && r.right <= window.innerWidth - 4
        }),
      )
      .toBe(true)
    await page.screenshot({ path: testInfo.outputPath('arrange-readonly.png') })
    expect(await read(page)).toEqual(f.arranged)
    await readonly(false)
    await expect(restore(page)).toBeEnabled()
    await restore(page).click()
    await expect.poll(() => read(page)).toEqual(f.before)
  })
for (const change of ['undo-redo', 'edit-undo']) {
  test(`整理提示因 ${change} 失效后不会重新出现`, async ({ page }) => {
    const f = await setup(page)
    if (change === 'undo-redo') {
      await page.getByRole('button', { name: '撤销', exact: true }).click()
      await expect.poll(() => read(page)).toEqual(f.before)
    } else {
      await page.evaluate(() =>
        window.__plein.addNode({
          type: 'plein/text',
          name: '后续编辑',
          params: { text: '单独一步' },
          x: 1500,
          y: 900,
        }),
      )
      await expect.poll(async () => (await read(page)).nodes.length).toBe(3)
    }
    await expect(restore(page)).toHaveCount(0)
    await page
      .getByRole('button', { name: change === 'undo-redo' ? '重做' : '撤销', exact: true })
      .click()
    await expect.poll(() => read(page)).toEqual(f.arranged)
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    )
    await expect(restore(page)).toHaveCount(0, { timeout: 1500 })
  })
}
test('还原本地整理保留同伴刚更新的名称和连线', async ({ page, context }) => {
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
for (const width of [320, 390]) {
  test(`${width}px 整理提示完整可见且可点击，保留后不改变文档`, async ({ page }, testInfo) => {
    const f = await setup(page)
    await page.setViewportSize({ width, height: 900 })
    const status = page.getByRole('status').filter({ hasText: '是否保留此次整理结果？' })
    await expect(status).toBeVisible()
    await expect
      .poll(() =>
        status.evaluate((el) => {
          const r = el.getBoundingClientRect()
          return (
            r.left >= 4 &&
            r.right <= window.innerWidth - 4 &&
            r.top >= 64 &&
            r.bottom <= window.innerHeight
          )
        }),
      )
      .toBe(true)
    await page.screenshot({ path: testInfo.outputPath('arrange-confirm.png') })
    const keep = page.getByRole('button', { name: '保留', exact: true })
    await expect
      .poll(
        () =>
          keep.evaluate((el) => {
            const r = el.getBoundingClientRect()
            return (
              document
                .elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
                ?.closest('button') === el
            )
          }),
        { timeout: 1500 },
      )
      .toBe(true)
    if (width === 320) await keep.click()
    else {
      await keep.focus()
      await page.keyboard.press('Enter')
    }
    await expect(restore(page)).toHaveCount(0)
    await expect(page.getByRole('button', { name: '收起助手', exact: true })).toHaveCount(0)
    expect(await read(page)).toEqual(f.arranged)
  })
}
