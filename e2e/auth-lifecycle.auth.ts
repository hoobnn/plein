import { expect, type Route, test } from './fixtures'
import { waitEngine } from './canvas'

// 仅用于每次新建的隔离认证数据库。
const account = {
  name: '认证交互测试',
  email: 'owner@example.test',
  password: 'local-test-password-1019',
}

test('真实创建所有者并退出，登录区分服务失败和密码错误，等待时防止重复提交', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '创建所有者账号' })).toBeVisible()
  await page.getByPlaceholder('名字（可选）').fill(account.name)
  await page.getByPlaceholder('邮箱', { exact: true }).fill(account.email)
  await page.getByPlaceholder('密码（至少 8 位）').fill(account.password)
  let setups = 0
  let releaseSetup!: () => void
  const setupHeld = new Promise<void>((resolve) => {
    releaseSetup = resolve
  })
  await page.route('**/api/auth/sign-up/email', async (route) => {
    if (++setups !== 1) return route.continue()
    await setupHeld
    await route.fulfill({ status: 503, json: { message: '账号创建暂不可用' } })
  })
  try {
    await page.locator('form').evaluate((el) => {
      ;(el as HTMLFormElement).requestSubmit()
      ;(el as HTMLFormElement).requestSubmit()
    })
    await expect(page.getByRole('button', { name: '正在创建…', exact: true })).toBeDisabled()
    await expect(page.getByPlaceholder('名字（可选）')).toBeDisabled()
    await expect.poll(() => setups).toBe(1)
    releaseSetup()
    await expect(page.getByRole('alert')).toContainText('账号创建暂不可用')
    await expect(page.getByPlaceholder('邮箱', { exact: true })).toHaveValue(account.email)
  } finally {
    releaseSetup()
  }
  await page.getByRole('button', { name: '创建并进入', exact: true }).click()
  await expect(page.getByRole('heading', { name: '我的项目' })).toBeVisible()
  await page.getByRole('button', { name: '退出登录', exact: true }).click()
  await expect(page.getByRole('heading', { name: '登录 Plein' })).toBeVisible()
  let writes = 0
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route('**/api/auth/sign-in/email', async (route) => {
    writes++
    if (writes !== 1) return route.continue()
    await held
    await route.fulfill({ status: 503, json: { message: '登录服务暂不可用' } })
  })
  try {
    await page.getByPlaceholder('邮箱', { exact: true }).fill(account.email)
    await page.getByPlaceholder('密码', { exact: true }).fill(account.password)
    await page.locator('form').evaluate((el) => {
      ;(el as HTMLFormElement).requestSubmit()
      ;(el as HTMLFormElement).requestSubmit()
    })
    await expect(page.getByRole('button', { name: '正在登录…', exact: true })).toBeDisabled()
    await expect.poll(() => writes).toBe(1)
    await expect(page.getByPlaceholder('邮箱', { exact: true })).toBeDisabled()
    release()
    await expect(page.getByRole('alert')).toContainText('登录服务暂不可用')
    await expect(page.getByRole('alert')).not.toContainText('邮箱或密码不正确')
    await page.getByPlaceholder('密码', { exact: true }).fill('wrong-password-1019')
    await page.getByRole('button', { name: '登录', exact: true }).click()
    await expect(page.getByRole('alert')).toContainText('邮箱或密码不正确')
    await page.screenshot({ path: test.info().outputPath('login-retry.png') })
    await page.getByPlaceholder('密码', { exact: true }).fill(account.password)
    await page.getByRole('button', { name: '登录', exact: true }).click()
    await expect(page.getByRole('heading', { name: '我的项目' })).toBeVisible()
    expect(writes).toBe(3)
  } finally {
    release()
  }
})

for (const success of [false, true]) {
  test(`退出等待中进入画布，迟到${success ? '成功仍完成全局退出' : '失败只提示并保留当前位置'}`, async ({
    page,
  }) => {
    const session = await (await page.request.get('/api/session')).json()
    const path = session.needsSetup ? 'sign-up' : 'sign-in'
    expect((await page.request.post(`/api/auth/${path}/email`, { data: account })).ok()).toBe(true)
    const title = `退出边界 ${Date.now()}`
    const project = await (await page.request.post('/api/projects', { data: { title } })).json()
    await page.goto('/')
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    await page.route('**/api/auth/sign-out', async (route) => {
      await held
      if (success) await route.continue()
      else await route.fulfill({ status: 503, json: { message: '迟到的退出失败' } })
    })
    try {
      await page.getByRole('button', { name: '退出登录', exact: true }).click()
      await expect(page.getByRole('button', { name: '正在退出…', exact: true })).toBeDisabled()
      await page
        .locator(`[data-project="${project.id}"]`)
        .getByRole('link', { name: title, exact: true })
        .click()
      await waitEngine(page)
      if (!success) {
        await page.evaluate(() => {
          location.hash = '/'
        })
        await expect(page.getByRole('button', { name: '正在退出…', exact: true })).toBeDisabled()
        await page.evaluate((id) => {
          location.hash = `/c/${id}`
        }, project.lastCanvasId)
        await waitEngine(page)
      }
      release()
      if (success) {
        await expect(page.getByRole('heading', { name: '登录 Plein' })).toBeVisible()
        expect((await page.request.get(`/api/projects/${project.id}`)).status()).toBe(401)
      } else {
        await expect(page.getByText('退出登录失败：迟到的退出失败', { exact: true })).toBeVisible()
        expect(new URL(page.url()).hash).toBe(`#/c/${project.lastCanvasId}`)
        expect((await page.request.get(`/api/projects/${project.id}`)).ok()).toBe(true)
      }
    } finally {
      release()
    }
  })
}

