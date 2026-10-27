import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, type Page, test } from './fixtures'
import { centerOf, newProject, zoomTo } from './canvas'

let dir = ''
test.beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'plein-subtitle-lifecycle-'))
  execFileSync('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'sine=f=440:d=2',
    join(dir, 'line.wav'),
  ])
})
test.afterAll(() => rmSync(dir, { recursive: true, force: true }))

async function fixture(page: Page) {
  await newProject(page)
  const uploaded = await page.request.post('/api/assets', {
    headers: { 'content-type': 'audio/wav', 'x-file-name': 'line.wav' },
    data: readFileSync(join(dir, 'line.wav')),
  })
  expect(uploaded.status()).toBe(201)
  const assetId = (await uploaded.json()).id as string
  const ids = await page.evaluate((assetId) => {
    return ['原样片', '另一份样片'].map((name, index) =>
      window.__plein.addNode({
        type: 'plein/animatic',
        name,
        x: 300 + index * 700,
        y: 200,
        params: {
          model: 'plein/mock:audio',
          shots: [
            {
              shotId: `shot-${index}`,
              duration: 2,
              dialogue: [{ source: 'line', assetId, caption: '原始台词' }],
            },
          ],
        },
      }),
    )
  }, assetId)
  const editor = page.getByRole('dialog', { name: '序列', exact: true })
  const open = async (id = ids[0]!) => {
    await zoomTo(page, [id])
    const point = await centerOf(page, id)
    await page.mouse.dblclick(point.x, point.y)
    await editor.getByRole('button', { name: '字幕', exact: true }).click()
    await expect(editor.getByRole('button', { name: '识别全部对白并重建字幕' })).toBeEnabled()
  }
  const close = async () => {
    await editor.getByRole('button', { name: '关闭', exact: true }).click()
    await expect(editor).toHaveCount(0)
  }
  const tracks = () =>
    page.evaluate(
      (ids) => ids.map((id) => window.__plein.engine.doc.get(id)!.params!.subtitleTrack ?? null),
      ids,
    )
  return { assetId, ids, editor, open, close, tracks }
}

for (const action of ['close', 'reopen', 'switch'] as const) {
  test(`字幕识别等待中 ${action} 后，迟到成功保留服务响应且不写入旧编辑会话`, async ({ page }) => {
    const f = await fixture(page)
    let release!: () => void
    let started!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const ready = new Promise<void>((resolve) => {
      started = resolve
    })
    const recognized = {
      transcripts: { [f.assetId]: [{ start: 0, end: 1, text: '已识别台词' }] },
    }
    await page.route('**/api/media/subtitle-recognize', async (route) => {
      started()
      await gate
      await route.fulfill({ json: recognized })
    })
    await f.open()
    await f.editor.getByRole('button', { name: '识别全部对白并重建字幕' }).click()
    await ready
    await f.close()
    if (action !== 'close') await f.open(action === 'switch' ? f.ids[1] : f.ids[0])
    const completed = page.waitForResponse('**/api/media/subtitle-recognize')
    release()
    expect(await (await completed).json()).toEqual(recognized)
    await page.waitForTimeout(150)
    expect(await f.tracks()).toEqual([null, null])
    if (action !== 'close') {
      await f.editor.getByRole('button', { name: '识别全部对白并重建字幕' }).click()
      await expect.poll(async () => (await f.tracks())[action === 'switch' ? 1 : 0]).not.toBeNull()
    }
  })
}

test('字幕恢复等待中关闭再打开，保留已确认恢复且不自动发起旧会话识别', async ({ page }) => {
  const f = await fixture(page)
  await page.route('**/api/media/subtitle-recognition?**', (route) =>
    route.fulfill({
      json: {
        model: 'plein/mock:audio',
        assetId: f.assetId,
        expected: 'unknown-revision',
        recovery: { state: 'submit_unknown', attachable: true },
      },
    }),
  )
  let release!: () => void
  let started!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })
  let recoveries = 0
  let recognitions = 0
  await page.route('**/api/media/subtitle-recover', async (route) => {
    recoveries++
    expect(route.request().postDataJSON()).toMatchObject({
      expected: 'unknown-revision',
      operation: { action: 'attach', remoteId: 'existing-asr-task' },
    })
    started()
    await gate
    await route.fulfill({ json: { ok: true } })
  })
  await page.route('**/api/media/subtitle-recognize', (route) => {
    recognitions++
    return route.fulfill({
      json: { transcripts: { [f.assetId]: [{ start: 0, end: 1, text: '旧会话识别' }] } },
    })
  })
  await f.open()
  const controls = f.editor.getByRole('region', { name: '字幕识别恢复' })
  await controls.getByRole('textbox', { name: '字幕识别平台任务 ID' }).fill('existing-asr-task')
  await controls.getByRole('button', { name: '关联任务并续查' }).click()
  await ready
  await f.close()
  await f.open()
  const completed = page.waitForResponse('**/api/media/subtitle-recover')
  release()
  expect(await (await completed).json()).toEqual({ ok: true })
  await page.waitForTimeout(150)
  expect(recoveries).toBe(1)
  expect(recognitions).toBe(0)
  expect(await f.tracks()).toEqual([null, null])
})
