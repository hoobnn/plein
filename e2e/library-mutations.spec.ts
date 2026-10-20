import { openLibraryPanel } from './library-ui'
import { expect, test } from '@playwright/test'
import { newProject } from './canvas'

test('删除等待期间锁定编辑操作，失败后保留内容并可重试', async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 560 })
  await newProject(page)
  const canvas = await (
    await page.request.get(`/api/canvases/${page.url().split('/').at(-1)}`)
  ).json()
  const created = await page.request.post('/api/library', {
    data: { kind: 'prop', name: '删除恢复道具', projectId: canvas.projectId },
  })
  const item = await created.json()
  await openLibraryPanel(page)
  const panel = page.getByRole('dialog', { name: '资产库', exact: true })
  await panel.getByRole('button', { name: '道具', exact: true }).click()
  await panel.getByRole('button', { name: '本项目', exact: true }).click()
  await panel
    .getByRole('listitem')
    .filter({ hasText: item.name })
    .getByRole('button')
    .first()
    .click()
  let resume!: () => void
  const held = new Promise<void>((resolve) => {
    resume = resolve
  })
  let failed = true
  let deletes = 0
  await page.route(`**/api/library/${item.id}`, async (route) => {
    if (route.request().method() !== 'DELETE') return route.continue()
    deletes++
    await held
    if (failed)
      return route.fulfill({
        status: 503,
        json: { error: 'test_failure', message: '删除暂不可用' },
      })
    await route.continue()
  })
  const remove = panel.getByRole('button', { name: '删除', exact: true })
  await remove.click()
  const confirm = page.getByRole('dialog', { name: `删除道具「${item.name}」？`, exact: true })
  await confirm.getByRole('button', { name: '删除', exact: true }).click()
  try {
    await expect.poll(() => deletes).toBe(1)
    await expect(remove).toBeDisabled()
    await expect(panel.getByRole('button', { name: '返回', exact: true })).toBeDisabled()
    await expect(panel.getByRole('status')).toContainText('正在处理')
  } finally {
    resume()
  }
  await expect(panel.getByRole('alert')).toContainText('删除暂不可用')
  const name = panel.getByRole('textbox', { name: '名称', exact: true })
  await expect(name).toBeInViewport({ ratio: 1 })
  expect(
    await name.evaluate((element) => {
      const rect = element.getBoundingClientRect()
      return (
        document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) === element
      )
    }),
  ).toBe(true)
  await panel.screenshot({
    path: test.info().outputPath('library-delete-error.png'),
    animations: 'disabled',
  })
  await expect(panel.getByRole('textbox', { name: '名称', exact: true })).toHaveValue(item.name)
  await expect(remove).toBeEnabled()
  failed = false
  await remove.click()
  await confirm.getByRole('button', { name: '取消', exact: true }).click()
  expect(deletes).toBe(1)
  await remove.click()
  await confirm.getByRole('button', { name: '删除', exact: true }).click()
  await expect(panel.getByRole('textbox', { name: '名称', exact: true })).toHaveCount(0)
  expect(deletes).toBe(2)
  await expect(panel.getByText(item.name, { exact: true })).toHaveCount(0)
})

test('官方复制等待时阻止重复提交，切换到其他条目后迟到结果不抢走编辑目标', async ({ page }) => {
  await newProject(page)
  const canvas = await (
    await page.request.get(`/api/canvases/${page.url().split('/').at(-1)}`)
  ).json()
  await page.request.post('/api/library', {
    data: { kind: 'scene', name: '保留编辑的场景', projectId: canvas.projectId },
  })
  await openLibraryPanel(page)
  const panel = page.getByRole('dialog', { name: '资产库', exact: true })
  await panel.getByRole('button', { name: '风格', exact: true }).click()
  await panel.getByRole('button', { name: '官方', exact: true }).click()
  await panel.getByRole('listitem').first().getByRole('button').first().click()
  const officialName = await panel.getByRole('textbox', { name: '名称', exact: true }).inputValue()
  let resume!: () => void
  const held = new Promise<void>((resolve) => {
    resume = resolve
  })
  let copies = 0
  await page.route('**/api/library', async (route) => {
    if (route.request().method() !== 'POST') return route.continue()
    copies++
    await held
    await route.continue()
  })
  const copy = panel.getByRole('button', { name: '复制到我的', exact: true })
  await copy.dblclick()
  try {
    await expect.poll(() => copies).toBe(1)
    await expect(copy).toBeDisabled()
    await expect(panel.getByRole('status')).toContainText('正在处理')
    await panel.getByRole('button', { name: '场景', exact: true }).click()
    await panel.getByRole('button', { name: '本项目', exact: true }).click()
    await panel
      .getByRole('listitem')
      .filter({ hasText: '保留编辑的场景' })
      .getByRole('button')
      .first()
      .click()
  } finally {
    resume()
  }
  await page.waitForLoadState('networkidle')
  await expect(panel.getByRole('textbox', { name: '名称', exact: true })).toHaveValue(
    '保留编辑的场景',
  )
  expect(copies).toBe(1)
  const saved = await (await page.request.get('/api/library')).json()
  expect(
    saved.filter(
      (item: { kind: string; name: string }) => item.kind === 'style' && item.name === officialName,
    ),
  ).toHaveLength(1)
})

