import { expect, test } from '@playwright/test'
import { elements, newProject } from './canvas'

for (const mode of ['plan', 'edit'] as const) {
  test(`${mode} 确认失败后能重试，关闭重开保留等待状态并阻止相反选择`, async ({ page }) => {
    await newProject(page)
    await page.getByRole('button', { name: '打开助手', exact: true }).click()
    const panel = page.getByRole('complementary', { name: '助手', exact: true })
    const input = panel.getByPlaceholder('让小满帮你做点什么…')
    if (mode === 'plan') await panel.getByRole('button', { name: '先出计划', exact: true }).click()
    await input.fill('画一张雨夜天台')
    await panel.getByRole('button', { name: '发送', exact: true }).click()
    if (mode === 'edit') {
      await expect(panel.getByText('【mock】好了')).toBeVisible()
      await input.fill('让画面更紧张')
      await panel.getByRole('button', { name: '发送', exact: true }).click()
    }
    const card = panel.locator(mode === 'plan' ? '.plein-agent-plan' : '.plein-edit-plan')
    const approve = card.getByRole('button', {
      name: mode === 'plan' ? '同意并执行' : '只改文字',
      exact: true,
    })
    await expect(approve).toBeEnabled()
    const before = (await elements(page)).length
    let requests = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    await page.route('**/api/agent/sessions/*/approvals/*', async (route) => {
      requests++
      if (requests === 1)
        return route.fulfill({
          status: 503,
          json: { error: 'decision_failed', message: '确认测试失败' },
        })
      await gate
      await route.continue()
    })
    await approve.click()
    await expect(panel.getByRole('alert')).toHaveText('确认测试失败')
    await expect(approve).toBeEnabled()
    expect((await elements(page)).length).toBe(before)
    await approve.click()
    await expect(approve).toBeDisabled()
    await input.press('Escape')
    await expect(panel).toHaveCount(0)
    await page.getByRole('button', { name: '打开助手', exact: true }).click()
    await expect(approve).toBeDisabled()
    await expect(card).toHaveAttribute('aria-busy', 'true')
    await expect(card.getByRole('button', { name: '不用了', exact: true })).toBeDisabled()
    expect(requests).toBe(2)
    release()
    await expect(card).toHaveAttribute('data-status', mode === 'plan' ? 'approved' : 'applied')
    await expect(panel.getByRole('alert')).toHaveCount(0)
    await page.screenshot({
      path: test.info().outputPath('agent-decision-recovered.png'),
      animations: 'disabled',
    })
  })
}
