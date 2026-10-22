import { expect, type Page, test } from '@playwright/test'
import { newProject } from './canvas'

type PanEngine = Window['__plein']['engine'] & {
  camera: { x: number; y: number; zoom: number }
  flyTo(ids: string[]): void
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
  // 松手距最后一次移动超过 100ms 不起惯性。Playwright 要等上一个事件处理完、渲染出一帧才发下一个，
  // 软件渲染慢的机器上这一帧就超过 100ms，等于停住再松手；最后一次移动和松手一起发出才是甩动。
  await page.mouse.move(1050, 700)
  await page.mouse.down({ button: 'middle' })
  await page.mouse.move(1162, 730, { steps: 3 })
  await Promise.all([page.mouse.move(1200, 760), page.mouse.up({ button: 'middle' })])
  const released = await position(page)
  await expect.poll(() => position(page), { timeout: 1_000 }).not.toEqual(released)
}

for (const action of ['fly'] as const) {
  test(`松手惯性中 ${action} 接管镜头，不被旧平移继续推动`, async ({ page }) => {
    const ids = await setup(page)
    await flick(page)
    await page.evaluate((id) => (window.__plein.engine as PanEngine).flyTo([id]), ids.far)
    await page.waitForTimeout(800)
    // 旧惯性不能在新动画的首帧把它取消；到达位置应与同目标的适应结果一致。
    const arrived = await position(page)
    await page.evaluate((id) => window.__plein.engine.zoomToFit([id]), ids.far)
    expect(await position(page)).toEqual(arrived)
  })
}

for (const cancel of ['pointercancel'] as const) {
  test(`平移拖动 ${cancel} 后停止手势和惯性，下一次拖动可恢复`, async ({ page }) => {
    await setup(page)
    await drag(page)
    await page.evaluate(() => {
      const host = document.querySelector('canvas')!.parentElement!
      host.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1, bubbles: true }))
    })
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

for (const control of ['侧栏', '单击'] as const) {
  test(`惯性中${control}的真实操作停止旧运动，不修改节点`, async ({ page }) => {
    await setup(page)
    const before = await page.evaluate(() =>
      JSON.stringify([...window.__plein.engine.doc.elements()]),
    )
    await flick(page)
    if (control === '侧栏')
      await page
        .getByRole('treeitem', { name: '平移终点 定位到画布', exact: true })
        .getByRole('button', { name: '定位到画布' })
        .click()
    if (control === '单击') await page.mouse.click(1350, 720)
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
