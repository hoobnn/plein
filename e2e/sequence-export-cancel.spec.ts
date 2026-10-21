import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { centerOf, clickElement, newProject, waitNode } from './canvas'

let dir = ''
test.beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'plein-export-cancel-'))
  execFileSync('ffmpeg', [
    '-hide_banner',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=c=orange:s=160x90',
    '-frames:v',
    '1',
    join(dir, 'frame.png'),
  ])
})
test.afterAll(() => rmSync(dir, { recursive: true, force: true }))

test('实际导出中停止保留旧成片，任务状态一致且可再次成功导出', async ({ page }) => {
  await newProject(page)
  const uploaded = await page.request.post('/api/assets', {
    headers: { 'content-type': 'image/png', 'x-file-name': 'cancel-frame.png' },
    data: readFileSync(join(dir, 'frame.png')),
  })
  expect(uploaded.status()).toBe(201)
  const asset = (await uploaded.json()).id as string
  const id = await page.evaluate(
    (asset) =>
      window.__plein.addNode({
        type: 'plein/animatic',
        name: '真实取消导出',
        x: 400,
        y: 200,
        params: {
          resolution: '720p',
          aspectRatio: '16:9',
          subtitles: false,
          loudnorm: false,
          shots: [{ shotId: 'one', duration: 0.5, imageAssetId: asset, dialogue: [] }],
        },
      }),
    asset,
  )
  const open = async () => {
    await clickElement(page, id)
    const at = await centerOf(page, id)
    await page.mouse.dblclick(at.x, at.y)
  }
  await open()
  const editor = page.getByRole('dialog', { name: '序列', exact: true })
  await editor.getByRole('button', { name: '导出样片 MP4', exact: true }).click()
  await waitNode(page, id)
  const read = () =>
    page.evaluate((id) => {
      const el = window.__plein.engine.doc.get(id)!
      return { adopted: el.adopted, results: el.results, deliveries: el.deliveries }
    }, id)
  const previous = await read()
  expect(previous.results).toHaveLength(1)
  await editor.getByRole('button', { name: '样片编辑预览', exact: true }).click()
  const duration = editor.getByRole('spinbutton', { name: '样片镜头时长（秒）', exact: true })
  await duration.fill('300')
  await duration.blur()
  const canvas = /#\/c\/([^/?]+)/.exec(page.url())![1]
  const jobs = async () =>
    (await (await page.request.get(`/api/canvases/${canvas}/jobs`)).json()).jobs as Array<{
      id: string
      status: string
    }>
  await editor.getByRole('button', { name: '重新导出', exact: true }).click()
  await expect.poll(async () => (await jobs()).length).toBe(2)
  const active = (await jobs())[0]!
  expect(active.status).toBe('running')
  await expect
    .poll(
      () =>
        page.evaluate(
          ({ id, activeId }) => {
            const run = window.__plein.engine.doc.get(id)?.run as
              | { id?: string; progress?: number }
              | undefined
            return run?.id === activeId ? (run.progress ?? 0) : 0
          },
          { id, activeId: active.id },
        ),
      { message: '本次 ffmpeg 已实际输出合成进度', timeout: 30_000 },
    )
    .toBeGreaterThan(0)
  const cancellation = page.waitForResponse(
    (r) => r.url().endsWith(`/nodes/${id}/cancel`) && r.request().method() === 'POST',
  )
  await editor.getByRole('button', { name: '停止导出', exact: true }).click()
  const stopped = await cancellation
  expect(stopped.status()).toBe(204)
  expect(stopped.request().postDataJSON()).toEqual({ runId: active.id })
  await expect.poll(async () => (await jobs())[0]!.status).toBe('canceled')
  await expect
    .poll(() => page.evaluate((id) => window.__plein.engine.doc.get(id)?.run?.status, id))
    .toBe('canceled')
  expect(await read()).toEqual(previous)
  await expect
    .poll(() =>
      readdirSync(join(process.env.PLEIN_E2E_DATA!, 'tmp')).filter((name) =>
        name.startsWith('job-'),
      ),
    )
    .toEqual([])
  await expect(editor.getByRole('button', { name: '重新导出', exact: true })).toBeEnabled()
  await editor.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(editor).not.toBeVisible()
  await page.getByRole('button', { name: '任务', exact: true }).click()
  const panel = page.getByRole('complementary', { name: '任务', exact: true })
  const row = panel.locator(`[data-job-id="${active.id}"]`)
  // 运行超过一秒会附上「· 用时 N 秒」
  await expect(row.getByText(/^已取消( · 用时 .+)?$/)).toBeVisible()
  await expect(row.getByRole('button', { name: '停止', exact: true })).toHaveCount(0)
  await panel.screenshot({
    path: test.info().outputPath('actual-export-canceled.png'),
    animations: 'disabled',
  })
  await panel.getByRole('button', { name: '关闭', exact: true }).click()
  await open()
  await duration.fill('0.7')
  await duration.blur()
  await editor.getByRole('button', { name: '重新导出', exact: true }).click()
  await expect.poll(async () => (await jobs()).length).toBe(3)
  await expect.poll(async () => (await jobs())[0]!.status).toBe('succeeded')
  await waitNode(page, id)
  const after = await read()
  expect(after.results).toHaveLength(2)
  expect(after.deliveries).toHaveLength(2)
  expect(after.results!.some((result) => result.id === previous.results![0]!.id)).toBe(true)
  const latest = after.results!.find((result) => result.id === after.adopted)!
  const response = await page.request.get(`/api/assets/${latest.value.assetId}`)
  expect(response.ok()).toBe(true)
  const file = join(dir, 'retried.mp4')
  writeFileSync(file, await response.body())
  const probe = JSON.parse(
    execFileSync(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', file],
      { encoding: 'utf8' },
    ),
  )
  expect(Number(probe.format.duration)).toBeCloseTo(0.7, 1)
})
