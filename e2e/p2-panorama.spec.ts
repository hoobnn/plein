import { expect, test, type Page } from './fixtures'
import type { LibraryItem } from '../packages/protocol/src'
import { newProject } from './canvas'
import { openLibraryPanel } from './library-ui'

async function setup(page: Page) {
  await newProject(page)
  const bytes = await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 256
    canvas.height = 128
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#ff0000'
    ctx.fillRect(0, 0, 86, 128)
    ctx.fillStyle = '#0000ff'
    ctx.fillRect(86, 0, 84, 128)
    ctx.fillStyle = '#ffff00'
    ctx.fillRect(170, 0, 86, 128)
    return canvas.toDataURL('image/png').split(',')[1]!
  })
  const upload = await page.request.post('/api/assets', {
    headers: { 'content-type': 'image/png', 'x-file-name': 'panorama.png' },
    data: Buffer.from(bytes, 'base64'),
  })
  expect(upload.status()).toBe(201)
  const source = (await upload.json()) as { id: string }
  const canvasId = page.url().split('/').at(-1)!
  const canvas = (await (await page.request.get(`/api/canvases/${canvasId}`)).json()) as {
    projectId: string
  }
  const created = await page.request.post('/api/library', {
    data: {
      kind: 'scene',
      name: 'P2全景场景',
      description: '全景测试设定',
      projectId: canvas.projectId,
      images: [{ slot: 'panorama', assetId: source.id }],
    },
  })
  expect(created.status()).toBe(201)
  const item = (await created.json()) as LibraryItem
  const panel = await openLibraryPanel(page)
  await panel.getByRole('button', { name: '场景', exact: true }).click()
  await panel
    .getByRole('group', { name: '范围', exact: true })
    .getByRole('button', { name: '全部', exact: true })
    .click()
  await panel.locator(`[data-library-id="${item.id}"]`).getByRole('button').first().click()
  await panel.getByRole('button', { name: '浏览全景与截取视角', exact: true }).click()
  const panorama = page.getByRole('dialog', { name: '全景浏览与视角截图', exact: true })
  await expect(panorama.getByRole('img', { name: '全景透视预览' })).toBeVisible()
  return { item, source, panel, panorama, canvasId }
}

test('真正投影浏览全景，保存具名视角，普通编辑和模型引用保留截图与来源边界', async ({ page }) => {
  const { item, source, panel, panorama, canvasId } = await setup(page)
  const preview = panorama.getByRole('img', { name: '全景透视预览' })
  const center = () =>
    preview.evaluate((node) => {
      const canvas = node as HTMLCanvasElement
      return [
        ...canvas
          .getContext('2d')!
          .getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data,
      ]
    })
  await expect.poll(async () => (await center())[2]).toBeGreaterThan(230)
  await panorama.getByRole('spinbutton', { name: '朝向（度）', exact: true }).fill('90')
  await expect.poll(async () => (await center())[0]).toBeGreaterThan(230)
  await expect.poll(async () => (await center())[1]).toBeGreaterThan(230)
  await panorama.getByRole('combobox', { name: '截图画幅' }).click()
  await page.getByRole('option', { name: '竖屏 9:16', exact: true }).click()
  await expect(preview).toHaveAttribute('width', '288')
  await expect(preview).toHaveAttribute('height', '512')
  await panorama.getByRole('textbox', { name: '视角名称', exact: true }).fill('窗边反打')
  await panorama.getByRole('textbox', { name: '视角描述', exact: true }).fill('朝向窗户')
  await panorama.screenshot({ path: test.info().outputPath('panorama-perspective.png') })
  await panorama.getByRole('button', { name: '保存为命名视角', exact: true }).click()
  await expect(panorama).toBeHidden()
  const read = async () =>
    (await (await page.request.get(`/api/library/${item.id}`)).json()) as LibraryItem
  let saved = await read()
  expect(saved.sceneViews).toHaveLength(1)
  const view = saved.sceneViews![0]!
  expect(view).toMatchObject({
    name: '窗边反打',
    panorama: { assetId: source.id, yaw: 90, pitch: 0, fov: 55, format: 'portrait' },
  })
  const captured = (await (
    await page.request.get(`/api/assets/${view.images[0]}/meta`)
  ).json()) as { width: number; height: number }
  expect(captured).toMatchObject({ width: 576, height: 1024 })
  await panel.getByRole('textbox', { name: /^设定/ }).fill('更新场景设定，保留来源')
  await panel.getByRole('button', { name: '保存', exact: true }).click()
  await expect(panel.getByRole('button', { name: '已保存', exact: true })).toBeDisabled()
  saved = await read()
  expect(saved.sceneViews![0]!.panorama).toEqual(view.panorama)
  await panel.getByRole('button', { name: '添加到画布', exact: true }).click()
  await expect(panel).toBeHidden()
  const node = await page.evaluate(() =>
    window.__plein.addNode({
      type: 'plein/image',
      name: '全景视角引用',
      params: { model: 'plein/mock:image', prompt: '@P2全景场景/窗边反打' },
      x: 900,
      y: 100,
    }),
  )
  const prepared = (await (
    await page.request.get(`/api/canvases/${canvasId}/nodes/${node}/input`)
  ).json()) as { inputs: { references: { assetId: string }[] } }
  expect(prepared.inputs.references.map((ref) => ref.assetId)).toEqual(view.images)
})

test('确认期间场景变化时拒绝旧截图，取消等待不会创建视角', async ({ page }) => {
  const { item, panorama, panel } = await setup(page)
  await page.request.patch(`/api/library/${item.id}`, { data: { description: '并发更新后的场景' } })
  await panorama.getByRole('button', { name: '保存为命名视角', exact: true }).click()
  await expect(panorama.getByRole('alert')).toContainText('已变化')
  await expect(panorama.getByRole('button', { name: '请重新核对场景', exact: true })).toBeDisabled()
  await panorama.getByRole('button', { name: '关闭', exact: true }).last().click()
  await expect(panorama).toBeHidden()
  await panel.getByRole('button', { name: '浏览全景与截取视角', exact: true }).click()
  await expect(panorama.getByRole('img', { name: '全景透视预览' })).toBeVisible()
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  let calls = 0
  await page.route('**/api/library/*/panorama-view', async (route) => {
    calls++
    await held
    await route.continue().catch(() => {})
  })
  await panorama.getByRole('button', { name: '保存为命名视角', exact: true }).click()
  await expect.poll(() => calls).toBe(1)
  await panorama.getByRole('button', { name: '取消截图', exact: true }).click()
  release()
  await expect(panorama).toBeHidden()
  const saved = (await (await page.request.get(`/api/library/${item.id}`)).json()) as LibraryItem
  expect(saved.sceneViews ?? []).toEqual([])
  expect(saved.description).toBe('并发更新后的场景')
})
