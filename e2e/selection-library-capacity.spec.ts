import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import type { LibraryItem } from '../packages/protocol/src/library'
import { solidPng } from '../packages/providers/src/mock/media'
import { newProject } from './canvas'

let dir = ''
test.beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'plein-library-capacity-'))
  for (const color of ['red', 'blue'])
    execFileSync('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      `color=c=${color}:s=64x64:d=0.4`,
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      join(dir, `${color}.mp4`),
    ])
})
test.afterAll(() => rmSync(dir, { recursive: true, force: true }))

const cases = [
  {
    id: 'videos',
    selected: [0, 1],
    blocked: '特效',
    reason: '每条特效只能保存 1 个参考视频，请先只选 1 个视频',
    recovered: [1],
    kind: '特效',
    images: [],
    video: 1,
  },
  {
    id: 'covers',
    selected: [2, 3],
    blocked: '特效',
    reason: '每条特效只能保存 1 张封面，请先只选 1 张图片',
    recovered: [2, 3],
    kind: '道具',
    images: [2, 3],
    video: null,
  },
  {
    id: 'mixed',
    selected: [0, 2],
    blocked: '道具',
    reason: '道具只收图片，请先取消选择视频',
    recovered: [0, 2],
    kind: '特效',
    images: [2],
    video: 0,
  },
  {
    id: 'mixed-overflow',
    selected: [0, 2, 3],
    blocked: '特效',
    reason: '每条特效只能保存 1 张封面，请先只选 1 张图片',
    recovered: [0, 3],
    kind: '特效',
    images: [3],
    video: 0,
  },
  {
    id: 'duplicate',
    selected: [0, 4],
    blocked: null,
    reason: '',
    recovered: [0, 4],
    kind: '特效',
    images: [],
    video: 0,
  },
]
for (const scenario of cases) {
  test(`入库容量 ${scenario.id} 不静默丢素材，调整后保存全部引用`, async ({ page }) => {
    await newProject(page)
    const sources = [
      { mime: 'video/mp4', data: readFileSync(join(dir, 'red.mp4')) },
      { mime: 'video/mp4', data: readFileSync(join(dir, 'blue.mp4')) },
      { mime: 'image/png', data: Buffer.from(solidPng(64, 48, [200, 20, 20])) },
      { mime: 'image/png', data: Buffer.from(solidPng(64, 48, [20, 20, 200])) },
    ]
    const assets: string[] = []
    for (const source of sources) {
      const response = await page.request.post('/api/assets', {
        headers: { 'Content-Type': source.mime },
        data: source.data,
      })
      expect(response.status()).toBe(201)
      assets.push((await response.json()).id)
    }
    const ids = await page.evaluate(
      ({ assets, selected }) => {
        const engine = window.__plein.engine as typeof window.__plein.engine & {
          paste(data: unknown): void
        }
        engine.paste({
          plein: 1,
          edges: [],
          elements: [0, 1, 2, 3, 0].map((asset, i) => ({
            id: `capacity-${i}`,
            kind: asset < 2 ? 'video' : 'image',
            name: `容量素材${i}`,
            assetId: assets[asset],
            x: 300 + i * 220,
            y: 200,
            w: 200,
            h: 150,
            rotation: 0,
            locked: false,
            parentId: null,
          })),
        })
        const all = [...engine.doc.elements()]
        const ids = [0, 1, 2, 3, 4].map((i) => all.find((el) => el.name === `容量素材${i}`)!.id)
        engine.selection.set(selected.map((i) => ids[i]!))
        engine.zoomToFit()
        return ids
      },
      { assets, selected: scenario.selected },
    )
    if (scenario.id === 'mixed-overflow') await page.setViewportSize({ width: 390, height: 640 })
    const title = `容量验证-${scenario.id}-${Date.now()}`
    const records = async () =>
      (await (await page.request.get('/api/library')).json()) as LibraryItem[]
    try {
      const trigger = page.getByRole('button', { name: '存入资产库', exact: true })
      await trigger.click()
      const menu = page.getByRole('dialog', { name: '存入资产库', exact: true })
      if (scenario.blocked) {
        const blocked = menu.getByRole('button', { name: new RegExp(`^${scenario.blocked}`) })
        await expect(blocked).toBeDisabled()
        await expect(blocked).toContainText(scenario.reason)
        const box = (await menu.boundingBox())!
        const viewport = page.viewportSize()!
        expect(box.x).toBeGreaterThanOrEqual(0)
        expect(box.y).toBeGreaterThanOrEqual(0)
        expect(box.x + box.width).toBeLessThanOrEqual(viewport.width)
        expect(box.y + box.height).toBeLessThanOrEqual(viewport.height)
        await menu.screenshot({
          path: test.info().outputPath('capacity-menu.png'),
          animations: 'disabled',
        })
        await page.keyboard.press('Escape')
        await page.evaluate(
          ({ ids, selected }) => window.__plein.engine.selection.set(selected.map((i) => ids[i]!)),
          { ids, selected: scenario.recovered },
        )
        await trigger.click()
      }
      await menu.getByRole('button', { name: new RegExp(`^${scenario.kind}`) }).click()
      const panel = page.getByRole('dialog', { name: '资产库', exact: true })
      await panel.getByRole('textbox', { name: '名称', exact: true }).fill(title)
      await panel.getByRole('button', { name: '保存', exact: true }).click()
      await expect(panel.getByRole('button', { name: '已保存', exact: true })).toBeDisabled()
      const saved = (await records()).find((item) => item.name === title)!
      expect(saved.images.map((image) => image.assetId)).toEqual(
        scenario.images.map((i) => assets[i]),
      )
      expect(saved.video).toBe(scenario.video === null ? null : assets[scenario.video]!)
      if (scenario.video !== null) {
        const video = panel.locator('video')
        await expect(video).toHaveAttribute('src', new RegExp(assets[scenario.video]!))
        await video.evaluate(async (video: HTMLVideoElement) => {
          await video.play()
        })
        await expect
          .poll(() => video.evaluate((video: HTMLVideoElement) => video.currentTime))
          .toBeGreaterThan(0)
      }
      await panel.screenshot({
        path: test.info().outputPath('capacity-saved.png'),
        animations: 'disabled',
      })
    } finally {
      for (const item of await records())
        if (item.name === title) await page.request.delete(`/api/library/${item.id}`)
    }
  })
}
