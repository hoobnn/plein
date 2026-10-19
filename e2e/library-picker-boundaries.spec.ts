import { execFileSync } from 'node:child_process'
import { expect, type Locator, type Page, test } from '@playwright/test'
import { solidPng } from '../packages/providers/src/mock/media'
import { newProject } from './canvas'
import { openLibraryPanel } from './library-ui'

async function fixture(
  page: Page,
  missing = false,
  kind: 'scene' | 'character' | 'effect' = 'scene',
) {
  await newProject(page)
  const assets: string[] = []
  for (let i = 0; i < 12; i++) {
    const upload = await page.request.post('/api/assets', {
      headers: { 'Content-Type': 'image/png' },
      data: Buffer.from(solidPng(80, 60, [30 + i * 8, 100, 160])),
    })
    expect(upload.status()).toBe(201)
    assets.push((await upload.json()).id)
  }
  if (kind === 'effect') {
    const video = execFileSync('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=teal:s=160x90:d=1',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      'frag_keyframe+empty_moov',
      '-f',
      'mp4',
      'pipe:1',
    ])
    const upload = await page.request.post('/api/assets', {
      headers: { 'Content-Type': 'video/mp4' },
      data: video,
    })
    expect(upload.status()).toBe(201)
    assets.push((await upload.json()).id)
  }
  const names = assets.map((_, i) =>
    i === 11 ? `角色_${'W'.repeat(180)}.png` : `候选参考 ${i + 1}`,
  )
  await page.evaluate(
    ({ assets, names }) => {
      const e = window.__plein.engine as typeof window.__plein.engine & {
        paste(data: unknown): void
      }
      e.paste({
        plein: 1,
        edges: [],
        elements: assets.map((assetId, i) => ({
          id: `ref-${i}`,
          kind: i === 12 ? 'video' : 'image',
          name: names[i],
          assetId,
          x: 300 + (i % 4) * 300,
          y: 200 + Math.floor(i / 4) * 180,
          w: 160,
          h: 120,
          parentId: null,
        })),
      })
    },
    { assets, names },
  )
  const name = `选材边界 ${page.url().split('/').at(-1)}`
  const response = await page.request.post('/api/library', {
    data: {
      kind,
      name,
      description: '保留手写场景设定',
      images: missing ? [{ slot: 'main', assetId: assets[0] }] : [],
      ...(kind === 'character'
        ? { profile: { periods: [{ id: 'teen', name: '少年', images: assets.slice(0, 3) }] } }
        : {}),
    },
  })
  expect(response.status()).toBe(201)
  const item = await response.json()
  const panel = await openLibraryPanel(page)
  await panel
    .getByRole('group', { name: '资产类别', exact: true })
    .getByRole('button', {
      name: kind === 'scene' ? '场景' : kind === 'character' ? '角色' : '特效',
      exact: true,
    })
    .click()
  await panel
    .getByRole('group', { name: '范围', exact: true })
    .getByRole('button', { name: kind === 'effect' ? '我的' : '全部', exact: true })
    .click()
  await panel.getByRole('listitem').filter({ hasText: name }).getByRole('button').first().click()
  const field = (label: string) =>
    panel
      .locator('.ui-field')
      .filter({ has: page.locator('.ui-label').filter({ hasText: label }) })
      .last()
  return {
    assets,
    names,
    item,
    panel,
    field,
    read: async () => (await page.request.get(`/api/library/${item.id}`)).json(),
  }
}
async function picker(page: Page, field: Locator) {
  const trigger = field.getByRole('button', { name: '从画布选', exact: true })
  await trigger.click()
  const menu = page.getByRole('dialog', { name: '从画布选', exact: true })
  await expect(menu).toBeVisible()
  return { trigger, menu }
}
async function fits(page: Page) {
  const menu = page.getByRole('dialog', { name: '从画布选', exact: true })
  await expect
    .poll(async () => {
      const r = await menu.boundingBox(),
        v = page.viewportSize()!
      return (
        !!r &&
        r.x >= 8 &&
        r.y >= 8 &&
        r.x + r.width <= v.width - 8 &&
        r.y + r.height <= v.height - 8
      )
    })
    .toBe(true)
}
async function save(f: Awaited<ReturnType<typeof fixture>>) {
  await f.panel.getByRole('button', { name: '保存', exact: true }).click()
  await expect(f.panel.getByRole('button', { name: '已保存', exact: true })).toBeDisabled()
  return f.read()
}

for (const height of [640, 320]) {
  test(`320×${height} 画布选材菜单完整落在窗口内，末项可选择并保存正确素材`, async ({ page }) => {
    await page.setViewportSize({ width: 320, height })
    const f = await fixture(page)
    const { menu } = await picker(page, f.field('主场景图'))
    await fits(page)
    const last = menu.getByRole('button', { name: `选择图片「${f.names[11]}」`, exact: true })
    await last.scrollIntoViewIfNeeded()
    await expect(last).toBeInViewport({ ratio: 1 })
    const r = (await last.boundingBox())!
    expect(r.width).toBeGreaterThanOrEqual(40)
    expect(r.height).toBeGreaterThanOrEqual(40)
    await page.screenshot({ path: test.info().outputPath(`picker-${height}.png`) })
    await last.click()
    await expect(menu).toHaveCount(0)
    expect((await save(f)).images).toEqual([{ slot: 'main', assetId: f.assets[11] }])
  })
}

