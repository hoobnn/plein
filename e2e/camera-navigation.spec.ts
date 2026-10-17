import { expect, type Page, test } from '@playwright/test'
import { centerOf, newProject } from './canvas'

type NavigationEngine = Window['__plein']['engine'] & {
  camera: { x: number; y: number; zoom: number; centerOn(x: number, y: number): void }
  flyTo(ids: string[]): void
  zoomTo(zoom: number): void
  flight: unknown
}
async function setup(page: Page) {
  await newProject(page)
  return page.evaluate(() => {
    const add = (name: string, x: number, y: number) =>
      window.__plein.addNode({ type: 'plein/text', name, params: {}, x, y })
    const home = add('当前节点', 0, 0)
    const far = add('远处节点', 4000, -2500)
    const latest = add('最新节点', -3000, 2000)
    window.__plein.engine.zoomToFit([home])
    return { home, far, latest }
  })
}
const camera = (page: Page) =>
  page.evaluate(() => {
    const { camera } = window.__plein.engine as NavigationEngine
    return { x: camera.x, y: camera.y, zoom: camera.zoom }
  })

for (const action of ['fit', 'zoom', 'center'] as const) {
  test(`平滑定位中 ${action} 立即接管镜头，旧动画不再拉回`, async ({ page }) => {
    const ids = await setup(page)
    const expected = await page.evaluate(
      ({ ids, action }) => {
        const engine = window.__plein.engine as NavigationEngine
        engine.flyTo([ids.far])
        if (action === 'fit') engine.zoomToFit([ids.latest])
        if (action === 'zoom') engine.zoomTo(0.5)
        if (action === 'center') {
          const r = engine.doc.worldRect(ids.latest)
          engine.camera.centerOn(r.x + r.w / 2, r.y + r.h / 2)
        }
        const { x, y, zoom } = engine.camera
        return { x, y, zoom }
      },
      { ids, action },
    )
    // 超过现有 560ms 镜头动画时长，确认后续帧不会覆盖刚完成的导航。
    await page.waitForTimeout(700)
    expect(await camera(page)).toEqual(expected)
    if (action !== 'zoom') {
      const p = await centerOf(page, ids.latest)
      expect(p.x).toBeGreaterThan(296)
      expect(p.x).toBeLessThan(1428)
      expect(p.y).toBeGreaterThan(64)
      expect(p.y).toBeLessThan(836)
    }
  })
}

test('连续平滑定位以最后一个目标为准，滚轮操作能停止正在进行的定位', async ({ page }) => {
  const ids = await setup(page)
  await page.evaluate((ids) => {
    const engine = window.__plein.engine as NavigationEngine
    engine.flyTo([ids.far])
    engine.flyTo([ids.latest])
  }, ids)
  await page.waitForTimeout(700)
  const p = await centerOf(page, ids.latest)
  expect(p.x).toBeGreaterThan(296)
  expect(p.x).toBeLessThan(1428)
  expect(p.y).toBeGreaterThan(64)
  expect(p.y).toBeLessThan(836)
  await page.mouse.move(1100, 700)
  await page.evaluate((ids) => (window.__plein.engine as NavigationEngine).flyTo([ids.far]), ids)
  await page.mouse.wheel(0, 160)
  await expect
    .poll(() => page.evaluate(() => !!(window.__plein.engine as NavigationEngine).flight))
    .toBe(false)
  const manual = await camera(page)
  await page.waitForTimeout(700)
  expect(await camera(page)).toEqual(manual)
})

for (const control of ['侧栏', '缩放菜单', '小地图'] as const) {
  test(`${control} 的实际操作在动画中接管镜头，不改写节点`, async ({ page }) => {
    const ids = await setup(page)
    const before = await page.evaluate(() =>
      JSON.stringify([...window.__plein.engine.doc.elements()]),
    )
    let target = page
      .getByRole('treeitem', { name: '最新节点 定位到画布', exact: true })
      .getByRole('button', { name: '定位到画布' })
    if (control === '缩放菜单') {
      await page.getByRole('button', { name: '缩放选项', exact: true }).click()
      target = page.getByRole('button', { name: '缩放至 50%', exact: true })
    }
    if (control === '小地图') {
      await page.getByRole('button', { name: '小地图', exact: true }).click()
      target = page.getByLabel('小地图：点击或拖动移动视口', { exact: true })
    }
    // 在真实输入事件的捕获阶段开始旧导航，保证按钮处理时动画仍在运行，避免依赖机器速度。
    await target.evaluate(
      (element, { id, event }) => {
        element.addEventListener(
          event,
          () => (window.__plein.engine as NavigationEngine).flyTo([id]),
          { capture: true, once: true },
        )
      },
      { id: ids.far, event: control === '小地图' ? 'pointerdown' : 'click' },
    )
    await target.click()
    expect(await page.evaluate(() => !!(window.__plein.engine as NavigationEngine).flight)).toBe(
      false,
    )
    const expected = await camera(page)
    await page.waitForTimeout(700)
    expect(await camera(page)).toEqual(expected)
    expect(
      await page.evaluate(() => JSON.stringify([...window.__plein.engine.doc.elements()])),
    ).toBe(before)
    if (control === '缩放菜单')
      await expect(page.getByRole('button', { name: '缩放选项', exact: true })).toHaveText('50%')
    if (control === '侧栏') {
      await expect(page.getByRole('textbox', { name: '提示词', exact: true })).toBeVisible()
      await page.screenshot({ path: 'test-results/camera-navigation-sidebar.png' })
    }
  })
}

test('动画中中键拖动画布立即接管，按住期间镜头不回弹', async ({ page }) => {
  const ids = await setup(page)
  await page.mouse.move(1100, 700)
  await page.evaluate((ids) => (window.__plein.engine as NavigationEngine).flyTo([ids.far]), ids)
  await page.mouse.down({ button: 'middle' })
  const before = await camera(page)
  await page.mouse.move(1210, 760, { steps: 5 })
  const dragged = await camera(page)
  expect(dragged.x).toBeGreaterThan(before.x + 90)
  expect(dragged.y).toBeGreaterThan(before.y + 40)
  await page.waitForTimeout(700)
  expect(await camera(page)).toEqual(dragged)
  await page.mouse.up({ button: 'middle' })
})
