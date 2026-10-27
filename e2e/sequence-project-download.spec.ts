import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, type Page, test } from './fixtures'
import { centerOf, clickElement, newProject } from './canvas'

let dir = ''
test.beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'plein-project-download-'))
  execFileSync('ffmpeg', [
    '-hide_banner',
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
test.afterAll(() => rmSync(dir, { recursive: true, force: true }))

async function fixture(page: Page) {
  await newProject(page)
  const response = await page.request.post('/api/assets', {
    headers: { 'content-type': 'video/webm', 'x-file-name': 'clip.webm' },
    data: readFileSync(join(dir, 'clip.webm')),
  })
  expect(response.status()).toBe(201)
  const asset = (await response.json()).id as string
  const { id, source } = await page.evaluate((asset) => {
    const source = window.__plein.addNode({
      type: 'plein/video',
      name: '工程已有视频',
      x: -400,
      y: 200,
      params: {},
    })
    ;(
      window.__plein.engine.doc.mutable(source)! as unknown as { set(k: string, v: unknown): void }
    ).set('results', [
      {
        id: 'clip',
        runId: 'fixture',
        port: 'video',
        at: 1,
        value: { type: 'video', assetId: asset },
      },
    ])
    const id = window.__plein.addNode({
      type: 'plein/sequence',
      name: '工程下载恢复',
      x: 400,
      y: 200,
      params: { subtitles: false, aspectRatio: '16:9', resolution: '720p' },
    })
    window.__plein.connect([source, 'video'], [id, 'clips'])
    return { id, source }
  }, asset)
  const open = async () => {
    await clickElement(page, id)
    const at = await centerOf(page, id)
    await page.mouse.dblclick(at.x, at.y)
  }
  await open()
  const editor = page.getByRole('dialog', { name: '序列', exact: true })
  const downloads: string[] = []
  page.on('download', (download) => downloads.push(download.suggestedFilename()))
  return { id, source, asset, editor, open, downloads }
}

for (const mode of ['unavailable', 'not-zip', 'disconnected'] as const) {
  test(`工程 ZIP ${mode} 失败可见且不保存错误页，重试读取实际工程`, async ({ page }) => {
    const f = await fixture(page)
    let blocked = true
    await page.route('**/api/media/sequence-export/*', (route) =>
      blocked && mode === 'disconnected'
        ? route.abort('connectionreset')
        : blocked
          ? route.fulfill(
              mode === 'unavailable'
                ? { status: 503, json: { error: 'unavailable', message: '工程下载暂不可用' } }
                : { status: 200, contentType: 'text/html', body: '<html>upstream error</html>' },
            )
          : route.continue(),
    )
    await f.editor.getByRole('button', { name: '导出工程', exact: true }).click()
    const error = f.editor.getByRole('alert', { name: '工程导出失败', exact: true })
    await expect(error).toContainText(
      mode === 'unavailable' ? '工程下载暂不可用' : mode === 'disconnected' ? '读取中断' : 'ZIP',
    )
    if (mode === 'unavailable') {
      await page.setViewportSize({ width: 390, height: 700 })
      expect(await error.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
      await expect(f.editor.getByRole('button', { name: '关闭', exact: true })).toBeInViewport()
      await f.editor.screenshot({
        path: test.info().outputPath('project-download-error-390.png'),
        animations: 'disabled',
      })
    }
    expect(f.downloads).toEqual([])
    await expect(f.editor.getByRole('button', { name: '导出工程', exact: true })).toBeEnabled()
    blocked = false
    const downloaded = page.waitForEvent('download')
    await f.editor.getByRole('button', { name: '导出工程', exact: true }).click()
    const file = await downloaded
    expect(await file.failure()).toBeNull()
    expect(execFileSync('unzip', ['-t', (await file.path())!], { encoding: 'utf8' })).toContain(
      'No errors detected',
    )
    const listing = execFileSync('unzip', ['-l', (await file.path())!], { encoding: 'utf8' })
    expect(listing).toContain('timeline.otio')
    expect(listing).toContain('timeline.fcpxml')
    expect(listing).toContain('clip.webm')
    await expect(error).toHaveCount(0)
    expect(f.downloads).toHaveLength(1)
    expect(statSync((await file.path())!).size).toBeGreaterThan(0)
  })
}

for (const entry of ['cancel', 'close', 'edit', 'preparing-close'] as const) {
  test(`工程读取等待期间 ${entry} 不发出旧下载，恢复后可下载最新工程`, async ({ page }) => {
    const f = await fixture(page)
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let entered!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    let finished!: () => void
    const settled = new Promise<void>((resolve) => {
      finished = resolve
    })
    let blocked = true
    let preparations = 0
    page.on('request', (request) => {
      if (request.method() === 'POST' && request.url().endsWith('/api/media/sequence-export'))
        preparations++
    })
    const routeURL =
      entry === 'preparing-close'
        ? '**/api/media/sequence-export'
        : '**/api/media/sequence-export/*'
    await page.route(routeURL, async (route) => {
      if (blocked) {
        entered()
        await held
      }
      try {
        await route.continue()
      } catch {
      } finally {
        finished()
      }
    })
    try {
      await f.editor.getByRole('button', { name: '导出工程', exact: true }).evaluate((button) => {
        ;(button as HTMLButtonElement).click()
        ;(button as HTMLButtonElement).click()
      })
      await started
      await expect(
        f.editor.getByRole('button', { name: '正在读取工程…', exact: true }),
      ).toBeDisabled()
      expect(preparations).toBe(1)
      if (entry === 'cancel') {
        await f.editor.getByRole('button', { name: '取消工程导出', exact: true }).click()
        await expect(
          f.editor.getByRole('status').filter({ hasText: '已取消工程文件读取' }),
        ).toBeVisible()
      } else if (entry === 'edit') {
        await f.editor.getByRole('button', { name: '成片', exact: true }).click()
        await f.editor.getByRole('button', { name: '竖屏 9:16', exact: true }).click()
        await expect(
          f.editor.getByRole('alert', { name: '工程导出失败', exact: true }),
        ).toContainText('剪辑内容已变化')
      } else {
        await f.editor.getByRole('button', { name: '关闭', exact: true }).click()
        await expect(f.editor).not.toBeVisible()
      }
      blocked = false
      release()
      await settled
      expect(f.downloads).toEqual([])
      if (entry === 'close' || entry === 'preparing-close') await f.open()
      await expect(f.editor.getByRole('button', { name: '导出工程', exact: true })).toBeEnabled()
      const downloaded = page.waitForEvent('download')
      await f.editor.getByRole('button', { name: '导出工程', exact: true }).click()
      const file = await downloaded
      expect(await file.failure()).toBeNull()
      const path = (await file.path())!
      expect(execFileSync('unzip', ['-t', path], { encoding: 'utf8' })).toContain(
        'No errors detected',
      )
      if (entry === 'edit') {
        const xml = execFileSync('unzip', ['-p', path, '*/timeline.fcpxml'], { encoding: 'utf8' })
        expect(xml).toContain('width="720"')
        expect(xml).toContain('height="1280"')
      }
      expect(f.downloads).toHaveLength(1)
      expect(preparations).toBe(2)
      await expect(
        f.editor.getByRole('status').filter({ hasText: '已交给浏览器下载' }),
      ).toBeVisible()
    } finally {
      release()
    }
  })
}

test('较大真实工程不复制整包 ArrayBuffer，下载 ZIP 和素材 CRC 完整', async ({ page }) => {
  const f = await fixture(page)
  const large = join(dir, 'large-reference.wav')
  execFileSync('ffmpeg', [
    '-hide_banner',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'sine=f=440:d=400',
    '-ac',
    '2',
    '-ar',
    '48000',
    '-c:a',
    'pcm_s16le',
    large,
  ])
  const uploaded = await page.request.post('/api/assets', {
    headers: { 'content-type': 'audio/wav', 'x-file-name': 'large-reference.wav' },
    data: readFileSync(large),
  })
  expect(uploaded.status()).toBe(201)
  const audio = (await uploaded.json()).id as string
  await page.evaluate(
    ({ audio, sequence }) => {
      const source = window.__plein.addNode({
        type: 'plein/speech',
        name: '较大工程配乐',
        x: -400,
        y: 600,
        params: {},
      })
      ;(
        window.__plein.engine.doc.mutable(source)! as unknown as {
          set(k: string, v: unknown): void
        }
      ).set('results', [
        {
          id: 'music',
          runId: 'fixture',
          port: 'audio',
          at: 1,
          value: { type: 'audio', assetId: audio },
        },
      ])
      window.__plein.connect([source, 'audio'], [sequence, 'music'])
      const native = Blob.prototype.arrayBuffer
      Blob.prototype.arrayBuffer = function () {
        if (this.size > 1024 * 1024) throw new Error('不能把整个大工程复制成 ArrayBuffer')
        return native.call(this)
      }
    },
    { audio, sequence: f.id },
  )
  const session = await page.context().newCDPSession(page)
  try {
    await session.send('Network.enable')
    await session.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 0,
      downloadThroughput: 8 * 1024 * 1024,
      uploadThroughput: -1,
    })
    const response = page.waitForResponse(
      (r) => r.request().method() === 'GET' && /\/api\/media\/sequence-export\//.test(r.url()),
    )
    await f.editor.getByRole('button', { name: '导出工程', exact: true }).click()
    const failures: { canceled?: boolean; errorText: string }[] = []
    session.on('Network.loadingFailed', (event) => failures.push(event))
    await response
    await f.editor.getByRole('button', { name: '取消工程导出', exact: true }).click()
    await expect(
      f.editor.getByRole('status').filter({ hasText: '已取消工程文件读取' }),
    ).toBeVisible()
    await expect.poll(() => failures.some((event) => event.canceled)).toBe(true)
    expect(f.downloads).toEqual([])
  } finally {
    await session.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    })
    await session.detach()
  }
  const downloaded = page.waitForEvent('download')
  await f.editor.getByRole('button', { name: '导出工程', exact: true }).click()
  const file = await downloaded
  expect(await file.failure()).toBeNull()
  const path = (await file.path())!
  expect(statSync(path).size).toBeGreaterThan(64 * 1024 * 1024)
  expect(execFileSync('unzip', ['-t', path], { encoding: 'utf8' })).toContain('No errors detected')
  expect(execFileSync('unzip', ['-l', path], { encoding: 'utf8' })).toContain('large-reference.wav')
  await test.info().attach('large-project-bytes.json', {
    body: JSON.stringify({ bytes: statSync(path).size }),
    contentType: 'application/json',
  })
})

