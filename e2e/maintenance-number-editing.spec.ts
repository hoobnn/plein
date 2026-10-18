import { expect, test } from '@playwright/test'
import { newProject } from './canvas'

const fields = [
  ['intervalHours', '备份间隔（小时）', '-1'],
  ['keepBackups', '保留最近几份', '1.5'],
  ['unusedDays', '未引用素材保留（天）', '3651'],
  ['trashDays', '回收站保留（天）', '366'],
] as const

test.beforeEach(async ({ request }) => {
  expect(
    (
      await request.put('/api/maintenance/settings', {
        data: {
          autoBackup: false,
          intervalHours: 24,
          keepBackups: 7,
          unusedDays: 30,
          trashDays: 30,
        },
      })
    ).ok(),
  ).toBe(true)
})

for (const [key, label, bad] of fields) {
  test(`维护数值 ${key} 可清空修改，无效值不提交，失败草稿可重试`, async ({ page, request }) => {
    await page.setViewportSize({ width: 800, height: 560 })
    await newProject(page)
    await page.getByRole('button', { name: '设置', exact: true }).click()
    const settings = page.getByRole('dialog', { name: '设置', exact: true })
    await settings.getByRole('button', { name: '数据', exact: true }).click()
    const field = settings.getByRole('spinbutton', { name: label, exact: true })
    const save = settings.getByRole('button', { name: '保存设置', exact: true })
    let submitted = 0
    page.on('request', (request) => {
      if (request.method() === 'PUT' && request.url().endsWith('/api/maintenance/settings'))
        submitted++
    })
    await field.fill('')
    await expect(field).toHaveValue('')
    await save.click()
    await expect(field).toHaveAttribute('aria-invalid', 'true')
    expect(submitted).toBe(0)
    if (key === 'intervalHours') {
      const other = settings.getByRole('spinbutton', { name: '保留最近几份', exact: true })
      await other.fill('')
      await save.click()
      await expect(field).toBeFocused()
      await other.fill('7')
    }
    await field.fill(bad)
    await save.click()
    await expect(field).toHaveAttribute('aria-invalid', 'true')
    await expect(field).toHaveAccessibleDescription(/整数/)
    await expect(field).toBeFocused()
    if (key === 'keepBackups')
      await settings.screenshot({
        path: test.info().outputPath('maintenance-number-invalid.png'),
        animations: 'disabled',
      })
    expect(submitted).toBe(0)
    await field.fill('')
    await field.pressSequentially('12')
    await expect(field).toHaveValue('12')
    if (key === 'intervalHours') {
      await page.route('**/api/maintenance/settings', (route) =>
        route.fulfill({ status: 503, json: { error: 'test_failure', message: '保存暂不可用' } }),
      )
      await save.click()
      await expect(settings.getByRole('alert')).toContainText('保存暂不可用')
      await expect(field).toHaveValue('12')
      await page.unroute('**/api/maintenance/settings')
    }
    await save.click()
    await expect(settings.getByRole('status').filter({ hasText: '维护设置已保存' })).toBeVisible()
    await expect(save).toBeEnabled()
    expect((await (await request.get('/api/maintenance/status')).json()).settings[key]).toBe(12)
    await expect(field).not.toHaveAttribute('aria-invalid', 'true')
    if (key === 'intervalHours') {
      await field.fill('13')
      await expect(settings.getByRole('status')).toHaveCount(0)
      expect((await (await request.get('/api/maintenance/status')).json()).settings[key]).toBe(12)
      await settings.getByRole('button', { name: '关闭', exact: true }).click()
      await expect(settings).toHaveCount(0)
      await page.getByRole('button', { name: '设置', exact: true }).click()
      await settings.getByRole('button', { name: '数据', exact: true }).click()
      await expect(field).toHaveValue('12')
    }
  })
}
