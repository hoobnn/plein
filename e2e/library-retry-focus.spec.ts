import { execFileSync } from 'node:child_process'
import { expect, type Page, test } from './fixtures'
import { solidPng } from '../packages/providers/src/mock/media'
import { newProject } from './canvas'
import { openLibraryPanel } from './library-ui'

let video: Buffer
test.beforeAll(() => {
  video = execFileSync('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=c=teal:s=64x64:d=1',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    'frag_keyframe+empty_moov',
    '-f',
    'mp4',
    'pipe:1',
  ])
})
async function fixture(page: Page, type: 'slot' | 'extra' | 'character' | 'profile' | 'video') {
  await newProject(page)
  const upload = await page.request.post('/api/assets', {
    headers: { 'Content-Type': type === 'video' ? 'video/mp4' : 'image/png' },
    data: type === 'video' ? video : Buffer.from(solidPng(80, 60, [20, 120, 180])),
  })
  expect(upload.status()).toBe(201)
  const asset = (await upload.json()).id as string
  const kind = type === 'slot' ? 'scene' : type === 'video' ? 'effect' : 'character'
  const name = `${type}键盘重试恢复`
  const created = await page.request.post('/api/library', {
    data: {
      kind,
      name,
      images:
        type === 'slot'
          ? [{ slot: 'main', assetId: asset }]
          : type === 'extra'
            ? [{ slot: 'extra', assetId: asset }]
            : type === 'character'
              ? [{ slot: 'portrait', assetId: asset }]
              : [],
      ...(type === 'profile'
        ? { profile: { periods: [{ id: 'teen', name: '少年', images: [asset] }] } }
        : {}),
      ...(type === 'video' ? { video: asset } : {}),
    },
  })
  expect(created.status()).toBe(201)
  const item = await created.json()
  return { asset, item, kind, name }
}
async function open(page: Page, kind: string, name: string) {
  const panel = await openLibraryPanel(page)
  await panel
    .getByRole('group', { name: '资产类别', exact: true })
    .getByRole('button', {
      name: kind === 'scene' ? '场景' : kind === 'effect' ? '特效' : '角色',
      exact: true,
    })
    .click()
  await panel
    .getByRole('group', { name: '范围', exact: true })
    .getByRole('button', { name: kind === 'effect' ? '我的' : '全部', exact: true })
    .click()
  await panel.getByRole('listitem').filter({ hasText: name }).getByRole('button').first().click()
  return panel
}

for (const type of ['slot', 'extra', 'character', 'profile'] as const) {
  test(`${type} 图片反复重试保留键盘位置，成功后不改档案或选择`, async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 650 })
    const f = await fixture(page, type)
    let fail = true
    await page.route(
      `**/api/assets/${f.asset}/${type === 'character' ? 'thumb-1024' : 'thumb-256'}`,
      (route) => (fail ? route.fulfill({ status: 503, body: 'unavailable' }) : route.continue()),
    )
    const panel = await open(page, f.kind, f.name)
    if (type === 'profile')
      await panel
        .getByRole('group', { name: '档案分页' })
        .getByRole('button', { name: /^时期与服饰/ })
        .click()
    const area =
      type === 'slot'
        ? panel
            .locator('.ui-field')
            .filter({ has: page.locator('.ui-label').filter({ hasText: '主场景图' }) })
            .last()
        : type === 'extra'
          ? panel.locator('.lib-character-extra-list')
          : type === 'character'
            ? panel.getByRole('region', { name: '肖像／半身图', exact: true })
            : panel.locator('.lib-look-editor .lib-strip-tile').first()
    const retry = area.getByRole('button', {
      name:
        type === 'slot'
          ? '重新加载主场景图 1'
          : type === 'extra'
            ? '重新加载预览其他参考 1'
            : type === 'character'
              ? '重新加载肖像／半身图'
              : '重新加载图片',
      exact: true,
    })
    const focus =
      type === 'profile'
        ? area
        : type === 'slot'
          ? area.getByRole('group', { name: '主场景图 1', exact: true })
          : area.getByRole('button', {
              name: type === 'extra' ? '预览其他参考 1' : '预览肖像／半身图',
              exact: true,
            })
    await expect(retry).toBeVisible()
    const before = await (await page.request.get(`/api/library/${f.item.id}`)).json()
    const pressed =
      type === 'extra' || type === 'character' ? await focus.getAttribute('aria-pressed') : null
    await retry.focus()
    await page.keyboard.press('Enter')
    await expect(retry).toBeVisible()
    await expect.poll(() => area.evaluate((el) => el.contains(document.activeElement))).toBe(true)
    await expect(focus).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(retry).toBeFocused()
    fail = false
    await page.keyboard.press('Enter')
    await expect
      .poll(() =>
        area
          .locator('img')
          .evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0),
      )
      .toBe(true)
    await expect(focus).toBeFocused()
    await expect(retry).toHaveCount(0)
    if (pressed !== null) await expect(focus).toHaveAttribute('aria-pressed', pressed)
    await expect(panel.getByRole('button', { name: '已保存', exact: true })).toBeDisabled()
    expect(await (await page.request.get(`/api/library/${f.item.id}`)).json()).toEqual(before)
    if (type === 'slot' || type === 'profile' || type === 'extra' || type === 'character') {
      const edge = (png: Buffer) => [
        ...execFileSync(
          'ffmpeg',
          [
            '-hide_banner',
            '-loglevel',
            'error',
            '-i',
            'pipe:0',
            '-vf',
            'crop=1:1:iw/2:0',
            '-frames:v',
            '1',
            '-f',
            'rawvideo',
            '-pix_fmt',
            'rgb24',
            'pipe:1',
          ],
          { input: png },
        ),
      ]
      const focused = edge(await focus.screenshot({ animations: 'disabled' }))
      await panel.getByRole('button', { name: '返回', exact: true }).focus()
      const unfocused = edge(await focus.screenshot({ animations: 'disabled' }))
      expect(focused).not.toEqual(unfocused)
      await focus.focus()
    }
    await panel.screenshot({
      path: test.info().outputPath(`${type}-retry-focus.png`),
      animations: 'disabled',
    })
  })
}

