import { execFileSync } from 'node:child_process'
import { expect, test } from './fixtures'
import { solidPng } from '../packages/providers/src/mock/media'
import { newProject, zoomTo } from './canvas'

for (const op of ['crop', 'rotate', 'separate'] as const) {
  test(`分组内真实 ${op} 产物归组、独立撤销并随父级移动`, async ({ page }) => {
    await newProject(page)
    const video = op === 'separate'
    const bytes = video
      ? execFileSync('ffmpeg', [
          '-hide_banner',
          '-loglevel',
          'error',
          '-f',
          'lavfi',
          '-i',
          'color=c=teal:s=160x90:d=0.6:r=10',
          '-f',
          'lavfi',
          '-i',
          'sine=f=440:d=0.6',
          '-shortest',
          '-pix_fmt',
          'yuv420p',
          '-c:a',
          'aac',
          '-movflags',
          'frag_keyframe+empty_moov',
          '-f',
          'mp4',
          'pipe:1',
        ])
      : Buffer.from(solidPng(160, 90, [30, 140, 180]))
    const upload = await page.request.post('/api/assets', {
      headers: { 'Content-Type': video ? 'video/mp4' : 'image/png' },
      data: bytes,
    })
    expect(upload.status()).toBe(201)
    const asset = (await upload.json()).id as string
    const ids = await page.evaluate(
      ({ asset, video }) => {
        const e = window.__plein.engine as typeof window.__plein.engine & {
          paste(data: unknown): void
        }
        e.paste({
          plein: 1,
          edges: [],
          elements: [
            {
              id: 'frame',
              kind: 'frame',
              name: '加工分组',
              x: 100,
              y: 100,
              w: 1400,
              h: 900,
              parentId: null,
            },
            {
              id: 'source',
              kind: video ? 'video' : 'image',
              name: '组内原片',
              assetId: asset,
              x: 100,
              y: 200,
              w: 240,
              h: 135,
              parentId: 'frame',
            },
          ],
        })
        const els = [...e.doc.elements()]
        return {
          frame: els.find((el) => el.kind === 'frame')!.id,
          source: els.find((el) => el.kind !== 'frame')!.id,
        }
      },
      { asset, video },
    )
    await zoomTo(page, [ids.frame])
    await page.getByRole('treeitem', { name: '组内原片 定位到画布', exact: true }).click()
    const before = await page.evaluate((id) => window.__plein.engine.doc.get(id), ids.source)
    await page.getByRole('button', { name: '媒体工具', exact: true }).click()
    const tools = page.getByRole('dialog', { name: '媒体工具', exact: true })
    if (op === 'crop') {
      await tools.getByRole('button', { name: '裁剪', exact: true }).click()
      await expect(tools.getByLabel('宽', { exact: true })).toHaveAttribute('placeholder', '160')
      await tools.getByLabel('宽', { exact: true }).fill('80')
      await tools.getByRole('button', { name: '开始加工', exact: true }).click()
    } else
      await tools
        .getByRole('button', { name: op === 'rotate' ? '旋转 90°' : '分离音频与画面', exact: true })
        .click()
    const produced = () =>
      page.evaluate(
        (ids) =>
          [...window.__plein.engine.doc.elements()].filter(
            (el) => el.id !== ids.frame && el.id !== ids.source,
          ),
        ids,
      )
    await expect.poll(async () => (await produced()).length).toBe(video ? 2 : 1)
    const outputs = await produced()
    for (const result of outputs) expect(result.parentId).toBe(ids.frame)
    expect(await page.evaluate((id) => window.__plein.engine.doc.get(id), ids.source)).toEqual(
      before,
    )
    for (const result of outputs) {
      expect(result.assetId).not.toBe(asset)
      const meta = await (await page.request.get(`/api/assets/${result.assetId}/meta`)).json()
      if (op === 'crop') expect(meta).toMatchObject({ width: 80, height: 90 })
      if (op === 'rotate') expect(meta).toMatchObject({ width: 90, height: 160 })
      if (video) {
        const raw = await (await page.request.get(`/api/assets/${result.assetId}`)).body()
        const probe = JSON.parse(
          execFileSync(
            'ffprobe',
            ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'json', 'pipe:0'],
            { input: raw, encoding: 'utf8' },
          ),
        )
        expect(probe.streams.map((s: { codec_type: string }) => s.codec_type)).toEqual([
          result.kind,
        ])
      }
    }
    const rects = await page.evaluate(
      (ids) => ids.map((id) => window.__plein.engine.doc.worldRect(id)),
      outputs.map((el) => el.id),
    )
    if (video) expect(rects[1]!.x - rects[0]!.x - rects[0]!.w).toBe(16)
    await zoomTo(page, [ids.frame])
    await page.evaluate(() => window.__plein.engine.selection.set([]))
    await page.screenshot({
      path: test.info().outputPath(`grouped-${op}.png`),
      animations: 'disabled',
    })
    await page.keyboard.press('ControlOrMeta+z')
    await expect.poll(async () => (await produced()).length).toBe(0)
    await page.keyboard.press('ControlOrMeta+Shift+z')
    await expect.poll(() => produced()).toEqual(outputs)
    expect(
      await page.evaluate(
        (ids) => ids.map((id) => window.__plein.engine.doc.worldRect(id)),
        outputs.map((el) => el.id),
      ),
    ).toEqual(rects)
    await page.evaluate((id) => window.__plein.engine.selection.set([id]), ids.frame)
    await page.keyboard.press('Shift+ArrowRight')
    await expect
      .poll(() =>
        page.evaluate(
          (ids) => ids.map((id) => window.__plein.engine.doc.worldRect(id)),
          outputs.map((el) => el.id),
        ),
      )
      .toEqual(rects.map((r) => ({ ...r, x: r.x + 10 })))
  })
}
