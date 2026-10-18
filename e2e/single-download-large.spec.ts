import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { newProject } from './canvas'

let dir = ''
let bytes: Buffer
test.beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'plein-large-download-'))
  const path = join(dir, 'reference.mp4')
  execFileSync('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=1280x720:rate=24:duration=16',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-crf',
    '0',
    '-pix_fmt',
    'yuv420p',
    path,
  ])
  bytes = readFileSync(path)
})
test.afterAll(() => rmSync(dir, { recursive: true, force: true }))

test('较大视频读取完成后交给浏览器，保存字节与原视频一致', async ({ page }) => {
  await newProject(page)
  expect(bytes.length).toBeGreaterThan(16 * 1024 * 1024)
  const uploaded = await page.request.post('/api/assets', {
    headers: { 'Content-Type': 'video/mp4' },
    data: bytes,
  })
  expect(uploaded.status()).toBe(201)
  const assetId = (await uploaded.json()).id as string
  await page.evaluate((assetId) => {
    const engine = window.__plein.engine as typeof window.__plein.engine & {
      paste(data: unknown): void
    }
    engine.paste({
      plein: 1,
      edges: [],
      elements: [
        {
          id: 'large',
          name: '较大视频.mp4',
          kind: 'video',
          assetId,
          x: 400,
          y: 300,
          w: 320,
          h: 180,
          rotation: 0,
          locked: false,
          parentId: null,
        },
      ],
    })
    const ids = [...engine.doc.elements()].map((el) => el.id)
    engine.selection.set(ids)
    engine.zoomToFit(ids)
  }, assetId)
  const bar = page.getByRole('toolbar', { name: '结果操作', exact: true })
  const download = page.waitForEvent('download')
  await bar.getByRole('button', { name: '下载', exact: true }).click()
  const file = await download
  expect(await file.failure()).toBeNull()
  const downloaded = readFileSync((await file.path())!)
  await test.info().attach('video-download-size.json', {
    body: JSON.stringify({ bytes: bytes.length, downloaded: downloaded.length, assetId }),
    contentType: 'application/json',
  })
  expect(downloaded.length).toBe(bytes.length)
  expect(createHash('sha256').update(downloaded).digest('hex')).toBe(assetId)
  await expect(bar.getByRole('button', { name: '下载', exact: true })).toBeEnabled()
  await expect(page.locator('.ui-toast')).toContainText('已交给浏览器下载 1 个文件')
  await page.screenshot({
    path: test.info().outputPath('large-video-download.png'),
    animations: 'disabled',
  })
})
