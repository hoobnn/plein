import { readFileSync } from 'node:fs'
import { expect, test, type Download } from '@playwright/test'
import { solidPng } from '../packages/providers/src/mock/media'
import { newProject } from './canvas'

for (const mode of [
  'failure',
  'cancel',
  'double',
  'selection',
  'selection-cancel',
  'navigate',
] as const) {
  test(`批量下载 ${mode} 显示状态并只恢复未下载文件`, async ({ page }) => {
    await newProject(page)
    const sources = [
      [200, 20, 20],
      [20, 20, 200],
    ].map((color) => Buffer.from(solidPng(64, 48, color as [number, number, number])))
    const assets: string[] = []
    for (const data of sources) {
      const response = await page.request.post('/api/assets', {
        headers: { 'Content-Type': 'image/png' },
        data,
      })
      expect(response.status()).toBe(201)
      assets.push((await response.json()).id)
    }
    await page.evaluate((assets) => {
      const engine = window.__plein.engine as typeof window.__plein.engine & {
        paste(data: unknown): void
      }
      engine.paste({
        plein: 1,
        edges: [],
        elements: assets.map((assetId, i) => ({
          id: `download-${i}`,
          name: `恢复下载${i}`,
          kind: 'image',
          assetId,
          x: 300 + i * 240,
          y: 200,
          w: 200,
          h: 150,
          rotation: 0,
          locked: false,
          parentId: null,
        })),
      })
      const ids = [...engine.doc.elements()].map((el) => el.id)
      engine.selection.set(ids)
      engine.zoomToFit(ids)
    }, assets)
    if (mode === 'failure') await page.setViewportSize({ width: 390, height: 640 })
    let fail = mode === 'failure'
    let blocked = false
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const requests = [0, 0]
    await page.route('**/api/assets/*', async (route) => {
      const index = assets.indexOf(route.request().url().split('/').at(-1)!)
      if (index < 0 || route.request().resourceType() !== 'fetch') return route.continue()
      requests[index]!++
      if (index === 1 && fail)
        return route.fulfill({ status: 503, body: 'temporarily unavailable' })
      if (index === 1 && !blocked && mode !== 'failure') {
        blocked = true
        await held
      }
      await route.continue().catch(() => {})
    })
    const downloads: Download[] = []
    const aborted: string[] = []
    page.on('requestfailed', (request) => {
      if (request.resourceType() === 'fetch') aborted.push(request.url())
    })
    page.on('download', (download) => downloads.push(download))
    const bar = page.getByRole('toolbar', { name: '多选操作', exact: true })
    try {
      await bar.getByRole('button', { name: '下载（2）', exact: true }).click()
      if (mode === 'failure') {
        await expect(bar.getByRole('status')).toContainText('1 个文件读取失败', { timeout: 2000 })
        const box = (await bar.boundingBox())!
        expect(box.x).toBeGreaterThanOrEqual(0)
        expect(box.x + box.width).toBeLessThanOrEqual(390)
        expect(box.y + box.height).toBeLessThanOrEqual(640)
        expect(downloads).toHaveLength(1)
        await page.screenshot({
          path: test.info().outputPath('download-failure.png'),
          animations: 'disabled',
        })
        fail = false
        await bar.getByRole('button', { name: '重试未下载（1）', exact: true }).click()
      } else {
        await expect.poll(() => blocked, { timeout: 2000 }).toBe(true)
        await expect(bar.getByRole('button', { name: /正在读取/ })).toBeDisabled()
        if (mode === 'double') {
          await bar
            .getByRole('button', { name: /正在读取/ })
            .evaluate((button: HTMLButtonElement) => {
              button.click()
              button.click()
            })
          release()
        } else if (mode === 'cancel') {
          await bar.getByRole('button', { name: '取消下载', exact: true }).click()
          await expect(bar.getByRole('status')).toContainText('1 个文件未下载')
          release()
          await bar.getByRole('button', { name: '继续下载（1）', exact: true }).click()
        } else if (mode === 'navigate') {
          await page.getByRole('link', { name: 'Plein', exact: true }).click()
          await expect(bar).toHaveCount(0)
          await expect.poll(() => aborted.some((url) => url.endsWith(assets[1]!))).toBe(true)
          release()
          expect(downloads).toHaveLength(1)
          await expect(page.locator('.ui-toast')).toHaveCount(0)
          return
        } else {
          await page.evaluate(() => window.__plein.engine.selection.set([]))
          if (mode === 'selection-cancel') {
            const standalone = page.getByRole('toolbar', { name: '下载操作', exact: true })
            await standalone.getByRole('button', { name: '取消下载', exact: true }).click()
            await expect(standalone.getByRole('status')).toContainText('1 个文件未下载')
            await standalone.screenshot({
              path: test.info().outputPath('download-without-selection.png'),
              animations: 'disabled',
            })
            release()
            await standalone.getByRole('button', { name: '继续下载（1）', exact: true }).click()
          } else release()
        }
      }
      await expect.poll(() => downloads.length).toBe(2)
      await expect(page.locator('.ui-toast')).toContainText('已交给浏览器下载')
      for (let i = 0; i < 2; i++) {
        expect(await downloads[i]!.failure()).toBeNull()
        expect(downloads[i]!.suggestedFilename()).toMatch(new RegExp(`^恢复下载${i}`))
        expect(readFileSync((await downloads[i]!.path())!)).toEqual(sources[i])
      }
      expect(requests).toEqual(
        mode === 'failure' || mode === 'cancel' || mode === 'selection-cancel' ? [1, 2] : [1, 1],
      )
    } finally {
      release()
    }
  })
}
