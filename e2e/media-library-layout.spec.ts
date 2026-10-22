import { execFileSync } from 'node:child_process'
import { expect, test } from '@playwright/test'
import { newProject } from './canvas'

for (const width of [390, 1440]) {
  test(`素材库 ${width}px 查看详情、预览、返回和复用保持可操作`, async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await newProject(page)
    const assets: string[] = []
    const colors =
      width === 390
        ? [
            'blue',
            'green',
            ...Array.from({ length: 12 }, (_, i) => `0x${(0x405060 + i * 0x070503).toString(16)}`),
          ]
        : ['blue', 'green']
    const names = colors.map((_, i) => `布局验收-${i}.png`)
    for (const [i, color] of colors.entries()) {
      const data = execFileSync('ffmpeg', [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        `color=c=${color}:s=160x96`,
        '-frames:v',
        '1',
        '-f',
        'image2pipe',
        '-vcodec',
        'png',
        'pipe:1',
      ])
      const response = await page.request.post('/api/assets', {
        headers: { 'content-type': 'image/png', 'x-file-name': encodeURIComponent(names[i]!) },
        data,
      })
      expect(response.status()).toBe(201)
      assets.push(((await response.json()) as { id: string }).id)
    }
    await page.getByRole('button', { name: '素材', exact: true }).click()
    const panel = page.getByRole('dialog', { name: '素材', exact: true })
    await panel.getByRole('combobox', { name: '关联项目' }).click()
    await page.getByRole('option', { name: '全部项目', exact: true }).click()
    await panel.getByRole('searchbox', { name: '搜索素材', exact: true }).fill('布局验收-')
    const card = (i: number) =>
      panel.getByRole('button', { name: `查看素材 ${names[i]}`, exact: true })
    await expect(card(0)).toBeVisible()
    await page.setViewportSize({ width, height: 640 })
    const first = 0 // 素材按新到旧排列，首个上传的素材位于长列表底部
    await card(first).scrollIntoViewIfNeeded()
    const list = panel.locator('[aria-busy]')
    const scrollTop = await list.evaluate((el) => el.scrollTop)
    if (width === 390) expect(scrollTop).toBeGreaterThan(0)
    await card(first).click()
    await expect(panel.getByRole('heading', { name: names[first], exact: true })).toBeVisible()
    await panel.screenshot({ path: test.info().outputPath('media-detail.png') })
    const back = panel.getByRole('button', { name: '返回素材列表', exact: true })
    if (width < 768) {
      await expect(back).toBeVisible()
      await expect(card(1)).toBeHidden()
    } else {
      await expect(back).toBeHidden()
      await expect(card(1)).toBeVisible()
      expect((await card(1).boundingBox())!.width).toBeGreaterThan(120)
    }
    expect(await panel.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
    await panel.getByRole('button', { name: '放大查看素材', exact: true }).click()
    const preview = page.getByRole('dialog', { name: '素材预览', exact: true })
    const image = preview.getByRole('img', { name: names[first], exact: true })
    await expect
      .poll(() => image.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0))
      .toBe(true)
    await preview.getByRole('button', { name: '放大', exact: true }).click()
    await expect(preview.getByText('125%', { exact: true })).toBeVisible()
    await preview.getByRole('button', { name: '关闭', exact: true }).click()
    await expect(preview).toHaveCount(0)
    if (width < 768) {
      await back.click()
      await expect(card(first)).toBeFocused()
      expect(await list.evaluate((el) => el.scrollTop)).toBeCloseTo(scrollTop, 0)
      await expect(card(1)).toBeVisible()
    }
    await card(1).click()
    await expect(panel.getByRole('heading', { name: names[1], exact: true })).toBeVisible()
    await panel.getByRole('button', { name: '放入当前画布', exact: true }).click()
    await expect(panel).toHaveCount(0)
    const placed = await page.evaluate(() => {
      const engine = window.__plein.engine
      const el = engine.doc.get(engine.selection.values()[0]!)!
      return { kind: el.kind, assetId: el.assetId, name: el.name }
    })
    expect(placed).toEqual({ kind: 'image', assetId: assets[1], name: names[1] })
    expect(errors).toEqual([])
  })
}
