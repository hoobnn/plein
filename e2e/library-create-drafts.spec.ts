import { openLibraryPanel } from './library-ui'
import { expect, test } from '@playwright/test'
import { newProject } from './canvas'

test('官方复制完成后可直接编辑保存，更新复制条目而不再次创建', async ({ page }) => {
  await newProject(page)
  await openLibraryPanel(page)
  const panel = page.getByRole('dialog', { name: '资产库', exact: true })
  await panel.getByRole('button', { name: '风格', exact: true }).click()
  await panel.getByRole('button', { name: '官方', exact: true }).click()
  await panel.getByRole('listitem').first().getByRole('button').first().click()
  let creates = 0
  let updates = 0
  await page.route('**/api/library', async (route) => {
    if (route.request().method() === 'POST') creates++
    await route.continue()
  })
  await page.route('**/api/library/*', async (route) => {
    if (route.request().method() === 'PATCH') updates++
    await route.continue()
  })
  await panel.getByRole('button', { name: '复制到我的', exact: true }).click()
  const name = panel.getByRole('textbox', { name: '名称', exact: true })
  await expect(name).toBeEnabled()
  await expect(panel.getByRole('button', { name: '已保存', exact: true })).toBeDisabled()
  await name.fill('复制后编辑的风格')
  await panel.getByRole('button', { name: '保存', exact: true }).click()
  await expect(panel.getByRole('button', { name: '已保存', exact: true })).toBeDisabled()
  expect(creates).toBe(1)
  expect(updates).toBe(1)
  const saved = await (await page.request.get('/api/library')).json()
  expect(saved.some((item: { name: string }) => item.name === '复制后编辑的风格')).toBe(true)
})

for (const action of ['保存', '保存并添加到画布']) {
  test(`新建${action}等待时继续编辑，响应后保留新内容并更新同一资产`, async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 560 })
    await newProject(page)
    const canvas = await (
      await page.request.get(`/api/canvases/${page.url().split('/').at(-1)}`)
    ).json()
    await openLibraryPanel(page)
    const panel = page.getByRole('dialog', { name: '资产库', exact: true })
    await panel.getByRole('button', { name: '道具', exact: true }).click()
    await panel.getByRole('button', { name: '新建道具', exact: true }).first().click()
    const name = panel.getByRole('textbox', { name: '名称', exact: true })
    const description = panel.getByRole('textbox', { name: /^设定/ })
    await name.fill('提交时的水杯')
    await description.fill('提交时的设定')
    let resume!: () => void
    const held = new Promise<void>((resolve) => {
      resume = resolve
    })
    let creates = 0
    let updates = 0
    await page.route('**/api/library', async (route) => {
      if (route.request().method() !== 'POST') return route.continue()
      creates++
      await held
      await route.continue()
    })
    await page.route('**/api/library/*', async (route) => {
      if (route.request().method() === 'PATCH') updates++
      await route.continue()
    })
    await panel.getByRole('button', { name: action, exact: true }).click()
    try {
      await expect.poll(() => creates).toBe(1)
      await name.fill('继续编辑后的水杯')
      await description.fill('继续编辑后的设定')
    } finally {
      resume()
    }
    await expect(panel).toBeVisible()
    await expect(name).toHaveValue('继续编辑后的水杯')
    await expect(description).toHaveValue('继续编辑后的设定')
    await expect(panel.getByRole('button', { name: '保存', exact: true })).toBeEnabled()
    const records = async () =>
      (await (await page.request.get('/api/library')).json()).filter(
        (item: { projectId: string }) => item.projectId === canvas.projectId,
      )
    expect(await records()).toMatchObject([{ name: '提交时的水杯', description: '提交时的设定' }])
    expect(await page.evaluate(() => [...window.__plein.engine.doc.elements()].length)).toBe(0)
    if (action === '保存并添加到画布')
      await expect(panel.getByRole('status')).toContainText('仍有新修改')
    await panel.screenshot({
      path: test.info().outputPath('library-created-draft.png'),
      animations: 'disabled',
    })
    await panel.getByRole('button', { name: action, exact: true }).click()
    if (action === '保存')
      await expect(panel.getByRole('button', { name: '已保存', exact: true })).toBeDisabled()
    else {
      await expect(panel).toBeHidden()
      await expect
        .poll(() =>
          page.evaluate(() =>
            [...window.__plein.engine.doc.elements()].map((el) => ({
              name: el.name,
              description: el.params?.description,
            })),
          ),
        )
        .toEqual([{ name: '继续编辑后的水杯', description: '继续编辑后的设定' }])
    }
    expect(creates).toBe(1)
    expect(updates).toBe(1)
    expect(await records()).toMatchObject([
      { name: '继续编辑后的水杯', description: '继续编辑后的设定' },
    ])
  })
}

test('新建失败保留草稿，修正后重试只创建一条资产', async ({ page }) => {
  await newProject(page)
  const canvas = await (
    await page.request.get(`/api/canvases/${page.url().split('/').at(-1)}`)
  ).json()
  await openLibraryPanel(page)
  const panel = page.getByRole('dialog', { name: '资产库', exact: true })
  await panel.getByRole('button', { name: '道具', exact: true }).click()
  await panel.getByRole('button', { name: '新建道具', exact: true }).first().click()
  const name = panel.getByRole('textbox', { name: '名称', exact: true })
  await name.fill('失败前的草稿')
  let attempts = 0
  await page.route('**/api/library', async (route) => {
    if (route.request().method() !== 'POST') return route.continue()
    if (++attempts === 1)
      return route.fulfill({
        status: 503,
        json: { error: 'test_failure', message: '创建暂不可用' },
      })
    await route.continue()
  })
  const save = panel.getByRole('button', { name: '保存', exact: true })
  await save.click()
  await expect(panel.getByRole('alert')).toContainText('创建暂不可用')
  await expect(name).toHaveValue('失败前的草稿')
  await expect(save).toBeEnabled()
  await name.fill('修正后重试的草稿')
  await save.click()
  await expect(panel.getByRole('button', { name: '已保存', exact: true })).toBeDisabled()
  await expect(panel.getByRole('alert')).toHaveCount(0)
  const records = (await (await page.request.get('/api/library')).json()).filter(
    (item: { projectId: string }) => item.projectId === canvas.projectId,
  )
  expect(records).toMatchObject([{ name: '修正后重试的草稿' }])
  expect(records).toHaveLength(1)
  expect(attempts).toBe(2)
})
