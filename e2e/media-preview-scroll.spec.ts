import { execFileSync } from 'node:child_process'
import { expect, test } from '@playwright/test'
import { newProject } from './canvas'

for (const width of [390])
  for (const portrait of [false, true]) {
    test(`${width}px ${portrait ? '竖图' : '横图'}放大后四角可滚动查看，键盘仍可操作`, async ({
      page,
    }) => {
      const errors: string[] = []
      page.on('pageerror', (error) => errors.push(error.message))
      await newProject(page)
      const size = portrait ? [320, 640] : [640, 320]
      const name = `预览边角-${portrait ? 'portrait' : 'landscape'}.png`
      const data = execFileSync('ffmpeg', [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        `color=c=white:s=${size[0]}x${size[1]},drawbox=x=0:y=0:w=48:h=48:color=red:t=fill,drawbox=x=iw-48:y=ih-48:w=48:h=48:color=blue:t=fill`,
        '-frames:v',
        '1',
        '-f',
        'image2pipe',
        '-vcodec',
        'png',
        'pipe:1',
      ])
      const response = await page.request.post('/api/assets', {
        headers: { 'content-type': 'image/png', 'x-file-name': encodeURIComponent(name) },
        data,
      })
      expect(response.status()).toBe(201)
      const id = ((await response.json()) as { id: string }).id
      await page.getByRole('button', { name: '素材', exact: true }).click()
      const panel = page.getByRole('dialog', { name: '素材', exact: true })
      await panel.getByRole('combobox', { name: '关联项目' }).click()
      await page.getByRole('option', { name: '全部项目', exact: true }).click()
      await panel.getByRole('searchbox', { name: '搜索素材', exact: true }).fill(name)
      await page.setViewportSize({ width, height: 640 })
      await panel.getByRole('button', { name: `查看素材 ${name}`, exact: true }).click()
      await panel.getByRole('button', { name: '放大查看素材', exact: true }).click()
      const preview = page.getByRole('dialog', { name: '素材预览', exact: true })
      const image = preview.getByRole('img', { name, exact: true })
      await expect
        .poll(() => image.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0))
        .toBe(true)
      for (let i = 0; i < 4; i++)
        await preview.getByRole('button', { name: '放大', exact: true }).click()
      await expect(preview.getByText('200%', { exact: true })).toBeVisible()
      const first = await image.evaluate((image) => {
        const area = image.parentElement!
        area.scrollTo(0, 0)
        const i = image.getBoundingClientRect(),
          r = area.getBoundingClientRect()
        return {
          x: i.left - r.left - area.clientLeft,
          y: i.top - r.top - area.clientTop,
          overflow: area.scrollWidth - area.clientWidth,
        }
      })
      expect(first.overflow).toBeGreaterThan(0)
      expect(first.x).toBeGreaterThanOrEqual(0)
      expect(first.y).toBeGreaterThanOrEqual(0)
      await preview.screenshot({ path: test.info().outputPath('preview-top-left.png') })
      const last = await image.evaluate((image) => {
        const area = image.parentElement!
        area.scrollTo(area.scrollWidth, area.scrollHeight)
        const i = image.getBoundingClientRect(),
          r = area.getBoundingClientRect()
        return {
          x: i.right - r.left - area.clientLeft,
          y: i.bottom - r.top - area.clientTop,
          w: area.clientWidth,
          h: area.clientHeight,
        }
      })
      expect(last.x).toBeLessThanOrEqual(last.w + 1)
      expect(last.y).toBeLessThanOrEqual(last.h + 1)
      await preview.screenshot({ path: test.info().outputPath('preview-bottom-right.png') })
      const area = preview.getByRole('region', { name: '素材预览区域', exact: true })
      await area.evaluate((el) => el.scrollTo(0, 0))
      await area.focus()
      await area.press('ArrowRight')
      await expect.poll(() => area.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0)
      await expect(image).toHaveAttribute('src', `/api/assets/${id}`)
      expect(errors).toEqual([])
    })
  }
