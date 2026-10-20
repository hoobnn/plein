import { expect, type Page, test } from '@playwright/test'
import { newProject } from './canvas'

async function fixture(page: Page) {
  await newProject(page)
  const id = page.url().split('#/c/')[1]!
  return (await page.request.get(`/api/canvases/${id}`)).json() as Promise<{
    id: string
    projectId: string
  }>
}
async function open(page: Page) {
  await page.getByRole('button', { name: '切换画布', exact: true }).click()
  await page.getByRole('button', { name: '新建画布', exact: true }).click()
  return page.getByRole('dialog', { name: '新建画布', exact: true })
}
test('新建画布失败保留名称、焦点和错误，窄屏可修改重试成功', async ({ page }, testInfo) => {
  const f = await fixture(page)
  const original = page.url()
  let writes = 0
  await page.route('**/api/canvases', (route) => {
    if (route.request().method() !== 'POST') return route.continue()
    writes++
    return writes === 1
      ? route.fulfill({ status: 503, json: { message: '新画布创建暂时失败，请重试' } })
      : route.continue()
  })
  const dialog = await open(page)
  const input = dialog.getByRole('textbox', { name: '画布名称', exact: true })
  await input.fill('未丢失的新画布草稿 🌧️')
  await dialog.getByRole('button', { name: '新建', exact: true }).click()
  await expect(dialog.getByRole('alert')).toContainText('新画布创建暂时失败，请重试', {
    timeout: 1500,
  })
  await expect(input).toHaveValue('未丢失的新画布草稿 🌧️')
  await expect(input).toBeFocused()
  expect(page.url()).toBe(original)
  await page.setViewportSize({ width: 390, height: 700 })
  await expect(dialog.getByRole('alert')).toBeInViewport()
  await page.screenshot({ path: testInfo.outputPath('create-retry.png'), animations: 'disabled' })
  await input.fill('修改草稿后成功创建')
  await dialog.getByRole('button', { name: '新建', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page).not.toHaveURL(original)
  const list = await (await page.request.get(`/api/projects/${f.projectId}/canvases`)).json()
  expect(
    list.filter((item: { title: string }) => item.title === '修改草稿后成功创建'),
  ).toHaveLength(1)
  expect(list.some((item: { id: string }) => item.id === f.id)).toBe(true)
  expect(writes).toBe(2)
})

for (const outcome of ['success', 'failure']) {
  test(`创建画布等待只提交一次，关闭后迟到${outcome}不覆盖新输入框`, async ({ page }) => {
    const f = await fixture(page)
    const original = page.url()
    let release!: () => void
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    let writes = 0
    await page.route('**/api/canvases', async (route) => {
      if (route.request().method() !== 'POST') return route.continue()
      writes++
      await pending
      return outcome === 'success'
        ? route.fulfill({ response: await route.fetch() })
        : route.fulfill({ status: 503, json: { message: '旧创建请求失败' } })
    })
    try {
      const dialog = await open(page)
      await dialog.getByRole('textbox').fill('等待中的新画布')
      await dialog.getByRole('button', { name: '新建', exact: true }).click()
      await expect.poll(() => writes).toBe(1)
      await expect(dialog.getByRole('textbox')).toBeDisabled()
      await expect(dialog.getByRole('button', { name: '新建中…', exact: true })).toBeDisabled()
      await dialog.dispatchEvent('submit', { bubbles: true, cancelable: true })
      expect(writes).toBe(1)
      await dialog.getByRole('button', { name: '关闭', exact: true }).click()
      await expect(dialog).toHaveCount(0)
      const next = await open(page)
      await next.getByRole('textbox').fill('随后打开的新草稿')
      const response = page.waitForResponse(
        (r) => r.request().method() === 'POST' && r.url().endsWith('/api/canvases'),
      )
      release()
      await response
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      )
      await expect(next).toBeVisible()
      await expect(next.getByRole('textbox')).toHaveValue('随后打开的新草稿')
      expect(page.url()).toBe(original)
      await expect(next.getByRole('alert')).toHaveCount(0)
      await expect(page.getByText('旧创建请求失败', { exact: true })).toHaveCount(0)
      await next.getByRole('button', { name: '取消', exact: true }).click()
      expect(writes).toBe(1)
      const list = await (await page.request.get(`/api/projects/${f.projectId}/canvases`)).json()
      expect(
        list.filter((item: { title: string }) => item.title === '等待中的新画布'),
      ).toHaveLength(outcome === 'success' ? 1 : 0)
    } finally {
      release()
    }
  })
}
