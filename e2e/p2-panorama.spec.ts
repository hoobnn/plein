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

test('真正投影浏览全景，保存具名视角并保留截图来源 @core', async ({ page }) => {
  const { item, source, panorama } = await setup(page)
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
  const saved = await read()
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
})