test('保存等待时继续编辑不丢掉新草稿，下一次保存提交最新名称', async ({ page }) => {
  await newProject(page)
  const canvas = await (
    await page.request.get(`/api/canvases/${page.url().split('/').at(-1)}`)
  ).json()
  const item = await (
    await page.request.post('/api/library', {
      data: { kind: 'prop', name: '名称基线', projectId: canvas.projectId },
    })
  ).json()
  await openLibraryPanel(page)
  const panel = page.getByRole('dialog', { name: '资产库', exact: true })
  await panel.getByRole('button', { name: '道具', exact: true }).click()
  await panel.getByRole('button', { name: '本项目', exact: true }).click()
  await panel
    .getByRole('listitem')
    .filter({ hasText: item.name })
    .getByRole('button')
    .first()
    .click()
  const name = panel.getByRole('textbox', { name: '名称', exact: true })
  let resume!: () => void
  const held = new Promise<void>((resolve) => {
    resume = resolve
  })
  let updates = 0
  await page.route(`**/api/library/${item.id}`, async (route) => {
    if (route.request().method() !== 'PATCH') return route.continue()
    updates++
    if (updates === 1) await held
    await route.continue()
  })
  await name.fill('第一次名称')
  await panel.getByRole('button', { name: '保存', exact: true }).click()
  try {
    await expect.poll(() => updates).toBe(1)
    await expect(panel.getByRole('status')).toContainText('正在处理')
    await name.fill('保留的新名称')
  } finally {
    resume()
  }
  await expect(panel.getByRole('status')).toHaveCount(0)
  await expect(name).toHaveValue('保留的新名称')
  await panel.getByRole('button', { name: '保存', exact: true }).click()
  await expect(panel.getByRole('button', { name: '已保存', exact: true })).toBeDisabled()
  expect(updates).toBe(2)
  const saved = await (await page.request.get('/api/library')).json()
  expect(saved.find((entry: { id: string }) => entry.id === item.id).name).toBe('保留的新名称')
})

test('关闭后重开同条目继续保存，旧应答不覆盖新草稿且写入按提交顺序完成', async ({ page }) => {
  await newProject(page)
  const canvas = await (
    await page.request.get(`/api/canvases/${page.url().split('/').at(-1)}`)
  ).json()
  const item = await (
    await page.request.post('/api/library', {
      data: { kind: 'prop', name: '跨会话保存基线', projectId: canvas.projectId },
    })
  ).json()
  const panel = page.getByRole('dialog', { name: '资产库', exact: true })
  const open = async () => {
    await openLibraryPanel(page)
    await panel.getByRole('button', { name: '道具', exact: true }).click()
    await panel.locator(`[data-library-id="${item.id}"]`).getByRole('button').first().click()
  }
  await open()
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const submitted: string[] = []
  await page.route(`**/api/library/${item.id}`, async (route) => {
    if (route.request().method() !== 'PATCH') return route.continue()
    submitted.push(route.request().postDataJSON().name)
    if (submitted.length === 1) await gate
    await route.continue()
  })
  const name = panel.getByRole('textbox', { name: '名称', exact: true })
  try {
    await name.fill('旧会话已提交')
    await panel.getByRole('button', { name: '保存', exact: true }).click()
    await expect.poll(() => submitted.length).toBe(1)
    await panel.getByRole('button', { name: '关闭', exact: true }).click()
    await expect(panel).toBeHidden()
    await open()
    await name.fill('新会话已提交')
    await panel.getByRole('button', { name: '保存', exact: true }).click()
    await expect(panel.getByRole('status')).toContainText('正在处理')
    expect(submitted).toEqual(['旧会话已提交'])
    await name.fill('新会话尚未提交')
    release()
    await expect(panel.getByRole('status')).toHaveCount(0)
    await expect(name).toHaveValue('新会话尚未提交')
    expect(submitted).toEqual(['旧会话已提交', '新会话已提交'])
    expect((await (await page.request.get(`/api/library/${item.id}`)).json()).name).toBe(
      '新会话已提交',
    )
    await panel.getByRole('button', { name: '保存', exact: true }).click()
    await expect(panel.getByRole('button', { name: '已保存', exact: true })).toBeDisabled()
    expect((await (await page.request.get(`/api/library/${item.id}`)).json()).name).toBe(
      '新会话尚未提交',
    )
    expect(submitted).toHaveLength(3)
  } finally {
    release()
  }
})
