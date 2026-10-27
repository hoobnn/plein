import { expect, type Page, test } from './fixtures'
import { centerOf, clickElement, handleOf, newProject, waitEngine } from './canvas'

const pageErrors = new WeakMap<Page, string[]>()
test.beforeEach(({ page }) => {
  const errors: string[] = []
  pageErrors.set(page, errors)
  page.on('pageerror', (error) => errors.push(error.message))
})
test.afterEach(({ page }) => expect(pageErrors.get(page)).toEqual([]))

async function setup(page: Page) {
  await newProject(page)
  const id = await page.evaluate(() =>
    window.__plein.addNode({
      type: 'plein/text',
      name: '手势节点',
      params: { text: '保留正文' },
      x: 400,
      y: 200,
    }),
  )
  await clickElement(page, id)
  return id
}
const geometry = (page: Page, id: string) =>
  page.evaluate((id) => {
    const engine = window.__plein.engine as Window['__plein']['engine'] & {
      scene: { rect(id: string): { x: number; y: number; w: number; h: number } }
    }
    return { saved: engine.doc.worldRect(id), shown: engine.scene.rect(id) }
  }, id)
async function frames(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  )
}
async function cancel(page: Page, kind: string) {
  if (kind === 'Escape') await page.keyboard.press('Escape')
  else
    await page.evaluate((kind) => {
      const host = document.querySelector('canvas')!.parentElement!
      if (kind === 'blur') window.dispatchEvent(new Event('blur'))
      else if (kind === 'lostcapture') host.releasePointerCapture(1)
      else host.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1, bubbles: true }))
    }, kind)
  if (kind === 'lostcapture') await page.mouse.move(1200, 700)
  await frames(page)
}
for (const [operation, cancellation] of [
  ['move', 'pointercancel'],
  ['move', 'blur'],
  ['move', 'lostcapture'],
  ['move', 'Escape'],
  ['resize', 'pointercancel'],
] as const) {
  test(`${operation} 的 ${cancellation} 撤销预览而不写位置，后续拖动可用`, async ({ page }) => {
    const id = await setup(page)
    const before = await geometry(page, id)
    const p =
      operation === 'move'
        ? await centerOf(page, id)
        : await page.evaluate((id) => {
            const { engine } = window.__plein
            const r = engine.doc.worldRect(id)
            return engine.worldToClient(r.x + r.w, r.y + r.h)
          }, id)
    await page.mouse.move(p.x, p.y)
    await page.mouse.down()
    await page.mouse.move(p.x + 80, p.y + 55, { steps: 5 })
    await expect.poll(async () => (await geometry(page, id)).shown).not.toEqual(before.shown)
    expect((await geometry(page, id)).saved).toEqual(before.saved)
    await cancel(page, cancellation)
    await expect.poll(() => geometry(page, id)).toEqual(before)
    await page.mouse.move(p.x + 120, p.y + 80)
    await page.mouse.up()
    expect(await geometry(page, id)).toEqual(before)
    await clickElement(page, id)
    const center = await centerOf(page, id)
    await page.mouse.move(center.x, center.y)
    await page.mouse.down()
    await page.mouse.move(center.x + 90, center.y - 60, { steps: 5 })
    await page.mouse.up()
    expect((await geometry(page, id)).saved).not.toEqual(before.saved)
    await page.getByRole('button', { name: '撤销', exact: true }).click()
    await expect.poll(() => geometry(page, id)).toEqual(before)
  })
}

test('其他指针不能提交或取消节点移动，当前指针仍可完成一次可撤销操作', async ({ page }) => {
  const id = await setup(page)
  const before = await geometry(page, id)
  const p = await centerOf(page, id)
  await page.mouse.move(p.x, p.y)
  await page.mouse.down()
  await page.mouse.move(p.x + 80, p.y - 50, { steps: 5 })
  const preview = await geometry(page, id)
  await page.evaluate(() => {
    const host = document.querySelector('canvas')!.parentElement!
    for (const type of ['pointermove', 'pointerup', 'pointercancel'])
      host.dispatchEvent(
        new PointerEvent(type, { pointerId: 2, clientX: 0, clientY: 0, bubbles: true }),
      )
  })
  expect(await geometry(page, id)).toEqual(preview)
  await page.mouse.move(p.x + 120, p.y - 70)
  await page.mouse.up()
  expect((await geometry(page, id)).saved).not.toEqual(before.saved)
  await page.getByRole('button', { name: '撤销', exact: true }).click()
  await expect.poll(() => geometry(page, id)).toEqual(before)
})

