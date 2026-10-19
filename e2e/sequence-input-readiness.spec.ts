import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { centerOf, clickElement, newProject, waitNode } from './canvas'

let dir = ''
test.beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'plein-sequence-inputs-'))
  execFileSync('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=c=blue:s=96x64:d=0.6:r=10',
    '-c:v',
    'libvpx-vp9',
    '-deadline',
    'realtime',
    join(dir, 'ready-video.webm'),
  ])
  execFileSync('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'sine=f=440:d=0.5',
    join(dir, 'ready-audio.wav'),
  ])
})
test.afterAll(() => rmSync(dir, { recursive: true, force: true }))

for (const port of ['dialogue', 'sfx', 'music'] as const) {
  test(`${port} 缺结果、待采用或缺输出时说明原因，修正后导出完整工程和成片`, async ({ page }) => {
    if (port === 'music') await page.setViewportSize({ width: 800, height: 560 })
    await newProject(page)
    const upload = async (name: string, mime: string) => {
      const response = await page.request.post('/api/assets', {
        headers: {
          'content-type': mime,
          'x-file-name': name,
        },
        data: readFileSync(join(dir, name)),
      })
      expect(response.status()).toBe(201)
      return (await response.json()).id as string
    }
    const video = await upload('ready-video.webm', 'video/webm')
    const audio = await upload('ready-audio.wav', 'audio/wav')
    const sourceName = port === 'music' ? `待确认声音${'Reference'.repeat(8)}` : '待确认声音'
    const { seq, source } = await page.evaluate(
      ({ video, port, sourceName }) => {
        const videoNode = window.__plein.addNode({
          type: 'plein/video',
          name: '已完成镜头',
          params: {},
          x: -500,
          y: 0,
        })
        const mutable = window.__plein.engine.doc.mutable(videoNode) as unknown as {
          set(k: string, v: unknown): void
        }
        mutable.set('results', [
          {
            id: 'video-ready',
            runId: 'fixture',
            at: 1,
            port: 'video',
            value: { type: 'video', assetId: video },
          },
        ])
        const source = window.__plein.addNode({
          type: 'plein/speech',
          name: sourceName,
          params: {},
          x: -500,
          y: 300,
        })
        const seq = window.__plein.addNode({
          type: 'plein/sequence',
          name: '输入就绪序列',
          x: 400,
          y: 200,
          params: { resolution: '720p', aspectRatio: '16:9', subtitles: false, loudnorm: false },
        })
        window.__plein.connect([videoNode, 'video'], [seq, 'clips'])
        window.__plein.connect([source, 'audio'], [seq, port])
        return { seq, source }
      },
      { video, port, sourceName },
    )
    let submits = 0
    page.on('request', (request) => {
      if (request.method() === 'POST' && /\/nodes\/[^/]+\/run$/.test(request.url())) submits++
    })
    await clickElement(page, seq)
    const at = await centerOf(page, seq)
    await page.mouse.dblclick(at.x, at.y)
    const editor = page.getByRole('dialog', { name: '序列', exact: true })
    const render = editor.getByRole('button', { name: '导出 MP4', exact: true })
    const project = editor.getByRole('button', { name: '导出工程', exact: true })
    await expect(render).toBeDisabled()
    await expect(project).toBeDisabled()
    await expect(editor.getByRole('status').filter({ hasText: '待确认声音' })).toContainText(
      '还没有结果',
    )
    const select = (mode: 'pending' | 'ready' | 'missing') =>
      page.evaluate(
        ({ source, audio, mode }) => {
          const mutable = window.__plein.engine.doc.mutable(source) as unknown as {
            set(k: string, v: unknown): void
          }
          mutable.set('results', [
            {
              id: 'audio-ready',
              runId: 'fixture',
              port: 'audio',
              at: 1,
              value: { type: 'audio', assetId: audio },
            },
            {
              id: 'missing-output',
              runId: 'other',
              port: 'text',
              at: 2,
              value: { type: 'text', text: '仅元数据' },
            },
          ])
          mutable.set(
            'adopted',
            mode === 'pending' ? null : mode === 'ready' ? 'audio-ready' : 'missing-output',
          )
        },
        { source, audio, mode },
      )
    await select('pending')
    await expect(render).toBeDisabled()
    await expect(editor.getByRole('status').filter({ hasText: '待确认声音' })).toContainText(
      '候选待采用',
    )
    await select('missing')
    await expect(render).toBeDisabled()
    await expect(project).toBeDisabled()
    await expect(editor.getByRole('status').filter({ hasText: '待确认声音' })).toContainText('输出')
    expect(
      await editor
        .getByRole('status')
        .filter({ hasText: '待确认声音' })
        .evaluate((el) => el.scrollWidth <= el.clientWidth),
    ).toBe(true)
    expect(submits).toBe(0)
    await editor.screenshot({ path: test.info().outputPath('missing-audio-output.png') })
    // 已在运行的导出仍须能停止；受控状态不代表真的启动了一个合成进程。
    let canceled = 0
    await page.route(`**/nodes/${seq}/cancel`, async (route) => {
      expect(route.request().postDataJSON()).toEqual({ runId: 'export-readiness-fixture' })
      canceled++
      await page.evaluate((seq) => {
        const mutable = window.__plein.engine.doc.mutable(seq) as unknown as {
          set(k: string, v: unknown): void
        }
        mutable.set('run', { id: 'export-readiness-fixture', status: 'canceled', at: Date.now() })
      }, seq)
      await route.fulfill({ status: 204 })
    })
    await page.evaluate((seq) => {
      const mutable = window.__plein.engine.doc.mutable(seq) as unknown as {
        set(k: string, v: unknown): void
      }
      mutable.set('run', { id: 'export-readiness-fixture', status: 'running', at: Date.now() })
    }, seq)
    const stop = editor.getByRole('button', { name: '停止导出', exact: true })
    await expect(stop).toBeEnabled()
    await expect(stop).toHaveAttribute('title', '停止当前导出任务')
    await stop.click()
    await expect(render).toBeDisabled()
    expect(canceled).toBe(1)
    await select('ready')
    await expect(render).toBeEnabled()
    await expect(project).toBeEnabled()
    const download = page.waitForEvent('download')
    await project.click()
    const file = await download
    expect(await file.failure()).toBeNull()
    const listing = execFileSync('unzip', ['-l', (await file.path())!], { encoding: 'utf8' })
    expect(listing).toContain('timeline.otio')
    expect(listing).toContain('ready-video.webm')
    expect(listing).toContain('ready-audio.wav')
    await render.click()
    await waitNode(page, seq)
    expect(submits).toBe(1)
    const result = await page.evaluate(
      (id) => window.__plein.engine.doc.get(id)?.results?.[0]?.value,
      seq,
    )
    expect(result?.type).toBe('video')
    const meta = await (await page.request.get(`/api/assets/${result!.assetId}/meta`)).json()
    expect(meta.duration).toBeGreaterThan(0)
    const data = await (await page.request.get(`/api/assets/${result!.assetId}`)).body()
    const pcm = execFileSync(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        'pipe:0',
        '-vn',
        '-ac',
        '1',
        '-ar',
        '8000',
        '-f',
        'f32le',
        'pipe:1',
      ],
      { input: data },
    )
    let energy = 0
    for (let i = 0; i < pcm.length; i += 4) energy += pcm.readFloatLE(i) ** 2
    expect(Math.sqrt(energy / (pcm.length / 4))).toBeGreaterThan(0.005)
  })
}
