import { expect, type Page, test } from '@playwright/test'
import { newProject } from './canvas'

type PanEngine = Window['__plein']['engine'] & {
  camera: { x: number; y: number; zoom: number }
  flyTo(ids: string[]): void
  zoomTo(zoom: number): void
}
const position = (page: Page) =>
  page.evaluate(() => {
    const { x, y, zoom } = (window.__plein.engine as PanEngine).camera
    return { x, y, zoom }
  })
async function setup(page: Page) {
  await newProject(page)
  return page.evaluate(() => {
    const home = window.__plein.addNode({
      type: 'plein/text',
      name: '平移起点',
      params: {},
      x: 0,
      y: 0,
    })
    const far = window.__plein.addNode({
      type: 'plein/text',
      name: '平移终点',
      params: {},
      x: -4000,
      y: -2000,
    })
    window.__plein.engine.zoomToFit([home])
    return { home, far }
  })
}
async function drag(page: Page) {
  await page.mouse.move(1050, 700)
  await page.mouse.down({ button: 'middle' })
  await page.mouse.move(1200, 760, { steps: 4 })
}
async function flick(page: Page) {
  await drag(page)
  await page.mouse.up({ button: 'middle' })
  const released = await position(page)
  await expect.poll(() => position(page)).not.toEqual(released)
}

for (const action of ['fit', 'zoom', 'fly'] as const) {
  test(`松手惯性中 ${action} 接管镜头，不被旧平移继续推动`, async ({ page }) => {
    const ids = await setup(page)
    await flick(page)
    const expected = await page.evaluate(
      ({ action, id }) => {
        const engine = window.__plein.engine as PanEngine
        if (action === 'fit') engine.zoomToFit([id])
        if (action === 'zoom') engine.zoomTo(0.5)
        if (action === 'fly') engine.flyTo([id])
        const { x, y, zoom } = engine.camera
        return { x, y, zoom }
      },
      { action, id: ids.far },
    )
    await page.waitForTimeout(800)
    if (action === 'fly') {
      // 旧惯性不能在新动画的首帧把它取消；到达位置应与同目标的适应结果一致。
      const arrived = await position(page)
      await page.evaluate((id) => window.__plein.engine.zoomToFit([id]), ids.far)
      expect(await position(page)).toEqual(arrived)
    } else expect(await position(page)).toEqual(expected)
  })
}

for (const cancel of ['pointercancel', 'blur', 'lostcapture'] as const) {
  test(`平移拖动 ${cancel} 后停止手势和惯性，下一次拖动可恢复`, async ({ page }) => {
    await setup(page)
    await drag(page)
    await page.evaluate((cancel) => {
      const host = document.querySelector('canvas')!.parentElement!
      if (cancel === 'blur') window.dispatchEvent(new Event('blur'))
      else if (cancel === 'lostcapture') host.releasePointerCapture(1)
      else host.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1, bubbles: true }))
    }, cancel)
    // lostpointercapture 在浏览器下一次指针事件前派发。
    await page.mouse.move(1210, 765)
    const cancelled = await position(page)
    expect(
      await page
        .locator('canvas')
        .first()
        .evaluate((el) => el.parentElement!.style.cursor),
    ).toBe('')
    await page.mouse.move(1270, 790)
    await page.mouse.up({ button: 'middle' })
    await page.waitForTimeout(800)
    expect(await position(page)).toEqual(cancelled)
    await drag(page)
    expect(await position(page)).not.toEqual(cancelled)
    await page.mouse.up({ button: 'middle' })
  })
}

test('其他指针的移动和松手不接管当前平移，也不破坏捕获', async ({ page }) => {
  await setup(page)
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await drag(page)
  const before = await position(page)
  await page.evaluate(() => {
    const host = document.querySelector('canvas')!.parentElement!
    for (const type of ['pointermove', 'pointerup', 'pointercancel'])
      host.dispatchEvent(
        new PointerEvent(type, { pointerId: 2, clientX: 10, clientY: 10, bubbles: true }),
      )
  })
  expect(await position(page)).toEqual(before)
  await page.mouse.move(1250, 780)
  expect((await position(page)).x).toBeGreaterThan(before.x + 30)
  await page.mouse.up({ button: 'middle' })
  expect(errors).toEqual([])
})

test('按住停止移动后松手，不沿用旧速度重新启动惯性', async ({ page }) => {
  await setup(page)
  await drag(page)
  await page.waitForTimeout(200)
  const stopped = await position(page)
  await page.mouse.up({ button: 'middle' })
  await page.waitForTimeout(800)
  expect(await position(page)).toEqual(stopped)
})

