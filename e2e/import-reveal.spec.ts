import { expect, test } from './fixtures'
import { elements, newProject, waitNode } from './canvas'

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAAAwCAIAAAAuKetIAAAAYklEQVR4nO3PUQkAIBTAwBfFqDbXEH4cwmABbnP2+rrhgga0oAEtaEALGtCCBrSgAS1oQAsa0IIGtKABLWhACxrQgga0oAEtaEALGtCCBrSgAS1oQAsa0IIGtKABLWhACx67GbZ1HuLZqnQAAAAASUVORK5CYII=',
  'base64',
)

for (const mode of ['file', 'text', 'history'] as const) {
  test(`${mode} 新素材被避让到视口外时自动定位并保留选择`, async ({ page }) => {
    await newProject(page)
    if (mode === 'history') {
      const id = await page.evaluate(() =>
        window.__plein.addNode({
          type: 'plein/image',
          name: '待复用历史结果',
          params: { model: 'plein/mock:image', prompt: '海鸟' },
          x: -1000,
          y: -1000,
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
    }
    await page.evaluate(() => {
      const id = window.__plein.addNode({
        type: 'plein/text',
        name: '覆盖当前视口的已有内容',
        params: { text: '让新内容避让到画布右侧' },
        x: 0,
        y: 0,
      })
      const map = window.__plein.engine.doc.mutable(id) as unknown as {
        set(key: string, value: number): void
      }
      map.set('w', 8000)
      map.set('h', 4000)
    })
    if (mode === 'file') {
      const chooser = page.waitForEvent('filechooser')
      await page.getByRole('button', { name: '上传', exact: true }).click()
      await (
        await chooser
      ).setFiles({ name: '需要定位的图片.png', mimeType: 'image/png', buffer: png })
    } else if (mode === 'text') {
      await page
        .locator('canvas')
        .first()
        .evaluate((canvas) => {
          const data = new DataTransfer()
          data.setData('text/plain', '需要定位的粘贴正文')
          canvas.dispatchEvent(
            new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }),
          )
        })
    } else {
      await page.getByRole('button', { name: '生成历史', exact: true }).click()
      const history = page.getByRole('dialog', { name: '生成历史' })
      await history.getByRole('checkbox').first().check()
      await history.getByRole('button', { name: '放到画布上', exact: true }).click()
      await expect(history).toBeHidden()
    }
    const kind = mode === 'text' ? 'markdown' : 'image'
    await expect
      .poll(async () => (await elements(page)).filter((el) => el.kind === kind).length)
      .toBe(1)
    const imported = (await elements(page)).find((el) => el.kind === kind)!
    const result = await page.evaluate((id) => {
      const e = window.__plein.engine
      const r = e.doc.worldRect(id)
      return {
        center: e.worldToClient(r.x + r.w / 2, r.y + r.h / 2),
        selection: e.selection.values(),
        width: innerWidth,
        height: innerHeight,
      }
    }, imported.id)
    expect(result.selection).toEqual([imported.id])
    expect(result.center.x).toBeGreaterThan(300)
    expect(result.center.x).toBeLessThan(result.width - 16)
    expect(result.center.y).toBeGreaterThan(64)
    expect(result.center.y).toBeLessThan(result.height - 64)
  })
}

test('新文件已在可见区域时保持用户当前缩放和视角', async ({ page }) => {
  await newProject(page)
  const before = await page.evaluate(() => {
    const e = window.__plein.engine as typeof window.__plein.engine & {
      camera: { x: number; y: number; zoom: number; zoomTo(value: number): void }
    }
    e.camera.zoomTo(2)
    return { x: e.camera.x, y: e.camera.y, zoom: e.camera.zoom }
  })
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: '上传', exact: true }).click()
  await (await chooser).setFiles({ name: '视角保持.png', mimeType: 'image/png', buffer: png })
  await expect.poll(async () => (await elements(page)).length).toBe(1)
  expect(
    await page.evaluate(() => {
      const c = (
        window.__plein.engine as unknown as { camera: { x: number; y: number; zoom: number } }
      ).camera
      return { x: c.x, y: c.y, zoom: c.zoom }
    }),
  ).toEqual(before)
})

