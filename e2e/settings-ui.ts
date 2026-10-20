import type { Page } from '@playwright/test'

/** 编辑画布时，窄窗口经画布工具进入，宽窗口使用独立设置按钮。 */
export async function openCanvasSettings(page: Page) {
  const tools = page.getByRole('button', { name: '画布工具', exact: true })
  if (await tools.isVisible()) {
    await tools.click()
    await page.getByRole('menuitem', { name: '设置', exact: true }).click()
  } else await page.getByRole('button', { name: '设置', exact: true }).click()
  return page.getByRole('dialog', { name: '设置', exact: true })
}