for (const mode of ['delayed', 'failed', 'missing-duration', 'cancel', 'close'] as const) {
  test(`工程对白时长 ${mode} 安全等待与恢复，保留同镜头每句声音`, async ({ page }) => {
    const f = await fixture(page)
    const voices: string[] = []
    for (const [name, frequency] of [
      ['first', 440],
      ['second', 880],
    ] as const) {
      const path = join(dir, `${name}.wav`)
      execFileSync('ffmpeg', [
        '-y',
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        `sine=f=${frequency}:d=0.1`,
        path,
      ])
      const uploaded = await page.request.post('/api/assets', {
        headers: { 'content-type': 'audio/wav', 'x-file-name': `${name}.wav` },
        data: readFileSync(path),
      })
      expect(uploaded.status()).toBe(201)
      voices.push((await uploaded.json()).id)
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
    await page.route(`**/api/assets/${voices[0]}/meta`, async (route) => {
      entered()
      await gate
      if (broken)
        await route.fulfill({
          status: 503,
          json: { error: 'unavailable', message: '对白信息暂不可用' },
        })
      else if (mode === 'missing-duration') {
        const response = await route.fetch()
        const data = await response.json()
        delete data.duration
        await route.fulfill({ response, json: data })
      } else await route.continue()
    })
    let submits = 0
    page.on('request', (request) => {
      if (request.method() === 'POST' && request.url().endsWith('/api/media/sequence-export'))
        submits++
    })
    try {
      await page.evaluate(
        ({ voices, sequence, clip }) => {
          const sources = voices.map((assetId, i) => {
            const source = window.__plein.addNode({
              type: 'plein/speech',
              name: `对白 ${i + 1}`,
              x: -400,
              y: 700 + i * 200,
              params: {},
            })
            const node = window.__plein.engine.doc.mutable(source)! as unknown as {
              set(k: string, v: unknown): void
            }
            node.set('results', [
              {
                id: 'voice',
                runId: 'fixture',
                port: 'audio',
                at: 1,
                value: { type: 'audio', assetId },
              },
            ])
            window.__plein.connect([source, 'audio'], [sequence, 'dialogue'])
            return source
          })
          const node = window.__plein.engine.doc.mutable(sequence)! as unknown as {
            get(k: string): { get(k: string): unknown; set(k: string, v: unknown): void }
          }
          const params = node.get('params')
          const instances = params.get('clips') as Array<Record<string, unknown>>
          if (!instances.some((row) => row.source === clip && row.clipInstanceId))
            throw new Error('Expected the actual materialized video instance')
          params.set(
            'clips',
            instances.map((row) =>
              row.source === clip
                ? { ...row, dialogue: sources[0], more: [sources[1]], lineGap: 0 }
                : row,
            ),
          )
        },
        { voices, sequence: f.id, clip: f.source },
      )
      await reading
      await f.editor.getByRole('button', { name: '导出工程', exact: true }).click()
      await expect(
        f.editor.getByRole('button', { name: '取消工程导出', exact: true }),
      ).toBeVisible()
      expect(submits).toBe(0)
      await expect(
        f.editor.getByRole('status').filter({ hasText: '正在读取素材时长' }),
      ).toBeVisible()
      if (mode === 'cancel') {
        await f.editor.getByRole('button', { name: '取消工程导出', exact: true }).click()
        await expect(
          f.editor.getByRole('status').filter({ hasText: '已取消工程文件读取' }),
        ).toBeVisible()
      } else if (mode === 'close') {
        await f.editor.getByRole('button', { name: '关闭', exact: true }).click()
        await expect(f.editor).not.toBeVisible()
      }
      if (mode === 'failed' || mode === 'missing-duration') {
        release()
        await expect(f.editor.getByRole('alert', { name: '工程导出失败' })).toContainText(
          mode === 'failed' ? '对白信息暂不可用' : '缺少有效时长',
        )
        expect(submits).toBe(0)
        expect(f.downloads).toEqual([])
        if (mode === 'missing-duration') {
          await page.setViewportSize({ width: 390, height: 700 })
          await expect(f.editor.getByRole('button', { name: '关闭', exact: true })).toBeInViewport()
          await expect(f.editor.getByRole('alert', { name: '工程导出失败' })).toContainText(
            'first.wav',
          )
          await page.screenshot({ path: test.info().outputPath('missing-duration-390.png') })
          return
        }
        broken = false
      }
      if (mode === 'close') await f.open()
      const downloaded = page.waitForEvent('download')
      if (mode === 'cancel' || mode === 'close' || mode === 'failed')
        await f.editor.getByRole('button', { name: '导出工程', exact: true }).click()
      release()
      const file = await downloaded
      expect(await file.failure()).toBeNull()
      const path = (await file.path())!
      const list = execFileSync('unzip', ['-l', path], { encoding: 'utf8' })
      expect(list).toContain('first.wav')
      expect(list).toContain('second.wav')
      expect(execFileSync('unzip', ['-t', path], { encoding: 'utf8' })).toContain(
        'No errors detected',
      )
      expect(submits).toBe(1)
    } finally {
      release()
    }
  })
}
