import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { centerOf, clickElement, newProject } from './canvas'

let dir = ''
test.beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'plein-metadata-recovery-'))
  execFileSync('ffmpeg', [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=c=blue:s=96x64:d=0.6:r=10',
    '-c:v',
    'libvpx-vp9',
    '-deadline',
    'realtime',
    join(dir, 'clip.webm'),
  ])
})
test.beforeAll(() => {
  execFileSync('ffmpeg', [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=c=red:s=96x64:d=0.6:r=10',
    '-c:v',
    'libvpx-vp9',
    '-deadline',
    'realtime',
    join(dir, 'replacement.webm'),
  ])
})
test.afterAll(() => rmSync(dir, { recursive: true, force: true }))

for (const entry of ['header', 'inline', 'readonly', 'replacement'] as const) {
  test(`素材信息 ${entry} 失败恢复，保留剪辑并恢复时间线与工程导出`, async ({ page }) => {
    await newProject(page)
    const uploaded = await page.request.post('/api/assets', {
      headers: { 'content-type': 'video/webm', 'x-file-name': 'metadata-recovery.webm' },
      data: readFileSync(join(dir, 'clip.webm')),
    })
    expect(uploaded.status()).toBe(201)
    const asset = (await uploaded.json()).id as string
    let broken = true
    let reads = 0
    await page.route(`**/api/assets/${asset}/meta`, (route) => {
      reads++
      return broken
        ? route.fulfill({
            status: 503,
            json: { error: 'unavailable', message: '素材信息暂不可用' },
          })
        : route.continue()
    })
    const { id, video } = await page.evaluate((asset) => {
      const video = window.__plein.addNode({
        type: 'plein/video',
        name: '恢复时长的视频',
        x: -400,
        y: 200,
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
          value: { type: 'video', assetId: asset },
        },
      ])
      const sequence = window.__plein.addNode({
        type: 'plein/sequence',
        name: '元信息恢复',
        x: 400,
        y: 200,
        params: { subtitles: false, aspectRatio: '16:9', resolution: '720p' },
      })
      window.__plein.connect([video, 'video'], [sequence, 'clips'])
      return { id: sequence, video }
    }, asset)
    await clickElement(page, id)
    const at = await centerOf(page, id)
    await page.mouse.dblclick(at.x, at.y)
    const editor = page.getByRole('dialog', { name: '序列', exact: true })
    await expect(editor).toHaveCSS('opacity', '1')
    await expect.poll(() => reads).toBeGreaterThan(0)
    await expect(editor.getByRole('button', { name: '导出工程', exact: true })).toBeDisabled()
    const error = editor.getByRole('alert', { name: '素材信息读取失败', exact: true })
    await expect(error).toContainText('素材信息暂不可用')
    const original = await page.evaluate((id) => window.__plein.engine.doc.get(id)?.params, id)
    if (entry !== 'header') {
      await page.setViewportSize({ width: 390, height: 700 })
      await expect(
        editor.getByRole('button', { name: '重试素材信息', exact: true }),
      ).toBeInViewport()
      expect(await error.evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true)
      await page.screenshot({ path: test.info().outputPath(`metadata-error-${entry}-390.png`) })
      await editor.getByRole('button', { name: '重试素材信息', exact: true }).click()
      await expect(error).toContainText('素材信息暂不可用')
    }
    if (entry === 'readonly') {
      await page.evaluate(() => {
        const doc = window.__plein.engine.doc as typeof window.__plein.engine.doc & {
          readOnly: boolean
        }
        doc.readOnly = true
      })
    }
    if (entry === 'replacement') {
      const response = await page.request.post('/api/assets', {
        headers: { 'content-type': 'video/webm', 'x-file-name': 'replacement.webm' },
        data: readFileSync(join(dir, 'replacement.webm')),
      })
      expect(response.status()).toBe(201)
      const replacement = (await response.json()).id as string
      expect(replacement).not.toBe(asset)
      await page.evaluate(
        ({ video, replacement }) => {
          const node = window.__plein.engine.doc.mutable(video)! as unknown as {
            set(k: string, v: unknown): void
          }
          node.set('results', [
            {
              id: 'new',
              runId: 'fixture',
              port: 'video',
              at: 2,
              value: { type: 'video', assetId: replacement },
            },
          ])
        },
        { video, replacement },
      )
    } else {
      broken = false
      const before = reads
      const retry = editor.getByRole('button', {
        name: entry === 'header' ? '重新加载预览' : '重试素材信息',
        exact: true,
      })
      await retry.focus()
      await page.keyboard.press('Enter')
      await expect.poll(() => reads).toBeGreaterThan(before)
    }
    await expect(editor.getByRole('button', { name: '导出工程', exact: true })).toBeEnabled()
    await expect(editor.locator('.ui-chip').first()).toContainText('0.6 秒')
    await expect(error).toBeHidden()
    expect(await page.evaluate((id) => window.__plein.engine.doc.get(id)?.params, id)).toEqual(
      original,
    )
    const readyReads = reads
    await editor.getByRole('button', { name: '重新加载预览', exact: true }).click()
    expect(reads).toBe(readyReads)
    const downloaded = page.waitForEvent('download')
    await editor.getByRole('button', { name: '导出工程', exact: true }).click()
    const file = await downloaded
    expect(await file.failure()).toBeNull()
    if (entry === 'replacement')
      expect(execFileSync('unzip', ['-l', (await file.path())!], { encoding: 'utf8' })).toContain(
        'replacement.webm',
      )
    expect(execFileSync('unzip', ['-t', (await file.path())!], { encoding: 'utf8' })).toContain(
      'No errors detected',
    )
  })
}
