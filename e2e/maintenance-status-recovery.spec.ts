import { openCanvasSettings } from './settings-ui'
import { expect, test } from '@playwright/test'
import { newProject } from './canvas'

test.beforeEach(async ({ request }) => {
  const status = await (await request.get('/api/maintenance/status')).json()
  expect(
    (
      await request.put('/api/maintenance/settings', {
        data: { ...status.settings, autoBackup: false },
      })
    ).ok(),
  ).toBe(true)
})

test('首次读取维护状态失败可手动重试，不必等待自动轮询', async ({ page }) => {
  let failing = true
  await page.route('**/api/maintenance/status', async (route) => {
    if (failing)
      await route.fulfill({
        status: 503,
        json: { error: 'test_failure', message: '维护状态暂不可用' },
      })
    else await route.continue()
  })
  await newProject(page)
  await openCanvasSettings(page)
  const settings = page.getByRole('dialog', { name: '设置', exact: true })
  await settings.getByRole('button', { name: '数据', exact: true }).click()
  await expect(settings.getByRole('alert')).toContainText('维护状态暂不可用')
  failing = false
  await settings.getByRole('button', { name: '重试读取维护状态', exact: true }).click()
  await expect(settings.getByRole('region', { name: '自动备份', exact: true })).toBeVisible()
  await expect(settings.getByRole('alert')).toHaveCount(0)
})

test('真实备份成功后读取失败保留操作与设置草稿，重试不重复备份', async ({ page, request }) => {
  await page.setViewportSize({ width: 800, height: 560 })
  const before = await (await request.get('/api/maintenance/status')).json()
  await newProject(page)
  await openCanvasSettings(page)
  const settings = page.getByRole('dialog', { name: '设置', exact: true })
  await settings.getByRole('button', { name: '数据', exact: true }).click()
  const automatic = settings.getByRole('region', { name: '自动备份', exact: true })
  const retained = automatic.getByRole('spinbutton', { name: '保留最近几份', exact: true })
  await retained.fill('8')
  let failing = true
  let submitted = 0
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/api/maintenance/backups'))
      submitted++
  })
  await page.route('**/api/maintenance/status', async (route) => {
    if (failing)
      await route.fulfill({
        status: 503,
        json: { error: 'test_failure', message: '备份后的状态读取失败' },
      })
    else await route.continue()
  })
  await automatic.getByRole('button', { name: '立即备份', exact: true }).click()
  await expect(settings.getByRole('alert')).toContainText('备份后的状态读取失败')
  expect((await (await request.get('/api/maintenance/status')).json()).backups.length).toBe(
    before.backups.length + 1,
  )
  await expect(automatic).toBeVisible()
  await expect(retained).toHaveValue('8')
  await expect(settings.getByRole('status')).toContainText('备份完成')
  await expect(settings.getByRole('status')).toBeInViewport()
  await settings.getByRole('alert').scrollIntoViewIfNeeded()
  await settings.screenshot({
    path: test.info().outputPath('maintenance-read-error.png'),
    animations: 'disabled',
  })
  failing = false
  await settings.getByRole('button', { name: '重试读取维护状态', exact: true }).click()
  await expect(settings.getByRole('alert')).toHaveCount(0)
  await expect(retained).toHaveValue('8')
  await expect(
    settings
      .getByRole('region', { name: '本机备份', exact: true })
      .getByRole('button', { name: '恢复副本', exact: true }),
  ).toHaveCount(before.backups.length + 1)
  expect(submitted).toBe(1)
})
