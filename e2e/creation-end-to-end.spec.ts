import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { loadConfig } from '../apps/server/src/config'
import { startServer, type RunningServer } from '../apps/server/src/start'
import type { JobList, PreparedInput } from '../packages/protocol/src/runs'
import {
  addNode,
  byName,
  centerOf,
  clickElement,
  contextMenu,
  deselect,
  showStoryboardCards,
  waitEngine,
  waitNode,
  zoomTo,
} from './canvas'

let server: RunningServer
let data: string
let config: ReturnType<typeof loadConfig>
const submits: Array<{ capability: string; model: string }> = []
function observeSubmits() {
  // 只观测本次隔离服务的 registry，不修改共享 provider 定义。
  const mock = server.server.plugins.registry.providers.get('plein/mock')!
  const original = mock.def.submit
  mock.def = {
    ...mock.def,
    async submit(request, context) {
      submits.push({ capability: request.capability, model: request.model })
      return original(request, context)
    },
  }
}
test.beforeAll(async () => {
  data = mkdtempSync(join(tmpdir(), 'plein-complete-creation-'))
  const bundled = join(import.meta.dirname, '../apps/desktop/stage/ffmpeg')
  const useBundled =
    process.platform === 'darwin' &&
    ['ffmpeg', 'ffprobe'].every((name) => existsSync(join(bundled, name)))
  config = loadConfig({
    PLEIN_DATA_DIR: data,
    PLEIN_PORT: process.env.PLEIN_FLOW_PORT ?? '0',
    PLEIN_MOCK_PROVIDER: '1',
    PLEIN_AGENT: '0',
    PLEIN_WEB_DIST:
      process.env.PLEIN_FLOW_DIST ?? join(import.meta.dirname, '../apps/web/dist-e2e'),
    PLEIN_FFMPEG_PATH:
      process.env.PLEIN_FFMPEG_PATH ?? (useBundled ? join(bundled, 'ffmpeg') : undefined),
    PLEIN_FFPROBE_PATH:
      process.env.PLEIN_FFPROBE_PATH ?? (useBundled ? join(bundled, 'ffprobe') : undefined),
  })
  server = await startServer(config)
  observeSubmits()
})
test.afterAll(async () => {
  await server?.close()
  if (data) rmSync(data, { recursive: true, force: true })
})

