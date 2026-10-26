import { expect, test, type Page } from '@playwright/test'
import type { LibraryItem } from '../packages/protocol/src'
import { solidPng } from '../packages/providers/src/mock/media'
import { newProject, revealGenerator, waitNode } from './canvas'
import { openLibraryPanel } from './library-ui'

const readItem = async (page: Page, id: string): Promise<LibraryItem> =>
  (await page.request.get(`/api/library/${id}`)).json()
const allItems = async (page: Page): Promise<LibraryItem[]> =>
  (await page.request.get('/api/library')).json()
async function openAll(page: Page) {
  const panel = await openLibraryPanel(page)
  await panel
    .getByRole('group', { name: '范围', exact: true })
    .getByRole('button', { name: '全部', exact: true })
    .click()
  return panel
}
async function draft(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          [...window.__plein.engine.doc.elements()].filter(
            (el) => el.nodeType === 'plein/image' && el.params?.characterAssetTarget,
          ).length,
      ),
    )
    .toBe(1)
  await revealGenerator(page)
  return page.evaluate(() =>
    [...window.__plein.engine.doc.elements()].find(
      (el) => el.nodeType === 'plein/image' && el.params?.characterAssetTarget,
    )!,
  )
}
async function generate(page: Page, id: string) {
  await page.getByRole('button', { name: '生成', exact: true }).click()
  await waitNode(page, id)
  await expect(page.getByRole('button', { name: '归档到角色', exact: true })).toBeVisible()
}
const submissions = (page: Page) => {
  const sent: string[] = []
  page.on('request', (request) => {
    if (
      request.method() === 'POST' &&
      /\/(run|run-flow|run-batch|commit)$/.test(new URL(request.url()).pathname)
    )
      sent.push(request.url())
  })
  return sent
}

test('从文字起点保存角色并制作草稿，手动生成后明确归档槽位和独立封面', async ({ page }) => {
  await newProject(page)
  const sent = submissions(page)
  let panel = await openAll(page)
  await panel.getByRole('button', { name: '新建角色', exact: true }).first().click()
  await expect(panel.getByRole('region', { name: '示例设定，尚未生成图片' })).toBeVisible()
  await panel.getByRole('button', { name: '使用「阿岚」示例', exact: true }).click()
  await panel.getByRole('textbox', { name: '名称', exact: true }).fill('P1新建角色')
  await panel
    .locator('[data-character-slot="character_3view"]')
    .getByRole('button', { name: '制作这类图片', exact: true })
    .click()
  await expect(panel).toBeHidden()
  const made = await draft(page)
  const item = (await allItems(page)).find((entry) => entry.name === 'P1新建角色')!
  expect(made.params!.characterAssetTarget).toEqual({ libraryId: item.id, slot: 'character_3view' })
  expect(made.results ?? []).toHaveLength(0)
  expect(made.params!.prompt).toContain('三视图')
  expect(sent).toEqual([])
  await generate(page, made.id)
  await page.getByRole('button', { name: '归档到角色', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '归档到角色', exact: true })
  await expect(dialog.getByText('制作意图', { exact: true })).toBeVisible()
  await dialog.getByRole('combobox', { name: '目标槽位' }).click()
  await page.getByRole('option', { name: '肖像／半身图', exact: true }).click()
  await dialog.getByRole('checkbox', { name: '设为独立封面' }).check()
  await dialog.screenshot({ path: test.info().outputPath('character-archive.png') })
  await dialog.getByRole('button', { name: '确认归档', exact: true }).click()
  await expect(dialog).toBeHidden()
  const saved = await readItem(page, item.id)
  expect(saved.projectId).toBe(item.projectId)
  expect(saved.description).toBe(item.description)
  expect(saved.images).toHaveLength(1)
  expect(saved.images[0]!.slot).toBe('portrait')
  expect(saved.coverAssetId).toBe(saved.images[0]!.assetId)
  expect(saved.images.some((image) => image.slot === 'full_body')).toBe(false)
  expect(sent).toHaveLength(1)
  panel = await openAll(page)
  const row = panel.locator(`[data-library-id="${item.id}"]`)
  await expect(row.locator(`img[src*="${saved.coverAssetId}"]`)).toBeVisible()
  await row.getByRole('button').first().click()
  await panel
    .getByRole('group', { name: '档案分页' })
    .getByRole('button', { name: '基础设定', exact: true })
    .click()
  await panel.getByRole('textbox', { name: /^基础设定/ }).fill('保存普通设定时保留独立封面')
  await panel.getByRole('button', { name: '保存', exact: true }).click()
  await expect(panel.getByRole('button', { name: '已保存', exact: true })).toBeDisabled()
  expect((await readItem(page, item.id)).coverAssetId).toBe(saved.coverAssetId)
})

