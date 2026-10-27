import { expect, type Page, test } from './fixtures'
import { article, checkpointPair, panel } from './checkpoints'

async function confirmDelete(page: Page, name: string) {
  await article(page, name)
    .getByRole('button', { name: `删除检查点 ${name}`, exact: true })
    .click()
  await page
    .getByRole('dialog', { name: `删除检查点「${name}」？`, exact: true })
    .getByRole('button', { name: '删除检查点', exact: true })
    .click()
}

for (const reopen of [false, true]) {
  test(`删除等待期间${reopen ? '关闭并重开窗口后' : ''}切换预览，成功仅移除目标版本`, async ({
    page,
  }) => {
    const f = await checkpointPair(page)
    let release!: () => void
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    let writes = 0
    const path = `/api/checkpoints/${f.first.id}`
    await page.route(`**${path}`, async (route) => {
      if (route.request().method() !== 'DELETE') return route.continue()
      writes++
      await pending
      await route.continue()
    })
    try {
      await article(page, f.first.name)
        .getByRole('button', { name: '只读预览', exact: true })
        .click()
      await expect(panel(page).getByTestId('checkpoint-preview')).toContainText('第一版正文')
      await confirmDelete(page, f.first.name)
      await expect.poll(() => writes).toBe(1)
      await expect(panel(page).getByRole('status')).toContainText('正在删除检查点')
      await expect(
        article(page, f.first.name).getByRole('button', {
          name: `删除检查点 ${f.first.name}`,
          exact: true,
        }),
      ).toBeDisabled()
      if (!reopen) {
        for (const width of [390, 320]) {
          await page.setViewportSize({ width, height: 700 })
          await expect(panel(page).getByRole('status')).toBeInViewport({ ratio: 1 })
          await expect(
            panel(page).getByRole('button', { name: '关闭', exact: true }),
          ).toBeInViewport({ ratio: 1 })
        }
        await panel(page).screenshot({
          path: test.info().outputPath('checkpoint-delete-pending-mobile.png'),
          animations: 'disabled',
        })
        await page.setViewportSize({ width: 1440, height: 900 })
      }
      if (reopen) {
        await panel(page).getByRole('button', { name: '关闭', exact: true }).click()
        await expect(panel(page)).toHaveCount(0)
        await page.getByRole('button', { name: '检查点', exact: true }).click()
      }
      await expect(panel(page).getByRole('status')).toContainText('正在删除检查点')
      await expect(
        article(page, f.first.name).getByRole('button', {
          name: `删除检查点 ${f.first.name}`,
          exact: true,
        }),
      ).toBeDisabled()
      await expect(
        article(page, f.first.name).getByRole('button', { name: '恢复为新画布', exact: true }),
      ).toBeDisabled()
      await article(page, f.second.name)
        .getByRole('button', { name: '只读预览', exact: true })
        .click()
      const section = panel(page).getByRole('region', {
        name: `预览检查点 ${f.second.name}`,
        exact: true,
      })
      await expect(section.getByTestId('checkpoint-preview')).toContainText('第二版正文')
      const completed = page
        .waitForResponse((r) => r.url().endsWith(path) && r.request().method() === 'DELETE')
        .then((r) => r.finished())
      release()
      await completed
      await expect(article(page, f.first.name)).toHaveCount(0)
      await expect(section.getByTestId('checkpoint-preview')).toContainText('第二版正文')
      expect((await page.request.get(path)).status()).toBe(404)
      expect((await page.request.get(`/api/checkpoints/${f.second.id}`)).status()).toBe(200)
      expect(writes).toBe(1)
      expect(await page.evaluate(() => [...window.__plein.engine.doc.elements()])).toEqual(
        f.original,
      )
    } finally {
      release()
    }
  })
}

test('删除成功但列表刷新失败时保留其他检查点，可刷新恢复且不重复删除', async ({ page }) => {
  const f = await checkpointPair(page)
  let fail = true,
    writes = 0
  await page.route(`**/api/projects/${f.projectId}/checkpoints?*`, (route) =>
    fail
      ? route.fulfill({ status: 503, json: { message: '检查点列表暂时失败' } })
      : route.continue(),
  )
  await page.route(`**/api/checkpoints/${f.first.id}`, (route) => {
    if (route.request().method() === 'DELETE') writes++
    return route.continue()
  })
  await article(page, f.second.name).getByRole('button', { name: '只读预览', exact: true }).click()
  await expect(panel(page).getByTestId('checkpoint-preview')).toContainText('第二版正文')
  await confirmDelete(page, f.first.name)
  await expect(panel(page).getByRole('alert')).toContainText('检查点列表暂时失败')
  await expect(article(page, f.first.name)).toHaveCount(0)
  await expect(article(page, f.second.name)).toBeVisible()
  await expect(panel(page).getByTestId('checkpoint-preview')).toContainText('第二版正文')
  fail = false
  await panel(page).getByRole('button', { name: '刷新', exact: true }).click()
  await expect(panel(page).getByRole('alert')).toHaveCount(0)
  await expect(article(page, f.second.name)).toBeVisible()
  await expect(article(page, f.first.name)).toHaveCount(0)
  expect(writes).toBe(1)
  expect(await page.evaluate(() => [...window.__plein.engine.doc.elements()])).toEqual(f.original)
})

