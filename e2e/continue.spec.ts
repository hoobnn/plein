import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, type Page, test } from './fixtures'
import {
  addNode,
  centerOf,
  clickRun,
  edgesInto,
  elements,
  newProject,
  revealGenerator,
  waitNode,
  zoomTo,
} from './canvas'

let dir = ''
test.beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'plein-e2e-continue-'))
  execFileSync('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'smptebars=s=320x180:d=1:r=10',
    '-c:v',
    'libvpx-vp9',
    join(dir, 'retake.webm'),
  ])
  for (const [name, color, duration] of [
    ['before.webm', 'red', '1.6'],
    ['after.webm', 'green', '2.4'],
  ])
    execFileSync('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      `color=c=${color}:s=160x240:d=${duration}:r=10`,
      '-c:v',
      'libvpx-vp9',
      '-deadline',
      'realtime',
      join(dir, name!),
    ])
  execFileSync('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'color=c=blue:s=160x240',
    '-frames:v',
    '1',
    join(dir, 'reference.png'),
  ])
})

test.afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
})

const params = (page: Page, id: string) =>
  page.evaluate((id) => window.__plein.engine.doc.get(id)?.params ?? {}, id)

test(
  '取帧续镜：从尾帧接出下一个镜头，记下父视频；父镜头重生成后一键换新首帧',
  { tag: '@core' },
  async ({ page, request }) => {
    await newProject(page)
    await addNode(page, '生成视频')
    const generator = page.getByTestId('generator')
    // 编辑器固定在卡片下方，先把它移进窗口再点里面的控件
    await revealGenerator(page)
    await generator.locator('textarea').first().fill('雨夜天台，她走到栏杆边')
    await clickRun(page)
    const [parent] = (await elements(page)).filter((e) => e.kind === 'node')
    await waitNode(page, parent!.id)

    await generator.getByRole('button', { name: '续镜' }).click()
    await expect(page.getByRole('button', { name: /从尾帧续/ })).toBeVisible()

    await page.getByRole('button', { name: /从尾帧续/ }).click()
    await expect(page.locator('.ui-toast')).toContainText('接出下一个镜头')

    const next = (await elements(page)).find((e) => e.name?.endsWith('· 续镜'))!
    expect(next).toBeTruthy()
    const p = await params(page, next.id)
    expect(p.mode).toBe('image')
    expect(p.continuesFrom).toMatchObject({ elementId: parent!.id, last: true })
    // 首帧是抽出来的那张图，连在「图片」输入上
    const [edge] = await edgesInto(page, next.id)
    expect(edge?.[2]).toBe('images')
    const frame = (await elements(page)).find((e) => e.id === edge![0])!
    expect(frame.kind).toBe('image')

    const continued = page.getByTestId('continued-from')
    // 编辑器固定在卡片下方，先把它移进窗口再点里面的控件
    await revealGenerator(page)
    await expect(continued).toContainText('续自')
    await expect(continued).toContainText('尾帧')
    await zoomTo(page, [parent!.id, frame.id, next.id])

    // 点「续自」回到上一个镜头
    await continued.getByRole('button').first().click()
    await expect
      .poll(() => page.evaluate(() => window.__plein.engine.selection.values()))
      .toEqual([parent!.id])

    // 上一个镜头重新生成出了不同的画面（mock 每次给同一段视频，这里换成另一段并采用它）
    const clip = join(dir, 'retake.webm')
    const uploaded = await request.post('/api/assets', {
      headers: { 'content-type': 'video/webm', 'x-file-name': 'retake.webm' },
      data: readFileSync(clip),
    })
    const retake = ((await uploaded.json()) as { id: string }).id
    await page.evaluate(
      ({ id, assetId }) => {
        const m = window.__plein.engine.doc.mutable(id) as unknown as {
          get(k: string): unknown
          set(k: string, v: unknown): void
          doc: { transact(fn: () => void): void }
        }
        const old = (m.get('results') as unknown[]) ?? []
        const r = {
          id: 'retake',
          port: 'video',
          runId: 'retake',
          at: Date.now(),
          value: { type: 'video', assetId, mime: 'video/webm' },
        }
        m.doc.transact(() => {
          m.set('results', [r, ...old])
          m.set('adopted', 'retake')
        })
      },
      { id: parent!.id, assetId: retake },
    )
    const oldFrame = await page.evaluate(
      (id) => window.__plein.engine.doc.get(id)?.assetId,
      frame.id,
    )
    await page.evaluate((id) => {
      const { engine } = window.__plein as unknown as {
        engine: { selection: { set(ids: string[]): void } }
      }
      engine.selection.set([id])
    }, next.id)
    await expect(continued).toContainText('首帧已旧')
    await page.mouse.move(700, 120)

    // 编辑器固定在卡片下方，先把它移进窗口再点里面的控件
    await revealGenerator(page)
    await continued.getByRole('button', { name: '换成新画面' }).click()
    await expect(page.locator('.ui-toast')).toContainText('已换成上一个镜头的新画面')
    await expect(continued).not.toContainText('首帧已旧')
    const refreshed = await page.evaluate(
      (id) => window.__plein.engine.doc.get(id)?.assetId,
      frame.id,
    )
    expect(refreshed).not.toBe(oldFrame)
    expect((await params(page, next.id)).continuesFrom).toMatchObject({ assetId: retake })
  },
)

