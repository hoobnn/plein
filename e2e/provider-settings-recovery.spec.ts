import { expect, type Page, test } from '@playwright/test'
import { newProject } from './canvas'

const configUrl = '/api/providers/plein/mock/config'
const defaults = {
  enabled: true,
  settings: { latencyMs: 0, queueMs: 0, failWith: 'none' },
  secrets: { MOCK_API_KEY: null },
}
test.beforeEach(async ({ request }) => {
  expect((await request.put(configUrl, { data: defaults })).ok()).toBe(true)
})
test.afterEach(async ({ request }) => {
  await request.put(configUrl, { data: defaults })
})
async function openProvider(page: Page) {
  await page.setViewportSize({ width: 800, height: 560 })
  await newProject(page)
  await page.getByRole('button', { name: '画布工具', exact: true }).click()
  await page.getByRole('menuitem', { name: '设置', exact: true }).click()
  const settings = page.getByRole('dialog', { name: '设置', exact: true })
  await settings.getByRole('button', { name: /^模型平台/ }).click()
  const row = settings.locator('[data-provider="plein/mock"]')
  await row.getByRole('button', { expanded: false }).click()
  return row
}

test('平台配置读取失败可在展开行内重复重试，成功后显示真实配置', async ({ page }) => {
  let failing = true
  await page.route(`**${configUrl}`, async (route) => {
    if (route.request().method() === 'GET' && failing)
      await route.fulfill({ status: 503, json: { error: 'test_failure', message: '配置暂不可用' } })
    else await route.continue()
  })
  const row = await openProvider(page)
  await expect(row.getByText('读取配置失败：配置暂不可用', { exact: true })).toBeVisible()
  const retry = row.getByRole('button', { name: '重试读取配置', exact: true })
  await retry.click()
  await expect(row.getByText('读取配置失败：配置暂不可用', { exact: true })).toBeVisible()
  failing = false
  await retry.click()
  await expect(row.getByRole('spinbutton', { name: '模拟耗时（毫秒）', exact: true })).toHaveValue(
    '0',
  )
  await expect(row.getByRole('alert')).toHaveCount(0)
  await expect(retry).toHaveCount(0)
})

test('连接检查成功后保存失败仍显示错误，真实重试保存可见且持久化', async ({ page, request }) => {
  const row = await openProvider(page)
  const latency = row.getByRole('spinbutton', { name: '模拟耗时（毫秒）', exact: true })
  await expect(latency).toBeVisible()
  await expect(row.getByText('已配置', { exact: true })).not.toHaveClass(/ui-tag-success/)
  await row.getByRole('button', { name: '测试连接', exact: true }).click()
  await expect(row.getByRole('status')).toContainText(
    '连接检查通过；尚未验证具体模型、资源权限或余额',
  )
  await latency.fill('321')
  await page.route(`**${configUrl}`, async (route) => {
    if (route.request().method() === 'PUT')
      await route.fulfill({ status: 503, json: { error: 'test_failure', message: '保存暂不可用' } })
    else await route.continue()
  })
  await row.getByRole('button', { name: '保存', exact: true }).click()
  await expect(row.getByText('保存失败：保存暂不可用', { exact: true })).toBeVisible()
  expect((await (await request.get(configUrl)).json()).settings.latencyMs).toBe(0)
  await expect(latency).toHaveValue('321')
  await page.unroute(`**${configUrl}`)
  await row.getByRole('button', { name: '保存', exact: true }).click()
  await expect(row.getByRole('status')).toContainText('已保存')
  expect((await (await request.get(configUrl)).json()).settings.latencyMs).toBe(321)
})

test('修改配置或密钥后清除旧检查结果，避免把旧结果当作当前配置状态', async ({ page, request }) => {
  expect(
    (
      await request.put(configUrl, {
        data: { settings: { ...defaults.settings, failWith: 'auth' } },
      })
    ).ok(),
  ).toBe(true)
  const row = await openProvider(page)
  await row.getByRole('button', { name: '测试连接', exact: true }).click()
  const stale = row.getByText('检查失败：模拟：密钥无效', { exact: true })
  await expect(stale).toBeVisible()
  await row.getByLabel(/API Key/).fill('e2e-placeholder-key')
  await expect(stale).toHaveCount(0)
  await expect(row.getByRole('button', { name: '测试连接', exact: true })).toBeDisabled()
  await expect(row.getByText('修改尚未保存，请先保存再测试连接。', { exact: true })).toBeVisible()
  await row.getByRole('button', { name: '保存', exact: true }).click()
  await expect(row.getByRole('status')).toContainText('已保存')
  await row.getByRole('button', { name: '测试连接', exact: true }).click()
  await expect(stale).toBeVisible()
  await row.getByRole('spinbutton', { name: '模拟耗时（毫秒）', exact: true }).fill('123')
  await expect(stale).toHaveCount(0)
  await expect(row.getByRole('button', { name: '测试连接', exact: true })).toBeDisabled()
  await row.screenshot({
    path: test.info().outputPath('provider-edited.png'),
    animations: 'disabled',
  })
})

