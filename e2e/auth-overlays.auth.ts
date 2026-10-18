import { expect, type Page, test } from '@playwright/test'
import { waitEngine } from './canvas'

const account = {
  name: '认证交互测试',
  email: 'owner@example.test',
  password: 'local-test-password-1019',
}
async function authenticated(page: Page) {
  const session = await (await page.request.get('/api/session')).json()
  const path = session.needsSetup ? 'sign-up' : 'sign-in'
  expect((await page.request.post(`/api/auth/${path}/email`, { data: account })).ok()).toBe(true)
  const project = await (
    await page.request.post('/api/projects', { data: { title: `会话浮层 ${Date.now()}` } })
  ).json()
  await page.goto('/')
  await expect(page.locator(`[data-project="${project.id}"]`)).toBeVisible()
  return project as { id: string; lastCanvasId: string }
}
async function login(page: Page) {
  await page.getByPlaceholder('邮箱', { exact: true }).fill(account.email)
  await page.getByPlaceholder('密码', { exact: true }).fill(account.password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
}

for (const label of ['资产库', '素材', '创作检查点', '设置']) {
  test(`${label} 读取遇到真实会话失效时不覆盖登录，重新登录也不残留旧窗口`, async ({ page }) => {
    const project = await authenticated(page)
    expect(
      (
        await page.request.post('/api/auth/sign-out', {
          data: {},
          headers: { origin: new URL(page.url()).origin },
        })
      ).ok(),
    ).toBe(true)
    if (label === '创作检查点')
      await page
        .locator(`[data-project="${project.id}"]`)
        .getByRole('button', { name: '项目检查点', exact: true })
        .click()
    else await page.getByRole('banner').getByRole('button', { name: label, exact: true }).click()
    await expect(page.getByText('登录 Plein', { exact: true })).toBeVisible()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await login(page)
    await expect(page.getByRole('heading', { name: '我的项目' })).toBeVisible()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    if (label === '创作检查点')
      await page
        .locator(`[data-project="${project.id}"]`)
        .getByRole('button', { name: '项目检查点', exact: true })
        .click()
    else await page.getByRole('banner').getByRole('button', { name: label, exact: true }).click()
    await expect(page.getByRole('dialog', { name: label, exact: true })).toBeVisible()
  })
}

test('画布改名确认中会话失效，确认框退出并归还可输入的登录页', async ({ page }) => {
  const project = await authenticated(page)
  await page.evaluate((id) => {
    location.hash = `/c/${id}`
  }, project.lastCanvasId)
  await waitEngine(page)
  await page.getByRole('button', { name: '切换画布', exact: true }).click()
  await page.getByRole('button', { name: '重命名当前画布', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '重命名画布', exact: true })
  await dialog.getByRole('textbox').fill('会话失效后不能保存的标题')
  expect(
    (
      await page.request.post('/api/auth/sign-out', {
        data: {},
        headers: { origin: new URL(page.url()).origin },
      })
    ).ok(),
  ).toBe(true)
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.getByText('登录 Plein', { exact: true })).toBeVisible()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await page.screenshot({ path: test.info().outputPath('expired-session-login.png') })
  await login(page)
  await waitEngine(page)
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByRole('button', { name: '切换画布', exact: true })).toHaveText('画布 1')
  expect(
    (await (await page.request.get(`/api/canvases/${project.lastCanvasId}`)).json()).title,
  ).toBe('画布 1')
})
