import { expect, type Page, test } from '@playwright/test'
import { newProject } from './canvas'

const endpoint = '/api/providers/plein/mock/config'
const defaults = { enabled: true, settings: { latencyMs: 20, queueMs: 0, failWith: 'none' } }
test.beforeEach(async ({ request }) => {
  expect((await request.put(endpoint, { data: defaults })).ok()).toBe(true)
})
test.afterEach(async ({ request }) => {
  await request.put(endpoint, {
    data: { ...defaults, settings: { ...defaults.settings, latencyMs: 0 } },
  })
})
async function openProvider(page: Page) {
  await page.setViewportSize({ width: 800, height: 560 })
  await newProject(page)
  await page.getByRole('button', { name: '设置', exact: true }).click()
  const settings = page.getByRole('dialog', { name: '设置', exact: true })
  await settings.getByRole('button', { name: /^模型平台/ }).click()
  const row = settings.locator('[data-provider="plein/mock"]')
  await row.getByRole('button', { expanded: false }).click()
  return { row, settings }
}

for (const incomplete of ['-', '1e']) {
  test(`平台未完成数字 ${incomplete} 阻止保存，折叠不清除错误，修正后可保存`, async ({
    page,
    request,
  }) => {
    const { row, settings } = await openProvider(page)
    const number = row.getByRole('spinbutton', { name: '模拟耗时（毫秒）', exact: true })
    const save = row.getByRole('button', { name: '保存', exact: true })
    let writes = 0
    page.on('request', (request) => {
      if (request.method() === 'PUT' && request.url().endsWith(endpoint)) writes++
    })
    await number.fill('')
    await number.pressSequentially(incomplete)
    expect(await number.evaluate((element: HTMLInputElement) => element.validity.badInput)).toBe(
      true,
    )
    if (incomplete === '1e') {
      await number.press('Tab')
      await save.focus()
      await page.keyboard.press('Enter')
    } else await save.click()
    await expect(number).toHaveValue('20')
    await expect(number).toHaveAttribute('aria-invalid', 'true')
    await expect(row.getByRole('alert')).toContainText('请输入有效数字')
    await expect(number).toHaveAccessibleDescription(/请输入有效数字/)
    expect(writes).toBe(0)
    await expect(number).toBeFocused()
    expect((await (await request.get(endpoint)).json()).settings.latencyMs).toBe(20)
    await row.getByRole('button', { expanded: true }).click()
    await row.getByRole('button', { expanded: false }).click()
    await expect(number).toHaveAttribute('aria-invalid', 'true')
    await save.click()
    expect(writes).toBe(0)
    await expect(number).toBeFocused()
    if (incomplete === '1e') {
      await settings.getByRole('button', { name: '外观', exact: true }).click()
      await settings.getByRole('button', { name: /^模型平台/ }).click()
      await expect(number).toHaveAttribute('aria-invalid', 'true')
      await number.focus()
      await expect(row.getByRole('alert')).toBeInViewport()
    }
    if (incomplete === '1e')
      await settings.screenshot({
        path: test.info().outputPath('provider-invalid-number.png'),
        animations: 'disabled',
      })
    await number.fill('123')
    await number.press('Enter')
    await expect(number).not.toHaveAttribute('aria-invalid', 'true')
    await save.focus()
    await page.keyboard.press('Enter')
    await expect(row.getByRole('status')).toContainText('已保存')
    await expect(save).toBeEnabled()
    expect(writes).toBe(1)
    expect((await (await request.get(endpoint)).json()).settings.latencyMs).toBe(123)
  })
}

test('平台数字回车先提交草稿，空值仍使用默认值，范围收拢后可以键盘保存', async ({
  page,
  request,
}) => {
  const { row } = await openProvider(page)
  const number = row.getByRole('spinbutton', { name: '模拟耗时（毫秒）', exact: true })
  const save = row.getByRole('button', { name: '保存', exact: true })
  let writes = 0
  page.on('request', (request) => {
    if (request.method() === 'PUT' && request.url().endsWith(endpoint)) writes++
  })
  await number.fill('60000.9')
  await number.press('Enter')
  await expect(number).toHaveValue('60000')
  expect(writes).toBe(0)
  await save.focus()
  await page.keyboard.press('Enter')
  await expect(row.getByRole('status')).toContainText('已保存')
  await expect(save).toBeEnabled()
  expect((await (await request.get(endpoint)).json()).settings.latencyMs).toBe(60000)
  await number.fill('')
  await number.press('Enter')
  await expect(number).toHaveValue('')
  await expect(number).toHaveAttribute('placeholder', '0')
  await save.focus()
  await page.keyboard.press('Enter')
  await expect(row.getByRole('status')).toContainText('已保存')
  await expect(save).toBeEnabled()
  expect((await (await request.get(endpoint)).json()).settings).not.toHaveProperty('latencyMs')
  expect(writes).toBe(2)
})