async function connections(page: Page) {
  await newProject(page)
  return page.evaluate(() => {
    const source = window.__plein.addNode({
      type: 'plein/image',
      name: '连线来源',
      params: {},
      x: 100,
      y: 100,
    })
    const a = window.__plein.addNode({
      type: 'plein/image-process',
      name: '原目标',
      params: {},
      x: 650,
      y: 100,
    })
    const b = window.__plein.addNode({
      type: 'plein/image-process',
      name: '新目标',
      params: {},
      x: 650,
      y: 600,
    })
    if (!window.__plein.connect([source, 'images'], [a, 'image'])) throw new Error('测试连线未建立')
    window.__plein.engine.zoomToFit([source, a, b])
    return { source, a, b }
  })
}
const edges = (page: Page) => page.evaluate(() => [...window.__plein.engine.doc.edges()])
for (const cancellation of ['pointercancel'] as const) {
  test(`拾起已有连线 ${cancellation} 不删除原边，也不写入临时连接`, async ({ page }) => {
    const ids = await connections(page)
    const before = await edges(page)
    expect(before).toHaveLength(1)
    const p = await handleOf(page, ids.a, 'in')
    await page.mouse.move(p.x, p.y)
    await page.mouse.down()
    await page.mouse.move(p.x - 100, p.y + 50, { steps: 4 })
    expect(await edges(page)).toEqual(before)
    if (cancellation === 'pointercancel')
      await page.screenshot({ path: 'test-results/gesture-edge-preview.png' })
    await cancel(page, cancellation)
    await page.mouse.up()
    expect(await edges(page)).toEqual(before)
    if (cancellation === 'pointercancel')
      await page.screenshot({ path: 'test-results/gesture-edge-cancelled.png' })
    await expect(page.getByRole('dialog', { name: '添加节点', exact: true })).toHaveCount(0)
  })
}

test('已有连线改接后一步撤销还原原边，放回原口不改变边的标识', async ({ page }) => {
  const ids = await connections(page)
  const before = await edges(page)
  const from = await handleOf(page, ids.a, 'in')
  const to = await handleOf(page, ids.b, 'in')
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(to.x, to.y, { steps: 8 })
  expect(await edges(page)).toEqual(before)
  await page.mouse.up()
  const changed = await edges(page)
  expect(changed).toHaveLength(1)
  expect(changed[0]!.to[0]).toBe(ids.b)
  await page.getByRole('button', { name: '撤销', exact: true }).click()
  expect(await edges(page)).toEqual(before)
  await page.getByRole('button', { name: '重做', exact: true }).click()
  expect(await edges(page)).toEqual(changed)
  const same = await handleOf(page, ids.b, 'in')
  await page.mouse.move(same.x, same.y)
  await page.mouse.down()
  await page.mouse.up()
  expect(await edges(page)).toEqual(changed)
})