for (const steering of ['typing', 'drop-typing', 'notice-reset'] as const) {
  test(`上传期间${steering} 后保留新上下文，并允许手动定位导入结果`, async ({ page }, testInfo) => {
    await newProject(page)
    await page.evaluate(() =>
      window.__plein.addNode({
        type: 'plein/text',
        name: '用户继续操作的卡片',
        params: { text: '编辑中的内容' },
        x: 1000,
        y: 0,
      }),
    )
    if (steering === 'typing' || steering === 'drop-typing')
      await page
        .getByRole('treeitem', { name: '用户继续操作的卡片 定位到画布', exact: true })
        .click()
    let held = false
    let release = () => {}
    await page.route('**/api/assets', async (route) => {
      if (route.request().method() !== 'POST') return route.continue()
      const response = await route.fetch()
      await new Promise<void>((resolve) => {
        release = resolve
        held = true
      })
      await route.fulfill({ response })
    })
    if (steering === 'drop-typing') {
      const prompt = page
        .getByTestId('generator')
        .getByRole('textbox', { name: '提示词', exact: true })
      await prompt.focus()
      await page
        .locator('canvas')
        .first()
        .evaluate(
          (canvas, bytes) => {
            const data = new DataTransfer()
            data.items.add(
              new File([new Uint8Array(bytes)], '拖入的图片.png', { type: 'image/png' }),
            )
            canvas.dispatchEvent(
              new DragEvent('drop', {
                bubbles: true,
                cancelable: true,
                clientX: 850,
                clientY: 400,
                dataTransfer: data,
              }),
            )
          },
          [...png],
        )
    } else {
      const chooser = page.waitForEvent('filechooser')
      await page.getByRole('button', { name: '上传', exact: true }).click()
      await (
        await chooser
      ).setFiles({ name: '稍后完成的文件.png', mimeType: 'image/png', buffer: png })
    }
    await expect.poll(() => held).toBe(true)
    if (steering === 'notice-reset')
      await page
        .getByRole('treeitem', { name: '用户继续操作的卡片 定位到画布', exact: true })
        .click()
    else
      await page
        .getByTestId('generator')
        .getByRole('textbox', { name: '提示词', exact: true })
        .fill('上传期间继续编辑')
    const before = await page.evaluate(() => {
      const e = window.__plein.engine as typeof window.__plein.engine & {
        camera: { x: number; y: number; zoom: number }
      }
      return {
        selection: e.selection.values(),
        camera: { x: e.camera.x, y: e.camera.y, zoom: e.camera.zoom },
      }
    })
    release()
    await expect
      .poll(async () => (await elements(page)).filter((el) => el.kind === 'image').length)
      .toBe(1)
    expect(
      await page.evaluate(() => {
        const e = window.__plein.engine as typeof window.__plein.engine & {
          camera: { x: number; y: number; zoom: number }
        }
        return {
          selection: e.selection.values(),
          camera: { x: e.camera.x, y: e.camera.y, zoom: e.camera.zoom },
        }
      }),
    ).toEqual(before)
    const imported = (await elements(page)).find((el) => el.kind === 'image')!
    await expect(page.getByRole('button', { name: '定位新素材', exact: true })).toBeVisible()
    if (steering === 'notice-reset') {
      await page.getByRole('button', { name: '切换画布' }).click()
      await page.getByRole('button', { name: '新建画布' }).click()
      await page.getByRole('dialog').getByRole('textbox').fill('清空旧通知的画布')
      await page.keyboard.press('Enter')
      await expect(page.getByRole('button', { name: '切换画布' })).toHaveText('清空旧通知的画布')
      await expect(page.getByRole('button', { name: '定位新素材', exact: true })).toHaveCount(0)
      await expect(page.getByRole('status').filter({ hasText: '已导入' })).toHaveCount(0)
      return
    }
    if (steering === 'typing')
      await page.screenshot({
        path: testInfo.outputPath('late-import.png'),
        animations: 'disabled',
      })
    await page.getByRole('button', { name: '定位新素材', exact: true }).click()
    expect(await page.evaluate(() => window.__plein.engine.selection.values())).toEqual([
      imported.id,
    ])
  })
}
