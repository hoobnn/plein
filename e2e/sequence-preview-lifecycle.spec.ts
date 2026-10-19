import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import { centerOf, clickElement, elements, newProject } from './canvas'

let dir = ''
test.beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'plein-preview-lifecycle-'))
  const ff = (...args: string[]) =>
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args])
  for (const color of ['red', 'blue'])
    ff('-f', 'lavfi', '-i', `color=c=${color}:s=96x64`, '-frames:v', '1', join(dir, `${color}.png`))
  ff('-f', 'lavfi', '-i', 'sine=f=440:d=3', join(dir, 'audio.wav'))
  ff(
    '-f',
    'lavfi',
    '-i',
    'color=c=red:s=96x64:d=3:r=8',
    '-c:v',
    'libvpx-vp9',
    '-deadline',
    'realtime',
    join(dir, 'video.webm'),
  )
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

async function setup(page: Page, reply: 'success' | 'error') {
  await newProject(page)
  const upload = async (file: string, mime: string) => {
    const response = await page.request.post('/api/assets', {
      headers: { 'content-type': mime, 'x-file-name': file },
      data: readFileSync(join(dir, file)),
    })
    expect(response.status()).toBe(201)
    return (await response.json()).id as string
  }
  const red = await upload('red.png', 'image/png')
  const blue = await upload('blue.png', 'image/png')
  const audio = await upload('audio.wav', 'audio/wav')
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let reads = 0
  await page.route(`**/api/assets/${audio}`, async (route) => {
    if (++reads > 1) return route.continue()
    await gate
    return reply === 'success'
      ? route.fulfill({
          status: 200,
          contentType: 'audio/wav',
          headers: { 'x-preview-old': 'true' },
          body: readFileSync(join(dir, 'audio.wav')),
        })
      : route.fulfill({ status: 503, body: 'old request failed' })
  })
  await page.evaluate((audio) => {
    const oldBuffers = new WeakSet<ArrayBuffer>()
    const start = AudioBufferSourceNode.prototype.start
    AudioBufferSourceNode.prototype.start = function (...args: Parameters<typeof start>) {
      document.body.dataset.soundStarts = String(Number(document.body.dataset.soundStarts ?? 0) + 1)
      return start.apply(this, args)
    }
    const stop = AudioBufferSourceNode.prototype.stop
    AudioBufferSourceNode.prototype.stop = function (...args: Parameters<typeof stop>) {
      if ((args[0] ?? 0) <= this.context.currentTime)
        document.body.dataset.immediateStops = String(
          Number(document.body.dataset.immediateStops ?? 0) + 1,
        )
      return stop.apply(this, args)
    }
    const decode = BaseAudioContext.prototype.decodeAudioData
    BaseAudioContext.prototype.decodeAudioData = async function (buffer) {
      try {
        return await decode.call(this, buffer)
      } finally {
        if (oldBuffers.has(buffer))
          setTimeout(() => {
            document.body.dataset.oldDecoded = 'true'
          }, 0)
      }
    }
    const original = window.fetch
    window.fetch = async (...args) => {
      const response = await original(...args)
      if (response.headers.get('x-preview-old') === 'true') {
        const read = response.arrayBuffer.bind(response)
        response.arrayBuffer = async () => {
          const buffer = await read()
          oldBuffers.add(buffer)
          return buffer
        }
      }
      if (response.url.endsWith(`/api/assets/${audio}`) && response.status === 503)
        setTimeout(() => {
          document.body.dataset.oldFailed = 'true'
        }, 0)
      return response
    }
  }, audio)
  const ids = await page.evaluate(
    ({ red, blue, audio }) =>
      [red, blue].map((image, i) =>
        window.__plein.addNode({
          type: 'plein/animatic',
          name: i === 0 ? '旧序列' : '新序列',
          x: 400 + i * 700,
          y: 200,
          params: {
            subtitles: false,
            shots: [
              {
                shotId: `shot-${i}`,
                imageAssetId: image,
                duration: 30,
                dialogue: i === 0 ? [{ source: 'line', assetId: audio, caption: '迟到声音' }] : [],
              },
            ],
          },
        }),
      ),
    { red, blue, audio },
  )
  const editor = await open(page, ids[0]!)
  await editor.locator('.seq-monitor').getByRole('button', { name: '播放', exact: true }).click()
  await expect.poll(() => reads).toBe(1)
  return { ids, editor, release }
}

