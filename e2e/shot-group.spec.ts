import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, type Page, test } from './fixtures'
import { clickElement, contextMenu, elements, newProject, settle, zoomTo } from './canvas'

/** 设了就把界面截图存到这个目录（亮色、暗色各一张） */
const shotDir = process.env.PLEIN_E2E_SHOTS

async function shoot(page: Page, name: string) {
  if (!shotDir) return
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    await page.waitForTimeout(300)
    await page.screenshot({ path: join(shotDir, `${name}-${scheme}.png`) })
  }
  await page.emulateMedia({ colorScheme: null })
}

let dir = ''

test.beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'plein-e2e-shots-'))
  // 四格分镜图：四种色调的渐变拼成 2×2
  const panels = [
    ['0x1e3a8a', '0xf59e0b'],
    ['0x0f766e', '0xfde68a'],
    ['0x7c2d12', '0xfca5a5'],
    ['0x312e81', '0x67e8f9'],
  ]
  const inputs = panels.flatMap(([a, b]) => [
    '-f',
    'lavfi',
    '-i',
    `gradients=s=480x270:c0=${a}:c1=${b}:x0=0:y0=0:x1=480:y1=270:d=1:r=1`,
  ])
  execFileSync('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    ...inputs,
    '-filter_complex',
    '[0][1][2][3]xstack=inputs=4:layout=0_0|w0_0|0_h0|w0_h0',
    '-frames:v',
    '1',
    join(dir, 'storyboard.png'),
  ])
  execFileSync('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'color=c=blue:s=64x48',
    '-frames:v',
    '1',
    join(dir, 'replacement.png'),
  ])
})

test('宫格切分上传中切换画布取消旧写入，不产生迟到的分组或错误', async ({ page }) => {
  await newProject(page)
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: '上传', exact: true }).click()
  await (await chooser).setFiles(join(dir, 'storyboard.png'))
  await expect.poll(async () => (await elements(page)).length).toBe(1)
  const source = (await elements(page))[0]!
  const oldDoc = await page.evaluateHandle(() => window.__plein.engine.doc)
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  let release = () => {}
  let started = false
  let completed = false
  await page.route('**/api/assets', async (route) => {
    if (route.request().method() !== 'POST') return route.continue()
    const response = await route.fetch()
    await new Promise<void>((resolve) => {
      release = resolve
      started = true
    })
    await route.fulfill({ response })
    completed = true
  })
  await clickElement(page, source.id)
  await page
    .getByRole('toolbar', { name: '结果操作' })
    .getByRole('button', { name: '宫格切分' })
    .click()
  await page.getByRole('button', { name: /4 宫格/ }).click()
  await expect.poll(() => started).toBe(true)
  await page.getByRole('button', { name: '切换画布' }).click()
  await page.getByRole('button', { name: '新建画布' }).click()
  await page.getByRole('dialog').getByRole('textbox').fill('取消切图后的画布')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('button', { name: '切换画布' })).toHaveText('取消切图后的画布')
  release()
  await expect.poll(() => completed).toBe(true)
  expect(await oldDoc.evaluate((doc) => [...doc.elements()].map((el) => el.id))).toEqual([
    source.id,
  ])
  expect(await elements(page)).toEqual([])
  expect(errors).toEqual([])
  await oldDoc.dispose()
})
test.afterAll(() => rmSync(dir, { recursive: true, force: true }))

