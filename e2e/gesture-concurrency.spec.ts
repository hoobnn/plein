import { expect, type Page, test } from './fixtures'
import { centerOf, clickElement, newProject, waitEngine } from './canvas'

const errors = new WeakMap<Page, string[]>()
test.beforeEach(({ page }) => {
  const list: string[] = []
  errors.set(page, list)
  page.on('pageerror', (error) => list.push(error.message))
})
test.afterEach(({ page }) => expect(errors.get(page)).toEqual([]))

async function setup(page: Page) {
  await newProject(page)
  const ids = await page.evaluate(() => {
    const first = window.__plein.addNode({
      type: 'plein/text',
      name: '拖动对象',
      params: { text: '原正文' },
      x: 400,
      y: 200,
    })
    const other = window.__plein.addNode({
      type: 'plein/text',
      name: '另一个对象',
      params: {},
      x: 700,
      y: 200,
    })
    window.__plein.engine.zoomToFit([first, other])
    return { first, other }
  })
  await page.getByRole('treeitem', { name: '拖动对象 定位到画布', exact: true }).click()
  return ids
}
const geometry = (page: Page, id: string) =>
  page.evaluate((id) => {
    const engine = window.__plein.engine as Window['__plein']['engine'] & {
      scene: { rect(id: string): unknown }
    }
    return {
      saved: engine.doc.get(id) ? engine.doc.worldRect(id) : null,
      shown: engine.scene.rect(id) ?? null,
    }
  }, id)
async function drag(page: Page, id: string) {
  const p = await centerOf(page, id)
  await page.mouse.move(p.x, p.y)
  await page.mouse.down()
  await page.mouse.move(p.x + 70, p.y - 60, { steps: 4 })
  return p
}

for (const kind of ['move', 'marquee'] as const) {
  test(`${kind} 期间通过侧栏改选，旧手势不再覆盖选区或位置`, async ({ page }) => {
    const ids = await setup(page)
    const before = await geometry(page, ids.first)
    const p = await centerOf(page, ids.first)
    if (kind === 'move') await drag(page, ids.first)
    else {
      await page.keyboard.press('Escape')
      await page.mouse.move(p.x - 160, p.y - 130)
      await page.mouse.down()
      await page.mouse.move(p.x + 145, p.y + 130, { steps: 5 })
    }
    const row = page.getByRole('treeitem', { name: '另一个对象 定位到画布', exact: true })
    await row.press('Enter')
    await page.mouse.move(p.x + 100, p.y - 90)
    await page.mouse.up()
    expect(await page.evaluate(() => window.__plein.engine.selection.values())).toEqual([ids.other])
    await expect.poll(() => geometry(page, ids.first)).toEqual(before)
    await expect(page.getByText('节点或连线已更新，本次操作已取消', { exact: true })).toHaveCount(0)
  })
}

