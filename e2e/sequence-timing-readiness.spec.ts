import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { centerOf, clickElement, newProject } from './canvas'

let dir = ''
test.beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'plein-timing-readiness-'))
  for (const color of ['blue', 'red'])
    execFileSync('ffmpeg', [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      `color=c=${color}:s=96x64:d=0.6:r=10`,
      '-c:v',
      'libvpx-vp9',
      '-deadline',
      'realtime',
      join(dir, `${color}.webm`),
    ])
})
test.afterAll(() => rmSync(dir, { recursive: true, force: true }))

for (const readOnly of [false, true]) {
  for (const mode of ['delayed', 'failed', 'removed'] as const) {
    test(`前序镜头时长 ${mode} 不按临时位置激活后镜头，只读=${readOnly}`, async ({ page }) => {
      await newProject(page)
      const assets: string[] = []
      for (const color of ['blue', 'red']) {
        const response = await page.request.post('/api/assets', {
          headers: { 'content-type': 'video/webm', 'x-file-name': `${color}.webm` },
          data: readFileSync(join(dir, `${color}.webm`)),
        })
        expect(response.status()).toBe(201)
        assets.push((await response.json()).id)
      }
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      let entered!: () => void
      const reading = new Promise<void>((resolve) => {
        entered = resolve
      })
      let broken = mode === 'failed'
      await page.route(`**/api/assets/${assets[0]}/meta`, async (route) => {
        entered()
        await gate
        return broken
          ? route.fulfill({
              status: 503,
              json: { error: 'unavailable', message: '前序素材信息暂不可用' },
            })
          : route.continue()
      })
      try {
        const { id, sources } = await page.evaluate(
          ({ assets, readOnly }) => {
            const sequence = window.__plein.addNode({
              type: 'plein/sequence',
              name: '同名镜头读取',
              x: 400,
              y: 200,
              params: { subtitles: false, aspectRatio: '16:9' },
            })
            const sources = assets.map((assetId, i) => {
              const video = window.__plein.addNode({
                type: 'plein/video',
                name: '同名镜头',
                x: -400,
                y: 200 + i * 300,
                params: {},
              })
              const node = window.__plein.engine.doc.mutable(video)! as unknown as {
                set(k: string, v: unknown): void
              }
              node.set('results', [
                {
                  id: 'ready',
                  runId: 'fixture',
                  port: 'video',
                  at: 1,
                  value: { type: 'video', assetId },
                },
              ])
              window.__plein.connect([video, 'video'], [sequence, 'clips'])
              return video
            })
            ;(window.__plein.engine.doc as unknown as { readOnly: boolean }).readOnly = readOnly
            return { id: sequence, sources }
          },
          { assets, readOnly },
        )
        await clickElement(page, id)
        const at = await centerOf(page, id)
        await page.mouse.dblclick(at.x, at.y)
        const editor = page.getByRole('dialog', { name: '序列', exact: true })
        await expect(editor).toHaveCSS('opacity', '1')
        await reading
        const clips = editor.locator('.seq-clip')
        await clips.nth(1).focus()
        await expect(editor.locator('.seq-clip-head')).toContainText('时长 0.6 秒')
        const saved = () => page.evaluate((id) => window.__plein.engine.doc.get(id)?.params, id)
        const before = await saved()
        await editor.getByRole('button', { name: '回到开头', exact: true }).focus()
        for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight')
        const time = editor.locator('.seq-time > span').first()
        await expect(time).toHaveText('0:00.1')
        await clips.nth(1).focus()
        await page.keyboard.press('Enter')
        await expect(time).toHaveText('0:00.1')
        await expect(clips.nth(1)).toHaveAttribute('aria-disabled', 'true')
        await expect(clips.nth(1)).toHaveAccessibleDescription(/第 2 个镜头，共 2 个/)
        await expect(editor.getByRole('status', { name: '镜头定位暂不可用' })).toBeVisible()
        const firstBox = (await clips.first().boundingBox())!
        const secondBox = (await clips.nth(1).boundingBox())!
        expect(firstBox.x + firstBox.width).toBeLessThanOrEqual(secondBox.x + 1)
        await expect(clips.nth(1).locator('.seq-trim-out')).toHaveCount(0)
        if (!readOnly) {
          await page.mouse.move(
            secondBox.x + secondBox.width / 2,
            secondBox.y + secondBox.height / 2,
          )
          await page.mouse.down()
          await page.mouse.move(firstBox.x + firstBox.width / 2, firstBox.y + firstBox.height / 2, {
            steps: 4,
          })
          await page.mouse.up()
          expect(await saved()).toEqual(before)
          await expect(time).toHaveText('0:00.1')
        }
        if (mode === 'delayed' && !readOnly) {
          await page.setViewportSize({ width: 390, height: 700 })
          await editor.getByRole('status', { name: '镜头定位暂不可用' }).scrollIntoViewIfNeeded()
          await editor.screenshot({ path: test.info().outputPath('timing-unready-390.png') })
          await page.setViewportSize({ width: 1440, height: 900 })
        }
        expect(await saved()).toEqual(before)
        if (mode === 'removed') {
          await page.evaluate((source) => {
            const doc = window.__plein.engine
              .doc as unknown as import('../packages/doc/src/doc').PleinDoc
            doc.ydoc.transact(() => {
              doc.elementMaps.delete(source)
              for (const [id, edge] of doc.edgeMap)
                if (edge.from[0] === source || edge.to[0] === source) doc.edgeMap.delete(id)
            }, 'simulated-peer')
            doc.flush()
          }, sources[0]!)
          await expect(clips).toHaveCount(1)
          await expect(editor.locator('.ui-chip').first()).toContainText('0.6 秒')
          await expect(clips.first()).not.toHaveAttribute('aria-disabled', 'true')
          await expect(editor.locator('.seq-clip-index')).toHaveText('01')
          const response = page.waitForResponse(
            (r) => r.url().endsWith(`/api/assets/${assets[0]}/meta`),
            { timeout: 10000 },
          )
          release()
          await (await response).finished()
          await page.evaluate(
            () =>
              new Promise<void>((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
              ),
          )
          await expect(clips).toHaveCount(1)
          await expect(editor.locator('.ui-chip').first()).toContainText('0.6 秒')
          await expect(time).toHaveText('0:00.1')
          await expect(clips.first()).toHaveAccessibleDescription(/第 1 个镜头，共 1 个/)
          await expect
            .poll(() =>
              editor
                .locator('.seq-stage canvas')
                .first()
                .evaluate((canvas: HTMLCanvasElement) => {
                  const pixel = canvas
                    .getContext('2d')!
                    .getImageData(
                      Math.floor(canvas.width / 2),
                      Math.floor(canvas.height / 2),
                      1,
                      1,
                    ).data
                  return pixel[0]! > 180 && pixel[2]! < 90
                }),
            )
            .toBe(true)
          await clips.first().focus()
          await page.keyboard.press('Enter')
          await expect(time).toHaveText('0:00.0')
          expect(await saved()).toEqual(before)
          return
        }
        const held = mode === 'delayed'
        if (held) {
          const box = (await clips.nth(1).boundingBox())!
          await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
          await page.mouse.down()
        }
        release()
        if (mode === 'failed') {
          await expect(editor.getByRole('alert', { name: '素材信息读取失败' })).toContainText(
            '前序素材信息暂不可用',
          )
          await expect(clips.nth(1)).toHaveAttribute('aria-disabled', 'true')
          broken = false
          await editor.getByRole('button', { name: '重新加载预览', exact: true }).click()
        }
        await expect(editor.locator('.ui-chip').first()).toContainText('1.2 秒')
        if (held) await page.mouse.up()
        await expect(time).toHaveText('0:00.1')
        await expect(clips.nth(1)).not.toHaveAttribute('aria-disabled', 'true')
        await expect(clips.nth(1).locator('.seq-trim-out')).toHaveCount(readOnly ? 0 : 1)
        await clips.nth(1).focus()
        await page.keyboard.press('Enter')
        await expect(time).toHaveText('0:00.6')
        const screen = editor.locator('.seq-stage canvas').first()
        await expect
          .poll(() =>
            screen.evaluate(
              (canvas: HTMLCanvasElement) =>
                canvas
                  .getContext('2d')!
                  .getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1)
                  .data[0],
            ),
          )
          .toBeGreaterThan(180)
        expect(await saved()).toEqual(before)
      } finally {
        release()
      }
    })
  }
}
