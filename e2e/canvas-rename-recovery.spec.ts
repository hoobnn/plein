import { expect, type Page, test } from './fixtures'
import { newProject } from './canvas'

async function fixture(page: Page) {
  await newProject(page)
  const id = decodeURIComponent(page.url().split('#/c/')[1]!)
  const canvas = await (await page.request.get(`/api/canvases/${id}`)).json()
  const other = await (
    await page.request.post('/api/canvases', {
      data: { projectId: canvas.projectId, title: '另一张画布' },
    })
  ).json()
  return { ...canvas, other }
}
async function rename(page: Page) {
  await page.getByRole('button', { name: '切换画布', exact: true }).click()
  await page
    .getByRole('dialog', { name: '画布', exact: true })
    .getByRole('button', { name: '重命名当前画布', exact: true })
    .click()
  return page.getByRole('dialog', { name: '重命名画布', exact: true })
}

test('画布改名失败保留名称并可原地修改重试，成功后菜单与页头一致', async ({ page }) => {
  const f = await fixture(page)
  let writes = 0
  await page.route(`**/api/canvases/${f.id}`, (route) => {
    if (route.request().method() !== 'PATCH') return route.continue()
    writes++
    return writes === 1
      ? route.fulfill({ status: 503, json: { message: '画布名称保存失败，请重试' } })
      : route.continue()
  })
  const dialog = await rename(page)
  await dialog.getByRole('textbox').fill('未丢失的画布名称 🌧️')
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  await expect(dialog.getByRole('alert')).toContainText('画布名称保存失败，请重试')
  await expect(dialog.getByRole('textbox')).toHaveValue('未丢失的画布名称 🌧️')
  await expect(dialog.getByRole('textbox')).toBeFocused()
  await page.setViewportSize({ width: 390, height: 700 })
  await expect(dialog.getByRole('alert')).toBeInViewport()
  await dialog.screenshot({
    path: test.info().outputPath('canvas-rename-error.png'),
    animations: 'disabled',
  })
  await page.setViewportSize({ width: 1440, height: 900 })
  await dialog.getByRole('textbox').fill('修改后重试成功')
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByRole('button', { name: '切换画布', exact: true })).toHaveText(
    '修改后重试成功',
  )
  await page.getByRole('button', { name: '切换画布', exact: true }).click()
  await expect(
    page
      .getByRole('dialog', { name: '画布', exact: true })
      .getByRole('button', { name: '修改后重试成功', exact: true }),
  ).toHaveAttribute('aria-current', 'true')
  expect((await (await page.request.get(`/api/canvases/${f.id}`)).json()).title).toBe(
    '修改后重试成功',
  )
  expect(writes).toBe(2)
})

