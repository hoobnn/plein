import { expect, type Page, test } from '@playwright/test'
import { newProject } from './canvas'

async function openData(page: Page) {
  await page.setViewportSize({ width: 800, height: 560 })
  await newProject(page)
  await page.getByRole('button', { name: '设置', exact: true }).click()
  const settings = page.getByRole('dialog', { name: '设置', exact: true })
  await settings.getByRole('button', { name: '数据', exact: true }).click()
  return settings
}

test.beforeEach(async ({ request }) => {
  const status = await (await request.get('/api/maintenance/status')).json()
  expect(
    (
      await request.put('/api/maintenance/settings', {
        data: { ...status.settings, autoBackup: false },
      })
    ).ok(),
  ).toBe(true)
  expect((await request.post('/api/maintenance/backups')).ok()).toBe(true)
})

test('恢复副本失败可重试，真实恢复后的目录和后续说明在视口内', async ({ page }) => {
  const settings = await openData(page)
  const restore = settings.getByRole('button', { name: '恢复副本', exact: true }).first()
  let failing = true
  let submitted = 0
  let restoredPath = ''
  await page.route('**/api/maintenance/backups/*/restore-copy', async (route) => {
    submitted++
    if (failing) {
      await route.fulfill({ status: 503, json: { error: 'test_failure', message: '恢复暂不可用' } })
    } else {
      const response = await route.fetch()
      expect(response.ok()).toBe(true)
      restoredPath = (await response.json()).path
      await route.fulfill({ response })
    }
  })
  await restore.click()
  await expect(settings.getByRole('alert')).toContainText('恢复暂不可用')
  await expect(restore).toBeEnabled()
  failing = false
  await restore.click()
  const result = settings.getByText('已恢复到：', { exact: false })
  await expect(result).toContainText('/restored/')
  expect(restoredPath).not.toBe('')
  await expect(result).toContainText(restoredPath)
  await expect(restore).toBeEnabled()
  await expect(result).toBeInViewport()
  await expect(settings.getByText(/当前数据仍在使用/)).toBeInViewport()
  await expect(settings.getByRole('alert')).toHaveCount(0)
  expect(submitted).toBe(2)
  await settings.screenshot({
    path: test.info().outputPath('restore-result.png'),
    animations: 'disabled',
  })
})

test('恢复完成后执行其他维护操作，不再显示上一次的恢复指引', async ({ page }) => {
  const settings = await openData(page)
  await settings.getByRole('button', { name: '恢复副本', exact: true }).first().click()
  const result = settings.getByText('已恢复到：', { exact: false })
  await expect(result).toContainText('/restored/')
  const backup = settings.getByRole('button', { name: '立即备份', exact: true })
  await expect(backup).toBeEnabled()
  await backup.click()
  await expect(settings.getByRole('status').filter({ hasText: '备份完成' })).toBeVisible()
  await expect(backup).toBeEnabled()
  await expect(result).toHaveCount(0)
})