for (const change of ['replace', 'delete'] as const) {
  test(`切图上传中${change === 'replace' ? '替换' : '删除'}来源，提示原因且不写入失效分组`, async ({
    page,
  }) => {
    await newProject(page)
    const chooser = page.waitForEvent('filechooser')
    await page.getByRole('button', { name: '上传', exact: true }).click()
    await (await chooser).setFiles(join(dir, 'storyboard.png'))
    await expect.poll(async () => (await elements(page)).length).toBe(1)
    const source = (await elements(page))[0]!
    const replacement = await page.request.post('/api/assets', {
      headers: { 'content-type': 'image/png' },
      data: readFileSync(join(dir, 'replacement.png')),
    })
    expect(replacement.status()).toBe(201)
    const asset = (await replacement.json()).id as string
    let release = () => {}
    let held = false
    let uploads = 0
    await page.route('**/api/assets', async (route) => {
      if (route.request().method() !== 'POST' || ++uploads < 4) return route.continue()
      const response = await route.fetch()
      await new Promise<void>((resolve) => {
        release = resolve
        held = true
      })
      await route.fulfill({ response })
    })
    await clickElement(page, source.id)
    await page
      .getByRole('toolbar', { name: '结果操作' })
      .getByRole('button', { name: '宫格切分' })
      .click()
    await page.getByRole('button', { name: /4 宫格/ }).click()
    await expect.poll(() => held).toBe(true)
    if (change === 'delete') {
      await contextMenu(page, source.id, '删除')
      await expect.poll(async () => (await elements(page)).length).toBe(0)
    } else
      await page.evaluate(
        ({ id, asset }) => {
          const doc = window.__plein.engine.doc as unknown as {
            origin: unknown
            ydoc: { transact(fn: () => void, origin: unknown): void }
            mutable(id: string): { set(key: string, value: string): void }
          }
          doc.ydoc.transact(() => doc.mutable(id).set('assetId', asset), doc.origin)
        },
        { id: source.id, asset },
      )
    release()
    await expect(page.getByRole('status')).toContainText(
      change === 'delete' ? '来源元素已删除' : '来源图片已变化',
    )
    expect((await elements(page)).filter((el) => el.kind === 'frame')).toEqual([])
    expect((await elements(page)).length).toBe(change === 'delete' ? 0 : 1)
  })
}

test('切图上传中移动来源并新增障碍，完成时按当前布局避让且整组独立撤销', async ({ page }) => {
  await newProject(page)
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: '上传', exact: true }).click()
  await (await chooser).setFiles(join(dir, 'storyboard.png'))
  await expect.poll(async () => (await elements(page)).length).toBe(1)
  const source = (await elements(page))[0]!
  let release = () => {}
  let held = false
  let uploads = 0
  await page.route('**/api/assets', async (route) => {
    if (route.request().method() !== 'POST' || ++uploads < 4) return route.continue()
    const response = await route.fetch()
    await new Promise<void>((resolve) => {
      release = resolve
      held = true
    })
    await route.fulfill({ response })
  })
  await clickElement(page, source.id)
  await page
    .getByRole('toolbar', { name: '结果操作' })
    .getByRole('button', { name: '宫格切分' })
    .click()
  await page.getByRole('button', { name: /4 宫格/ }).click()
  await expect.poll(() => held).toBe(true)
  const blocker = await page.evaluate((id) => {
    const e = window.__plein.engine
    const doc = e.doc as unknown as {
      origin: unknown
      ydoc: { transact(fn: () => void, origin: unknown): void }
      worldRect(id: string): { x: number; y: number; w: number; h: number }
      mutable(id: string): { get(key: string): unknown; set(key: string, value: number): void }
    }
    const before = doc.worldRect(id)
    doc.ydoc.transact(() => doc.mutable(id).set('x', before.x + 900), doc.origin)
    const now = doc.worldRect(id)
    return window.__plein.addNode({
      type: 'plein/text',
      name: '切图期间新增的卡片',
      params: { text: '保留位置，不与切片重叠' },
      x: now.x + now.w + 120,
      y: now.y + now.h / 2 - 120,
    })
  }, source.id)
  release()
  await expect
    .poll(async () => (await elements(page)).filter((el) => el.kind === 'frame').length)
    .toBe(1)
  const frame = (await elements(page)).find((el) => el.kind === 'frame')!
  const [s, f, b] = await page.evaluate(
    (ids) => ids.map((id) => window.__plein.engine.doc.worldRect(id)),
    [source.id, frame.id, blocker],
  )
  expect(f!.x).toBeGreaterThanOrEqual(s!.x + s!.w + 40)
  expect(f!.x < b!.x + b!.w && f!.x + f!.w > b!.x && f!.y < b!.y + b!.h && f!.y + f!.h > b!.y).toBe(
    false,
  )
  await page.getByRole('button', { name: '撤销', exact: true }).click()
  expect((await elements(page)).map((el) => el.id).sort()).toEqual([source.id, blocker].sort())
  expect(await page.evaluate((id) => window.__plein.engine.doc.worldRect(id).x, source.id)).toBe(
    s!.x,
  )
  await page.getByRole('button', { name: '重做', exact: true }).click()
  expect((await elements(page)).find((el) => el.id === frame.id)?.kind).toBe('frame')
})

