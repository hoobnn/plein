import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, type Page, test } from './fixtures'
import { centerOf, clickElement, newProject, waitEngine } from './canvas'

let dir = ''
test.beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'plein-gesture-collaboration-'))
  for (const color of ['red', 'blue'])
    execFileSync('ffmpeg', [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      `color=c=${color}:s=96x64:d=2:r=10`,
      '-c:v',
      'libvpx-vp9',
      '-deadline',
      'realtime',
      join(dir, `${color}.webm`),
    ])
})
test.afterAll(() => rmSync(dir, { recursive: true, force: true }))

async function open(page: Page, id: string) {
  await clickElement(page, id)
  const at = await centerOf(page, id)
  await page.mouse.dblclick(at.x, at.y)
  const editor = page.getByRole('dialog', { name: '序列', exact: true })
  await expect(editor).toHaveCSS('opacity', '1')
  return editor
}

async function videoFixture(page: Page) {
  await newProject(page)
  const assets: string[] = []
  for (const color of ['red', 'blue']) {
    const response = await page.request.post('/api/assets', {
      headers: { 'content-type': 'video/webm', 'x-file-name': `${color}.webm` },
      data: readFileSync(join(dir, `${color}.webm`)),
    })
    expect(response.status()).toBe(201)
    assets.push((await response.json()).id)
  }
  const { id, source } = await page.evaluate((assetId) => {
    const source = window.__plein.addNode({
      type: 'plein/video',
      name: '可替换镜头',
      x: -400,
      y: 200,
      params: {},
    })
    const node = window.__plein.engine.doc.mutable(source)! as unknown as {
      set(k: string, v: unknown): void
    }
    node.set('results', [
      { id: 'ready', runId: 'fixture', port: 'video', at: 1, value: { type: 'video', assetId } },
    ])
    const id = window.__plein.addNode({
      type: 'plein/sequence',
      name: '手势协作',
      x: 400,
      y: 200,
      params: {
        subtitles: false,
        aspectRatio: '16:9',
        resolution: '720p',
        clips: [{ source, in: 0, out: 1.8, subtitle: '原字幕' }],
      },
    })
    window.__plein.connect([source, 'video'], [id, 'clips'])
    return { id, source }
  }, assets[0]!)
  const editor = await open(page, id)
  await expect(editor.locator('.seq-filmstrip > span').first()).toBeVisible()
  const saved = () =>
    page.evaluate(
      (id) =>
        (window.__plein.engine.doc.get(id)!.params!.clips as Array<Record<string, unknown>>)[0]!,
      id,
    )
  return { id, source, assets, editor, saved }
}

test(
  '双端同步更新取消旧修剪，随后可继续修剪并同步',
  { tag: '@core' },
  async ({ page, context }) => {
    const f = await videoFixture(page)
    const peer = await context.newPage()
    try {
      await peer.goto(page.url())
      await waitEngine(peer)
      await expect(peer.getByTestId('sync-status')).toHaveAttribute('data-sync', 'connected')
      const clip = f.editor.locator('.seq-clip').first()
      await clip.hover()
      const handle = (await clip.locator('.seq-trim-out').boundingBox())!
      await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
      await page.mouse.down()
      await page.mouse.move(handle.x - 40, handle.y + handle.height / 2, { steps: 4 })
      await expect(f.editor.locator('[data-trimming]')).toHaveCount(1)
      await peer.evaluate((id) => {
        const doc = window.__plein.engine.doc
        const clips = doc.get(id)!.params!.clips as Array<Record<string, unknown>>
        const params = doc.mutable(id)!.get('params') as { set(k: string, v: unknown): void }
        params.set(
          'clips',
          clips.map((row) => ({ ...row, out: 1.4 })),
        )
      }, f.id)
      await expect.poll(async () => (await f.saved()).out).toBe(1.4)
      await page.mouse.up()
      await expect(f.editor.locator('[data-trimming]')).toHaveCount(0)
      expect((await f.saved()).out).toBe(1.4)
      await clip.hover()
      const current = (await clip.locator('.seq-trim-out').boundingBox())!
      await page.mouse.move(current.x + current.width / 2, current.y + current.height / 2)
      await page.mouse.down()
      await page.mouse.move(current.x - 30, current.y + current.height / 2, { steps: 4 })
      await page.mouse.up()
      await expect.poll(async () => Number((await f.saved()).out)).toBeLessThan(1.4)
      const saved = (await f.saved()).out
      await expect
        .poll(() =>
          peer.evaluate(
            (id) =>
              (
                window.__plein.engine.doc.get(id)!.params!.clips as Array<Record<string, unknown>>
              )[0]!.out,
            f.id,
          ),
        )
        .toBe(saved)
    } finally {
      await peer.close()
    }
  },
)
