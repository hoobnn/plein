import { readFileSync } from 'node:fs'
import { expect, test, type Download } from './fixtures'
import { sineWav, solidPng } from '../packages/providers/src/mock/media'
import { clickElement, newProject } from './canvas'

for (const mode of ['failure', 'cancel', 'switch', 'replace', 'replace-before-render'] as const) {
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
          if (mode.startsWith('replace'))
            await page.evaluate(
              ({ id, assetId, freeze }) => {
                const doc = window.__plein.engine.doc as typeof window.__plein.engine.doc & {
                  schedule(flush: () => void): void
                  flush(): void
                  restoreDownloadTest?(): void
                }
                if (freeze) {
                  doc.flush()
                  const schedule = doc.schedule
                  doc.schedule = () => {}
                  doc.restoreDownloadTest = () => {
                    doc.schedule = schedule
                    doc.flush()
                    delete doc.restoreDownloadTest
                  }
                }
                const node = window.__plein.engine.doc.mutable(id) as unknown as {
                  set(key: string, value: unknown): void
                }
                node.set('assetId', assetId)
              },
              { id: ids[0]!, assetId: assets[1]!, freeze: mode === 'replace-before-render' },
            )
          else await page.evaluate((id) => window.__plein.engine.selection.set([id]), ids[1]!)
          const oldResponse =
            mode === 'replace-before-render'
              ? page.waitForResponse(
                  (response) =>
                    response.url().endsWith(`/api/assets/${assets[0]}`) &&
                    response.request().resourceType() === 'fetch',
                )
              : null
          release()
          if (oldResponse) {
            await (await oldResponse).finished()
            await page.evaluate(
              () =>
                new Promise((resolve) =>
                  requestAnimationFrame(() => requestAnimationFrame(resolve)),
                ),
            )
            expect(downloads).toHaveLength(0)
            await page.evaluate(() =>
              (
                window.__plein.engine.doc as unknown as { restoreDownloadTest?(): void }
              ).restoreDownloadTest?.(),
            )
          }
          await expect(bar.getByRole('button', { name: '下载', exact: true })).toBeVisible()
          await bar.getByRole('button', { name: '下载', exact: true }).click()
        }
      }
      await expect.poll(() => downloads.length).toBe(1)
      const expected = mode === 'switch' || mode.startsWith('replace') ? 1 : 0
      expect(await downloads[0]!.failure()).toBeNull()
      expect(downloads[0]!.suggestedFilename()).toMatch(
        new RegExp(`^单图${mode.startsWith('replace') ? 0 : expected}`),
      )
      expect(readFileSync((await downloads[0]!.path())!)).toEqual(bytes[expected])
    } finally {
      release()
      await page.evaluate(() =>
        (
          window.__plein.engine.doc as unknown as { restoreDownloadTest?(): void }
        ).restoreDownloadTest?.(),
      )
    }
  })
}

for (const mode of ['failure', 'switch'] as const) {
  test(`音频候选下载 ${mode} 保留正确文件身份并可恢复`, async ({ page }) => {
    await newProject(page)
    const bytes = [330, 660].map((hz) => Buffer.from(sineWav(0.5, hz)))
    const assets: string[] = []
    for (const data of bytes) {
      const response = await page.request.post('/api/assets', {
        headers: { 'Content-Type': 'audio/wav', 'x-file-name': 'candidate.wav' },
        data,
      })
      expect(response.status()).toBe(201)
      assets.push((await response.json()).id)
    }
    const id = await page.evaluate((assets) => {
      const id = window.__plein.addNode({
        type: 'plein/speech',
        name: '音频下载恢复',
        params: { text: '保留的台词', model: 'plein/mock:audio' },
        x: 400,
        y: 300,
      })
      const node = window.__plein.engine.doc.mutable(id) as unknown as {
        set(key: string, value: unknown): void
      }
      node.set(
        'results',
        assets.map((assetId, i) => ({
          id: `audio-${i}`,
          port: 'audio',
          runId: `audio-run-${i}`,
          at: Date.now() + i,
          value: { type: 'audio', assetId },
        })),
      )
      node.set('adopted', 'audio-0')
      return id
    }, assets)
    await clickElement(page, id)
    const generator = page.getByTestId('generator')
    const downloads: Download[] = []
    page.on('download', (download) => downloads.push(download))
    let held = false
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    await page.route(`**/api/assets/${assets[0]}`, async (route) => {
      if (route.request().resourceType() !== 'fetch') return route.continue()
      if (mode === 'failure' && !held) {
        held = true
        return route.fulfill({ status: 503, body: 'audio unavailable' })
      }
      if (mode === 'switch') {
        held = true
        await gate
      }
      await route.continue().catch(() => {})
    })
    try {
      await generator.getByRole('button', { name: '下载', exact: true }).click()
      if (mode === 'failure') {
        await expect(generator.getByRole('button', { name: '重试下载', exact: true })).toBeVisible()
        expect(downloads).toHaveLength(0)
        await generator.getByRole('button', { name: '重试下载', exact: true }).click()
      } else {
        await expect.poll(() => held).toBe(true)
        await page
          .locator('.plein-node')
          .getByRole('button', { name: '下一个结果', exact: true })
          .click()
        const viewer = page.getByRole('dialog', { name: '查看「音频下载恢复」', exact: true })
        await viewer.getByRole('button', { name: '采用此候选', exact: true }).click()
        await viewer.getByRole('button', { name: '关闭', exact: true }).click()
        await expect(generator.getByRole('button', { name: '下载', exact: true })).toBeEnabled()
        release()
        await generator.getByRole('button', { name: '下载', exact: true }).click()
      }
      await expect.poll(() => downloads.length).toBe(1)
      expect(await downloads[0]!.failure()).toBeNull()
      expect(readFileSync((await downloads[0]!.path())!)).toEqual(bytes[mode === 'switch' ? 1 : 0])
      await page.waitForLoadState('networkidle')
      expect(downloads).toHaveLength(1)
    } finally {
      release()
    }
  })
}
