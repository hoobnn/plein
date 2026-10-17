import { expect, test } from '@playwright/test'
import { centerOf, newProject } from './canvas'

for (const action of ['zoomToFit', 'flyTo'] as const) {
  test(`新建节点后立即 ${action} 可定位尚未逐帧提交的元素`, async ({ page }) => {
    await newProject(page)
    const id = await page.evaluate((action) => {
      const id = window.__plein.addNode({
        type: 'plein/text',
        name: '立即定位',
        params: { text: '新节点' },
        x: -3000,
        y: -2000,
      })
      const engine = window.__plein.engine as unknown as {
        zoomToFit(ids: string[]): void
        flyTo(ids: string[]): void
      }
      engine[action]([id])
      return id
    }, action)
    await expect
      .poll(
        async () => {
          const p = await centerOf(page, id)
          return p.x > 296 && p.x < 1428 && p.y > 64 && p.y < 836
        },
        { message: '新节点应进入画布可见区域' },
      )
      .toBe(true)
    await page
      .getByRole('treeitem', { name: '立即定位 定位到画布', exact: true })
      .getByRole('button', { name: '定位到画布' })
      .click()
    await expect(page.getByRole('textbox', { name: '提示词', exact: true })).toHaveValue('新节点')
  })
}