test('同名角色按ID创建新参考，保留旧卡；归档冲突后须重新读取且旧图转为其他参考', async ({
  page,
}) => {
  await newProject(page)
  const image = await page.request.post('/api/assets', {
    headers: { 'content-type': 'image/png', 'x-file-name': 'original.png' },
    data: Buffer.from(solidPng(64, 96, [40, 80, 110])),
  })
  expect(image.status()).toBe(201)
  const assetId = ((await image.json()) as { id: string }).id
  const make = async (description: string) => {
    const response = await page.request.post('/api/library', {
      data: {
        kind: 'character',
        name: 'P1同名角色',
        description,
        projectId: null,
        images: [{ slot: 'portrait', assetId }],
      },
    })
    expect(response.status()).toBe(201)
    return (await response.json()) as LibraryItem
  }
  const original = await make('当前角色设定')
  const other = await make('另一个同名角色')
  const old = await page.evaluate(
    (id) =>
      window.__plein.addNode({
        type: 'plein/character',
        name: 'P1同名角色',
        params: { libraryId: id, description: '画布旧版设定' },
        x: 100,
        y: 100,
      }),
    original.id,
  )
  const sent = submissions(page)
  const panel = await openAll(page)
  await panel.locator(`[data-library-id="${original.id}"]`).getByRole('button').first().click()
  await panel
    .locator('[data-character-slot="portrait"]')
    .getByRole('button', { name: '制作这类图片', exact: true })
    .click()
  await expect(panel).toBeHidden()
  const made = await draft(page)
  expect(made.params!.characterAssetTarget).toEqual({ libraryId: original.id, slot: 'portrait' })
  expect(made.params!.prompt).toContain('@P1同名角色 · 制作参考')
  const refs = await page.evaluate(
    ({ libraryId, old }) => {
      const doc = window.__plein.engine.doc
      const source = [...doc.elements()].find(
        (el) =>
          el.nodeType === 'plein/character' && el.params?.libraryId === libraryId && el.id !== old,
      )
      return { source, old: doc.get(old) }
    },
    { libraryId: original.id, old },
  )
  expect(refs.source!.id).not.toBe(old)
  expect(refs.source!.params!.description).toBe('当前角色设定')
  expect(refs.old!.params!.description).toBe('画布旧版设定')
  const canvasId = page.url().split('/').at(-1)!
  const preview = await page.request.get(`/api/canvases/${canvasId}/nodes/${made.id}/input`)
  expect(preview.status()).toBe(200)
  const input = await preview.json()
  expect(input.status).toBe('ready')
  expect(input.prompt).toContain('当前角色设定')
  expect(input.prompt).not.toContain('画布旧版设定')
  expect(input.inputs.references.map((value: { assetId: string }) => value.assetId)).toEqual([
    assetId,
  ])
  expect(sent).toEqual([])
  await generate(page, made.id)
  await page.getByRole('button', { name: '归档到角色', exact: true }).click()
  let dialog = page.getByRole('dialog', { name: '归档到角色', exact: true })
  await expect(dialog).toBeVisible()
  const updated = await page.request.patch(`/api/library/${original.id}`, {
    data: { name: 'P1原角色已改名' },
  })
  expect(updated.status()).toBe(200)
  await dialog.getByRole('button', { name: '确认归档', exact: true }).click()
  await expect(dialog.getByRole('alert')).toContainText('重新')
  await expect(dialog.getByRole('button', { name: '请重新核对', exact: true })).toBeDisabled()
  expect((await readItem(page, original.id)).images).toEqual(original.images)
  await dialog.getByRole('button', { name: '关闭', exact: true }).last().click()
  await expect(dialog).toBeHidden()
  await page.getByRole('button', { name: '归档到角色', exact: true }).click()
  dialog = page.getByRole('dialog', { name: '归档到角色', exact: true })
  await expect(dialog.getByText('P1原角色已改名', { exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: '确认归档', exact: true }).click()
  await expect(dialog).toBeHidden()
  const saved = await readItem(page, original.id)
  expect(saved.projectId).toBeNull()
  expect(saved.images).toContainEqual({ slot: 'extra', assetId })
  expect(saved.images.filter((image) => image.slot === 'portrait')).toHaveLength(1)
  expect((await readItem(page, other.id)).images).toEqual(other.images)
  expect(sent).toHaveLength(1)
})

test('制作前保存失败保留角色草稿，修正重试后只创建一个制作节点', async ({ page }) => {
  await newProject(page)
  const sent = submissions(page)
  const panel = await openAll(page)
  await panel.getByRole('button', { name: '新建角色', exact: true }).first().click()
  await panel.getByRole('textbox', { name: '名称', exact: true }).fill('P1失败后重试')
  await page.route('**/api/library', async (route) => {
    if (route.request().method() !== 'POST') return route.continue()
    await route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'test_failure', message: '测试保存失败' }),
    })
  })
  const produce = panel
    .locator('[data-character-slot="portrait"]')
    .getByRole('button', { name: '制作这类图片', exact: true })
  await produce.click()
  await expect(panel.getByRole('alert')).toBeVisible()
  await expect(panel.getByRole('textbox', { name: '名称', exact: true })).toHaveValue(
    'P1失败后重试',
  )
  expect(await page.evaluate(() => [...window.__plein.engine.doc.elements()].length)).toBe(0)
  await page.unroute('**/api/library')
  await produce.click()
  await expect(panel).toBeHidden()
  await draft(page)
  expect((await allItems(page)).filter((item) => item.name === 'P1失败后重试')).toHaveLength(1)
  expect(sent).toEqual([])
})