test('关闭预览后，退场期间才解码完成的旧配音不再开始播放', async ({ page }) => {
  const { editor, release } = await setup(page, 'success')
  try {
    await editor.getByRole('button', { name: '关闭', exact: true }).click()
    release()
    await page.waitForFunction(() => document.body.dataset.oldDecoded === 'true')
    expect(await page.evaluate(() => Number(document.body.dataset.soundStarts ?? 0))).toBe(0)
    await expect(editor).toBeHidden()
  } finally {
    release()
  }
})

test('关闭正在播放的预览时立即停止已有声音', async ({ page }) => {
  const { editor, release } = await setup(page, 'success')
  try {
    release()
    await expect
      .poll(() => page.evaluate(() => Number(document.body.dataset.soundStarts ?? 0)))
      .toBeGreaterThan(0)
    const before = await page.evaluate(() => Number(document.body.dataset.immediateStops ?? 0))
    await editor.getByRole('button', { name: '关闭', exact: true }).click()
    // 即时检查；等待退场动画后再检查会让旧实现也通过。
    expect(
      await page.evaluate(() => Number(document.body.dataset.immediateStops ?? 0)),
    ).toBeGreaterThan(before)
    await expect(editor).toBeHidden()
  } finally {
    release()
  }
})

test('切到成片回看立即停止旧预览，返回编辑时保持暂停且可重新播放', async ({ page }) => {
  const { editor, release } = await setup(page, 'success')
  try {
    await editor.getByRole('button', { name: '实际 MP4 回看 / 交付', exact: true }).click()
    await expect(editor.locator('.seq-monitor')).toHaveCount(0)
    release()
    await page.waitForFunction(() => document.body.dataset.oldDecoded === 'true')
    expect(await page.evaluate(() => Number(document.body.dataset.soundStarts ?? 0))).toBe(0)
    await editor.getByRole('button', { name: '样片编辑预览', exact: true }).click()
    const monitor = editor.locator('.seq-monitor')
    await expect(monitor.getByRole('button', { name: '播放', exact: true })).toBeVisible()
    expect(await monitor.getByRole('alert').count()).toBe(0)
    await monitor.getByRole('button', { name: '播放', exact: true }).click()
    await expect
      .poll(() => page.evaluate(() => Number(document.body.dataset.soundStarts ?? 0)))
      .toBeGreaterThan(0)
  } finally {
    release()
  }
})