test('取消删除和 Esc 不发送请求，失败保留原版本，显式重试后才删除', async ({ page }) => {
  const f = await checkpointPair(page)
  let fail = true,
    writes = 0
  await page.route(`**/api/checkpoints/${f.first.id}`, (route) => {
    if (route.request().method() !== 'DELETE') return route.continue()
    writes++
    return fail
      ? route.fulfill({ status: 503, json: { message: '删除服务暂时不可用' } })
      : route.continue()
  })
  await article(page, f.first.name).getByRole('button', { name: '只读预览', exact: true }).click()
  await expect(panel(page).getByTestId('checkpoint-preview')).toContainText('第一版正文')
  const remove = article(page, f.first.name).getByRole('button', {
    name: `删除检查点 ${f.first.name}`,
    exact: true,
  })
  const confirmation = page.getByRole('dialog', {
    name: `删除检查点「${f.first.name}」？`,
    exact: true,
  })
  for (const cancel of ['button', 'escape']) {
    await remove.click()
    await expect(confirmation).toContainText('当前画布和素材文件保留')
    if (cancel === 'button')
      await confirmation.getByRole('button', { name: '取消', exact: true }).click()
    else await page.keyboard.press('Escape')
    await expect(confirmation).toHaveCount(0)
    await expect(remove).toBeFocused()
    expect(writes).toBe(0)
  }
  await confirmDelete(page, f.first.name)
  await expect(panel(page).getByRole('alert')).toContainText('删除服务暂时不可用')
  await expect(remove).toBeEnabled()
  await expect(panel(page).getByTestId('checkpoint-preview')).toContainText('第一版正文')
  expect(writes).toBe(1)
  fail = false
  await confirmDelete(page, f.first.name)
  await expect(article(page, f.first.name)).toHaveCount(0)
  await expect(article(page, f.second.name)).toBeVisible()
  await expect(panel(page).getByRole('region', { name: /^预览检查点/ })).toHaveCount(0)
  expect(writes).toBe(2)
  expect(await page.evaluate(() => [...window.__plein.engine.doc.elements()])).toEqual(f.original)
})

test('删除前发起的旧列表迟到时，不带回已经删除的检查点', async ({ page }) => {
  const f = await checkpointPair(page)
  let releaseDelete!: () => void, releaseList!: () => void
  const deleting = new Promise<void>((resolve) => {
    releaseDelete = resolve
  })
  const listing = new Promise<void>((resolve) => {
    releaseList = resolve
  })
  let received = false,
    settled = false,
    reads = 0,
    writes = 0
  const path = `/api/checkpoints/${f.first.id}`
  await page.route(`**${path}`, async (route) => {
    if (route.request().method() !== 'DELETE') return route.continue()
    writes++
    await deleting
    await route.continue()
  })
  await page.route(`**/api/projects/${f.projectId}/checkpoints?*`, async (route) => {
    reads++
    if (reads !== 1) return route.continue()
    const response = await route.fetch()
    received = true
    await listing
    await route.fulfill({ response }).catch(() => {})
    settled = true
  })
  try {
    await confirmDelete(page, f.first.name)
    await expect.poll(() => writes).toBe(1)
    await panel(page).getByRole('button', { name: '刷新', exact: true }).click()
    await expect.poll(() => received).toBe(true)
    releaseDelete()
    await expect(article(page, f.first.name)).toHaveCount(0)
    await expect.poll(() => reads).toBe(2)
    await expect(panel(page).getByRole('button', { name: '刷新', exact: true })).toBeEnabled()
    releaseList()
    await expect.poll(() => settled).toBe(true)
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    )
    await expect(article(page, f.first.name)).toHaveCount(0)
    await expect(article(page, f.second.name)).toBeVisible()
    expect((await page.request.get(path)).status()).toBe(404)
    expect(writes).toBe(1)
  } finally {
    releaseDelete()
    releaseList()
  }
})
