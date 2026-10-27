import { expect, test } from './fixtures'
import { newProject, waitEngine, waitNode } from './canvas'

for (const count of [13, 1000]) {
  test(`${count} 元素离线演示故事板使用本地图片，预览关闭与定位保持对应素材`, async ({ page }) => {
    const assetRequests: string[] = []
    await page.route(
      (url) => url.pathname.startsWith('/api/'),
      (route) => {
        const path = new URL(route.request().url()).pathname
        if (path.startsWith('/api/assets/')) assetRequests.push(path)
        return route.abort('internetdisconnected')
      },
    )
    await page.goto(`/#/demo?n=${count}`)
    await waitEngine(page)
    await page.getByRole('button', { name: '故事板', exact: true }).click()
    const images = page.getByRole('region', { name: '图片', exact: true })
    const preview = images.getByRole('button', { name: '查看图片', exact: true }).first()
    await expect
      .poll(() =>
        preview
          .locator('img')
          .evaluateAll((items) =>
            items.some(
              (img) => img instanceof HTMLImageElement && img.complete && img.naturalWidth > 0,
            ),
          ),
      )
      .toBe(true)
    const thumbnail = await preview.locator('img').getAttribute('src')
    expect(thumbnail).toMatch(/^blob:/)
    await preview.click()
    const viewer = page.getByRole('dialog', { name: '查看「图片」', exact: true })
    await expect(viewer.locator('img').first()).toHaveAttribute('src', thumbnail!)
    await expect
      .poll(() =>
        viewer
          .locator('img')
          .first()
          .evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0),
      )
      .toBe(true)
    await expect(viewer).toHaveCSS('opacity', '1')
    await viewer.screenshot({
      path: test.info().outputPath('demo-local-preview.png'),
      animations: 'disabled',
    })
    await page.keyboard.press('Escape')
    await expect(viewer).toHaveCount(0)
    await expect(preview).toBeFocused()
    await images.getByRole('button', { name: '图片', exact: true }).first().click()
    await expect(images).toHaveCount(0)
    await expect
      .poll(() =>
        page.evaluate(() => {
          const engine = window.__plein.engine
          const id = engine.selection.values()[0]
          return id ? engine.doc.get(id)?.assetId : undefined
        }),
      )
      .toBe('demo:0')
    expect(assetRequests).toEqual([])
  })
}

test('离开演示释放图片地址，真实画布使用服务端素材，重进演示使用新地址', async ({ page }) => {
  await newProject(page)
  const id = await page.evaluate(() =>
    window.__plein.addNode({
      type: 'plein/image',
      name: '服务端图片',
      params: { model: 'plein/mock:image', prompt: '远程水杯' },
      x: 400,
      y: 300,
    }),
  )
  const canvasId = decodeURIComponent(page.url().split('#/c/')[1]!)
  await expect
    .poll(async () =>
      (await page.request.get(`/api/canvases/${canvasId}/nodes/${id}/input`)).status(),
    )
    .toBe(200)
  expect(
    (await page.request.post(`/api/canvases/${canvasId}/nodes/${id}/run`, { data: {} })).status(),
  ).toBe(202)
  await waitNode(page, id)
  const asset = await page.evaluate(
    (id) => window.__plein.engine.doc.get(id)!.results![0]!.value.assetId,
    id,
  )
  const enterDemo = async () => {
    await page.evaluate(() => {
      location.hash = '#/demo?n=13'
    })
    await expect
      .poll(() =>
        page.evaluate(() =>
          [...(window.__plein?.engine.doc.elements() ?? [])].some((el) => el.assetId === 'demo:0'),
        ),
      )
      .toBe(true)
    await page.getByRole('button', { name: '故事板', exact: true }).click()
    const preview = page.getByRole('button', { name: '查看图片', exact: true }).first()
    await expect
      .poll(() =>
        preview
          .locator('img')
          .evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0),
      )
      .toBe(true)
    return (await preview.locator('img').getAttribute('src'))!
  }
  const original = await enterDemo()
  expect(
    await page.evaluate(
      (url) =>
        fetch(url).then(
          (response) => response.ok,
          () => false,
        ),
      original,
    ),
  ).toBe(true)
  await page.evaluate((id) => {
    location.hash = `#/c/${id}`
  }, canvasId)
  await expect
    .poll(() => page.evaluate((id) => !!window.__plein?.engine.doc.get(id), id))
    .toBe(true)
  const thumb = page
    .getByRole('treeitem', { name: '服务端图片 定位到画布', exact: true })
    .locator('img')
  await expect(thumb).toHaveAttribute('src', `/api/assets/${asset}/thumb-256`)
  await page.getByRole('button', { name: '故事板', exact: true }).click()
  const preview = page.getByRole('button', { name: '查看服务端图片', exact: true })
  await expect(preview.locator('img')).toHaveAttribute('src', `/api/assets/${asset}/thumb-1024`)
  await preview.click()
  const viewer = page.getByRole('dialog', { name: '查看「服务端图片」', exact: true })
  await expect(viewer.locator('img').first()).toHaveAttribute('src', `/api/assets/${asset}`)
  await page.keyboard.press('Escape')
  await expect(viewer).toHaveCount(0)
  expect(
    await page.evaluate(
      (url) =>
        fetch(url).then(
          () => true,
          () => false,
        ),
      original,
    ),
  ).toBe(false)
  const replacement = await enterDemo()
  expect(replacement).toMatch(/^blob:/)
  expect(replacement).not.toBe(original)
})
