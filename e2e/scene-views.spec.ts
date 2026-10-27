import { expect, test } from './fixtures'
import { solidPng } from '../packages/providers/src/mock/media'
import type { PreparedInput } from '../packages/protocol/src/runs'
import { clickElement, newProject } from './canvas'
import { openLibraryPanel } from './library-ui'

test('场景编辑命名视角并用于实际输入，改名保留旧引用且不混入主图', async ({ page }) => {
  await newProject(page)
  const canvas = /#\/c\/([^/?]+)/.exec(page.url())![1]!
  const base = await page.request.post('/api/assets', {
    headers: { 'Content-Type': 'image/png' },
    data: Buffer.from(solidPng(64, 48, [20, 70, 90])),
  })
  expect(base.status()).toBe(201)
  const baseId = (await base.json()).id
  const name = `视角教室${canvas.slice(0, 5)}`
  const created = await page.request.post('/api/library', {
    data: {
      kind: 'scene',
      name,
      description: '一楼教室',
      images: [{ slot: 'main', assetId: baseId }],
    },
  })
  expect(created.status()).toBe(201)
  const item = await created.json()
  const panel = await openLibraryPanel(page)
  await panel.getByRole('button', { name: '场景', exact: true }).click()
  await panel
    .getByRole('group', { name: '范围', exact: true })
    .getByRole('button', { name: '全部', exact: true })
    .click()
  const card = panel.getByRole('listitem').filter({ hasText: name })
  await card.getByRole('button').first().click()
  const views = panel.getByRole('group', { name: '场景视角档案', exact: true })
  await views.getByRole('button', { name: '添加视角', exact: true }).click()
  await views.getByRole('textbox', { name: '视角名称', exact: true }).fill('门口')
  await views.getByRole('textbox', { name: '视角描述', exact: true }).fill('从门口望向黑板')
  const chooser = page.waitForEvent('filechooser')
  await views.getByRole('button', { name: '上传', exact: true }).click()
  await (
    await chooser
  ).setFiles({
    name: 'door.png',
    mimeType: 'image/png',
    buffer: Buffer.from(solidPng(64, 48, [110, 170, 90])),
  })
  await expect(views.getByRole('button', { name: '门口 · 1 图', exact: true })).toBeVisible()
  await views.getByRole('textbox', { name: '视角名称', exact: true }).fill('门口正拍')
  await panel.getByRole('button', { name: '保存', exact: true }).click()
  await expect(panel.getByRole('button', { name: '已保存', exact: true })).toBeDisabled()
  const saved = await (await page.request.get(`/api/library/${item.id}`)).json()
  expect(saved.sceneViews[0].name).toBe('门口正拍')
  expect(saved.sceneViews[0].aliases).toContain('门口')
  expect(saved.sceneViews[0].images).toHaveLength(1)
  await panel
    .getByRole('group', { name: '资产操作', exact: true })
    .getByRole('button', { name: '添加到画布', exact: true })
    .click()
  await expect(panel).toBeHidden()
  const image = await page.evaluate(
    (name) =>
      window.__plein.addNode({
        type: 'plein/image',
        name: '视角验证镜头',
        x: 700,
        y: 0,
        params: { model: 'plein/mock:image', prompt: `@${name}/门口 学生走入` },
      }),
    name,
  )
  await expect
    .poll(async () => {
      const response = await page.request.get(`/api/canvases/${canvas}/nodes/${image}/input`)
      return await response.json()
    })
    .toMatchObject({ status: 'ready' })
  const response = await page.request.get(`/api/canvases/${canvas}/nodes/${image}/input`)
  const prepared = (await response.json()) as PreparedInput
  expect(prepared.inputs.references?.map((v) => v.assetId)).toEqual(saved.sceneViews[0].images)
  expect(prepared.inputs.references?.map((v) => v.assetId)).not.toContain(baseId)
  expect(prepared.prompt).toContain('从门口望向黑板')
  await clickElement(page, image)
  await expect(page.getByText(`${name}（门口正拍）`, { exact: true })).toBeVisible()
})

test('视角图可作库封面，缺图与未知视角阻断且同场景多个引用都显示', async ({ page }) => {
  await newProject(page)
  const canvas = /#\/c\/([^/?]+)/.exec(page.url())![1]!
  const upload = await page.request.post('/api/assets', {
    headers: { 'Content-Type': 'image/png' },
    data: Buffer.from(solidPng(64, 48, [110, 170, 90])),
  })
  expect(upload.status()).toBe(201)
  const imageId = (await upload.json()).id
  const name = `视角封面${canvas.slice(0, 5)}`
  const created = await page.request.post('/api/library', {
    data: {
      kind: 'scene',
      name,
      images: [],
      sceneViews: [
        { id: 'door', name: '门口', aliases: [], description: '门口描述', images: [imageId] },
        { id: 'empty', name: '空机位', aliases: [], description: '缺图描述', images: [] },
      ],
    },
  })
  expect(created.status()).toBe(201)

  const panel = await openLibraryPanel(page)
  await panel.getByRole('button', { name: '场景', exact: true }).click()
  await panel
    .getByRole('group', { name: '范围', exact: true })
    .getByRole('button', { name: '全部', exact: true })
    .click()
  const card = panel.getByRole('listitem').filter({ hasText: name })
  await expect(card.locator('img').first()).toHaveAttribute('src', new RegExp(imageId))
  await card.getByRole('button').first().click()
  await expect(
    panel.getByRole('complementary', { name: '预览', exact: true }).locator('img'),
  ).toHaveAttribute('src', new RegExp(imageId))
  await panel
    .getByRole('group', { name: '资产操作', exact: true })
    .getByRole('button', { name: '添加到画布', exact: true })
    .click()
  await expect(panel).toBeHidden()

  const withEmpty = await page.evaluate(
    (name) =>
      window.__plein.addNode({
        type: 'plein/image',
        name: '缺图视角验证',
        x: 700,
        y: 0,
        params: {
          model: 'plein/mock:image',
          prompt: `@${name}/门口 @${name}/空机位`,
        },
      }),
    name,
  )
  const unknown = await page.evaluate(
    (name) =>
      window.__plein.addNode({
        type: 'plein/image',
        name: '未知视角验证',
        x: 1000,
        y: 0,
        params: { model: 'plein/mock:image', prompt: `@${name}/不存在` },
      }),
    name,
  )
  const input = async (node: string) => {
    const response = await page.request.get(`/api/canvases/${canvas}/nodes/${node}/input`)
    expect(response.status()).toBe(200)
    return (await response.json()) as PreparedInput
  }
  await expect.poll(async () => (await input(withEmpty)).status).toBe('blocked')
  const missing = await input(withEmpty)
  expect(missing.blocked.map((issue) => issue.message).join('；')).toContain('空机位')
  expect(missing.blocked.map((issue) => issue.message).join('；')).toContain('没有参考图')
  expect(missing.inputs.references?.map((value) => value.assetId)).toEqual([imageId])

  await expect.poll(async () => (await input(unknown)).status).toBe('unprepared')
  const invalid = await input(unknown)
  expect(invalid.inputHash).toBeUndefined()
  expect(invalid.blocked.map((issue) => issue.message).join('；')).toContain('视角「不存在」不存在')

  await clickElement(page, withEmpty)
  await expect(page.getByText(`${name}（门口）`, { exact: true })).toBeVisible()
  await expect(page.getByText(`${name}（空机位）`, { exact: true })).toBeVisible()
})
