import { expect, test } from './fixtures'

test.describe('本机数据安全', { tag: '@core' }, () => {
  test('本机数据页显示空间、备份状态并能创建恢复副本', async ({ page }, testInfo) => {
    await page.goto('/')
    await page.getByRole('button', { name: '设置', exact: true }).click()
    const settings = page.getByRole('dialog', { name: '设置', exact: true })
    await settings.getByRole('button', { name: '数据', exact: true }).click()
    await expect(settings.getByText(/自动备份/).first()).toBeVisible()
    await settings.getByRole('button', { name: '立即备份', exact: true }).click()
    await expect(
      settings.getByRole('button', { name: '恢复副本', exact: true }).first(),
    ).toBeVisible()
    await settings.screenshot({ path: testInfo.outputPath('data-maintenance.png') })
    await settings.getByRole('button', { name: '恢复副本', exact: true }).first().click()
    await expect(settings.getByText(/副本|恢复/).last()).toBeVisible()
  })
})
