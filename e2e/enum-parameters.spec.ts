import { expect, test } from '@playwright/test'
import type { Catalog } from '../packages/protocol/src/plugins'
import { newProject } from './canvas'

test('插件数字枚举保留数值类型，零值可保存并重开', async ({ page }) => {
  // 同一服务端数字设置使用合法 enum 展示，覆盖插件提供的 JSON Schema 变体。
  await page.route('**/api/catalog', async (route) => {
    const response = await route.fetch()
    const catalog = (await response.json()) as Catalog
    const provider = catalog.providers.find((p) => p.id === 'plein/mock')!
    const schema = provider.settingsSchema as { properties: Record<string, unknown> }
    schema.properties.latencyMs = {
      type: 'integer',
      title: '模拟耗时（毫秒）',
      enum: [0, 100],
      default: 0,
    }
    schema.properties.queueMs = { type: 'integer', title: '排队枚举', enum: [0, 10] }
    await route.fulfill({ response, json: catalog })
  })
  await newProject(page)
  await page.getByRole('button', { name: '设置', exact: true }).click()
  let settings = page.getByRole('dialog', { name: '设置', exact: true })
  const open = async () => {
    await settings.getByRole('button', { name: /^模型平台/ }).click()
    const provider = settings.getByRole('button', { name: /^Mock（开发测试用）/ })
    if ((await provider.getAttribute('aria-expanded')) !== 'true') await provider.click()
  }
  await open()
  const field = () => settings.getByRole('combobox', { name: '模拟耗时（毫秒）', exact: true })
  await expect(field()).toHaveText('0')
  for (const value of [100, 0]) {
    await field().click()
    await page.getByRole('option', { name: String(value), exact: true }).click()
    const sent = page.waitForRequest(
      (r) => r.method() === 'PUT' && r.url().includes('/api/providers/plein/mock/config'),
    )
    await settings.getByRole('button', { name: '保存', exact: true }).click()
    const request = await sent
    expect(request.postDataJSON().settings.latencyMs).toBe(value)
    await expect(settings.getByText('已保存', { exact: true })).toBeVisible()
    const saved = await (await page.request.get('/api/providers/plein/mock/config')).json()
    expect(saved.settings.latencyMs).toBe(value)
  }
  const queue = settings.getByRole('combobox', { name: '排队枚举', exact: true })
  await expect(queue).toHaveText('默认')
  for (const option of ['10', '默认']) {
    await queue.click()
    await page.getByRole('option', { name: option, exact: true }).click()
    await settings.getByRole('button', { name: '保存', exact: true }).click()
    await expect(settings.getByText('已保存', { exact: true })).toBeVisible()
    const saved = await (await page.request.get('/api/providers/plein/mock/config')).json()
    expect(saved.settings.queueMs).toBe(option === '默认' ? undefined : 10)
  }
  await settings.screenshot({
    path: test.info().outputPath('enum-settings.png'),
    animations: 'disabled',
  })
  await settings.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(settings).toHaveCount(0)
  await page.getByRole('button', { name: '设置', exact: true }).click()
  settings = page.getByRole('dialog', { name: '设置', exact: true })
  await open()
  await expect(field()).toHaveText('0')
})
