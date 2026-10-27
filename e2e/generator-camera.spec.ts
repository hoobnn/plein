import { expect, test } from '@playwright/test'
import { clickElement, newProject, settle } from './canvas'

type PanEngine = Window['__plein']['engine'] & { camera: { panBy(x: number, y: number): void } }
async function setup(page: import('@playwright/test').Page) {
  await page.setViewportSize({ width: 1000, height: 560 })
  await newProject(page)
  const id = await page.evaluate(() =>
    window.__plein.addNode({
      type: 'plein/text',
      name: '相机布局',
      params: { text: '保持正文' },
      x: 400,
      y: 200,
    }),
  )
  await clickElement(page, id)
  // 编辑器固定在卡片下方，始终展开，不再有紧凑模式。
  await expect(page.getByTestId('generator')).toHaveAttribute('data-compact', 'false')
  await expect(page.getByTestId('node-editor')).toHaveAttribute('data-placement', 'below')
  return id
}

/** 编辑器固定在卡片下方；横向留在可见画布里，窗口不够宽就按可用宽度收 */
async function expectBelow(page: import('@playwright/test').Page, id: string) {
  await expect
    .poll(() =>
      page.evaluate((id) => {
        const engine = window.__plein.engine
        const rect = engine.doc.worldRect(id)
        const tl = engine.worldToClient(rect.x, rect.y)
        const br = engine.worldToClient(rect.x + rect.w, rect.y + rect.h)
        const panel = document.querySelector('[data-testid="node-editor"]')!.getBoundingClientRect()
        const left = engine.camera.insets.left
        const right = innerWidth - engine.camera.insets.right
        const width = Math.max(320, Math.min(840, right - left))
        const expected = Math.max(left, Math.min((tl.x + br.x - width) / 2, right - width))
        // 纵向：编辑器固定在卡片下方，不盖住卡片（卡片上的输出端口要能直接拖线）
        const top = br.y + 12
        return Math.max(Math.abs(panel.top - top), Math.abs(panel.x - expected))
      }, id),
    )
    .toBeLessThan(1)
}

test('中键平移后编辑器跟着卡片走，节点文档不变', async ({ page }) => {
  const id = await setup(page)
  const before = await page.evaluate(() => [...window.__plein.engine.doc.elements()])
  const panel = page.getByTestId('generator')
  await page.mouse.move(950, 300)
  await page.mouse.down({ button: 'middle' })
  try {
    await page.mouse.move(950, 120, { steps: 5 })
    await expect(panel.getByRole('textbox', { name: '提示词', exact: true })).toBeVisible()
    await expectBelow(page, id)
    // 外部相机接管结束旧平移，避免松手惯性改变下一步的起点。
    await page.evaluate(() => (window.__plein.engine as PanEngine).camera.panBy(0, 0))
  } finally {
    await page.mouse.up({ button: 'middle' })
  }
  await expectBelow(page, id)
  expect(await page.evaluate(() => [...window.__plein.engine.doc.elements()])).toEqual(before)
  expect(await page.evaluate(() => window.__plein.engine.selection.values())).toEqual([id])
})

test('平移往返保持编辑内容，编辑器始终贴在卡片下方', async ({ page }) => {
  const id = await setup(page)
  const panel = page.getByTestId('generator')
  const prompt = panel.getByRole('textbox', { name: '提示词', exact: true })
  await prompt.fill('主动编辑的正文 🌧️')
  await page.evaluate(() => (window.__plein.engine as PanEngine).camera.panBy(0, -180))
  await expectBelow(page, id)
  await page.evaluate(() => (window.__plein.engine as PanEngine).camera.panBy(0, 180))
  await expectBelow(page, id)
  await expect(prompt).toHaveValue('主动编辑的正文 🌧️')
})

test('缩放菜单、立即适应与侧栏平滑定位均按最新空间刷新布局', async ({ page }) => {
  const id = await setup(page)
  const panel = page.getByTestId('generator')
  const before = await page.evaluate((id) => window.__plein.engine.doc.worldRect(id), id)
  for (const zoom of ['10', '100']) {
    await page.getByRole('button', { name: '缩放选项', exact: true }).click()
    const field = page.getByRole('textbox', { name: '缩放百分比', exact: true })
    await field.fill(zoom)
    await field.press('Enter')
    await expectBelow(page, id)
  }
  await page.evaluate(() => (window.__plein.engine as PanEngine).camera.panBy(0, -180))
  await expectBelow(page, id)
  await page.evaluate((id) => window.__plein.engine.zoomToFit([id]), id)
  await expectBelow(page, id)
  await page.evaluate(() => (window.__plein.engine as PanEngine).camera.panBy(0, -180))
  await expectBelow(page, id)
  await page
    .getByRole('treeitem', { name: '相机布局 定位到画布', exact: true })
    .getByRole('button', { name: '定位到画布', exact: true })
    .click()
  await expectBelow(page, id)
  await settle(page, id)
  await panel.getByRole('textbox', { name: '提示词', exact: true }).click({ trial: true })
  await page.screenshot({ path: 'test-results/generator-camera-fit.png' })
  expect(await page.evaluate((id) => window.__plein.engine.doc.worldRect(id), id)).toEqual(before)
})
