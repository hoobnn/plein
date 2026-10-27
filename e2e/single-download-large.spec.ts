import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { expect, test, type Download } from './fixtures'
import { sineWav, solidPng } from '../packages/providers/src/mock/media'
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

test(
  '下载原文件：较大视频与多选分组里的素材，保存字节都与原素材一致',
  { tag: '@core' },
  async ({ page }) => {
    await newProject(page)
    expect(bytes.length).toBeGreaterThan(16 * 1024 * 1024)
    const files = [
      { name: '较大视频.mp4', mime: 'video/mp4', bytes },
      {
        name: '下载红杯',
        mime: 'image/png',
        bytes: Buffer.from(solidPng(64, 48, [200, 20, 20])),
      },
      {
        name: '下载蓝杯',
        mime: 'image/png',
        bytes: Buffer.from(solidPng(64, 48, [20, 20, 200])),
      },
      { name: '下载提示音', mime: 'audio/wav', bytes: Buffer.from(sineWav(0.2)) },
    ]
    const assets: string[] = []
    for (const file of files) {
      const response = await page.request.post('/api/assets', {
        headers: { 'Content-Type': file.mime },
        data: file.bytes,
      })
      expect(response.status()).toBe(201)
      assets.push(((await response.json()) as { id: string }).id)
    }
    await page.evaluate((assets) => {
      const engine = window.__plein.engine as typeof window.__plein.engine & {
        paste(data: unknown): void
      }
      const base = { rotation: 0, locked: false, x: 0, y: 0, w: 200, h: 150, parentId: null }
      engine.paste({
        plein: 1,
        edges: [],
        elements: [
          {
            ...base,
            id: 'large',
            name: '较大视频.mp4',
            kind: 'video',
            assetId: assets[0],
            x: 400,
            y: 300,
            w: 320,
            h: 180,
          },
          { ...base, id: 'frame', kind: 'frame', name: '下载分组', w: 500, h: 250 },
          {
            ...base,
            id: 'red',
            kind: 'image',
            name: '下载红杯',
            assetId: assets[1],
            parentId: 'frame',
          },
          {
            ...base,
            id: 'blue',
            kind: 'image',
            name: '下载蓝杯',
            assetId: assets[2],
            parentId: 'frame',
            x: 240,
          },
          // 同一个素材再放一次：显式选中也要各下载一份
          { ...base, id: 'duplicate', kind: 'image', name: '红杯副本', assetId: assets[1], x: 600 },
          { ...base, id: 'audio', kind: 'audio', name: '下载提示音', assetId: assets[3], x: 850 },
        ],
      })
      const all = [...engine.doc.elements()]
      const ids = ['较大视频.mp4', '下载分组', '下载红杯', '红杯副本', '下载提示音'].map(
        (name) => all.find((el) => el.name === name)!.id,
      )
      engine.selection.set(ids)
      engine.zoomToFit(ids)
    }, assets)

    const downloads: Download[] = []
    page.on('download', (download) => downloads.push(download))
    const bar = page.getByRole('toolbar', { name: '多选操作', exact: true })
    await bar.getByRole('button', { name: '下载（5）', exact: true }).click()
    await expect.poll(() => downloads.length).toBe(5)

    const expected = new Map<string, Buffer>([
      ['较大视频.mp4', bytes],
      ['下载红杯', files[1]!.bytes],
      ['下载蓝杯', files[2]!.bytes],
      ['红杯副本', files[1]!.bytes],
      ['下载提示音', files[3]!.bytes],
    ])
    const names: string[] = []
    for (const download of downloads) {
      expect(await download.failure()).toBeNull()
      const name = [...expected.keys()].find((key) => download.suggestedFilename().startsWith(key))
      expect(name).toBeTruthy()
      names.push(name!)
      const downloaded = readFileSync((await download.path())!)
      expect(downloaded.length).toBe(expected.get(name!)!.length)
      expect(createHash('sha256').update(downloaded).digest('hex')).toBe(
        createHash('sha256').update(expected.get(name!)!).digest('hex'),
      )
    }
    // 分组里的素材与显式选中的重复素材各下载一份，不多也不少
    expect(names.sort()).toEqual([...expected.keys()].sort())
    await expect(page.locator('.ui-toast')).toContainText('已交给浏览器下载 5 个文件')
  },
)