test('折叠前发出的配置读取迟到时不能覆盖重开后的真实配置', async ({ page, request }) => {
  let hold = true
  let release!: () => void
  let loaded!: () => void
  let delivered!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const ready = new Promise<void>((resolve) => {
    loaded = resolve
  })
  const returned = new Promise<void>((resolve) => {
    delivered = resolve
  })
  await page.route(`**${configUrl}`, async (route) => {
    if (route.request().method() !== 'GET') return route.continue()
    const pending = hold
    const response = await route.fetch()
    if (pending) {
      loaded()
      await gate
    }
    await route.fulfill({ response })
    if (pending) delivered()
  })
  try {
    const row = await openProvider(page)
    await ready
    await row.getByRole('button', { expanded: true }).click()
    expect(
      (
        await request.put(configUrl, {
          data: { settings: { ...defaults.settings, latencyMs: 987 } },
        })
      ).ok(),
    ).toBe(true)
    hold = false
    release()
    await returned
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    )
    await row.getByRole('button', { expanded: false }).click()
    await expect(
      row.getByRole('spinbutton', { name: '模拟耗时（毫秒）', exact: true }),
    ).toHaveValue('987')
  } finally {
    release()
  }
})

test('保存等待期间冻结输入，保存完成后才检查实际保存的配置', async ({ page, request }) => {
  const row = await openProvider(page)
  const latency = row.getByRole('spinbutton', { name: '模拟耗时（毫秒）', exact: true })
  const key = row.getByLabel(/API Key/)
  const check = row.getByRole('button', { name: '测试连接', exact: true })
  const save = row.getByRole('button', { name: '保存', exact: true })
  let tests = 0
  page.on('request', (request) => {
    if (request.url().endsWith('/api/providers/plein/mock/test')) tests++
  })
  await latency.fill('456')
  await key.fill('e2e-placeholder-key')
  await expect(check).toBeDisabled()
  expect(tests).toBe(0)
  let release!: () => void
  let saved!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const accepted = new Promise<void>((resolve) => {
    saved = resolve
  })
  await page.route(`**${configUrl}`, async (route) => {
    if (route.request().method() !== 'PUT') return route.continue()
    const response = await route.fetch()
    expect(response.ok()).toBe(true)
    saved()
    await gate
    await route.fulfill({ response })
  })
  try {
    await save.click()
    await accepted
    await expect(latency).toBeDisabled()
    await expect(key).toBeDisabled()
    await expect(row.getByRole('combobox', { name: '模拟错误', exact: true })).toBeDisabled()
    await expect(check).toBeDisabled()
    await expect(save).toBeDisabled()
    await expect(row.getByRole('status')).toContainText('处理中')
    release()
    await expect(save).toBeEnabled()
    await expect(check).toBeEnabled()
    await expect(key).toHaveValue('')
    const persisted = await (await request.get(configUrl)).json()
    expect(persisted.settings.latencyMs).toBe(456)
    expect(persisted.secrets.MOCK_API_KEY).toBe(true)
    await check.click()
    await expect(row.getByRole('status')).toContainText(
      '连接检查通过；尚未验证具体模型、资源权限或余额',
    )
    expect(tests).toBe(1)
  } finally {
    release()
  }
})

test('检查请求传输失败与服务端检查结果分开显示，重试成功才显示检查范围', async ({ page }) => {
  const row = await openProvider(page)
  await page.route('**/api/providers/plein/mock/test', (route) =>
    route.fulfill({
      status: 503,
      json: { error: 'unavailable', message: '检查服务暂不可用' },
    }),
  )
  const check = row.getByRole('button', { name: '测试连接', exact: true })
  await check.click()
  await expect(row.getByRole('alert')).toContainText('检查请求失败：检查服务暂不可用')
  await expect(
    row.getByText('连接检查通过；尚未验证具体模型、资源权限或余额', { exact: true }),
  ).toHaveCount(0)
  await expect(check).toBeEnabled()
  await page.unroute('**/api/providers/plein/mock/test')
  await check.click()
  await expect(row.getByRole('status')).toContainText(
    '连接检查通过；尚未验证具体模型、资源权限或余额',
  )
  await expect(row.getByRole('alert')).toHaveCount(0)
})