test('画布改名等待有反馈且仅提交一次，关闭等待窗口不丢失成功结果', async ({ page }) => {
  const f = await fixture(page)
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  let writes = 0
  await page.route(`**/api/canvases/${f.id}`, async (route) => {
    if (route.request().method() !== 'PATCH') return route.continue()
    writes++
    await pending
    await route.continue()
  })
  try {
    const dialog = await rename(page)
    await dialog.getByRole('textbox').fill('等待保存的画布')
    await dialog.getByRole('button', { name: '保存', exact: true }).click()
    await expect.poll(() => writes).toBe(1)
    await expect(dialog.getByRole('textbox')).toBeDisabled()
    await expect(dialog.getByRole('button', { name: '保存中…', exact: true })).toBeDisabled()
    await dialog.getByRole('button', { name: '关闭', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    release()
    await expect(page.getByRole('button', { name: '切换画布', exact: true })).toHaveText(
      '等待保存的画布',
    )
    expect(writes).toBe(1)
  } finally {
    release()
  }
})

test('画布改名请求期间切走再返回，迟到成功更新原画布标题而不跳转', async ({ page }) => {
  const f = await fixture(page)
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  let writes = 0
  await page.route(`**/api/canvases/${f.id}`, async (route) => {
    if (route.request().method() !== 'PATCH') return route.continue()
    writes++
    await pending
    await route.continue()
  })
  try {
    const dialog = await rename(page)
    await dialog.getByRole('textbox').fill('返回后仍能接收的标题')
    await dialog.getByRole('button', { name: '保存', exact: true }).click()
    await expect.poll(() => writes).toBe(1)
    if (await dialog.getByRole('button', { name: '关闭', exact: true }).count())
      await dialog.getByRole('button', { name: '关闭', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await page.getByRole('button', { name: '切换画布', exact: true }).click()
    await page
      .getByRole('dialog', { name: '画布', exact: true })
      .getByRole('button', { name: f.other.title, exact: true })
      .click()
    await expect(page.getByRole('button', { name: '切换画布', exact: true })).toHaveText(
      f.other.title,
    )
    await page.getByRole('button', { name: '切换画布', exact: true }).click()
    await page
      .getByRole('dialog', { name: '画布', exact: true })
      .getByRole('button', { name: f.title, exact: true })
      .click()
    await expect(page.getByRole('button', { name: '切换画布', exact: true })).toHaveText(f.title)
    release()
    await expect(page.getByRole('button', { name: '切换画布', exact: true })).toHaveText(
      '返回后仍能接收的标题',
    )
    expect(page.url()).toContain(`#/c/${f.id}`)
    expect(writes).toBe(1)
  } finally {
    release()
  }
})

test('画布改名取消、空白和原名称不提交，中文组字 Esc 不关闭窗口', async ({ page }) => {
  const f = await fixture(page)
  let writes = 0
  page.on('request', (request) => {
    if (request.method() === 'PATCH' && request.url().endsWith(`/api/canvases/${f.id}`)) writes++
  })
  let dialog = await rename(page)
  await dialog.getByRole('textbox').dispatchEvent('keydown', { key: 'Escape', isComposing: true })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('textbox').fill('应取消的名称')
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  dialog = await rename(page)
  await dialog.getByRole('textbox').fill('   ')
  await expect(dialog.getByRole('button', { name: '保存', exact: true })).toBeDisabled()
  await dialog.getByRole('textbox').fill(f.title)
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  expect(writes).toBe(0)
})

for (const outcome of ['success', 'failure'] as const) {
  test(`已关闭的改名窗口迟到${outcome === 'success' ? '成功' : '失败'}不关闭或修改随后新建画布的输入框`, async ({
    page,
  }) => {
    const f = await fixture(page)
    let release!: () => void
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    let writes = 0
    await page.route(`**/api/canvases/${f.id}`, async (route) => {
      if (route.request().method() !== 'PATCH') return route.continue()
      writes++
      await pending
      if (outcome === 'failure')
        return route.fulfill({ status: 503, json: { message: '旧改名窗口失败' } })
      await route.continue()
    })
    try {
      const dialog = await rename(page)
      await dialog.getByRole('textbox').fill('已发送的原画布名称')
      await dialog.getByRole('button', { name: '保存', exact: true }).click()
      await expect.poll(() => writes).toBe(1)
      await dialog.getByRole('button', { name: '关闭', exact: true }).click()
      await expect(dialog).toHaveCount(0)
      await page.getByRole('button', { name: '切换画布', exact: true }).click()
      await page
        .getByRole('dialog', { name: '画布', exact: true })
        .getByRole('button', { name: '新建画布', exact: true })
        .click()
      const next = page.getByRole('dialog', { name: '新建画布', exact: true })
      await next.getByRole('textbox').fill('不受旧请求影响的新草稿')
      const completed = page
        .waitForResponse(
          (response) =>
            response.request().method() === 'PATCH' &&
            response.url().endsWith(`/api/canvases/${f.id}`),
        )
        .then((response) => response.finished())
      release()
      await completed
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      )
      await expect(next).toBeVisible()
      await expect(next.getByRole('textbox')).toHaveValue('不受旧请求影响的新草稿')
      await expect(next.getByRole('alert')).toHaveCount(0)
      await next.getByRole('button', { name: '取消', exact: true }).click()
      await expect(page.getByRole('button', { name: '切换画布', exact: true })).toHaveText(
        outcome === 'success' ? '已发送的原画布名称' : f.title,
      )
      expect(writes).toBe(1)
    } finally {
      release()
    }
  })
}
