import { execFileSync } from 'node:child_process'
import { expect, test } from './fixtures'
import { newProject } from './canvas'

for (const width of [390]) {
  test(`素材搜索更新不打断 ${width}px 已打开预览，下一素材不会自动弹出`, async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await newProject(page)
    const names = ['预览时序-旧.png', '预览时序-新.png']
    const ids: string[] = []
    for (const [i, color] of ['orange', 'purple'].entries()) {
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
      ids.push(((await response.json()) as { id: string }).id)
    }
    await page.getByRole('button', { name: '素材', exact: true }).click()
    const panel = page.getByRole('dialog', { name: '素材', exact: true })
    await panel.getByRole('combobox', { name: '关联项目' }).click()
    await page.getByRole('option', { name: '全部项目', exact: true }).click()
    const search = panel.getByRole('searchbox', { name: '搜索素材', exact: true })
    await search.fill('预览时序-旧')
    await page.setViewportSize({ width, height: 640 })
    await panel.getByRole('button', { name: `查看素材 ${names[0]}`, exact: true }).click()
    await page.clock.install({ time: new Date('2030-01-01T00:00:00Z') })
    await page.clock.pauseAt(new Date('2030-01-01T00:00:01Z'))
    const refreshed = page.waitForResponse((response) => {
      const url = new URL(response.url())
      return url.pathname === '/api/assets' && url.searchParams.get('q') === '预览时序-新'
    })
    await search.fill('预览时序-新')
    await panel.getByRole('button', { name: '放大查看素材', exact: true }).click()
    const preview = page.getByRole('dialog', { name: '素材预览', exact: true })
    await expect(preview).toBeVisible()
    await page.clock.fastForward(1000)
    await (await refreshed).finished()
    await page.clock.resume()
    await expect(preview).toHaveAttribute('data-plein-modal-layer', '50')
    await expect(preview).toBeVisible()
    await expect(preview.getByRole('heading', { name: names[0], exact: true })).toBeVisible()
    const image = preview.getByRole('img', { name: names[0], exact: true })
    await expect(image).toHaveAttribute('src', `/api/assets/${ids[0]}`)
    await expect
      .poll(() => image.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0))
      .toBe(true)
    await preview.getByRole('button', { name: '放大', exact: true }).click()
    await expect(preview.getByText('125%', { exact: true })).toBeVisible()
    await preview.screenshot({ path: test.info().outputPath('media-search-preview.png') })
    await preview.getByRole('button', { name: '关闭', exact: true }).click()
    await page.clock.fastForward(1000)
    await expect(preview).toHaveCount(0)
    await expect.poll(() => panel.evaluate((el) => el.contains(document.activeElement))).toBe(true)
    await panel.getByRole('button', { name: `查看素材 ${names[1]}`, exact: true }).click()
    await expect(panel.getByRole('heading', { name: names[1], exact: true })).toBeVisible()
    await expect(preview).toHaveCount(0)
    await panel.getByRole('button', { name: '放大查看素材', exact: true }).click()
    await expect(preview.getByRole('heading', { name: names[1], exact: true })).toBeVisible()
    await expect(preview.getByRole('img', { name: names[1], exact: true })).toHaveAttribute(
      'src',
      `/api/assets/${ids[1]}`,
    )
    await expect(preview.getByText('100%', { exact: true })).toBeVisible()
    expect(errors).toEqual([])
  })
}
