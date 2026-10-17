import { expect, test } from '@playwright/test'
import { newProject } from './canvas'

// 同时在生产构建和开发 StrictMode 下运行，确保一次性打开目标不会被 effect 重放清掉。
test('角色卡编辑档案直达对应角色的时期分页，反复打开保持目标正确', async ({ page }) => {
  await newProject(page)
  await page.getByRole('button', { name: '资产库', exact: true }).click()
  const panel = page.getByRole('dialog', { name: '资产库', exact: true })
  await panel.getByRole('button', { name: '新建角色', exact: true }).first().click()
  await panel.getByRole('textbox', { name: '名称', exact: true }).fill('档案导航回归')
  await panel.getByRole('button', { name: '时期与服饰', exact: true }).click()
  await panel.getByRole('button', { name: '添加时期', exact: true }).click()
  await panel.getByRole('button', { name: '青年', exact: true }).click()
  await panel.getByRole('button', { name: '保存并添加到画布', exact: true }).click()
  await expect(panel).toBeHidden()
  const generator = page.getByTestId('generator')
  await expect(generator.getByRole('textbox', { name: '节点名称' })).toHaveValue('档案导航回归')
  for (let attempt = 0; attempt < 2; attempt++) {
    await generator.getByRole('button', { name: '编辑档案', exact: true }).click()
    await expect(panel.getByRole('textbox', { name: '名称', exact: true })).toHaveValue(
      '档案导航回归',
    )
    await expect(panel.getByRole('button', { name: '时期与服饰 1', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await expect(panel.getByRole('button', { name: '角色资产', exact: true })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
    await panel.getByRole('button', { name: '关闭', exact: true }).click()
    await expect(panel).toBeHidden()
  }
})
