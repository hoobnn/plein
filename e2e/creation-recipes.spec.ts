import { expect, test, type Page } from '@playwright/test'
import type { Catalog } from '../packages/protocol/src/plugins'
import { addNode, elements, newProject } from './canvas'

async function openRecipeDraft(page: Page) {
  await newProject(page)
  await addNode(page, '生成图片')
  const generator = page.getByTestId('generator')
  const prompt = generator.getByRole('textbox', { name: '提示词', exact: true })
  await prompt.fill('保留这份原始草稿')
  const node = (await elements(page)).find((el) => el.nodeType === 'plein/image')!
  await generator.getByRole('button', { name: '创作配方', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '创作配方', exact: true })
  await expect(dialog).toBeVisible()
  return { generator, prompt, node, dialog }
}

test('创作配方可搜索、说明输入，套用保留模型且不运行，一次撤销', async ({ page }) => {
  let submits = 0
  page.on('request', (request) => {
    if (request.method() === 'POST' && /\/api\/.*\/run(?:[-/?]|$)/.test(request.url())) submits++
  })
  await newProject(page)
  await addNode(page, '生成图片')
  const generator = page.getByTestId('generator')
  const prompt = generator.getByRole('textbox', { name: '提示词', exact: true })
  await prompt.fill('我的原始草稿')
  const node = (await elements(page)).find((el) => el.nodeType === 'plein/image')!
  const model = await page.evaluate(
    (id) => window.__plein.engine.doc.get(id)?.params?.model,
    node.id,
  )
  await generator.getByRole('button', { name: '创作配方', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '创作配方', exact: true })
  await expect(dialog).toContainText('非生成效果')
  await expect(dialog).toContainText('生成效果待实测')
  await page.screenshot({
    path: test.info().outputPath('recipe-library.png'),
    animations: 'disabled',
  })
  await dialog.getByRole('textbox', { name: '搜索创作配方' }).fill('三视图')
  await expect(dialog.getByRole('article')).toHaveCount(1)
  await dialog.getByRole('button', { name: '套用「角色三视图」到草稿' }).click()
  await expect(dialog).not.toBeVisible()
  await expect(prompt).toHaveValue(/【角色】的角色设定三视图/)
  expect(
    await page.evaluate((id) => window.__plein.engine.doc.get(id)?.params?.model, node.id),
  ).toBe(model)
  expect((await elements(page)).find((el) => el.id === node.id)?.results).toBe(0)
  expect(submits).toBe(0)
  await page.locator('canvas').focus()
  await page.getByRole('button', { name: '撤销', exact: true }).click()
  await expect(prompt).toHaveValue('我的原始草稿')
  await generator.getByRole('button', { name: '创作配方', exact: true }).click()
  await page
    .getByRole('dialog', { name: '创作配方', exact: true })
    .getByRole('textbox', { name: '搜索创作配方' })
    .fill('不会匹配的搜索')
  await expect(page.getByRole('dialog', { name: '创作配方', exact: true })).toContainText(
    '没有匹配的配方',
  )
  await page.keyboard.press('Escape')
  await expect(prompt).toHaveValue('我的原始草稿')
  expect(submits).toBe(0)
})

test('配方面板期间的并发草稿与只读变化不会被旧选择覆盖', async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 600 })
  await page.emulateMedia({ colorScheme: 'dark' })
  await newProject(page)
  await addNode(page, '生成图片', { x: 450, y: 300 })
  const generator = page.getByTestId('generator')
  await generator.getByRole('button', { name: '编辑生成图片', exact: true }).click()
  const node = (await elements(page)).find((el) => el.nodeType === 'plein/image')!
  const dialog = page.getByRole('dialog', { name: '创作配方', exact: true })
  await generator.getByRole('button', { name: '创作配方', exact: true }).click()
  const search = dialog.getByRole('textbox', { name: '搜索创作配方' })
  expect((await search.boundingBox())!.height).toBeGreaterThanOrEqual(28)
  await page.screenshot({
    path: test.info().outputPath('recipe-library-narrow-dark.png'),
    animations: 'disabled',
  })
  await page.evaluate((id) => {
    const params = window.__plein.engine.doc.mutable(id)!.get('params') as {
      set(key: string, value: unknown): void
    }
    params.set('prompt', '协作端的新草稿')
  }, node.id)
  await dialog.getByRole('button', { name: '套用「角色三视图」到草稿' }).click()
  await expect(dialog.getByRole('alert')).toContainText('草稿已变化')
  expect(
    await page.evaluate((id) => window.__plein.engine.doc.get(id)?.params?.prompt, node.id),
  ).toBe('协作端的新草稿')
  await page.keyboard.press('Escape')
  await generator.getByRole('button', { name: '创作配方', exact: true }).click()
  await page.evaluate(() => {
    ;(window.__plein.engine.doc as unknown as { readOnly: boolean }).readOnly = true
  })
  try {
    await dialog.getByRole('button', { name: '套用「角色三视图」到草稿' }).click()
    await expect(dialog.getByRole('alert')).toContainText('只读')
    expect(
      await page.evaluate((id) => window.__plein.engine.doc.get(id)?.params?.prompt, node.id),
    ).toBe('协作端的新草稿')
  } finally {
    await page.evaluate(() => {
      ;(window.__plein.engine.doc as unknown as { readOnly: boolean }).readOnly = false
    })
  }
})

