import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { centerOf, clickElement, newProject } from './canvas'

let dir = ''
test.beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'plein-preview-recovery-'))
  const ff = (...args: string[]) =>
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args])
  ff('-f', 'lavfi', '-i', 'color=c=red:s=96x64', '-frames:v', '1', join(dir, 'image.png'))
  ff(
    '-f',
    'lavfi',
    '-i',
    'color=c=red:s=96x64:d=3:r=10',
    '-c:v',
    'libvpx-vp9',
    '-deadline',
    'realtime',
    join(dir, 'video.webm'),
  )
  ff('-f', 'lavfi', '-i', 'sine=f=440:d=3', join(dir, 'audio.wav'))
})
test.afterAll(() => rmSync(dir, { recursive: true, force: true }))

for (const kind of ['image', 'video', 'audio', 'audio-decode'] as const) {
  test(`序列 ${kind} 原文件读取失败有提示，重试实际恢复画面或声音`, async ({ page }) => {
    await newProject(page)
    const upload = async (file: string, mime: string) => {
      const response = await page.request.post('/api/assets', {
        headers: { 'content-type': mime, 'x-file-name': file },
        data: readFileSync(join(dir, file)),
      })
      expect(response.status()).toBe(201)
      return (await response.json()).id as string
    }
    const image = await upload('image.png', 'image/png')
    const bad =
      kind === 'image'
        ? image
        : kind === 'video'
          ? await upload('video.webm', 'video/webm')
          : await upload('audio.wav', 'audio/wav')
    let blocked = true
    let reads = 0
    await page.route(`**/api/assets/${bad}`, (route) => {
      reads++
      return blocked
        ? route.fulfill({
            status: kind === 'audio-decode' ? 200 : 503,
            body: 'temporarily unavailable',
          })
        : route.continue()
    })
    await page.evaluate(() => {
      const start = AudioBufferSourceNode.prototype.start
      AudioBufferSourceNode.prototype.start = function (...args: Parameters<typeof start>) {
        document.body.dataset.previewSoundStarts = String(
          Number(document.body.dataset.previewSoundStarts ?? 0) + 1,
        )
        return start.apply(this, args)
      }
    })
    const id = await page.evaluate(
      ({ image, bad, kind }) => {
        if (kind !== 'video')
          return window.__plein.addNode({
            type: 'plein/animatic',
            name: '样片读取恢复',
            x: 400,
            y: 200,
            params: {
              subtitles: false,
              shots: [
                {
                  shotId: 'load-test',
                  imageAssetId: image,
                  duration: 3,
                  dialogue: kind.startsWith('audio')
                    ? [{ source: 'test-line', assetId: bad, caption: '测试声音' }]
                    : [],
                },
              ],
            },
          })
        const source = window.__plein.addNode({
          type: 'plein/video',
          name: '已有视频',
          x: -500,
          y: 200,
          params: {},
        })
        ;(
          window.__plein.engine.doc.mutable(source) as unknown as {
            set(key: string, value: unknown): void
          }
        ).set('results', [
          {
            id: 'test-result',
            port: 'video',
            runId: 'uploaded',
            at: Date.now(),
            value: { type: 'video', assetId: bad },
          },
        ])
        const seq = window.__plein.addNode({
          type: 'plein/sequence',
          name: '视频读取恢复',
          x: 400,
          y: 200,
          params: { subtitles: false, clipVolume: 0 },
        })
        window.__plein.connect([source, 'video'], [seq, 'clips'])
        return seq
      },
      { image, bad, kind },
    )
    await clickElement(page, id)
    const at = await centerOf(page, id)
    await page.mouse.dblclick(at.x, at.y)
    const editor = page.getByRole('dialog', { name: '序列', exact: true })
    const monitor = editor.locator('.seq-monitor')
    if (kind.startsWith('audio'))
      await monitor.getByRole('button', { name: '播放', exact: true }).click()
    await expect(monitor.getByRole('alert')).toContainText('预览素材读取失败')
    await expect(monitor.getByRole('button', { name: '播放', exact: true })).toBeVisible()
    await expect(editor).toHaveCSS('opacity', '1')
    if (kind === 'image')
      await page.screenshot({ path: 'test-results/sequence-preview-load-error.png' })
    if (kind.startsWith('audio')) {
      // 模拟上游分镜移除配音后再恢复；编辑器保持打开，预览引擎不能重建。
      const shots = await page.evaluate(
        (id) => window.__plein.engine.doc.get(id)!.params!.shots,
        id,
      )
      await page.evaluate((id) => {
        const doc = window.__plein.engine.doc
        const shots = doc.get(id)!.params!.shots as Array<Record<string, unknown>>
        const params = doc.mutable(id)!.get('params') as { set(key: string, value: unknown): void }
        params.set(
          'shots',
          shots.map((shot) => ({ ...shot, dialogue: [] })),
        )
      }, id)
      await expect(monitor.getByRole('alert')).toHaveCount(0)
      await page.evaluate(
        ({ id, shots }) => {
          const params = window.__plein.engine.doc.mutable(id)!.get('params') as {
            set(key: string, value: unknown): void
          }
          params.set('shots', shots)
        },
        { id, shots },
      )
      const beforeRestore = reads
      await monitor.getByRole('button', { name: '播放', exact: true }).click()
      await expect.poll(() => reads).toBeGreaterThan(beforeRestore)
      await expect(monitor.getByRole('alert')).toContainText('预览素材读取失败')
      await expect(monitor.getByRole('button', { name: '播放', exact: true })).toBeVisible()
    }
    const time = await monitor.locator('.seq-time').innerText()
    const before = reads
    blocked = false
    await monitor.getByRole('button', { name: '重试失败素材', exact: true }).click()
    await expect.poll(() => reads).toBeGreaterThan(before)
    await expect(monitor.getByRole('alert')).toHaveCount(0)
    await expect(monitor.locator('.seq-time')).toHaveText(time)
    if (kind.startsWith('audio')) {
      await monitor.getByRole('button', { name: '播放', exact: true }).click()
      await expect
        .poll(() => page.evaluate(() => Number(document.body.dataset.previewSoundStarts ?? 0)))
        .toBeGreaterThan(0)
    } else
      await expect
        .poll(() =>
          monitor
            .locator('canvas')
            .first()
            .evaluate((canvas: HTMLCanvasElement) => {
              const pixel = canvas
                .getContext('2d')!
                .getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data
              return pixel[0]! > 150 && pixel[1]! < 80 && pixel[2]! < 80
            }),
        )
        .toBe(true)
  })
}

