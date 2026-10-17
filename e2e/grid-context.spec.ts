import { expect, test } from '@playwright/test'
import { elements, newProject, settle } from './canvas'

for (const next of ['edit', 'back'] as const) {
  test(`切图等待期间${next === 'edit' ? '编辑其他卡片' : '切换选择后又返回原图'}，完成后保留当前上下文`, async ({
    page,
  }) => {
    await newProject(page)
    const response = await page.request.post('/api/assets', {
      headers: { 'content-type': 'image/png' },
      data: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAEAAAAAwCAIAAAAuKetIAAAAYklEQVR4nO3PUQkAIBTAwBfFqDbXEH4cwmABbnP2+rrhgga0oAEtaEALGtCCBrSgAS1oQAsa0IIGtKABLWhACxrQgga0oAEtaEALGtCCBrSgAS1oQAsa0IIGtKABLWhACx67GbZ1HuLZqnQAAAAASUVORK5CYII=',
        'base64',
      ),
    })
    expect(response.status()).toBe(201)
    const asset = (await response.json()).id as string
    const ids = await page.evaluate((asset) => {
      const e = window.__plein.engine as typeof window.__plein.engine & {
        paste(data: unknown): void
      }
      e.paste({
        plein: 1,
        elements: [
          {
            id: 'source',
            kind: 'image',
            name: '待切分的图片',
            assetId: asset,
            x: 0,
            y: 0,
            w: 320,
            h: 240,
            rotation: 0,
            locked: false,
            parentId: null,
          },
        ],
        edges: [],
      })
      const source = [...e.doc.elements()].find((el) => el.kind === 'image')!.id
      const other = window.__plein.addNode({
        type: 'plein/text',
        name: '切图时继续编辑',
        params: { text: '继续操作' },
        x: 800,
        y: 400,
      })
      return { source, other }
    }, asset)
    let uploads = 0
    let held = false
    let release = () => {}
    await page.route('**/api/assets', async (route) => {
      if (route.request().method() !== 'POST' || ++uploads < 4) return route.continue()
      const response = await route.fetch()
      await new Promise<void>((resolve) => {
        release = resolve
        held = true
      })
      await route.fulfill({ response })
    })
    await page
      .getByRole('treeitem', { name: '待切分的图片 定位到画布', exact: true })
      .getByRole('button', { name: '定位到画布', exact: true })
      .click()
    await settle(page, ids.source)
    await page
      .getByRole('toolbar', { name: '结果操作' })
      .getByRole('button', { name: '宫格切分' })
      .click()
    await page.getByRole('button', { name: /4 宫格/ }).click()
    await expect.poll(() => held).toBe(true)
    await page.getByRole('treeitem', { name: '切图时继续编辑 定位到画布', exact: true }).click()
    if (next === 'edit')
      await page
        .getByTestId('generator')
        .getByRole('textbox', { name: '提示词', exact: true })
        .fill('切图等待时的编辑')
    else await page.getByRole('treeitem', { name: '待切分的图片 定位到画布', exact: true }).click()
    const snapshot = () =>
      page.evaluate(() => {
        const e = window.__plein.engine as typeof window.__plein.engine & {
          camera: { x: number; y: number; zoom: number }
        }
        return {
          selection: e.selection.values(),
          camera: { x: e.camera.x, y: e.camera.y, zoom: e.camera.zoom },
        }
      })
    const before = await snapshot()
    release()
    await expect
      .poll(async () => (await elements(page)).filter((el) => el.kind === 'frame').length)
      .toBe(1)
    expect(await snapshot()).toEqual(before)
    if (next === 'edit')
      await expect(
        page.getByTestId('generator').getByRole('textbox', { name: '提示词', exact: true }),
      ).toHaveValue('切图等待时的编辑')
    await page.getByRole('button', { name: '定位新素材', exact: true }).click()
    const frame = (await elements(page)).find((el) => el.kind === 'frame')!
    expect(await page.evaluate(() => window.__plein.engine.selection.values())).toEqual([frame.id])
  })
}
