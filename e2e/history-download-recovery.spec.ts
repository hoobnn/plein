import { readFileSync } from 'node:fs'
import { expect, test, type Download } from '@playwright/test'
import { newProject, waitNode } from './canvas'

for (const mode of ['failure', 'filter', 'cancel', 'close', 'dismiss-failure'] as const) {
  test(`生成历史下载 ${mode} 保留原文件身份并可恢复`, async ({ page }) => {
    await newProject(page)
    const ids = await page.evaluate(() => [
      window.__plein.addNode({
        type: 'plein/image',
        name: '历史图片',
        params: { model: 'plein/mock:image', prompt: '红色杯子' },
        x: 300,
        y: 200,
      }),
      window.__plein.addNode({
        type: 'plein/speech',
        name: '历史音频',
        params: { model: 'plein/mock:audio', text: '你好' },
        x: 800,
        y: 200,
      }),
    ])
    const canvas = decodeURIComponent(page.url().split('#/c/')[1]!)
    for (const id of ids) {
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
    const assets = await page.evaluate(
      (ids) =>
        ids.map((id) => window.__plein.engine.doc.get(id)!.results![0]!.value.assetId as string),
      ids,
    )
    const bytes = await Promise.all(
      assets.map(async (id) => (await page.request.get(`/api/assets/${id}`)).body()),
    )
    if (mode === 'failure') await page.setViewportSize({ width: 390, height: 640 })
    await page.getByRole('button', { name: '生成历史', exact: true }).click()
    const panel = page.getByRole('dialog', { name: '生成历史', exact: true })
    await panel.getByRole('checkbox').first().check()
    await panel.getByRole('button', { name: '全选', exact: true }).click()
    const failing = mode === 'failure' || mode === 'dismiss-failure'
    let fail = failing
    let held = false
    let release!: () => void
    const waiting = new Promise<void>((resolve) => {
      release = resolve
    })
    const requests = [0, 0]
    const aborted: string[] = []
    page.on('requestfailed', (request) => aborted.push(request.url()))
    await page.route('**/api/assets/*', async (route) => {
      const index = assets.indexOf(route.request().url().split('/').at(-1)!)
      if (index < 0 || route.request().resourceType() !== 'fetch') return route.continue()
      requests[index]!++
      if (index === 0 && fail) return route.fulfill({ status: 503, body: 'unavailable' })
      if (index === 0 && !failing && !held) {
        held = true
        await waiting
      }
      await route.continue().catch(() => {})
    })
    const downloads: Download[] = []
    page.on('download', (download) => downloads.push(download))
    try {
      await panel.getByRole('button', { name: '下载', exact: true }).click()
      if (failing) {
        await expect(panel.getByRole('status').filter({ hasText: '1 个文件读取失败' })).toBeVisible(
          { timeout: 2000 },
        )
        if (mode === 'dismiss-failure') {
          await page.keyboard.press('Escape')
          await expect(panel).toHaveCount(0)
          await expect(page.locator('.ui-toast').filter({ hasText: '读取失败' })).toHaveCount(0, {
            timeout: 2000,
          })
          return
        }
        const box = (await panel.locator('footer').boundingBox())!
        expect(box.x).toBeGreaterThanOrEqual(0)
        expect(box.x + box.width).toBeLessThanOrEqual(390)
        expect(box.y + box.height).toBeLessThanOrEqual(640)
        await panel.screenshot({
          path: test.info().outputPath('history-download-failed.png'),
          animations: 'disabled',
        })
        fail = false
        await panel.getByRole('button', { name: '重试未下载（1）', exact: true }).click()
      } else {
        await expect.poll(() => held, { timeout: 2000 }).toBe(true)
        await expect(panel.getByRole('button', { name: /正在读取/ })).toBeDisabled()
        if (mode === 'close') {
          await page.keyboard.press('Escape')
          await expect(panel).toHaveCount(0)
          await expect.poll(() => aborted.some((url) => url.endsWith(assets[0]!))).toBe(true)
          release()
          expect(downloads).toHaveLength(1)
          await page.getByRole('button', { name: '生成历史', exact: true }).click()
          await expect(
            panel.getByRole('button', { name: /正在读取|继续下载|重试未下载/ }),
          ).toHaveCount(0)
          return
        }
        if (mode === 'filter') {
          await panel.getByRole('button', { name: /^图片/ }).click()
          await panel.getByRole('button', { name: '取消选择', exact: true }).click()
          await expect(panel.getByRole('button', { name: '取消下载', exact: true })).toBeVisible()
          release()
        } else {
          await panel.getByRole('button', { name: '取消下载', exact: true }).click()
          await expect(
            panel.getByRole('status').filter({ hasText: '1 个文件未下载' }),
          ).toBeVisible()
          release()
          await panel.getByRole('button', { name: '继续下载（1）', exact: true }).click()
        }
      }
      await expect.poll(() => downloads.length).toBe(2)
      for (const file of downloads) {
        expect(await file.failure()).toBeNull()
        const index = file.suggestedFilename().startsWith('历史图片') ? 0 : 1
        expect(file.suggestedFilename()).toBe(index === 0 ? '历史图片-2.png' : '历史音频-1.wav')
        expect(readFileSync((await file.path())!)).toEqual(bytes[index])
      }
      expect(requests).toEqual(mode === 'failure' || mode === 'cancel' ? [2, 1] : [1, 1])
      await expect(panel.getByRole('status').filter({ hasText: '已交给浏览器下载' })).toBeVisible()
      await panel.screenshot({
        path: test.info().outputPath('history-download.png'),
        animations: 'disabled',
      })
    } finally {
      release()
    }
  })
}
