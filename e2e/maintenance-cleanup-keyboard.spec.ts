import { openCanvasSettings } from './settings-ui'
import { expect, type Page, test } from '@playwright/test'
import { newProject } from './canvas'

let original: Record<string, unknown>
test.beforeEach(async ({ request }) => {
  original = (await (await request.get('/api/maintenance/status')).json()).settings
  expect(
    (
      await request.put('/api/maintenance/settings', {
        data: { ...original, autoBackup: false, unusedDays: 3650 },
      })
    ).ok(),
  ).toBe(true)
})
test.afterEach(async ({ request }) => {
  await request.put('/api/maintenance/settings', { data: original })
})
async function openData(page: Page) {
  await page.setViewportSize({ width: 800, height: 560 })
  await newProject(page)
  await openCanvasSettings(page)
  const settings = page.getByRole('dialog', { name: '设置', exact: true })
  await settings.getByRole('button', { name: '数据', exact: true }).click()
  return settings
}

test('键盘取消清理预览后焦点回到检查按钮，可以立即重新检查', async ({ page }) => {
  const settings = await openData(page)
  const inspect = settings.getByRole('button', { name: '检查可清理素材', exact: true })
  const preview = settings.getByRole('region', { name: '清理预览', exact: true })
  const cancel = preview.getByRole('button', { name: '取消', exact: true })
  await inspect.focus()
  await page.keyboard.press('Enter')
  await expect(cancel).toBeEnabled()
  await expect(preview).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(cancel).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(preview).toHaveCount(0)
  await expect(inspect).toBeFocused()
  await expect(inspect).toBeInViewport()
  await page.keyboard.press('Enter')
  await expect(preview).toBeVisible()
})

test('没有可清理素材时明确说明，不展示无效确认操作，也不发送清理', async ({ page }) => {
  const settings = await openData(page)
  let submitted = 0
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/api/maintenance/cleanup'))
      submitted++
  })
  const response = page.waitForResponse((response) =>
    response.url().endsWith('/api/maintenance/cleanup/preview'),
  )
  await settings.getByRole('button', { name: '检查可清理素材', exact: true }).click()
  expect((await (await response).json()).assets).toBe(0)
  const preview = settings.getByRole('region', { name: '清理预览', exact: true })
  const empty = preview.getByRole('status')
  await expect(empty).toContainText('暂无可清理素材')
  await expect(empty).toBeInViewport()
  await expect(preview.getByRole('button', { name: '确认移入回收站', exact: true })).toHaveCount(0)
  await settings.screenshot({
    path: test.info().outputPath('cleanup-empty.png'),
    animations: 'disabled',
  })
  await preview.getByRole('button', { name: '取消', exact: true }).click()
  expect(submitted).toBe(0)
})