for (const action of ['switch', 'reopen'] as const) {
  for (const reply of ['success', 'error'] as const) {
    test(`${action} 预览后旧配音 ${reply} 不影响当前画面与播放`, async ({ page }) => {
      const { ids, editor, release } = await setup(page, reply)
      try {
        await editor.getByRole('button', { name: '关闭', exact: true }).click()
        await expect(editor).toBeHidden()
        const current = await open(page, ids[action === 'switch' ? 1 : 0]!)
        const monitor = current.locator('.seq-monitor')
        const pixel = () =>
          monitor.locator('.seq-stage > canvas').evaluate((canvas: HTMLCanvasElement) => {
            const p = canvas
              .getContext('2d')!
              .getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data
            return p[0]! > 150 && p[2]! < 80 ? 'red' : p[2]! > 150 && p[0]! < 80 ? 'blue' : 'other'
          })
        await expect.poll(pixel).toBe(action === 'switch' ? 'blue' : 'red')
        await expect(monitor.getByRole('button', { name: '播放', exact: true })).toBeVisible()
        await monitor.getByRole('button', { name: '播放', exact: true }).click()
        if (action === 'reopen')
          await expect
            .poll(() => page.evaluate(() => Number(document.body.dataset.soundStarts ?? 0)))
            .toBeGreaterThan(0)
        const starts = await page.evaluate(() => Number(document.body.dataset.soundStarts ?? 0))
        release()
        await page.waitForFunction(
          (reply) =>
            reply === 'success'
              ? document.body.dataset.oldDecoded === 'true'
              : document.body.dataset.oldFailed === 'true',
          reply,
        )
        await page.evaluate(
          () =>
            new Promise<void>((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
            ),
        )
        expect(await monitor.getByRole('alert').count()).toBe(0)
        expect(await page.evaluate(() => Number(document.body.dataset.soundStarts ?? 0))).toBe(
          starts,
        )
        await expect(monitor.getByRole('button', { name: '暂停', exact: true })).toBeVisible()
        expect(await pixel()).toBe(action === 'switch' ? 'blue' : 'red')
        await current.screenshot({ path: test.info().outputPath(`${action}-${reply}.png`) })
      } finally {
        release()
      }
    })
  }
}

for (const action of ['reopen', 'resize'] as const) {
  test(`视频初始化等待中 ${action}，旧解码迟到结束不再降级或干扰新画面`, async ({ page }) => {
    const warnings: string[] = []
    const errors: string[] = []
    page.on('console', (message) => {
      if (message.type() === 'warning' && message.text().includes('WebCodecs 解码不可用'))
        warnings.push(message.text())
    })
    page.on('pageerror', (error) => errors.push(error.message))
    await newProject(page)
    const chooser = page.waitForEvent('filechooser')
    await page.getByRole('button', { name: '上传', exact: true }).click()
    await (await chooser).setFiles(join(dir, 'video.webm'))
    await expect
      .poll(async () => (await elements(page)).filter((e) => e.kind === 'video').length)
      .toBe(1)
    const video = (await elements(page)).find((e) => e.kind === 'video')!
    const asset = await page.evaluate((id) => window.__plein.engine.doc.get(id)!.assetId!, video.id)
    await page.evaluate((asset) => {
      const original = window.fetch.bind(window)
      let release!: () => void
      let blocked = true
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      window.addEventListener(
        'allow-new-video',
        () => {
          blocked = false
        },
        { once: true },
      )
      window.addEventListener('release-old-video', () => release(), { once: true })
      window.fetch = async (...args) => {
        const url = args[0] instanceof Request ? args[0].url : String(args[0])
        if (!blocked || new URL(url, location.href).pathname !== `/api/assets/${asset}`)
          return original(...args)
        document.body.dataset.oldVideoReads = String(
          Number(document.body.dataset.oldVideoReads ?? 0) + 1,
        )
        try {
          await gate
          return await original(...args)
        } finally {
          document.body.dataset.oldVideoSettled = String(
            Number(document.body.dataset.oldVideoSettled ?? 0) + 1,
          )
        }
      }
    }, asset)
    const id = await page.evaluate((source) => {
      const id = window.__plein.addNode({
        type: 'plein/sequence',
        name: '视频解码关闭重开',
        x: 3000,
        y: 1000,
        params: { subtitles: false, aspectRatio: '16:9' },
      })
      window.__plein.connect([source, 'video'], [id, 'clips'])
      return id
    }, video.id)
    try {
      let editor = await open(page, id)
      await expect
        .poll(() => page.evaluate(() => Number(document.body.dataset.oldVideoReads ?? 0)))
        .toBeGreaterThan(0)
      await page.evaluate(() => window.dispatchEvent(new Event('allow-new-video')))
      if (action === 'reopen') {
        await editor.getByRole('button', { name: '关闭', exact: true }).click()
        await expect(editor).toHaveCount(0)
        editor = await open(page, id)
      } else {
        await editor.getByRole('button', { name: '成片', exact: true }).click()
        await editor.getByRole('button', { name: '竖屏 9:16', exact: true }).click()
      }
      const canvas = editor.locator('.seq-stage > canvas')
      const red = () =>
        canvas.evaluate((canvas: HTMLCanvasElement) => {
          const p = canvas
            .getContext('2d')!
            .getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data
          return p[0]! > 150 && p[2]! < 80
        })
      await expect.poll(red).toBe(true)
      await expect(canvas).toHaveAttribute('data-decoder', 'webcodecs')
      await page.evaluate(() => window.dispatchEvent(new Event('release-old-video')))
      await expect
        .poll(() => page.evaluate(() => Number(document.body.dataset.oldVideoSettled ?? 0)))
        .toBeGreaterThan(0)
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      )
      expect(warnings).toEqual([])
      expect(errors).toEqual([])
      await expect(editor.locator('.seq-monitor').getByRole('alert')).toHaveCount(0)
      expect(await red()).toBe(true)
    } finally {
      await page.evaluate(() => window.dispatchEvent(new Event('release-old-video')))
    }
  })
}