test('已有连线确认丢到空白处才删除，撤销恢复原标识且节点保留', async ({ page }) => {
  const ids = await connections(page)
  const before = await edges(page)
  const p = await handleOf(page, ids.a, 'in')
  await page.mouse.move(p.x, p.y)
  await page.mouse.down()
  await page.mouse.move(1360, 110, { steps: 8 })
  expect(await edges(page)).toEqual(before)
  await page.mouse.up()
  expect(await edges(page)).toEqual([])
  await expect(page.getByRole('dialog', { name: '添加节点', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: '撤销', exact: true }).click()
  expect(await edges(page)).toEqual(before)
  expect(await page.evaluate(() => [...window.__plein.engine.doc.elements()].length)).toBe(3)
})

test('新连线取消不弹添加菜单，框选失焦恢复先前选区', async ({ page }) => {
  const ids = await connections(page)
  const before = await edges(page)
  const p = await handleOf(page, ids.source, 'out')
  await page.mouse.move(p.x, p.y)
  await page.mouse.down()
  await page.mouse.move(1360, 110, { steps: 8 })
  await cancel(page, 'pointercancel')
  await page.mouse.up()
  expect(await edges(page)).toEqual(before)
  await expect(page.getByRole('dialog', { name: '添加节点', exact: true })).toHaveCount(0)
  await clickElement(page, ids.a)
  await page.keyboard.press('Escape')
  const center = await centerOf(page, ids.a)
  await page.mouse.move(center.x - 220, center.y - 190)
  await page.mouse.down()
  await page.mouse.move(center.x + 220, center.y + 190, { steps: 6 })
  expect(await page.evaluate(() => window.__plein.engine.selection.values())).toContain(ids.a)
  await cancel(page, 'blur')
  await page.mouse.up()
  expect(await page.evaluate(() => window.__plein.engine.selection.values())).toEqual([])
})

test('节点拖动中滚轮接管镜头时取消旧位置预览', async ({ page }) => {
  const id = await setup(page)
  const before = await geometry(page, id)
  const p = await centerOf(page, id)
  await page.mouse.move(p.x, p.y)
  await page.mouse.down()
  await page.mouse.move(p.x + 80, p.y - 60, { steps: 5 })
  expect((await geometry(page, id)).shown).not.toEqual(before.shown)
  await page.mouse.wheel(0, 100)
  await expect.poll(() => geometry(page, id)).toEqual(before)
  await page.mouse.up()
  expect((await geometry(page, id)).saved).toEqual(before.saved)
})

test('正常缩放提交尺寸，撤销重做同步显示且不改变正文', async ({ page }) => {
  const id = await setup(page)
  const before = await geometry(page, id)
  const p = await page.evaluate((id) => {
    const { engine } = window.__plein
    const r = engine.doc.worldRect(id)
    return engine.worldToClient(r.x + r.w, r.y + r.h)
  }, id)
  await page.mouse.move(p.x, p.y)
  await page.mouse.down()
  await page.mouse.move(p.x + 80, p.y + 55, { steps: 5 })
  await page.mouse.up()
  const after = await geometry(page, id)
  expect(after.saved.w).toBeCloseTo(before.saved.w + 80)
  expect(after.saved.h).toBeCloseTo(before.saved.h + 55)
  await page.getByRole('button', { name: '撤销', exact: true }).click()
  await expect.poll(() => geometry(page, id)).toEqual(before)
  await page.getByRole('button', { name: '重做', exact: true }).click()
  await expect.poll(() => geometry(page, id)).toEqual(after)
  expect(await page.evaluate((id) => window.__plein.engine.doc.get(id)?.params?.text, id)).toBe(
    '保留正文',
  )
})

test('分组左上角缩放取消恢复全部预览，确认与撤销保持子节点世界位置', async ({ page }) => {
  await newProject(page)
  const children = await page.evaluate(() => {
    const ids = [400, 800].map((x) =>
      window.__plein.addNode({ type: 'plein/text', name: `子节点${x}`, params: {}, x, y: 200 }),
    )
    window.__plein.engine.selection.set(ids)
    return ids
  })
  await page.keyboard.press('ControlOrMeta+g')
  const id = await page.evaluate(
    () => [...window.__plein.engine.doc.elements()].find((el) => el.kind === 'frame')!.id,
  )
  await page.evaluate((id) => window.__plein.engine.zoomToFit([id]), id)
  const before = await geometry(page, id)
  const childBefore = await Promise.all(children.map((child) => geometry(page, child)))
  const p = await page.evaluate((id) => {
    const { engine } = window.__plein
    const r = engine.doc.worldRect(id)
    return engine.worldToClient(r.x, r.y)
  }, id)
  const resize = async () => {
    await page.mouse.move(p.x, p.y)
    await page.mouse.down()
    await page.mouse.move(p.x - 50, p.y - 35, { steps: 5 })
  }
  await resize()
  expect((await geometry(page, id)).shown).not.toEqual(before.shown)
  await cancel(page, 'Escape')
  await page.mouse.up()
  expect(await geometry(page, id)).toEqual(before)
  expect(await Promise.all(children.map((child) => geometry(page, child)))).toEqual(childBefore)
  await resize()
  await page.mouse.up()
  expect((await geometry(page, id)).saved).not.toEqual(before.saved)
  expect(await Promise.all(children.map((child) => geometry(page, child)))).toEqual(childBefore)
  await page.getByRole('button', { name: '撤销', exact: true }).click()
  await expect.poll(() => geometry(page, id)).toEqual(before)
  expect(await Promise.all(children.map((child) => geometry(page, child)))).toEqual(childBefore)
})

test('拾线期间同伴删除原边，旧手势不会在松手时重新接出连线', async ({ page, context }) => {
  const ids = await connections(page)
  const peerContext = await context.browser()!.newContext()
  try {
    const peer = await peerContext.newPage()
    peer.on('pageerror', (error) => pageErrors.get(page)!.push(error.message))
    await peer.goto(page.url())
    await waitEngine(peer)
    await expect(peer.getByTestId('sync-status')).toHaveAttribute('data-sync', 'connected')
    const from = await handleOf(page, ids.a, 'in')
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(from.x - 80, from.y + 40, { steps: 4 })
    const remote = await handleOf(peer, ids.a, 'in')
    await peer.mouse.move(remote.x, remote.y)
    await peer.mouse.down()
    await peer.mouse.move(1360, 110, { steps: 6 })
    await peer.mouse.up()
    await expect.poll(() => edges(page)).toEqual([])
    const to = await handleOf(page, ids.b, 'in')
    await page.mouse.move(to.x, to.y, { steps: 4 })
    await page.mouse.up()
    expect(await edges(page)).toEqual([])
    expect(await edges(peer)).toEqual([])
  } finally {
    await peerContext.close()
  }
})
