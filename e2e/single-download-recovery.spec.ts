import { readFileSync } from 'node:fs'
import { expect, test, type Download } from '@playwright/test'
import { solidPng } from '../packages/providers/src/mock/media'
import { newProject } from './canvas'

for (const mode of ['failure', 'cancel', 'switch', 'replace'] as const) {
  test(`单文件下载 ${mode} 可恢复且保持素材身份`, async ({ page }) => {
    await newProject(page)
    const bytes = [
      [200, 20, 20],
      [20, 20, 200],
    ].map((color) => Buffer.from(solidPng(64, 48, color as [number, number, number])))
    const assets: string[] = []
    for (const data of bytes) {
      const response = await page.request.post('/api/assets', {
        headers: { 'Content-Type': 'image/png' },
        data,
      })
      expect(response.status()).toBe(201)
      assets.push((await response.json()).id)
    }
    const ids = await page.evaluate((assets) => {
      const engine = window.__plein.engine as typeof window.__plein.engine & {
        paste(data: unknown): void
      }
      engine.paste({
        plein: 1,
        edges: [],
        elements: assets.map((assetId, i) => ({
          id: `single-${i}`,
          kind: 'image',
          name: `单图${i}`,
          assetId,
          x: 400 + i * 240,
          y: 300,
          w: 200,
          h: 150,
          rotation: 0,
          locked: false,
          parentId: null,
        })),
      })
      const ids = [...engine.doc.elements()].map((el) => el.id)
      engine.selection.set([ids[0]!])
      engine.zoomToFit(ids)
      return ids
    }, assets)
    const downloads: Download[] = []
    page.on('download', (download) => downloads.push(download))
    let fail = mode === 'failure'
    let held = false
    let release!: () => void
    const waiting = new Promise<void>((resolve) => {
      release = resolve
    })
    await page.route(`**/api/assets/${assets[0]}`, async (route) => {
      if (route.request().resourceType() !== 'fetch') return route.continue()
      if (fail) return route.fulfill({ status: 503, body: 'unavailable' })
      if (!held && mode !== 'failure') {
        held = true
        await waiting
      }
      await route.continue().catch(() => {})
    })
    const bar = page.getByRole('toolbar', { name: '结果操作', exact: true })
    try {
      await bar.getByRole('button', { name: '下载', exact: true }).click()
      if (mode === 'failure') {
        await expect(bar.getByRole('button', { name: '重试下载', exact: true })).toBeVisible({
          timeout: 2000,
        })
        expect(downloads).toHaveLength(0)
        fail = false
        await bar.getByRole('button', { name: '重试下载', exact: true }).click()
      } else {
        await expect.poll(() => held, { timeout: 2000 }).toBe(true)
        await expect(
          bar.getByRole('button', { name: '正在读取原文件', exact: true }),
        ).toBeDisabled()
        if (mode === 'cancel') {
          await bar.getByRole('button', { name: '取消下载', exact: true }).click()
          await expect(bar.getByRole('button', { name: '继续下载', exact: true })).toBeVisible()
          release()
          await bar.getByRole('button', { name: '继续下载', exact: true }).click()
        } else {
          if (mode === 'replace')
            await page.evaluate(
              ({ id, assetId }) => {
                const node = window.__plein.engine.doc.mutable(id) as unknown as {
                  set(key: string, value: unknown): void
                }
                node.set('assetId', assetId)
              },
              { id: ids[0]!, assetId: assets[1]! },
            )
          else await page.evaluate((id) => window.__plein.engine.selection.set([id]), ids[1]!)
          release()
          await expect(bar.getByRole('button', { name: '下载', exact: true })).toBeVisible()
          await bar.getByRole('button', { name: '下载', exact: true }).click()
        }
      }
      await expect.poll(() => downloads.length).toBe(1)
      const expected = mode === 'switch' || mode === 'replace' ? 1 : 0
      expect(await downloads[0]!.failure()).toBeNull()
      expect(downloads[0]!.suggestedFilename()).toMatch(
        new RegExp(`^单图${mode === 'replace' ? 0 : expected}`),
      )
      expect(readFileSync((await downloads[0]!.path())!)).toEqual(bytes[expected])
    } finally {
      release()
    }
  })
}