test('连续性使用真实首末帧、实际视频切点和固定角色参考 @core', async ({ page }, testInfo) => {
  await newProject(page)
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: '上传', exact: true }).click()
  await (
    await chooser
  ).setFiles(['before.webm', 'after.webm', 'reference.png'].map((name) => join(dir, name)))
  await expect
    .poll(
      async () =>
        (await elements(page)).filter((el) => el.kind === 'video' || el.kind === 'image').length,
    )
    .toBe(3)
  const fixture = await page.evaluate(() => {
    const all = [...window.__plein.engine.doc.elements()]
    const assets = ['before.webm', 'after.webm', 'reference.png'].map(
      (name) => all.find((el) => el.name === name)!.assetId!,
    )
    const board = window.__plein.addNode({
      type: 'plein/storyboard',
      name: '验收分镜',
      params: {
        shots: [
          { id: 's1', no: 1, duration: 9, description: '红色前镜' },
          { id: 's2', no: 2, duration: 9, description: '绿色后镜' },
        ],
      },
      x: 600,
      y: 200,
    })
    const ids = [0, 1].map((shot) =>
      (['image', 'video'] as const).map((role) => {
        const id = window.__plein.addNode({
          type: `plein/${role}`,
          name: `镜头${shot + 1}${role}`,
          params: {
            prompt: '固定素材验收',
            source: { storyboard: board, shot: `s${shot + 1}`, role },
          },
          x: 1000 + shot * 400,
          y: role === 'image' ? 200 : 600,
        })
        const m = window.__plein.engine.doc.mutable(id) as unknown as {
          set(key: string, value: unknown): void
        }
        m.set('results', [
          {
            id: `candidate-${id}`,
            runId: 'fixture-run',
            port: role === 'image' ? 'images' : 'video',
            value: { type: role, assetId: role === 'image' ? assets[2] : assets[shot] },
            at: 1,
          },
        ])
        m.set('adopted', `candidate-${id}`)
        return id
      }),
    )
    const actor = window.__plein.addNode({
      type: 'plein/character',
      name: '固定主角',
      params: {},
      x: 0,
      y: 1000,
    })
    const reference = all.find((el) => el.name === 'reference.png')!
    window.__plein.connect([reference.id, 'image'], [actor, 'references'])
    return { board, ids, reference: assets[2]! }
  })
  const open = async () => {
    await zoomTo(page, [fixture.board])
    const point = await centerOf(page, fixture.board)
    await page.mouse.dblclick(point.x, point.y)
    const dialog = page.getByRole('dialog', { name: '分镜表', exact: true })
    await dialog.getByRole('button', { name: '审核镜头', exact: true }).click()
    return dialog
  }
  const dialog = await open()
  await dialog.getByLabel('筛选镜头验收').selectOption('all')
  await dialog
    .locator('[data-shot-id="s2"]')
    .getByRole('button', { name: '与上一镜连续性审看', exact: true })
    .click()
  const continuity = page.getByRole('dialog', { name: '连续性审看', exact: true })
  const tail = continuity.getByRole('img', { name: '镜头 1 真实尾帧', exact: true })
  const head = continuity.getByRole('img', { name: '镜头 2 真实首帧', exact: true })
  await expect(tail).toBeVisible()
  await expect(head).toBeVisible()
  expect(await tail.getAttribute('src')).not.toContain('poster')
  expect(await head.getAttribute('src')).not.toBe(await tail.getAttribute('src'))
  await continuity.getByRole('combobox', { name: /^固定角色参考/ }).selectOption(fixture.reference)
  await expect(continuity.getByRole('img', { name: '固定角色参考', exact: true })).toBeVisible()
  await continuity.locator('video').evaluateAll((videos) =>
    videos.forEach((video) => {
      ;(video as HTMLVideoElement).muted = true
    }),
  )
  await continuity.getByRole('button', { name: '循环回看切点前后各一秒', exact: true }).click()
  await expect(
    continuity.getByText('当前镜开头 · 按实际视频时长播放', { exact: true }),
  ).toBeVisible({ timeout: 5000 })
  await continuity.getByRole('button', { name: '暂停回看', exact: true }).click()
  await continuity
    .getByRole('textbox', { name: /创作验收备注/ })
    .fill('切点衣服方向不一致，需要修后镜')
  await continuity.getByRole('button', { name: '保存为需修改', exact: true }).click()
  await continuity.screenshot({ path: testInfo.outputPath('continuity-review.png') })
  await continuity.getByRole('button', { name: '关闭', exact: true }).click()
  await dialog.getByLabel('筛选镜头验收').selectOption('changes')
  await expect(dialog.locator('[data-shot-id="s2"]')).toBeVisible()
  await dialog.getByRole('button', { name: '关闭', exact: true }).click()
  await page.reload()
  await page.waitForFunction(() => !!window.__plein)
  const restored = await open()
  await expect(restored.locator(`[data-review-node="${fixture.ids[1]![1]}"] > summary`)).toHaveText(
    '创作验收：需修改',
  )
})
