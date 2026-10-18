import { expect, type Page, test } from '@playwright/test'
import { newProject } from './canvas'

const configUrl = '/api/providers/plein/mock/config'
const modelUrl = '/api/model-defaults'
const defaults = {
  enabled: true,
  settings: { latencyMs: 0, queueMs: 0, failWith: 'none' },
  secrets: { MOCK_API_KEY: null },
}
test.beforeEach(async ({ request }) => {
  expect((await request.put(configUrl, { data: defaults })).ok()).toBe(true)
  expect(
    (
      await request.put(modelUrl, { data: { capability: 'text.chat', model: 'plein/mock:agent' } })
    ).ok(),
  ).toBe(true)
})
test.afterEach(async ({ request }) => {
  await request.put(configUrl, { data: defaults })
  await request.put(modelUrl, { data: { capability: 'text.chat', model: 'plein/mock:agent' } })
})
async function openProviders(page: Page) {
  await page.getByRole('button', { name: '设置', exact: true }).click()
  const settings = page.getByRole('dialog', { name: '设置', exact: true })
  await settings.getByRole('button', { name: /^模型平台/ }).click()
  return settings
}

test('折叠与切换设置分区保留平台草稿，关闭窗口后丢弃且不自动保存', async ({ page, request }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.setViewportSize({ width: 800, height: 560 })
  await newProject(page)
  const settings = await openProviders(page)
  const row = settings.locator('[data-provider="plein/mock"]')
  await row.getByRole('button', { expanded: false }).click()
  const latency = row.getByRole('spinbutton', { name: '模拟耗时（毫秒）', exact: true })
  const key = row.getByLabel(/API Key/)
  await latency.fill('321')
  await key.fill('e2e-unsaved-placeholder')
  await row.getByRole('button', { expanded: true }).click()
  await row.getByRole('button', { expanded: false }).click()
  await expect(latency).toHaveValue('321')
  await expect(key).toHaveValue('e2e-unsaved-placeholder')
  let writes = 0
  page.on('request', (request) => {
    if (request.method() === 'PUT' && request.url().endsWith(configUrl)) writes++
  })
  await settings.getByRole('button', { name: '外观', exact: true }).click()
  await expect(
    settings.getByRole('spinbutton', { name: '模拟耗时（毫秒）', exact: true }),
  ).toHaveCount(0)
  await settings.getByRole('button', { name: /^模型平台/ }).click()
  await expect(latency).toHaveValue('321')
  expect(
    await settings
      .locator('.ui-slide-swap')
      .evaluate((node) =>
        node
          .getAnimations()
          .some((animation) => (animation as CSSAnimation).animationName === 'ui-slide-in'),
      ),
  ).toBe(true)
  await expect(key).toHaveValue('e2e-unsaved-placeholder')
  await expect(row.getByRole('button', { name: '测试连接', exact: true })).toBeDisabled()
  await expect(row.getByText('修改尚未保存，请先保存再测试连接。', { exact: true })).toBeVisible()
  await row
    .getByText('修改尚未保存，请先保存再测试连接。', { exact: true })
    .scrollIntoViewIfNeeded()
  await settings.screenshot({
    path: test.info().outputPath('provider-draft-restored.png'),
    animations: 'disabled',
  })
  expect(writes).toBe(0)
  const actual = await (await request.get(configUrl)).json()
  expect(actual.settings.latencyMs).toBe(0)
  expect(actual.secrets.MOCK_API_KEY).toBe(false)
  await settings.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(settings).toHaveCount(0)
  const reopened = await openProviders(page)
  const newRow = reopened.locator('[data-provider="plein/mock"]')
  await newRow.getByRole('button', { expanded: false }).click()
  await expect(
    newRow.getByRole('spinbutton', { name: '模拟耗时（毫秒）', exact: true }),
  ).toHaveValue('0')
  await expect(newRow.getByLabel(/API Key/)).toHaveValue('')
  expect(writes).toBe(0)
})

test('默认模型保存等待期间切换分区再回来，仍锁定选择且不重复保存', async ({ page, request }) => {
  await newProject(page)
  const settings = await openProviders(page)
  const select = settings.getByRole('combobox', { name: '默认文本模型', exact: true })
  let writes = 0
  let release!: () => void
  let saved!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const confirmed = new Promise<void>((resolve) => {
    saved = resolve
  })
  await page.route(`**${modelUrl}`, async (route) => {
    writes++
    const response = await route.fetch()
    expect(response.ok()).toBe(true)
    saved()
    await gate
    await route.fulfill({ response })
  })
  try {
    await select.click()
    await page.getByRole('option', { name: 'Mock（开发测试用） · Mock 对话', exact: true }).click()
    await confirmed
    expect((await (await request.get('/api/catalog')).json()).defaultModels['text.chat']).toBe(
      'plein/mock:chat',
    )
    await settings.getByRole('button', { name: '外观', exact: true }).click()
    await expect(settings.getByRole('combobox', { name: '默认文本模型', exact: true })).toHaveCount(
      0,
    )
    await settings.getByRole('button', { name: /^模型平台/ }).click()
    await expect(select).toBeDisabled()
    await expect(
      settings.getByRole('status').filter({ hasText: '正在保存文本默认模型' }),
    ).toBeVisible()
    release()
    await expect(select).toBeEnabled()
    await expect(select).toContainText('Mock 对话')
    expect(writes).toBe(1)
  } finally {
    release()
  }
})

test('减少动态效果时切换分区保留草稿，容器没有切换动画', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await newProject(page)
  const settings = await openProviders(page)
  const row = settings.locator('[data-provider="plein/mock"]')
  await row.getByRole('button', { expanded: false }).click()
  const latency = row.getByRole('spinbutton', { name: '模拟耗时（毫秒）', exact: true })
  await latency.fill('654')
  await settings.getByRole('button', { name: '外观', exact: true }).click()
  await settings.getByRole('button', { name: /^模型平台/ }).click()
  await expect(latency).toHaveValue('654')
  expect(
    await settings.locator('.ui-slide-swap').evaluate((node) => node.getAnimations().length),
  ).toBe(0)
})