for (const control of ['侧栏', '小地图', '单击', '滚轮'] as const) {
  test(`惯性中${control}的真实操作停止旧运动，不修改节点`, async ({ page }) => {
    await setup(page)
    if (control === '小地图')
      await page.getByRole('button', { name: '小地图', exact: true }).click()
    const before = await page.evaluate(() =>
      JSON.stringify([...window.__plein.engine.doc.elements()]),
    )
    await flick(page)
    if (control === '侧栏')
      await page
        .getByRole('treeitem', { name: '平移终点 定位到画布', exact: true })
        .getByRole('button', { name: '定位到画布' })
        .click()
    if (control === '小地图')
      await page.getByLabel('小地图：点击或拖动移动视口', { exact: true }).click()
    if (control === '单击') await page.mouse.click(1350, 720)
    if (control === '滚轮') {
      await page
        .locator('canvas')
        .first()
        .evaluate((el) => {
          el.parentElement!.addEventListener(
            'wheel',
            () => (document.documentElement.dataset.panWheelHandled = 'true'),
            { once: true },
          )
        })
      await page.mouse.move(1350, 720)
      await page.mouse.wheel(0, 150)
      await expect(page.locator('html')).toHaveAttribute('data-pan-wheel-handled', 'true')
    }
    const stopped = await position(page)
    await page.waitForTimeout(800)
    expect(await position(page)).toEqual(stopped)
    expect(
      await page.evaluate(() => JSON.stringify([...window.__plein.engine.doc.elements()])),
    ).toBe(before)
    if (control === '侧栏')
      await page.screenshot({ path: 'test-results/pan-inertia-navigation.png' })
  })
}

test('空格拖动失焦清除抓手状态，返回后普通点击不继续平移', async ({ page }) => {
  await setup(page)
  await page.keyboard.down('Space')
  await page.mouse.move(1050, 700)
  await page.mouse.down()
  await page.mouse.move(1200, 760, { steps: 4 })
  await page.evaluate(() => window.dispatchEvent(new Event('blur')))
  const stopped = await position(page)
  await page.mouse.move(1240, 780)
  await page.mouse.up()
  await page.keyboard.up('Space')
  await page.mouse.move(1280, 700)
  await page.mouse.down()
  await page.mouse.move(1320, 730, { steps: 4 })
  await page.mouse.up()
  expect(await position(page)).toEqual(stopped)
  expect(
    await page
      .locator('canvas')
      .first()
      .evaluate((el) => el.parentElement!.style.cursor),
  ).toBe('')
})

for (const motion of ['拖动', '惯性'] as const) {
  test(`${motion}中切换画布清理旧输入，新画布仍可正常平移`, async ({ page }) => {
    const ids = await setup(page)
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    const oldCamera = await page.evaluateHandle(() => (window.__plein.engine as PanEngine).camera)
    try {
      if (motion === '拖动') await drag(page)
      else await flick(page)
      // 指针仍被捕获时，通过键盘操作切换，覆盖未松手就卸载旧画布。
      await page.getByRole('button', { name: '切换画布', exact: true }).press('Enter')
      await page.getByRole('button', { name: '新建画布', exact: true }).press('Enter')
      await page
        .getByRole('dialog', { name: '新建画布', exact: true })
        .getByRole('textbox')
        .fill('平移恢复画布')
      await page.keyboard.press('Enter')
      await expect(page.getByRole('button', { name: '切换画布', exact: true })).toHaveText(
        '平移恢复画布',
      )
      await page.waitForFunction(
        (id) => window.__plein && !window.__plein.engine.doc.get(id),
        ids.home,
      )
      if (motion === '拖动') await page.mouse.up({ button: 'middle' })
      const old = await oldCamera.evaluate(({ x, y, zoom }) => ({ x, y, zoom }))
      const fresh = await position(page)
      await page.waitForTimeout(800)
      expect(await oldCamera.evaluate(({ x, y, zoom }) => ({ x, y, zoom }))).toEqual(old)
      expect(await position(page)).toEqual(fresh)
      expect(
        await page
          .locator('canvas')
          .first()
          .evaluate((el) => el.parentElement!.style.cursor),
      ).toBe('')
      await drag(page)
      expect(await position(page)).not.toEqual(fresh)
      await page.mouse.up({ button: 'middle' })
      expect(await page.evaluate(() => [...window.__plein.engine.doc.elements()].length)).toBe(0)
      expect(errors).toEqual([])
    } finally {
      await oldCamera.dispose()
    }
  })
}
