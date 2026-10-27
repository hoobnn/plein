import { expect, test } from './fixtures'
import { solidPng } from '../packages/providers/src/mock/media'
import { newProject, waitNode } from './canvas'

for (const mode of ['arrows', 'enter'] as const) {
  test(`单张素材审片 ${mode} 没有候选时不改变视图或报错`, async ({ page }) => {
    await newProject(page)
    const response = await page.request.post('/api/assets', {
      headers: { 'Content-Type': 'image/png' },
      data: Buffer.from(solidPng(128, 72, [50, 120, 180])),
    })
    expect(response.status()).toBe(201)
    const assetId = (await response.json()).id as string
    await page.evaluate((assetId) => {
      const engine = window.__plein.engine as typeof window.__plein.engine & {
        paste(data: unknown): void
      }
      engine.paste({
        plein: 1,
        edges: [],
        elements: [
          {
            id: 'single',
            kind: 'image',
            name: '独立图片浏览',
            assetId,
            x: 400,
            y: 300,
            w: 320,
            h: 180,
            rotation: 0,
            locked: false,
            parentId: null,
          },
        ],
      })
      const ids = [...engine.doc.elements()].map((el) => el.id)
      engine.selection.set(ids)
      engine.zoomToFit(ids)
    }, assetId)
    await page
      .getByRole('toolbar', { name: '结果操作', exact: true })
      .getByRole('button', { name: '全屏查看', exact: true })
      .click()
    const viewer = page.getByRole('dialog', { name: '查看「独立图片浏览」', exact: true })
    const image = viewer.getByRole('img', { name: '独立图片浏览', exact: true })
    await expect(image).toHaveAttribute('src', `/api/assets/${assetId}`)
    await expect
      .poll(() =>
        image.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0),
      )
      .toBe(true)
    await viewer.getByRole('button', { name: '放大图片', exact: true }).click()
    const reset = viewer.getByRole('button', { name: '重置图片视图', exact: true })
    await expect(reset).toHaveText('125%')
    const surface = image.locator('..')
    const box = (await image.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + 30, box.y + box.height / 2)
    await page.mouse.up()
    const transform = await surface.evaluate((node: HTMLElement) => node.style.transform)
    await viewer.getByRole('group', { name: '候选审片操作', exact: true }).focus()
    if (mode === 'arrows') {
      for (const key of ['ArrowRight', 'ArrowLeft']) {
        await page.keyboard.press(key)
        await expect(reset).toHaveText('125%', { timeout: 1500 })
        expect(await surface.evaluate((node: HTMLElement) => node.style.transform)).toBe(transform)
      }
      await expect(viewer.getByText(/左右键浏览/)).toHaveCount(0)
    } else {
      await page.keyboard.press('Enter')
      await expect(viewer.getByRole('alert')).toHaveCount(0, { timeout: 1500 })
      await expect(viewer).toBeVisible()
    }
    await viewer.screenshot({
      path: test.info().outputPath('single-image-keys.png'),
      animations: 'disabled',
    })
  })
}

test('唯一剩余候选可恢复浏览，已显示时方向键不重置视图', async ({ page }) => {
  await newProject(page)
  const id = await page.evaluate(() =>
    window.__plein.addNode({
      type: 'plein/image',
      name: '单候选导航',
      params: { model: 'plein/mock:image', prompt: '两个不同水杯', count: 2 },
      x: 400,
      y: 300,
    }),
  )
  const canvas = decodeURIComponent(page.url().split('#/c/')[1]!)
  await expect
    .poll(async () =>
      (await page.request.get(`/api/canvases/${canvas}/nodes/${id}/input`)).status(),
    )
    .toBe(200)
  expect(
    (await page.request.post(`/api/canvases/${canvas}/nodes/${id}/run`, { data: {} })).status(),
  ).toBe(202)
  await waitNode(page, id)
  await page.getByRole('treeitem', { name: '单候选导航 定位到画布', exact: true }).click()
  await page.getByTestId('generator').getByRole('button', { name: '全屏查看', exact: true }).click()
  const viewer = page.getByRole('dialog', { name: '查看「单候选导航」', exact: true })
  const remaining = await page.evaluate((id) => {
    const records = window.__plein.engine.doc.get(id)!.results!
    ;(
      window.__plein.engine.doc.mutable(id) as unknown as { set(key: string, value: unknown): void }
    ).set('results', records.slice(1))
    return records[1]!
  }, id)
  const next = viewer.getByRole('button', { name: '预览下一个候选', exact: true })
  await expect(next).toBeEnabled()
  await next.click()
  await expect(viewer.getByRole('img', { name: '单候选导航', exact: true })).toHaveAttribute(
    'src',
    `/api/assets/${remaining.value.assetId}`,
  )
  await viewer.getByRole('button', { name: '放大图片', exact: true }).click()
  await viewer.getByRole('group', { name: '候选审片操作', exact: true }).focus()
  await page.keyboard.press('ArrowRight')
  await expect(viewer.getByRole('button', { name: '重置图片视图', exact: true })).toHaveText(
    '125%',
    { timeout: 1500 },
  )
  await expect(next).toBeDisabled()
  await expect(viewer.getByRole('button', { name: '预览上一个候选', exact: true })).toBeDisabled()
  await expect(viewer.getByText(/左右键浏览/)).toHaveCount(0)
  await viewer.screenshot({
    path: test.info().outputPath('one-candidate-view.png'),
    animations: 'disabled',
  })
})