const shotGroup = (page: Page, frameId: string) =>
  page.evaluate(
    (id) => window.__plein.engine.doc.get(id)?.params?.shotGroup as { order: string[] } | undefined,
    frameId,
  )

test(
  '分镜组：宫格切分后自动编号，调顺序、排版，拼成大图并标出实际像素',
  { tag: '@core' },
  async ({ page }) => {
    await newProject(page)
    const chooser = page.waitForEvent('filechooser')
    await page.getByRole('button', { name: '上传' }).click()
    await (await chooser).setFiles(join(dir, 'storyboard.png'))
    await expect.poll(async () => (await elements(page)).length).toBe(1)
    const [source] = await elements(page)

    await clickElement(page, source!.id)
    await page
      .getByRole('toolbar', { name: '结果操作' })
      .getByRole('button', { name: '宫格切分' })
      .click()
    await page.getByRole('button', { name: /4 宫格/ }).click()
    await expect
      .poll(async () => (await elements(page)).filter((e) => e.kind === 'frame').length)
      .toBe(1)
    const frame = (await elements(page)).find((e) => e.kind === 'frame')!
    await expect.poll(async () => (await shotGroup(page, frame.id))?.order.length).toBe(4)
    const tiles = (await shotGroup(page, frame.id))!.order

    // 切出来的直接是分镜组，图上有序号
    await zoomTo(page, [frame.id])
    await expect(page.locator('.plein-shot-badge')).toHaveCount(4)
    await page.evaluate((id) => window.__plein.engine.selection.set([id]), frame.id)
    const bar = page.getByRole('toolbar', { name: 'Frame 操作' })
    await expect(bar.getByRole('button', { name: '分镜组' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await bar.getByRole('button', { name: '分镜组' }).click()
    const panel = page.getByRole('dialog', { name: '分镜组' })
    await expect(panel.getByRole('listitem')).toHaveCount(4)

    // 第 4 格挪到最前，排成一行
    await panel.getByRole('button', { name: '宫格 4上移' }).click()
    await panel.getByRole('button', { name: '宫格 4上移' }).click()
    await panel.getByRole('button', { name: '宫格 4上移' }).click()
    expect((await shotGroup(page, frame.id))!.order).toEqual([tiles[3], ...tiles.slice(0, 3)])
    await panel.getByRole('button', { name: '4 列' }).click()
    const ys = await page.evaluate(
      (ids) => ids.map((id) => window.__plein.engine.doc.worldRect(id).y),
      tiles,
    )
    expect(new Set(ys).size).toBe(1)
    await expect(page.locator(`[data-shot-badge="${tiles[3]}"]`)).toHaveText('1')
    await shoot(page, '1-panel')

    await panel.getByRole('button', { name: '拼成大图' }).click()
    await expect(page.getByText(/拼好了：\d+×\d+ 像素/)).toBeVisible()
    const collage = (await elements(page)).find(
      (e) => e.kind === 'image' && /拼图/.test(e.name ?? ''),
    )!
    expect(collage.name).toMatch(/\d+×\d+$/)
    const [w, h] = collage
      .name!.match(/(\d+)×(\d+)$/)!
      .slice(1)
      .map(Number)
    // 4 格一行，每格按切出来的原图 480×270，格间和四周 16px
    expect([w, h]).toEqual([480 * 4 + 16 * 5, 270 + 16 * 2])
    // 拼好后镜头会飞到新图，等它停稳再取景
    await settle(page, collage.id)
    await zoomTo(page, [frame.id, collage.id])
    await page.mouse.move(700, 120)
    await shoot(page, '2-collage')

    // 回到切分前的原图
    await page.evaluate((id) => window.__plein.engine.selection.set([id]), frame.id)
    await bar.getByRole('button', { name: '分镜组' }).click()
    await panel.getByRole('button', { name: '定位原图' }).click()
    await expect
      .poll(() => page.evaluate(() => window.__plein.engine.selection.values()))
      .toEqual([source!.id])
  },
)