for (const change of ['move', 'resize', 'delete', 'text', 'other-move'] as const) {
  test(`拖动时同伴 ${change}，保留同伴变更并正确结束旧预览`, async ({ page, context }) => {
    const ids = await setup(page)
    const peerContext = await context.browser()!.newContext()
    try {
      const peer = await peerContext.newPage()
      peer.on('pageerror', (error) => errors.get(page)!.push(error.message))
      await peer.goto(page.url())
      await waitEngine(peer)
      await expect(peer.getByTestId('sync-status')).toHaveAttribute('data-sync', 'connected')
      await clickElement(peer, ids.first)
      const beforeOther = await geometry(page, ids.other)
      const beforeFirst = await geometry(page, ids.first)
      if (change === 'delete')
        await page.evaluate(
          (ids) => window.__plein.engine.selection.set([ids.first, ids.other]),
          ids,
        )
      const p = await drag(page, ids.first)
      if (change === 'move' || change === 'resize') {
        const at =
          change === 'move'
            ? await centerOf(peer, ids.first)
            : await peer.evaluate((id) => {
                const { engine } = window.__plein
                const r = engine.doc.worldRect(id)
                return engine.worldToClient(r.x + r.w, r.y + r.h)
              }, ids.first)
        await peer.mouse.move(at.x, at.y)
        await peer.mouse.down()
        await peer.mouse.move(at.x + 120, at.y - 40, { steps: 4 })
        await peer.mouse.up()
        const latest = await geometry(peer, ids.first)
        await expect.poll(async () => (await geometry(page, ids.first)).saved).toEqual(latest.saved)
        await expect.poll(() => geometry(page, ids.first)).toEqual(latest)
        await expect(
          page.getByRole('status').filter({ hasText: '节点或连线已更新，本次操作已取消' }),
        ).toHaveCount(1)
        if (change === 'move')
          await page.screenshot({ path: 'test-results/gesture-remote-position.png' })
        await page.mouse.move(p.x + 100, p.y - 80)
        await page.mouse.up()
        await expect.poll(() => geometry(page, ids.first)).toEqual(latest)
      } else if (change === 'delete') {
        await peer.keyboard.press('Delete')
        await expect.poll(() => geometry(page, ids.first)).toEqual({ saved: null, shown: null })
        await expect(
          page.getByText('节点或连线已更新，本次操作已取消', { exact: true }),
        ).toHaveCount(1)
        await page.mouse.up()
        await expect.poll(() => geometry(page, ids.other)).toEqual(beforeOther)
        await expect.poll(() => geometry(peer, ids.other)).toEqual(beforeOther)
      } else if (change === 'text') {
        await peer.getByRole('textbox', { name: '提示词', exact: true }).fill('同伴保留的新正文')
        await expect
          .poll(() =>
            page.evaluate((id) => window.__plein.engine.doc.get(id)?.params?.text, ids.first),
          )
          .toBe('同伴保留的新正文')
        const preview = await geometry(page, ids.first)
        expect(preview.shown).not.toEqual(preview.saved)
        await expect(
          page.getByText('节点或连线已更新，本次操作已取消', { exact: true }),
        ).toHaveCount(0)
        await page.mouse.move(p.x + 100, p.y - 80)
        await page.mouse.up()
        await expect
          .poll(async () => (await geometry(peer, ids.first)).saved)
          .toEqual((await geometry(page, ids.first)).saved)
        expect(
          await page.evaluate((id) => window.__plein.engine.doc.get(id)?.params?.text, ids.first),
        ).toBe('同伴保留的新正文')
        await page.getByRole('button', { name: '撤销', exact: true }).click()
        await expect.poll(() => geometry(page, ids.first)).toEqual(beforeFirst)
        expect(
          await page.evaluate((id) => window.__plein.engine.doc.get(id)?.params?.text, ids.first),
        ).toBe('同伴保留的新正文')
      } else {
        await clickElement(peer, ids.other)
        const at = await centerOf(peer, ids.other)
        await peer.mouse.move(at.x, at.y)
        await peer.mouse.down()
        await peer.mouse.move(at.x + 80, at.y - 50, { steps: 4 })
        await peer.mouse.up()
        const changed = await geometry(peer, ids.other)
        await expect.poll(() => geometry(page, ids.other)).toEqual(changed)
        const preview = await geometry(page, ids.first)
        expect(preview.shown).not.toEqual(preview.saved)
        await expect(
          page.getByText('节点或连线已更新，本次操作已取消', { exact: true }),
        ).toHaveCount(0)
        await page.mouse.up()
        expect((await geometry(page, ids.first)).saved).not.toEqual(beforeFirst.saved)
        expect(await geometry(page, ids.other)).toEqual(changed)
      }
    } finally {
      await peerContext.close()
    }
  })
}

test('框选中同伴移动对象，松手按最新位置重新确定选区', async ({ page, context }) => {
  const ids = await setup(page)
  const peerContext = await context.browser()!.newContext()
  try {
    const peer = await peerContext.newPage()
    peer.on('pageerror', (error) => errors.get(page)!.push(error.message))
    await peer.goto(page.url())
    await waitEngine(peer)
    await clickElement(peer, ids.first)
    await page.keyboard.press('Escape')
    const p = await centerOf(page, ids.first)
    await page.mouse.move(p.x - 160, p.y - 130)
    await page.mouse.down()
    await page.mouse.move(p.x + 145, p.y + 130, { steps: 4 })
    expect(await page.evaluate(() => window.__plein.engine.selection.values())).toEqual([ids.first])
    const at = await centerOf(peer, ids.first)
    await peer.mouse.move(at.x, at.y)
    await peer.mouse.down()
    await peer.mouse.move(at.x, at.y - 350, { steps: 6 })
    await peer.mouse.up()
    const latest = (await geometry(peer, ids.first)).saved
    await expect.poll(async () => (await geometry(page, ids.first)).saved).toEqual(latest)
    await page.mouse.up()
    expect(await page.evaluate(() => window.__plein.engine.selection.values())).toEqual([])
  } finally {
    await peerContext.close()
  }
})
