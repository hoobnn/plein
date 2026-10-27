import { execFileSync } from 'node:child_process'
import { expect, type Page, test } from './fixtures'
import { elements, newProject } from './canvas'

async function source(page: Page, size: string) {
  await newProject(page)
  const png = execFileSync('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    `gradients=s=${size}:c0=red:c1=blue:x0=0:y0=0:x1=5:y1=3:d=1:r=1`,
    '-frames:v',
    '1',
    '-f',
    'image2pipe',
    '-vcodec',
    'png',
    'pipe:1',
  ])
  const response = await page.request.post('/api/assets', {
    headers: { 'content-type': 'image/png' },
    data: png,
  })
  expect(response.status()).toBe(201)
  const asset = (await response.json()).id as string
  const id = await page.evaluate((asset) => {
    const e = window.__plein.engine as typeof window.__plein.engine & { paste(data: unknown): void }
    // 用正常卡片尺寸查看极小素材，切图仍应根据文件实际像素判断。
    e.paste({
      plein: 1,
      elements: [
        {
          id: 'tiny-source',
          kind: 'image',
          name: '像素边界图片',
          assetId: asset,
          x: 0,
          y: 0,
          w: 320,
          h: 192,
          rotation: 0,
          locked: false,
          parentId: null,
        },
      ],
      edges: [],
    })
    return [...e.doc.elements()][0]!.id
  }, asset)
  return { id, asset }
}

async function split(page: Page) {
  // 极小图片显示尺寸由元数据自适应，通过侧栏正常定位，专门验证切图边界。
  await page.getByRole('treeitem', { name: '像素边界图片 定位到画布', exact: true }).click()
  await page
    .getByRole('toolbar', { name: '结果操作' })
    .getByRole('button', { name: '宫格切分' })
    .click()
  await page.getByRole('button', { name: /4 宫格/ }).click()
}

test('极小原图切分给出像素要求，不上传空切片、不改画布', async ({ page }) => {
  const { id } = await source(page, '1x1')
  let uploads = 0
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/api/assets')) uploads++
  })
  await split(page)
  await expect(page.getByRole('status')).toContainText('图片只有 1×1 像素')
  await expect(page.getByRole('status')).toContainText('至少 2×2 像素')
  expect((await elements(page)).map((el) => el.id)).toEqual([id])
  expect(uploads).toBe(0)
})

test('奇数像素切分保留右侧和底部所有像素，切片可逐像素重组原图', async ({ page }) => {
  const { asset } = await source(page, '5x3')
  await split(page)
  await expect
    .poll(async () => (await elements(page)).filter((el) => el.kind === 'frame').length)
    .toBe(1)
  const assets = await page.evaluate(() => {
    const e = window.__plein.engine
    const frame = [...e.doc.elements()].find((el) => el.kind === 'frame')!
    return (frame.params!.shotGroup as { order: string[] }).order.map(
      (id) => e.doc.get(id)!.assetId!,
    )
  })
  const dimensions = await Promise.all(
    assets.map(async (id) => {
      const meta = await (await page.request.get(`/api/assets/${id}/meta`)).json()
      return [meta.width, meta.height]
    }),
  )
  expect(dimensions).toEqual([
    [2, 1],
    [3, 1],
    [2, 2],
    [3, 2],
  ])
  const same = await page.evaluate(
    async ({ asset, assets }) => {
      const load = async (id: string) =>
        createImageBitmap(await (await fetch(`/api/assets/${id}`)).blob())
      const original = await load(asset)
      const canvas = document.createElement('canvas')
      canvas.width = 5
      canvas.height = 3
      const ctx = canvas.getContext('2d')!
      ctx.drawImage(original, 0, 0)
      const before = ctx.getImageData(0, 0, 5, 3).data
      ctx.clearRect(0, 0, 5, 3)
      for (const [n, id] of assets.entries()) {
        const tile = await load(id)
        ctx.drawImage(tile, n % 2 ? 2 : 0, n >= 2 ? 1 : 0)
        tile.close()
      }
      original.close()
      return before.every((v, i) => v === ctx.getImageData(0, 0, 5, 3).data[i])
    },
    { asset, assets },
  )
  expect(same).toBe(true)
})