test('参考视频重试失败后仍可键盘再试，成功后聚焦播放控件并实际播放', async ({ page }) => {
  const f = await fixture(page, 'video')
  let fail = true
  await page.route(`**/api/assets/${f.asset}`, (route) =>
    fail ? route.fulfill({ status: 503, body: 'unavailable' }) : route.continue(),
  )
  const panel = await open(page, f.kind, f.name)
  const area = panel
    .locator('.ui-field')
    .filter({ has: page.locator('.ui-label').filter({ hasText: '参考视频' }) })
    .last()
  const retry = area.getByRole('button', { name: '重新加载参考视频', exact: true })
  await expect(retry).toBeVisible()
  await retry.focus()
  await page.keyboard.press('Enter')
  await expect(retry).toBeVisible()
  await expect(retry).toBeFocused()
  fail = false
  await page.keyboard.press('Enter')
  const player = area.locator('video')
  await expect.poll(() => player.evaluate((v: HTMLVideoElement) => v.readyState >= 2)).toBe(true)
  await expect(player).toBeFocused()
  await player.evaluate(async (v: HTMLVideoElement) => {
    await v.play()
  })
  await expect
    .poll(() => player.evaluate((v: HTMLVideoElement) => v.currentTime))
    .toBeGreaterThan(0)
  await expect(panel.getByRole('button', { name: '已保存', exact: true })).toBeDisabled()
})

test('参考视频重试等待时转去编辑名称，迟到失败不抢回焦点', async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 650 })
  const f = await fixture(page, 'video')
  let hold = false,
    arrived = false,
    release!: () => void
  const gate = new Promise<void>((r) => {
    release = r
  })
  await page.route(`**/api/assets/${f.asset}`, async (route) => {
    if (hold) {
      arrived = true
      await gate
    }
    await route.fulfill({ status: 503, body: 'unavailable' })
  })
  try {
    const panel = await open(page, f.kind, f.name)
    const area = panel
      .locator('.ui-field')
      .filter({ has: page.locator('.ui-label').filter({ hasText: '参考视频' }) })
      .last()
    const retry = area.getByRole('button', { name: '重新加载参考视频', exact: true })
    await expect(retry).toBeVisible()
    hold = true
    await retry.click()
    await expect.poll(() => arrived).toBe(true)
    const name = panel.getByRole('textbox', { name: '名称', exact: true })
    await name.focus()
    release()
    await expect(retry).toBeVisible()
    await expect(name).toBeFocused()
    await expect(name).toHaveValue(f.name)
    await expect(panel.getByRole('button', { name: '已保存', exact: true })).toBeDisabled()
  } finally {
    release()
  }
})

test('保存等待保留面板内的键盘位置，转去名称字段后完成不抢焦点', async ({ page }) => {
  const f = await fixture(page, 'extra')
  const panel = await open(page, f.kind, f.name)
  const name = panel.getByRole('textbox', { name: '名称', exact: true })
  await name.fill(`${f.name}已修改`)
  let arrived = false,
    release!: () => void
  const gate = new Promise<void>((r) => {
    release = r
  })
  await page.route(`**/api/library/${f.item.id}`, async (route) => {
    if (route.request().method() !== 'PATCH') return route.continue()
    const response = await route.fetch()
    arrived = true
    await gate
    await route.fulfill({ response })
  })
  try {
    await panel.getByRole('button', { name: '保存', exact: true }).click()
    await expect.poll(() => arrived).toBe(true)
    await expect(panel.getByRole('group', { name: '资产操作', exact: true })).toBeFocused()
    await name.focus()
    release()
    await expect(panel.getByRole('button', { name: '已保存', exact: true })).toBeDisabled()
    await expect(name).toBeFocused()
    expect((await (await page.request.get(`/api/library/${f.item.id}`)).json()).name).toBe(
      `${f.name}已修改`,
    )
  } finally {
    release()
  }
})
