import type { Page } from '@playwright/test'

/** 窄窗口从画布工具进入，宽窗口使用直接入口。 */
export async function openLibraryPanel(page: Page) {
  const tools = page.getByRole('button', { name: '画布工具', exact: true })
  if (await tools.isVisible()) {
    await tools.click()
    await page.getByRole('menuitem', { name: '资产库', exact: true }).click()
  } else await page.getByRole('button', { name: '资产库', exact: true }).click()
  return page.getByRole('dialog', { name: '资产库', exact: true })
}
