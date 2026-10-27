import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from './fixtures'
import { centerOf, elements, newProject, zoomTo } from './canvas'

let dir = ''
test.beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'plein-review-e2e-'))
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
test.afterAll(() => rmSync(dir, { recursive: true, force: true }))

test('创作验收独立采用并保留；连续性使用真实帧、实际视频切点和固定角色参考', async ({
  page,
}, testInfo) => {
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
  let dialog = await open()
  await dialog
    .locator('[data-shot-id="s1"]')
    .getByRole('button', { name: '预览镜头1image', exact: true })
    .click()
  const viewer = page.getByRole('dialog', { name: '查看「镜头1image」', exact: true })
  const viewerForm = viewer.locator(`[data-review-node="${fixture.ids[0]![0]}"]`)
  await viewerForm.locator('summary').first().focus()
  await page.keyboard.press('Enter')
  await expect(viewerForm.getByRole('textbox', { name: /创作验收备注/ })).toBeVisible()
  await viewerForm.getByRole('textbox', { name: /创作验收备注/ }).fill('键盘验收备注')
  await viewerForm.getByRole('button', { name: '保存为需修改', exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect(viewerForm.locator('summary').first()).toHaveText('创作验收：需修改')
  await viewer.getByRole('button', { name: '关闭', exact: true }).click()
  for (const id of fixture.ids[0]!) {
    const form = dialog.locator(`[data-review-node="${id}"]`)
    await form.locator('summary').first().click()
    await form.getByRole('textbox', { name: /创作验收备注/ }).fill('人物设定与构图可用')
    await form.getByRole('checkbox', { name: '角色一致性', exact: true }).check()
    await form.getByRole('button', { name: '保存为可用', exact: true }).click()
    await expect(form.locator('summary').first()).toHaveText('创作验收：可用')
  }
  expect(
    await page.evaluate(
      (id) => (window.__plein.engine.doc.get(id) as unknown as { adopted: string }).adopted,
      fixture.ids[0]![0]!,
    ),
  ).toBe(`candidate-${fixture.ids[0]![0]}`)
  await dialog.getByRole('button', { name: '下一待审', exact: true }).click()
  await expect(dialog.locator('[data-shot-id="s1"]')).toHaveCount(0)
  await expect(dialog.locator('[data-shot-id="s2"]')).toBeVisible()
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
  dialog = await open()
  await expect(dialog.locator(`[data-review-node="${fixture.ids[1]![1]}"] > summary`)).toHaveText(
    '创作验收：需修改',
  )
  await page.evaluate((id) => {
    const m = window.__plein.engine.doc.mutable(id) as unknown as {
      get(key: string): unknown
      set(key: string, value: unknown): void
    }
    const results = m.get('results') as Array<Record<string, unknown>>
    m.set('results', [{ ...results[0], id: 'new-candidate', runId: 'new-run' }, ...results])
    m.set('adopted', 'new-candidate')
  }, fixture.ids[0]![0]!)
  await expect(dialog.locator(`[data-review-node="${fixture.ids[0]![0]}"] > summary`)).toHaveText(
    '创作验收：待审',
  )
})
