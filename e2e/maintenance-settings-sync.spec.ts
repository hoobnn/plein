import { openCanvasSettings } from './settings-ui'
import { expect, type Page, test } from './fixtures'
import { newProject } from './canvas'

const defaults = {
  autoBackup: false,
  intervalHours: 24,
  keepBackups: 7,
  unusedDays: 30,
  trashDays: 30,
}
test.beforeEach(async ({ request }) => {
  expect((await request.put('/api/maintenance/settings', { data: defaults })).ok()).toBe(true)
})
test.afterEach(async ({ request }) => {
  await request.put('/api/maintenance/settings', { data: defaults })
})
async function openData(page: Page) {
  await openCanvasSettings(page)
  const settings = page.getByRole('dialog', { name: '设置', exact: true })
  await settings.getByRole('button', { name: '数据', exact: true }).click()
  await expect(
    settings.getByRole('spinbutton', { name: '备份间隔（小时）', exact: true }),
  ).toBeVisible()
  return settings
}

test('未编辑的维护数值与开关跟随外部更新', async ({ page, request }) => {
  await newProject(page)
  const settings = await openData(page)
  expect(await page.evaluate(() => document.visibilityState)).toBe('visible')
  expect(
    (
      await request.put('/api/maintenance/settings', {
        data: { ...defaults, intervalHours: 52, autoBackup: true },
      })
    ).ok(),
  ).toBe(true)
  await expect(
    settings.getByRole('spinbutton', { name: '备份间隔（小时）', exact: true }),
  ).toHaveValue('52')
  await expect(settings.getByRole('switch', { name: '启用自动备份', exact: true })).toBeChecked()
})

test('保留数值与开关草稿，保存时合并其他已更新的字段', async ({ page, request }) => {
  await newProject(page)
  const settings = await openData(page)
  const interval = settings.getByRole('spinbutton', { name: '备份间隔（小时）', exact: true })
  const toggle = settings.getByRole('switch', { name: '启用自动备份', exact: true })
  await interval.fill('12')
  await toggle.click()
  expect(
    (
      await request.put('/api/maintenance/settings', {
        data: { ...defaults, keepBackups: 9, unusedDays: 45 },
      })
    ).ok(),
  ).toBe(true)
  await expect(settings.getByRole('spinbutton', { name: '保留最近几份', exact: true })).toHaveValue(
    '9',
  )
  await expect(interval).toHaveValue('12')
  await expect(toggle).toBeChecked()
  await settings.getByRole('button', { name: '保存设置', exact: true }).click()
  await expect(settings.getByText('维护设置已保存', { exact: true })).toBeVisible()
  expect((await (await request.get('/api/maintenance/status')).json()).settings).toEqual({
    ...defaults,
    intervalHours: 12,
    autoBackup: true,
    keepBackups: 9,
    unusedDays: 45,
  })
})

test('保存响应在关闭重开后才返回，新面板显示实际保存值', async ({ page, request }) => {
  await newProject(page)
  const settings = await openData(page)
  let release!: () => void
  let saved!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const confirmed = new Promise<void>((resolve) => {
    saved = resolve
  })
  await page.route('**/api/maintenance/settings', async (route) => {
    const response = await route.fetch()
    saved()
    await gate
    await route.fulfill({ response })
  })
  try {
    await settings.getByRole('spinbutton', { name: '备份间隔（小时）', exact: true }).fill('12')
    await settings.getByRole('button', { name: '保存设置', exact: true }).click()
    await confirmed
    expect(
      (await (await request.get('/api/maintenance/status')).json()).settings.intervalHours,
    ).toBe(12)
    await settings.getByRole('button', { name: '关闭', exact: true }).click()
    await expect(settings).toHaveCount(0)
    const reopened = await openData(page)
    release()
    await expect(
      reopened.getByRole('spinbutton', { name: '备份间隔（小时）', exact: true }),
    ).toHaveValue('12')
    await expect(reopened.getByText('维护设置已保存', { exact: true })).toHaveCount(0)
  } finally {
    release()
  }
})