test('选材菜单保持打开时缩窄窗口，位置跟随且 Esc 只关闭选材层', async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 640 })
  const f = await fixture(page)
  const { menu, trigger } = await picker(page, f.field('主场景图'))
  await page.setViewportSize({ width: 320, height: 640 })
  await fits(page)
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  await expect(f.panel).toBeVisible()
  await expect(trigger).toBeFocused()
  expect((await f.read()).images).toEqual([])
})

test('候选长文件名完整提示且文字不溢出，选择后保存的是对应素材', async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 640 })
  const f = await fixture(page)
  const { menu } = await picker(page, f.field('主场景图'))
  const last = menu.getByRole('button', { name: `选择图片「${f.names[11]}」`, exact: true })
  await last.hover()
  const tip = page.getByRole('tooltip')
  await expect(tip).toHaveText(f.names[11]!)
  await expect.poll(() => tip.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
  await page.screenshot({ path: test.info().outputPath('picker-long-name.png') })
  await last.click()
  expect((await save(f)).images).toEqual([{ slot: 'main', assetId: f.assets[11] }])
})

test('单选完成后移除选材入口，键盘位置仍留在当前图片字段', async ({ page }) => {
  const f = await fixture(page)
  const field = f.field('主场景图')
  const { menu } = await picker(page, field)
  await menu.getByRole('button', { name: `选择图片「${f.names[0]}」`, exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect(menu).toHaveCount(0)
  await expect(field.getByRole('button', { name: '移除', exact: true })).toBeVisible()
  await expect
    .poll(() =>
      field.evaluate((el) => {
        const active = document.activeElement
        return JSON.stringify({
          inside: el.contains(active),
          tag: active?.tagName,
          label: active?.getAttribute('aria-label'),
          classes: active?.className,
        })
      }),
    )
    .toContain('"inside":true')
  expect((await save(f)).images).toEqual([{ slot: 'main', assetId: f.assets[0] }])
})

test('多选后已用候选禁用，键盘可继续选下一项，Esc 回到原入口', async ({ page }) => {
  const f = await fixture(page)
  const { menu, trigger } = await picker(page, f.field('多角度'))
  const first = menu.getByRole('button', { name: `选择图片「${f.names[0]}」`, exact: true })
  const second = menu.getByRole('button', { name: `选择图片「${f.names[1]}」`, exact: true })
  await first.focus()
  await page.keyboard.press('Enter')
  await expect(first).toBeDisabled()
  await expect(menu).toBeVisible()
  await expect(second).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(second).toBeDisabled()
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  await expect(trigger).toBeFocused()
  expect((await save(f)).images).toEqual(
    f.assets.slice(0, 2).map((assetId) => ({ slot: 'angle', assetId })),
  )
})

test('持续 404 的旧缩略图可移除并换成画布素材，保留文字设定', async ({ page }) => {
  const f = await fixture(page, true)
  await page.route(`**/api/assets/${f.assets[0]}/thumb-256`, (route) =>
    route.fulfill({ status: 404, body: 'not found' }),
  )
  // 重新进入编辑页，让故障覆盖新加载的旧缩略图。
  await f.panel.getByRole('button', { name: '返回', exact: true }).click()
  await f.panel
    .getByRole('listitem')
    .filter({ hasText: f.item.name })
    .getByRole('button')
    .first()
    .click()
  const field = f.field('主场景图')
  const retry = field.getByRole('button', { name: '重新加载主场景图 1', exact: true })
  await expect(retry).toBeVisible()
  await retry.click()
  await expect(retry).toBeVisible()
  await field.getByRole('button', { name: '移除', exact: true }).click()
  const { menu } = await picker(page, field)
  await menu.getByRole('button', { name: `选择图片「${f.names[1]}」`, exact: true }).click()
  const saved = await save(f)
  expect(saved.images).toEqual([{ slot: 'main', assetId: f.assets[1] }])
  expect(saved.description).toBe('保留手写场景设定')
})

test('档案参考图选满四张后选材入口退出，焦点保留在参考图字段且保存顺序正确', async ({ page }) => {
  const f = await fixture(page, false, 'character')
  await f.panel
    .getByRole('group', { name: '档案分页' })
    .getByRole('button', { name: /^时期与服饰/ })
    .click()
  const field = f.field('参考图')
  const { menu } = await picker(page, field)
  for (const name of f.names.slice(0, 3))
    await expect(
      menu.getByRole('button', { name: `选择图片「${name}」`, exact: true }),
    ).toBeDisabled()
  await menu.getByRole('button', { name: `选择图片「${f.names[3]}」`, exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect(menu).toHaveCount(0)
  await expect(field.locator('.lib-strip-tile')).toHaveCount(4)
  await expect(field).toBeFocused()
  expect((await save(f)).profile.periods[0].images).toEqual(f.assets.slice(0, 4))
})

test('视频单选和移除后键盘位置留在当前字段，保存的引用与播放素材一致', async ({ page }) => {
  const f = await fixture(page, false, 'effect')
  const field = f.field('参考视频')
  const { menu } = await picker(page, field)
  await menu.getByRole('button', { name: `选择视频「${f.names[12]}」`, exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect(menu).toHaveCount(0)
  await expect(field).toBeFocused()
  const player = field.locator('video')
  await expect(player).toHaveAttribute('src', new RegExp(f.assets[12]!))
  await expect.poll(() => player.evaluate((v: HTMLVideoElement) => v.readyState >= 2)).toBe(true)
  expect((await save(f)).video).toBe(f.assets[12])
  await field.getByRole('button', { name: '移除', exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect(field).toBeFocused()
  expect((await save(f)).video).toBeNull()
})