test(
  '从短剧模板、角色环境道具到两镜成片，返工候选与重启后完整保留',
  { tag: '@core' },
  async ({ page }) => {
    test.setTimeout(240_000)
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(process.env.PLEIN_FLOW_BASE_URL ?? server.url)
    await page.getByRole('button', { name: '新建项目', exact: true }).click()
    await expect(page).toHaveURL(/#\/c\//)
    await waitEngine(page)
    await page.waitForFunction(
      () => document.elementFromPoint(innerWidth / 2, innerHeight / 2)?.tagName === 'CANVAS',
    )
    await addNode(page, '短剧')
    const canvas = decodeURIComponent(page.url().split('#/c/')[1]!.split('?')[0]!)
    const api = (path: string) => `${server.url}${path}`
    const input = async (id: string) => {
      const response = await page.request.get(api(`/api/canvases/${canvas}/nodes/${id}/input`))
      expect(response.ok()).toBe(true)
      return (await response.json()) as PreparedInput
    }
    const jobs = async () =>
      ((await (await page.request.get(api(`/api/canvases/${canvas}/jobs`))).json()) as JobList).jobs
    const board = await byName(page, '分镜（双击展开镜头）')
    await zoomTo(page, [board.id])
    await contextMenu(page, board.id, '运行到此处')
    await waitNode(page, board.id)
    expect((await byName(page, '剧本')).status).toBe('succeeded')
    const cast = await byName(page, '角色与场景抽取')
    expect(cast.status).toBe('succeeded')
    await deselect(page)
    await zoomTo(page, [cast.id])
    const castAt = await centerOf(page, cast.id)
    await page.mouse.click(castAt.x, castAt.y, { button: 'right' })
    await page
      .getByRole('menu')
      .getByText(/^生成设定卡/)
      .click()
    const names = ['林晚', '老周', '老城区天台', '铁盒']
    for (const name of names)
      await expect
        .poll(async () =>
          (await page.evaluate(() => [...window.__plein.engine.doc.elements()])).some(
            (el) => el.name === name,
          ),
        )
        .toBe(true)
    const cards = await page.evaluate(
      (names) =>
        [...window.__plein.engine.doc.elements()]
          .filter((el) => names.includes(el.name ?? ''))
          .map((el) => ({ id: el.id, name: el.name!, type: el.nodeType, voice: el.params?.voice })),
      names,
    )
    expect(cards.map((c) => c.type).sort((a, b) => (a ?? '').localeCompare(b ?? ''))).toEqual([
      'plein/character',
      'plein/character',
      'plein/prop',
      'plein/scene',
    ])

    const dialog = page.getByRole('dialog', { name: '分镜表', exact: true })
    const openBoard = async () => {
      await deselect(page)
      await zoomTo(page, [board.id])
      const at = await centerOf(page, board.id)
      await page.mouse.dblclick(at.x, at.y)
      await expect(dialog).toBeVisible()
      await showStoryboardCards(dialog)
    }
    await openBoard()
    while ((await dialog.getByRole('article').count()) > 2) {
      const count = await dialog.getByRole('article').count()
      await dialog
        .getByRole('article')
        .last()
        .getByRole('button', { name: /^删除镜头/ })
        .click()
      await expect(dialog.getByRole('article')).toHaveCount(count - 1)
    }
    await expect(dialog.getByRole('article')).toHaveCount(2)
    const lines = ['林晚：别打开铁盒。', '老周：我在天台等你。']
    for (let i = 0; i < 2; i++) {
      const row = dialog.getByRole('article').nth(i)
      await row.getByLabel('时长', { exact: true }).fill('2')
      await row
        .getByLabel('画面', { exact: true })
        .fill(i ? '老周在雨夜天台等待。' : '林晚拿起桌上的铁盒。')
      await row
        .getByLabel('分镜图提示词', { exact: true })
        .fill(i ? '@老周 站在@老城区天台，注视@铁盒。' : '@林晚 在@老城区天台 拿起@铁盒。')
      await row.getByLabel('台词', { exact: true }).fill(lines[i]!)
      await row.getByLabel('台词', { exact: true }).blur()
    }
    await dialog.getByRole('button', { name: '展开为节点', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    const nodes = await page.evaluate(
      (id) =>
        [...window.__plein.engine.doc.elements()]
          .filter((el) => (el.params?.source as { storyboard?: string })?.storyboard === id)
          .map((el) => ({
            id: el.id,
            name: el.name!,
            role: (el.params!.source as { role: string }).role,
          })),
      board.id,
    )
    const images = nodes.filter((n) => n.role === 'image')
    const videos = nodes.filter((n) => n.role === 'video')
    const speech = nodes.filter((n) => n.role === 'speech')
    expect(images).toHaveLength(2)
    expect(videos).toHaveLength(2)
    expect(speech).toHaveLength(2)
    const batch = async (label: string) => {
      if (!(await dialog.isVisible())) await openBoard()
      await dialog.getByRole('button', { name: label, exact: true }).click()
      const checklist = page.getByRole('dialog', { name: '批量生成清单', exact: true })
      await expect(
        checklist.getByRole('button', { name: '确认并开始生成', exact: true }),
      ).toBeEnabled()
      await checklist.getByRole('button', { name: '确认并开始生成', exact: true }).click()
      await expect(checklist).toHaveCount(0)
    }
    await batch('批量出分镜图')
    for (const image of images) await waitNode(page, image.id)
    const generatedJobs = await jobs()
    for (const image of images) {
      const job = generatedJobs.find(
        (job) => job.nodeId === image.id && job.status === 'succeeded',
      )!
      expect(job.input?.refs.length).toBeGreaterThanOrEqual(3)
      for (const ref of job.input!.refs) {
        expect(cards.map((c) => c.id)).toContain(ref.elementId)
        expect(ref.sent.length, ref.name).toBeGreaterThan(0)
        expect(ref.sent).toEqual(ref.available)
      }
    }
    await batch('批量生成视频')
    for (const video of videos) await waitNode(page, video.id)
    const videoJobs = await jobs()
    for (let i = 0; i < videos.length; i++) {
      const recorded = videoJobs.find(
        (job) => job.nodeId === videos[i]!.id && job.status === 'succeeded',
      )!
      expect(recorded.input?.inputs.images?.[0]?.source).toBe(images[i]!.id)
      expect(recorded.input?.params.mode).toBe('image')
    }
    await batch('批量配音')
    for (const line of speech) await waitNode(page, line.id)
    const speechJobs = await jobs()
    for (let i = 0; i < speech.length; i++) {
      const character = cards.find((c) => c.name === names[i])!
      expect(character.voice).toBeTruthy()
      expect(
        speechJobs.find((j) => j.nodeId === speech[i]!.id && j.status === 'succeeded')?.input
          ?.voice,
      ).toEqual(character.voice)
    }
    await dialog.getByRole('button', { name: '关闭', exact: true }).click()
    const music = await byName(page, '配乐')
    await zoomTo(page, [music.id])
    await contextMenu(page, music.id, '运行到此处')
    await waitNode(page, music.id)
    const sequence = await byName(page, '序列')
    const openSequence = async () => {
      await deselect(page)
      await zoomTo(page, [sequence.id])
      const at = await centerOf(page, sequence.id)
      await page.mouse.dblclick(at.x, at.y)
      await expect(page.getByRole('dialog', { name: '序列', exact: true })).toBeVisible()
    }
    await openSequence()
    const editor = page.getByRole('dialog', { name: '序列', exact: true })
    await expect(editor.locator('.seq-clip')).toHaveCount(2)
    await editor.getByRole('button', { name: '导出 MP4', exact: true }).click()
    const film = editor.getByLabel('实际导出 MP4', { exact: true })
    await expect(film).toBeVisible({ timeout: 60_000 })
    const firstFilm = await film.getAttribute('src')
    expect(firstFilm).toMatch(/\/api\/assets\/[a-f0-9]{64}/)
    const output = await page.request.get(api(firstFilm!))
    expect(output.ok()).toBe(true)
    expect(output.headers()['content-type']).toContain('video/mp4')
    const firstBytes = await output.body()
    await expect
      .poll(() => film.evaluate((v: HTMLVideoElement) => v.readyState))
      .toBeGreaterThanOrEqual(2)
    await film.evaluate((v: HTMLVideoElement) => v.play())
    await expect
      .poll(() => film.evaluate((v: HTMLVideoElement) => v.currentTime))
      .toBeGreaterThan(0.1)
    await film.evaluate((v: HTMLVideoElement) => v.pause())
    await editor
      .getByRole('textbox', { name: '成片时间码意见', exact: true })
      .fill('自动验收夹具：复查第一镜停顿')
    await editor.getByRole('button', { name: '在当前时间添加意见', exact: true }).click()
    await expect(
      editor.getByRole('button', { name: '确认此版本可交付', exact: true }),
    ).toBeDisabled()
    await editor.getByRole('checkbox', { name: '已解决', exact: true }).check()
    await editor.getByRole('button', { name: '确认此版本可交付', exact: true }).click()
    await expect(editor.getByText('已人工确认此版本', { exact: false })).toBeVisible()
    const filmPath = test.info().outputPath('first-film.mp4')
    writeFileSync(filmPath, firstBytes)
    const probe = JSON.parse(
      execFileSync(
        config.ffprobePath ?? 'ffprobe',
        ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', filmPath],
        { encoding: 'utf8' },
      ),
    )
    expect(
      probe.streams.find((s: { codec_type: string }) => s.codec_type === 'video'),
    ).toMatchObject({ codec_name: 'h264', width: 1080, height: 1920 })
    expect(
      probe.streams.find((s: { codec_type: string }) => s.codec_type === 'audio'),
    ).toMatchObject({ codec_name: 'aac', sample_rate: '48000' })
    expect(Number(probe.format.duration)).toBeGreaterThan(0)
    execFileSync(config.ffmpegPath ?? 'ffmpeg', ['-v', 'error', '-i', filmPath, '-f', 'null', '-'])
    await editor.screenshot({ path: test.info().outputPath('complete-film-ui.png') })
    await editor.getByRole('button', { name: '关闭', exact: true }).click()
    await clickElement(page, videos[0]!.id)
    const generator = page.getByTestId('generator')
    const retry = generator.getByRole('button', { name: /^(?:生成|重新生成|重试)$/ })
    const mock = api('/api/providers/plein/mock/config')
    const originalConfig = await (await page.request.get(mock)).json()
    const originalVideo = await page.evaluate(
      (id) => window.__plein.engine.doc.get(id)!,
      videos[0]!.id,
    )
    try {
      expect(
        (
          await page.request.put(mock, {
            data: { settings: { ...originalConfig.settings, latencyMs: 3000 } },
          })
        ).ok(),
      ).toBe(true)
      await retry.click()
      await expect
        .poll(async () => (await jobs()).find((j) => j.nodeId === videos[0]!.id)?.recovery?.state)
        .toBe('remote_pending')
      const canceledId = (await jobs()).find((j) => j.nodeId === videos[0]!.id)!.id
      await generator.getByRole('button', { name: '取消', exact: true }).click()
      await expect
        .poll(async () => (await jobs()).find((j) => j.id === canceledId)?.status)
        .toBe('canceled')
      await page.getByRole('button', { name: '任务', exact: true }).click()
      const tasks = page.getByRole('complementary', { name: '任务', exact: true })
      const videoSubmitsBeforeRecovery = submits.filter(
        (s) => s.capability === 'video.generate',
      ).length
      await tasks.getByRole('button', { name: '重新获取', exact: true }).click()
      await expect
        .poll(async () => (await jobs()).find((j) => j.id === canceledId)?.recovery?.state)
        .toBe('remote_failed')
      await page.getByRole('button', { name: '任务', exact: true }).click()
      await expect(tasks).toHaveCount(0)
      expect(submits.filter((s) => s.capability === 'video.generate')).toHaveLength(
        videoSubmitsBeforeRecovery,
      )
      expect(
        (
          await page.request.put(mock, {
            data: { settings: { ...originalConfig.settings, latencyMs: 0, failWith: 'auth' } },
          })
        ).ok(),
      ).toBe(true)
      const previousJobs = new Set((await jobs()).map((j) => j.id))
      await retry.click()
      await expect
        .poll(
          async () =>
            (await jobs()).find((j) => j.nodeId === videos[0]!.id && !previousJobs.has(j.id))
              ?.status,
        )
        .toBe('failed')
      const failed = await page.evaluate((id) => window.__plein.engine.doc.get(id)!, videos[0]!.id)
      expect({ adopted: failed.adopted, results: failed.results }).toEqual({
        adopted: originalVideo.adopted,
        results: originalVideo.results,
      })
      expect(await (await page.request.get(api(firstFilm!))).body()).toEqual(firstBytes)
      await page.screenshot({ path: test.info().outputPath('retry-retains-film.png') })
    } finally {
      await page.request.put(mock, { data: { settings: originalConfig.settings } })
    }
    const failure = page.locator('.plein-node-failed').filter({ hasText: '密钥无效' })
    await expect(failure.locator('strong')).toBeVisible()
    await failure.getByRole('button', { name: '重试', exact: true }).click()
    await expect
      .poll(() =>
        page.evaluate((id) => window.__plein.engine.doc.get(id)?.results?.length, videos[0]!.id),
      )
      .toBe(2)
    await page
      .locator('.plein-node')
      .filter({ has: page.locator('.plein-node-title', { hasText: videos[0]!.name }) })
      .getByRole('button', { name: '下一个结果', exact: true })
      .click()
    const viewer = page.getByRole('dialog', { name: `查看「${videos[0]!.name}」`, exact: true })
    await viewer.getByRole('button', { name: '采用此候选', exact: true }).click()
    await viewer.getByRole('button', { name: '关闭', exact: true }).click()
    const read = () =>
      page.evaluate(() => ({
        elements: [...window.__plein.engine.doc.elements()]
          .map((el) => ({
            ...el,
            rect: window.__plein.engine.doc.worldRect(el.id),
          }))
          .sort((a, b) => a.id.localeCompare(b.id)),
        edges: [...window.__plein.engine.doc.edges()].sort((a, b) =>
          JSON.stringify(a).localeCompare(JSON.stringify(b)),
        ),
      }))
    const before = await read()
    const taskSnapshot = async () =>
      (await jobs())
        .map((j) => ({
          id: j.id,
          node: j.nodeId,
          status: j.status,
          attempts: j.attempts,
          inputHash: j.input?.inputHash,
        }))
        .sort((a, b) => a.id.localeCompare(b.id))
    const tasksBefore = await taskSnapshot()
    await page.reload()
    await waitEngine(page)
    await expect.poll(read).toEqual(before)
    const port = server.port
    await server.close()
    server = await startServer({ ...config, port })
    observeSubmits()
    await page.reload()
    await waitEngine(page)
    await expect.poll(read).toEqual(before)
    await expect.poll(taskSnapshot).toEqual(tasksBefore)
    await openSequence()
    await expect(editor.locator('.seq-clip')).toHaveCount(2)
    const previousExports = await page.evaluate(
      (id) => window.__plein.engine.doc.get(id)?.results?.length ?? 0,
      sequence.id,
    )
    await editor.getByRole('button', { name: '重新导出', exact: true }).click()
    await expect
      .poll(
        () =>
          page.evaluate(
            (id) => window.__plein.engine.doc.get(id)?.results?.length ?? 0,
            sequence.id,
          ),
        { timeout: 60_000 },
      )
      .toBe(previousExports + 1)
    await expect(film).toBeVisible({ timeout: 60_000 })
    await expect(editor.getByText('待人工确认', { exact: false }).first()).toBeVisible()
    await expect.poll(async () => (await input(sequence.id)).status).toBe('ready')
    const secondBytes = await (
      await page.request.get(api((await film.getAttribute('src'))!))
    ).body()
    const secondPath = test.info().outputPath('second-film.mp4')
    writeFileSync(secondPath, secondBytes)
    execFileSync(config.ffmpegPath ?? 'ffmpeg', [
      '-v',
      'error',
      '-i',
      secondPath,
      '-f',
      'null',
      '-',
    ])
    const finalJobs = await jobs()
    for (const job of finalJobs)
      if (job.input?.model) expect(job.input.model.provider).toBe('plein/mock')
    const proof = JSON.stringify(
      {
        canvas,
        cards,
        nodes,
        submits,
        jobs: finalJobs.map((j) => ({
          id: j.id,
          node: j.nodeId,
          status: j.status,
          inputHash: j.input?.inputHash,
          refs: j.input?.refs,
          voice: j.input?.voice,
        })),
        decodedFilm: {
          duration: probe.format.duration,
          streams: probe.streams.map((s: { codec_type: string; codec_name: string }) => ({
            kind: s.codec_type,
            codec: s.codec_name,
          })),
        },
        restartPreserved: true,
        quality: 'mock-scripted-not-human-approval',
      },
      null,
      2,
    )
    const proofPath = test.info().outputPath('workflow-proof.json')
    writeFileSync(proofPath, proof)
    await test.info().attach('workflow-proof', { path: proofPath, contentType: 'application/json' })
    expect(errors).toEqual([])
  },
)