test('移除并恢复读取中的配音后，旧失败不暂停已恢复的预览', async ({ page }) => {
  await newProject(page)
  const upload = async (file: string, mime: string) => {
    const response = await page.request.post('/api/assets', {
      headers: { 'content-type': mime, 'x-file-name': file },
      data: readFileSync(join(dir, file)),
    })
    expect(response.status()).toBe(201)
    return (await response.json()).id as string
  }
  const image = await upload('image.png', 'image/png')
  const audio = await upload('audio.wav', 'audio/wav')
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let reads = 0
  await page.route(`**/api/assets/${audio}`, async (route) => {
    if (++reads !== 1) return route.continue()
    await gate
    await route.fulfill({ status: 503, body: 'old failed request' })
  })
  await page.evaluate((audio) => {
    const start = AudioBufferSourceNode.prototype.start
    AudioBufferSourceNode.prototype.start = function (...args: Parameters<typeof start>) {
      document.body.dataset.previewSoundStarts = String(
        Number(document.body.dataset.previewSoundStarts ?? 0) + 1,
      )
      return start.apply(this, args)
    }
    const original = window.fetch
    window.fetch = async (...args) => {
      const response = await original(...args)
      if (response.url.endsWith(`/api/assets/${audio}`) && response.status === 503)
        setTimeout(() => {
          document.body.dataset.oldSoundSettled = 'true'
        }, 0)
      return response
    }
  }, audio)
  const id = await page.evaluate(
    ({ image, audio }) =>
      window.__plein.addNode({
        type: 'plein/animatic',
        name: '迟到配音错误',
        x: 400,
        y: 200,
        params: {
          subtitles: false,
          shots: [
            {
              shotId: 'late',
              imageAssetId: image,
              duration: 30,
              dialogue: [{ source: 'line', assetId: audio, caption: '测试声音' }],
            },
          ],
        },
      }),
    { image, audio },
  )
  await clickElement(page, id)
  const at = await centerOf(page, id)
  await page.mouse.dblclick(at.x, at.y)
  const monitor = page.getByRole('dialog', { name: '序列', exact: true }).locator('.seq-monitor')
  try {
    await monitor.getByRole('button', { name: '播放', exact: true }).click()
    await expect.poll(() => reads).toBe(1)
    const shots = await page.evaluate((id) => window.__plein.engine.doc.get(id)!.params!.shots, id)
    await page.evaluate((id) => {
      const doc = window.__plein.engine.doc
      const shots = doc.get(id)!.params!.shots as Array<Record<string, unknown>>
      const params = doc.mutable(id)!.get('params') as { set(key: string, value: unknown): void }
      params.set(
        'shots',
        shots.map((shot) => ({ ...shot, dialogue: [] })),
      )
    }, id)
    // 让 React 提交移除后的 scene，而非同一帧内合并两次上游变更。
    await expect(monitor.getByRole('alert')).toHaveCount(0)
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    )
    await page.evaluate(
      ({ id, shots }) => {
        const params = window.__plein.engine.doc.mutable(id)!.get('params') as {
          set(key: string, value: unknown): void
        }
        params.set('shots', shots)
      },
      { id, shots },
    )
    await expect.poll(() => reads).toBe(2)
    await expect
      .poll(() => page.evaluate(() => Number(document.body.dataset.previewSoundStarts ?? 0)))
      .toBeGreaterThan(0)
    release()
    await page.waitForFunction(() => document.body.dataset.oldSoundSettled === 'true')
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    )
    expect(await monitor.getByRole('alert').count()).toBe(0)
    await expect(monitor.getByRole('button', { name: '暂停', exact: true })).toBeVisible()
  } finally {
    release()
  }
})