test('退出失败保留会话和项目，等待时仅提交一次，重试真实退出后受保护接口不可访问', async ({
  page,
}) => {
  const session = await (await page.request.get('/api/session')).json()
  if (session.needsSetup) await page.request.post('/api/auth/sign-up/email', { data: account })
  else
    expect((await page.request.post('/api/auth/sign-in/email', { data: account })).ok()).toBe(true)
  const project = await (
    await page.request.post('/api/projects', { data: { title: '退出失败保留项目' } })
  ).json()
  await page.goto('/')
  let writes = 0
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route('**/api/auth/sign-out', async (route) => {
    writes++
    if (writes !== 1) return route.continue()
    await held
    await route.fulfill({ status: 503, json: { message: '退出服务暂不可用' } })
  })
  try {
    await page.getByRole('button', { name: '退出登录', exact: true }).evaluate((el) => {
      ;(el as HTMLButtonElement).click()
      ;(el as HTMLButtonElement).click()
    })
    await expect(page.getByRole('button', { name: '正在退出…', exact: true })).toBeDisabled()
    await expect.poll(() => writes).toBe(1)
    release()
    await expect(page.getByRole('alert')).toContainText('退出服务暂不可用')
    await expect(page.locator(`[data-project="${project.id}"]`)).toBeVisible()
    expect((await page.request.get(`/api/projects/${project.id}`)).ok()).toBe(true)
    await page.getByRole('button', { name: '退出登录', exact: true }).click()
    await expect(page.getByRole('heading', { name: '登录 Plein' })).toBeVisible()
    expect((await page.request.get(`/api/projects/${project.id}`)).status()).toBe(401)
    expect(writes).toBe(2)
  } finally {
    release()
  }
})

for (const failed of [false, true]) {
  test(`真实退出后迟到会话${failed ? '读取失败' : '旧身份'}不能覆盖登录页面`, async ({ page }) => {
    const session = await (await page.request.get('/api/session')).json()
    const path = session.needsSetup ? 'sign-up' : 'sign-in'
    expect((await page.request.post(`/api/auth/${path}/email`, { data: account })).ok()).toBe(true)
    const project = await (
      await page.request.post('/api/projects', { data: { title: '会话顺序检查' } })
    ).json()
    await page.goto('/')
    await expect(page.locator(`[data-project="${project.id}"]`)).toBeVisible()
    let held: { route: Route; response: Awaited<ReturnType<Route['fetch']>> } | undefined
    await page.route('**/api/session', async (route) => {
      if (held) return route.continue()
      held = { route, response: await route.fetch() }
    })
    await page.route(`**/api/projects/${project.id}/package/summary`, (route) =>
      route.fulfill({ status: 401, json: { message: '需要刷新会话' } }),
    )
    await page
      .locator(`[data-project="${project.id}"]`)
      .getByRole('button', { name: '导出项目包', exact: true })
      .click()
    await expect.poll(() => !!held).toBe(true)
    await page
      .getByRole('dialog', { name: '导出项目包', exact: true })
      .getByRole('button', { name: '取消', exact: true })
      .click()
    await page.getByRole('button', { name: '退出登录', exact: true }).click()
    await expect(page.getByRole('heading', { name: '登录 Plein' })).toBeVisible()
    let projectReads = 0
    page.on('request', (r) => {
      if (r.method() === 'GET' && r.url().endsWith('/api/projects')) projectReads++
    })
    const received = page.waitForResponse((r) => r.url().endsWith('/api/session'))
    if (failed) await held!.route.fulfill({ status: 503, json: { message: '迟到会话读取失败' } })
    else await held!.route.fulfill({ response: held!.response })
    await (await received).finished()
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    )
    await expect(page.getByRole('heading', { name: '登录 Plein' })).toBeVisible()
    expect(projectReads).toBe(0)
  })
}
