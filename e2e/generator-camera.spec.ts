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
  await expect(page.getByTestId('generator')).toHaveAttribute('data-compact', 'true')
  return id
}

test('中键平移腾出空间后展开编辑器，移回后恢复紧凑，节点文档不变', async ({ page }) => {
  const id = await setup(page)
  const before = await page.evaluate(() => [...window.__plein.engine.doc.elements()])
  const panel = page.getByTestId('generator')
  await page.mouse.move(950, 300)
  await page.mouse.down({ button: 'middle' })
  try {
    await page.mouse.move(950, 120, { steps: 5 })
    await expect(panel).toHaveAttribute('data-compact', 'false')
    await expect(panel.getByRole('textbox', { name: '提示词', exact: true })).toBeVisible()
    // 外部相机接管结束旧平移，避免松手惯性改变下一步的起点。
    await page.evaluate(() => (window.__plein.engine as PanEngine).camera.panBy(0, 0))
  } finally {
    await page.mouse.up({ button: 'middle' })
  }
  await page.evaluate(() => (window.__plein.engine as PanEngine).camera.panBy(0, 180))
  await expect(panel).toHaveAttribute('data-compact', 'true')
  expect(await page.evaluate(() => [...window.__plein.engine.doc.elements()])).toEqual(before)
  expect(await page.evaluate(() => window.__plein.engine.selection.values())).toEqual([id])
})

test('主动展开编辑后平移往返保持编辑和正文，仍可收起释放端口', async ({ page }) => {
  await setup(page)
  const panel = page.getByTestId('generator')
  await panel.getByRole('button', { name: '编辑文本', exact: true }).click()
  const prompt = panel.getByRole('textbox', { name: '提示词', exact: true })
  await prompt.fill('主动编辑的正文 🌧️')
  await page.evaluate(() => (window.__plein.engine as PanEngine).camera.panBy(0, -180))
  await expect(panel.getByRole('button', { name: '收起编辑器' })).toHaveCount(0)
  await page.evaluate(() => (window.__plein.engine as PanEngine).camera.panBy(0, 180))
  await expect(panel).toHaveAttribute('data-compact', 'false')
  await expect(prompt).toHaveValue('主动编辑的正文 🌧️')
  await panel.getByRole('button', { name: '收起编辑器' }).click()
  await expect(panel).toHaveAttribute('data-compact', 'true')
})

test('缩放菜单、立即适应与侧栏平滑定位均按最新空间刷新布局', async ({ page }) => {
  const id = await setup(page)
  const panel = page.getByTestId('generator')
  const before = await page.evaluate((id) => window.__plein.engine.doc.worldRect(id), id)
  for (const [zoom, compact] of [
    ['10', 'false'],
    ['100', 'true'],
  ] as const) {
    await page.getByRole('button', { name: '缩放选项', exact: true }).click()
    const field = page.getByRole('textbox', { name: '缩放百分比', exact: true })
    await field.fill(zoom)
    await field.press('Enter')
    await expect(panel).toHaveAttribute('data-compact', compact)
  }
  await page.evaluate(() => (window.__plein.engine as PanEngine).camera.panBy(0, -180))
  await expect(panel).toHaveAttribute('data-compact', 'false')
  await page.evaluate((id) => window.__plein.engine.zoomToFit([id]), id)
  await expect(panel).toHaveAttribute('data-compact', 'true')
  await page.evaluate(() => (window.__plein.engine as PanEngine).camera.panBy(0, -180))
  await expect(panel).toHaveAttribute('data-compact', 'false')
  await page
    .getByRole('treeitem', { name: '相机布局 定位到画布', exact: true })
    .getByRole('button', { name: '定位到画布', exact: true })
    .click()
  await expect(panel).toHaveAttribute('data-compact', 'true')
  await settle(page, id)
  await panel.getByRole('button', { name: '编辑文本', exact: true }).click({ trial: true })
  await page.screenshot({ path: 'test-results/generator-camera-fit.png' })
  expect(await page.evaluate((id) => window.__plein.engine.doc.worldRect(id), id)).toEqual(before)
})