for (const change of ['removed', 'changed', 'failed'] as const) {
  test(`采用前核对最新目录：${change} 时保留原草稿`, async ({ page }) => {
    const { dialog, node } = await openRecipeDraft(page)
    await page.route('**/api/catalog', async (route) => {
      if (change === 'failed') {
        await route.fulfill({
          status: 503,
          json: { error: 'unavailable', message: '目录暂时不可用' },
        })
        return
      }
      const response = await route.fetch()
      const catalog = (await response.json()) as Catalog
      if (change === 'removed')
        catalog.prompts = catalog.prompts.filter((p) => p.id !== 'plein/three-view')
      else
        catalog.prompts = catalog.prompts.map((p) =>
          p.id === 'plein/three-view' ? { ...p, template: '远端已经修改的新配方' } : p,
        )
      await route.fulfill({ response, json: catalog })
    })
    await dialog.getByRole('button', { name: '套用「角色三视图」到草稿', exact: true }).click()
    await expect(dialog.getByRole('alert')).toContainText(
      change === 'failed' ? '目录读取失败' : '目录已变化',
    )
    expect(
      await page.evaluate((id) => window.__plein.engine.doc.get(id)?.params?.prompt, node.id),
    ).toBe('保留这份原始草稿')
    expect((await elements(page)).find((el) => el.id === node.id)?.results).toBe(0)
  })
}

for (const departure of ['reopen', 'leave'] as const) {
  test(`最新目录迟到：${departure === 'reopen' ? '关闭并重开配方' : '离开画布'} 后不应用旧选择`, async ({
    page,
  }) => {
    const { generator, dialog, node } = await openRecipeDraft(page)
    const canvasUrl = page.url()
    let release = () => {}
    let started = () => {}
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    const requested = new Promise<void>((resolve) => {
      started = resolve
    })
    let requests = 0
    await page.route('**/api/catalog', async (route) => {
      requests++
      const response = await route.fetch()
      started()
      await pending
      await route.fulfill({ response })
    })
    await dialog.getByRole('button', { name: '套用「角色三视图」到草稿', exact: true }).click()
    try {
      await requested
      await expect(dialog.getByRole('status')).toContainText('正在核对配方')
      await expect(
        dialog.getByRole('button', { name: '套用「角色三视图」到草稿', exact: true }),
      ).toBeDisabled()
      expect(requests).toBe(1)
      await page.keyboard.press('Escape')
      await expect(dialog).not.toBeVisible()
      if (departure === 'reopen') {
        await generator.getByRole('button', { name: '创作配方', exact: true }).click()
        await expect(dialog).toBeVisible()
      } else {
        await page.getByRole('link', { name: 'Plein', exact: true }).click()
        await expect(page.getByRole('heading', { name: /^我的项目/ })).toBeVisible()
      }
      const responsePromise = page.waitForResponse((response) =>
        response.url().endsWith('/api/catalog'),
      )
      release()
      await (await responsePromise).finished()
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      )
      if (departure === 'reopen') await expect(dialog).toBeVisible()
    } finally {
      release()
    }
    await page.unroute('**/api/catalog')
    if (departure === 'leave') {
      await page.goto(canvasUrl)
      await expect.poll(() => page.evaluate(() => !!window.__plein)).toBe(true)
    }
    expect(
      await page.evaluate((id) => window.__plein.engine.doc.get(id)?.params?.prompt, node.id),
    ).toBe('保留这份原始草稿')
  })
}
