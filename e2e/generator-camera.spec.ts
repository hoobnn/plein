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
  // 编辑器固定在卡片下方，始终展开；空间不够时缩短并留在窗口内。
  await expect(page.getByTestId('generator')).toHaveAttribute('data-compact', 'false')
  await expect(page.getByTestId('node-editor')).toHaveAttribute('data-placement', 'below')
  return id
}

/** 面板要整个留在窗口里，底部的生成按钮才点得到 */
async function expectInsideViewport(page: import('@playwright/test').Page) {
  await expect
    .poll(() =>
      page.getByTestId('node-editor').evaluate((el) => {
        const r = el.getBoundingClientRect()
        return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight
      }),
    )
    .toBe(true)
}

test('中键平移后编辑器跟着卡片走，节点文档不变', async ({ page }) => {
  const id = await setup(page)
  const before = await page.evaluate(() => [...window.__plein.engine.doc.elements()])
  const panel = page.getByTestId('generator')
  const editor = page.getByTestId('node-editor')
  const topOf = () => editor.evaluate((el) => Math.round(el.getBoundingClientRect().top))
  const before1 = await topOf()
  await page.mouse.move(950, 300)
  await page.mouse.down({ button: 'middle' })
  try {
    await page.mouse.move(950, 120, { steps: 5 })
    await expect(panel.getByRole('textbox', { name: '提示词', exact: true })).toBeVisible()
    await expectInsideViewport(page)
    // 外部相机接管结束旧平移，避免松手惯性改变下一步的起点。
    await page.evaluate(() => (window.__plein.engine as PanEngine).camera.panBy(0, 0))
  } finally {
    await page.mouse.up({ button: 'middle' })
  }
  // 卡片跟着相机走，编辑器跟着卡片走
  await expect.poll(topOf).not.toBe(before1)
  await expectInsideViewport(page)
  expect(await page.evaluate(() => [...window.__plein.engine.doc.elements()])).toEqual(before)
  expect(await page.evaluate(() => window.__plein.engine.selection.values())).toEqual([id])
})

test('平移往返保持编辑内容，编辑器始终留在窗口内', async ({ page }) => {
  await setup(page)
  const panel = page.getByTestId('generator')
  const prompt = panel.getByRole('textbox', { name: '提示词', exact: true })
  await prompt.fill('主动编辑的正文 🌧️')
  await page.evaluate(() => (window.__plein.engine as PanEngine).camera.panBy(0, -180))
  await expectInsideViewport(page)
  await page.evaluate(() => (window.__plein.engine as PanEngine).camera.panBy(0, 180))
  await expectInsideViewport(page)
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
    await expectInsideViewport(page)
  }
  await page.evaluate(() => (window.__plein.engine as PanEngine).camera.panBy(0, -180))
  await expectInsideViewport(page)
  await page.evaluate((id) => window.__plein.engine.zoomToFit([id]), id)
  await expectInsideViewport(page)
  await page.evaluate(() => (window.__plein.engine as PanEngine).camera.panBy(0, -180))
  await expectInsideViewport(page)
  await page
    .getByRole('treeitem', { name: '相机布局 定位到画布', exact: true })
    .getByRole('button', { name: '定位到画布', exact: true })
    .click()
  await expectInsideViewport(page)
  await settle(page, id)
  await panel.getByRole('textbox', { name: '提示词', exact: true }).click({ trial: true })
  await page.screenshot({ path: 'test-results/generator-camera-fit.png' })
  expect(await page.evaluate((id) => window.__plein.engine.doc.worldRect(id), id)).toEqual(before)
})
