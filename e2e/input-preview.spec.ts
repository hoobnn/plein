import { expect, type Route, test } from '@playwright/test'
import { addNode, byName, deselect, newProject, waitNode } from './canvas'

test('实际输入首次读取失败可见，重试只刷新预览不生成', async ({ page }) => {
  await newProject(page)
  let failing = true
  let runs = 0
  page.on('request', (r) => {
    if (r.method() === 'POST' && /\/nodes\/[^/]+\/run$/.test(r.url())) runs++
  })
  await page.route('**/api/canvases/*/nodes/*/input', (route) =>
    failing
      ? route.fulfill({ status: 503, json: { message: '输入服务暂时不可用' } })
      : route.continue(),
  )
  await addNode(page, '图片')
  await page.getByRole('textbox', { name: '提示词' }).fill('雨后的天台')
  const preview = page.getByTestId('input-preview')
  await expect(preview.getByRole('alert')).toContainText('输入服务暂时不可用')
  failing = false
  await preview.getByRole('button', { name: '重新读取实际输入' }).click()
  await expect(preview.getByRole('alert')).toHaveCount(0)
  await preview.getByRole('button', { name: /实际输入/ }).click()
  await expect(preview).toContainText('雨后的天台')
  expect(runs).toBe(0)
})

test('预览刷新失败标明旧数据，旧阻断不锁死生成，409 返回的新输入恢复预览', async ({ page }) => {
  await newProject(page)
  await addNode(page, '角色')
  await deselect(page)
  await addNode(page, '图片', { x: 1200, y: 200 })
  const image = await byName(page, '生成图片')
  const prompt = page.getByRole('textbox', { name: '提示词' })
  await prompt.fill('@角色 站在天台上')
  const preview = page.getByTestId('input-preview')
  await expect(preview).toContainText('Mock 图片')
  await preview.getByRole('button', { name: /实际输入/ }).click()
  await preview.getByRole('button', { name: '可选' }).click()
  const generate = page.getByRole('button', { name: '生成', exact: true })
  await expect(preview).toContainText('不会提交')
  await expect(generate).toBeDisabled()

  // 去掉必需但没图的角色引用；准备新输入失败时，旧阻断不能冒充现在的状态。
  await page.route('**/api/canvases/*/nodes/*/input', (route) =>
    route.fulfill({ status: 503, json: { message: '输入刷新失败' } }),
  )
  await prompt.fill('没有角色的空天台')
  await expect(preview.getByRole('alert')).toContainText('输入刷新失败')
  await expect(preview).toContainText('上次读取的输入')
  await expect(generate).toBeEnabled()
  const changed = page.waitForResponse(
    (r) => r.request().method() === 'POST' && /\/nodes\/[^/]+\/run$/.test(r.url()),
  )
  await generate.click()
  expect((await changed).status()).toBe(409)
  await expect(preview.getByRole('alert')).toHaveCount(0)
  await expect(preview).toContainText('没有角色的空天台')
  await expect(preview).not.toContainText('不会提交')
  expect(
    await page.evaluate((id) => window.__plein.engine.doc.get(id)?.results?.length ?? 0, image.id),
  ).toBe(0)
  await generate.click()
  await waitNode(page, image.id)
})

test('提交的 409 新输入不会被仍在途中的预览响应覆盖', async ({ page }) => {
  await newProject(page)
  await addNode(page, '图片')
  const prompt = page.getByRole('textbox', { name: '提示词' })
  await prompt.fill('最初的输入')
  const preview = page.getByTestId('input-preview')
  await expect(preview).toHaveAttribute('aria-busy', 'false')
  await preview.getByRole('button', { name: /实际输入/ }).click()
  await expect(preview).toContainText('最初的输入')

  // 付费提交入口由测试接管，模拟提交时输入又变了的 409，不创建任务。
  let submit: Route | undefined
  await page.route('**/api/canvases/*/nodes/*/run', (route) => {
    submit = route
  })
  await page.getByRole('button', { name: '生成', exact: true }).click()
  await expect.poll(() => !!submit).toBe(true)
  let pending: Route | undefined
  let snapshot: unknown
  await page.route('**/api/canvases/*/nodes/*/input', async (route) => {
    snapshot = await (await route.fetch()).json()
    pending = route
  })
  await prompt.fill('仍在途中的输入')
  await expect.poll(() => !!pending).toBe(true)
  await submit!.fulfill({
    status: 409,
    json: {
      error: 'input_changed',
      message: '输入已变更，请重新确认',
      input: { ...(snapshot as object), prompt: '提交返回的新输入', inputHash: 'v2:receipt' },
    },
  })
  await expect(preview).toContainText('提交返回的新输入')
  const response = page.waitForResponse((r) => r.request() === pending!.request())
  await pending!.fulfill({ json: snapshot })
  await (await response).finished()
  await page.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
  )
  await expect(preview).toContainText('提交返回的新输入')
  await expect(preview).not.toContainText('仍在途中的输入')
})
