import { openCanvasSettings } from './settings-ui'
import { expect, type Page, test } from '@playwright/test'
import { addNode, elements, newProject, revealGenerator, waitNode } from './canvas'

const configUrl = '/api/providers/plein/mock/config'
const modelUrl = '/api/model-defaults'
const modelLabel = 'Mock（开发测试用） · Mock 对话'
test.beforeEach(async ({ request }) => {
  expect((await request.put(configUrl, { data: { enabled: true } })).ok()).toBe(true)
  expect(
    (
      await request.put(modelUrl, { data: { capability: 'text.chat', model: 'plein/mock:agent' } })
    ).ok(),
  ).toBe(true)
})
test.afterEach(async ({ request }) => {
  await request.put(configUrl, { data: { enabled: true } })
  await request.put(modelUrl, { data: { capability: 'text.chat', model: 'plein/mock:agent' } })
})
async function openProviders(page: Page) {
  await openCanvasSettings(page)
  const settings = page.getByRole('dialog', { name: '设置', exact: true })
  await settings.getByRole('button', { name: /^模型平台/ }).click()
  return settings
}

test('默认模型等待保存和目录刷新时锁定当前选择，之后仅新节点采用新默认值', async ({
  page,
  request,
}) => {
  await newProject(page)
  await addNode(page, 'LLM')
  const original = (await elements(page)).find((element) => element.nodeType === 'plein/llm')!
  expect(original).toBeDefined()
  await page.keyboard.press('Escape')
  const settings = await openProviders(page)
  const select = settings.getByRole('combobox', { name: '默认文本模型', exact: true })
  let releaseSave!: () => void
  let accepted!: () => void
  let releaseCatalog!: () => void
  let catalogRequested!: () => void
  const catalogStarted = new Promise<void>((resolve) => {
    catalogRequested = resolve
  })
  const saved = new Promise<void>((resolve) => {
    accepted = resolve
  })
  const saveGate = new Promise<void>((resolve) => {
    releaseSave = resolve
  })
  const catalogGate = new Promise<void>((resolve) => {
    releaseCatalog = resolve
  })
  await page.route(`**${modelUrl}`, async (route) => {
    const response = await route.fetch()
    expect(response.ok()).toBe(true)
    accepted()
    await saveGate
    await route.fulfill({ response })
  })
  await page.route('**/api/catalog', async (route) => {
    catalogRequested()
    await catalogGate
    await route.continue()
  })
  try {
    await select.click()
    await page.getByRole('option', { name: modelLabel, exact: true }).click()
    await saved
    expect((await (await request.get('/api/catalog')).json()).defaultModels['text.chat']).toBe(
      'plein/mock:chat',
    )
    await expect(select).toBeDisabled()
    await expect(
      settings.getByRole('combobox', { name: '默认图像模型', exact: true }),
    ).toBeEnabled()
    releaseSave()
    await catalogStarted
    await expect(
      settings.getByRole('status').filter({ hasText: '正在保存文本默认模型' }),
    ).toBeVisible()
    await expect(select).toBeDisabled()
    releaseCatalog()
    await expect(select).toBeEnabled()
    await expect(select).toContainText(modelLabel)
    await settings.getByRole('button', { name: '关闭', exact: true }).click()
    await addNode(page, 'LLM', { x: 1150, y: 450 })
    const created = (await elements(page)).find(
      (element) => element.nodeType === 'plein/llm' && element.id !== original.id,
    )!
    const models = await page.evaluate(
      ({ first, second }) =>
        [first, second].map((id) => window.__plein.engine.doc.get(id)?.params?.model),
      { first: original.id, second: created.id },
    )
    expect(models).toEqual(['plein/mock:agent', 'plein/mock:chat'])
    const generator = page.getByTestId('generator')
    await generator.getByRole('textbox', { name: '提示词' }).fill('验证新默认模型')
    // 编辑器固定在卡片下方，控件可能在窗口外：先把它移进窗口
    const generate = generator.getByRole('button', { name: '生成', exact: true })
    await revealGenerator(page, generate)
    await generate.click()
    await waitNode(page, created.id)
    expect(
      (await elements(page)).find((element) => element.id === created.id)?.results,
    ).toBeGreaterThan(0)
  } finally {
    releaseSave()
    releaseCatalog()
  }
})

test('默认模型保存失败保留原选择，重新选择可真实保存', async ({ page, request }) => {
  await newProject(page)
  const settings = await openProviders(page)
  const select = settings.getByRole('combobox', { name: '默认文本模型', exact: true })
  await page.route(`**${modelUrl}`, (route) =>
    route.fulfill({ status: 503, json: { error: 'test_failure', message: '默认模型暂不可保存' } }),
  )
  await select.click()
  await page.getByRole('option', { name: modelLabel, exact: true }).click()
  await expect(settings.getByRole('alert')).toContainText('默认模型暂不可保存')
  await expect(select).toBeEnabled()
  await expect(select).toContainText('Mock 智能体')
  expect((await (await request.get('/api/catalog')).json()).defaultModels['text.chat']).toBe(
    'plein/mock:agent',
  )
  await page.unroute(`**${modelUrl}`)
  await select.click()
  await page.getByRole('option', { name: modelLabel, exact: true }).click()
  await expect(select).toContainText(modelLabel)
  await expect(settings.getByRole('alert')).toHaveCount(0)
  expect((await (await request.get('/api/catalog')).json()).defaultModels['text.chat']).toBe(
    'plein/mock:chat',
  )
})

test('平台未展开时启停失败仍显示错误，重试后状态与实际配置一致', async ({ page, request }) => {
  await page.setViewportSize({ width: 800, height: 560 })
  await newProject(page)
  const settings = await openProviders(page)
  const row = settings.locator('[data-provider="plein/mock"]')
  const toggle = row.getByRole('switch')
  await expect(row.getByRole('button', { expanded: false })).toBeVisible()
  await page.route(`**${configUrl}`, async (route) => {
    if (route.request().method() === 'PUT')
      await route.fulfill({
        status: 503,
        json: { error: 'test_failure', message: '平台暂不可停用' },
      })
    else await route.continue()
  })
  await toggle.click()
  await expect(row.getByRole('alert')).toContainText('平台暂不可停用')
  await expect(row.getByRole('alert')).toBeInViewport()
  await settings.screenshot({
    path: test.info().outputPath('collapsed-provider-error.png'),
    animations: 'disabled',
  })
  await expect(toggle).toBeChecked()
  expect((await (await request.get(configUrl)).json()).enabled).toBe(true)
  await page.unroute(`**${configUrl}`)
  await toggle.click()
  await expect(toggle).not.toBeChecked()
  await expect(row.getByRole('alert')).toHaveCount(0)
  expect((await (await request.get(configUrl)).json()).enabled).toBe(false)
  await toggle.click()
  await expect(toggle).toBeChecked()
  expect((await (await request.get(configUrl)).json()).enabled).toBe(true)
})
