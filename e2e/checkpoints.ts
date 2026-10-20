import { expect, type Page } from '@playwright/test'
import { newProject } from './canvas'

export const panel = (page: Page) => page.getByRole('dialog', { name: '创作检查点', exact: true })
export const article = (page: Page, name: string) =>
  panel(page).getByRole('article').filter({ hasText: name })
export async function openCheckpoints(page: Page) {
  const tools = page.getByRole('button', { name: '画布工具', exact: true })
  if (await tools.isVisible()) {
    await tools.click()
    await page.getByRole('menuitem', { name: '检查点', exact: true }).click()
  } else await page.getByRole('button', { name: '检查点', exact: true }).click()
}
export async function checkpointPair(page: Page) {
  await newProject(page)
  const canvasId = decodeURIComponent(page.url().split('#/c/')[1]!)
  const canvas = await (await page.request.get(`/api/canvases/${canvasId}`)).json()
  const node = await page.evaluate(() =>
    window.__plein.addNode({
      type: 'plein/text',
      name: '预览原稿',
      x: 0,
      y: 0,
      params: { text: '第一版正文' },
    }),
  )
  await openCheckpoints(page)
  for (const name of ['第一版检查点', '第二版检查点']) {
    if (name === '第二版检查点')
      await page.evaluate((id) => {
        ;(
          window.__plein.engine.doc.mutable(id)!.get('params') as {
            set(key: string, value: string): void
          }
        ).set('text', '第二版正文')
      }, node)
    await panel(page).getByRole('textbox', { name: '检查点名称', exact: true }).fill(name)
    await panel(page).getByRole('button', { name: '保存当前画布', exact: true }).click()
    await expect(article(page, name)).toBeVisible()
    await expect(panel(page).getByRole('button', { name: '关闭预览', exact: true })).toBeVisible()
    await panel(page).getByRole('button', { name: '关闭预览', exact: true }).click()
    await expect(panel(page).getByRole('region', { name: /^预览检查点/ })).toHaveCount(0)
  }
  const list = await (
    await page.request.get(`/api/projects/${canvas.projectId}/checkpoints`)
  ).json()
  return {
    projectId: canvas.projectId as string,
    first: list.items.find((item: { name: string }) => item.name === '第一版检查点'),
    second: list.items.find((item: { name: string }) => item.name === '第二版检查点'),
    original: await page.evaluate(() => [...window.__plein.engine.doc.elements()]),
  }
}
