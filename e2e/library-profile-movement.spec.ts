import { expect, type Page, test } from '@playwright/test'
import { solidPng } from '../packages/providers/src/mock/media'
import { newProject } from './canvas'
import { openLibraryPanel } from './library-ui'

const images = [
  {
    name: 'profile-original.png',
    mimeType: 'image/png',
    buffer: Buffer.from(solidPng(64, 48, [30, 110, 170])),
  },
  {
    name: 'profile-new.png',
    mimeType: 'image/png',
    buffer: Buffer.from(solidPng(64, 48, [180, 80, 40])),
  },
]
const assets: string[] = []
test.beforeAll(async ({ request }) => {
  for (const file of images) {
    const response = await request.post('/api/assets', {
      headers: { 'Content-Type': file.mimeType },
      data: file.buffer,
    })
    expect(response.status()).toBe(201)
    assets.push((await response.json()).id)
  }
})
const look = (id: string, name: string) => ({
  id,
  name,
  aliases: [`旧${name}`],
  description: `保留${name}材质`,
  images: [assets[0]],
})
const initial = () => ({
  periods: [
    {
      id: 'teen',
      name: '少年',
      description: '保留少年样貌',
      voice: { provider: 'mock', voiceId: 'teen' },
      images: [assets[0]],
      outfits: [look('uniform', '校服')],
    },
    { id: 'youth', name: '青年', description: '保留青年样貌' },
    { id: 'adult', name: '成年', description: '保留成年样貌' },
  ],
  expressions: [look('happy', '开心')],
})
async function fixture(page: Page, data: unknown = initial(), expression = false) {
  const duplicateKeys: string[] = []
  page.on('console', (message) => {
    if (
      message.type() === 'error' &&
      message.text().includes('Encountered two children with the same key')
    )
      duplicateKeys.push(message.text())
  })
  await newProject(page)
  const name = `档案移动 ${page.url().split('/').at(-1)}`
  const created = await page.request.post('/api/library', {
    data: { kind: 'character', name, profile: data },
  })
  expect(created.status()).toBe(201)
  const item = await created.json()
  const panel = await openLibraryPanel(page)
  await panel
    .getByRole('group', { name: '范围', exact: true })
    .getByRole('button', { name: '全部', exact: true })
    .click()
  await panel.getByRole('listitem').filter({ hasText: name }).getByRole('button').first().click()
  await panel
    .getByRole('group', { name: '档案分页', exact: true })
    .getByRole('button', { name: expression ? /^表情/ : /^时期与服饰/ })
    .click()
  const save = async () => {
    expect(duplicateKeys).toEqual([])
    await panel.getByRole('button', { name: '保存', exact: true }).click()
    await expect(panel.getByRole('button', { name: '已保存', exact: true })).toBeDisabled()
    return (await (await page.request.get(`/api/library/${item.id}`)).json()).profile
  }
  return { panel, item, save }
}

test('时期往返排序后键盘回到移动的时期，顺序之外所有档案素材保持完整', async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 650 })
  const f = await fixture(page)
  const current = f.panel.locator('.lib-lane-period').filter({ hasText: '少年' })
  for (let step = 1; step <= 2; step++) {
    await f.panel.getByRole('button', { name: '往后挪', exact: true }).focus()
    await page.keyboard.press('Enter')
    await expect(current).toBeFocused()
    await expect(current).toBeInViewport({ ratio: 1 })
    await expect(f.panel.getByRole('textbox', { name: '时期名', exact: true })).toHaveValue('少年')
  }
  await expect(f.panel.getByRole('button', { name: '往后挪', exact: true })).toBeDisabled()
  const moved = await f.save()
  expect(moved).toEqual({
    ...f.item.profile,
    periods: [f.item.profile.periods[1], f.item.profile.periods[2], f.item.profile.periods[0]],
  })
  for (let step = 1; step <= 2; step++) {
    await f.panel.getByRole('button', { name: '往前挪', exact: true }).focus()
    await page.keyboard.press('Enter')
    await expect(current).toBeFocused()
  }
  await expect(f.panel.getByRole('button', { name: '往前挪', exact: true })).toBeDisabled()
  expect(await f.save()).toEqual(f.item.profile)
})

test('服饰跨时期移动跳过已满目标，取消和原值不抢焦点，往返移动正确保留图片与旧名', async ({
  page,
}) => {
  await page.setViewportSize({ width: 800, height: 650 })
  const data = initial()
  const full = {
    ...data.periods[1],
    outfits: Array.from({ length: 12 }, (_, i) => look(`filled${i}`, `青年服饰${i + 1}`)),
  }
  const f = await fixture(page, { ...data, periods: [data.periods[0], full, data.periods[2]] })
  await f.panel.getByRole('button', { name: '少年 · 校服', exact: true }).click()
  const belongs = f.panel.getByRole('combobox', { name: '属于时期', exact: true })
  await belongs.click()
  await expect(page.getByRole('option', { name: /青年/ })).toHaveAttribute('aria-disabled', 'true')
  await page.keyboard.press('Escape')
  await expect(belongs).toBeFocused()
  await belongs.click()
  await page.getByRole('option', { name: '少年', exact: true }).click()
  await expect(belongs).toBeFocused()
  await expect(f.panel.getByRole('button', { name: '已保存', exact: true })).toBeDisabled()
  await belongs.click()
  await expect(page.getByRole('option', { name: '少年', exact: true })).toBeFocused()
  await page.keyboard.press('End')
  await expect(page.getByRole('option', { name: '成年', exact: true })).toBeFocused()
  await page.keyboard.press('Enter')
  const name = f.panel.getByRole('textbox', { name: '服饰名', exact: true })
  await expect(belongs).toHaveText('成年')
  await expect(name).toBeFocused()
  await expect(name).toBeInViewport({ ratio: 1 })
  await expect(f.panel.locator('.lib-look-editor .lib-strip-tile img')).toHaveAttribute(
    'src',
    new RegExp(assets[0]!),
  )
  await f.panel.screenshot({
    path: test.info().outputPath('outfit-move-focus.png'),
    animations: 'disabled',
  })
  const expected = structuredClone(f.item.profile)
  expected.periods[2].outfits.push(expected.periods[0].outfits.shift())
  expect(await f.save()).toEqual(expected)
  await belongs.click()
  await page.getByRole('option', { name: '少年', exact: true }).click()
  await expect(name).toBeFocused()
  await expect(belongs).toHaveText('少年')
  expect(await f.save()).toEqual(f.item.profile)
})

for (const role of ['服饰', '表情'] as const) {
  test(`${role}添加至上限后新名称完整可见，上传素材只写入新项，删除后完整恢复原档案`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 800, height: 650 })
    const count = role === '服饰' ? 11 : 23
    const originals = Array.from({ length: count }, (_, i) =>
      look(`original${i}`, `${role}${i + 1}`),
    )
    const data =
      role === '服饰'
        ? { periods: [{ id: 'teen', name: '少年', outfits: originals }] }
        : { expressions: originals }
    const f = await fixture(page, data, role === '表情')
    const label = role === '服饰' ? '加服饰' : '添加表情'
    const preset = role === '服饰' ? '校服' : '开心'
    const add = f.panel.getByRole('button', { name: label, exact: true })
    // 添加入口贴着滚动区底边：新名称框出现在可视区下方，按底边对齐，最能暴露入场动画后的裁切。
    await add.evaluate((el) => el.scrollIntoView({ block: 'end' }))
    await add.click()
    const choice = f.panel
      .locator('.lib-add-pop')
      .getByRole('button', { name: preset, exact: true })
    await choice.focus()
    await page.keyboard.press('Enter')
    const name = f.panel.getByRole('textbox', {
      name: role === '服饰' ? '服饰名' : '名字',
      exact: true,
    })
    await expect(name).toBeFocused()
    await expect(name).toBeInViewport({ ratio: 1 })
    await expect(name).toHaveValue(preset)
    await expect(f.panel.getByRole('button', { name: label, exact: true })).toHaveCount(0)
    const field = f.panel
      .locator('.lib-look-editor')
      .getByRole('group', { name: '参考图', exact: true })
    const chooser = page.waitForEvent('filechooser')
    await field.getByRole('button', { name: '上传', exact: true }).click()
    await (await chooser).setFiles(images[1]!)
    await expect(field.locator('img')).toHaveAttribute('src', new RegExp(assets[1]!))
    await expect(field).toBeFocused()
    const saved = await f.save()
    const list = role === '服饰' ? saved.periods[0].outfits : saved.expressions
    const before = role === '服饰' ? f.item.profile.periods[0].outfits : f.item.profile.expressions
    expect(list.slice(0, count)).toEqual(before)
    expect(list).toHaveLength(count + 1)
    expect(list[count]).toMatchObject({ name: preset, images: [assets[1]] })
    await f.panel.screenshot({
      path: test.info().outputPath(`profile-${role}-capacity.png`),
      animations: 'disabled',
    })
    const remove =
      role === '服饰'
        ? f.panel.getByRole('button', { name: `删除服饰「${preset}」`, exact: true })
        : f.panel.locator('.lib-look-editor').getByRole('button', { name: '删除', exact: true })
    await remove.focus()
    await page.keyboard.press('Enter')
    await expect(f.panel.getByRole('button', { name: label, exact: true })).toBeVisible()
    expect(await f.save()).toEqual(f.item.profile)
  })
}

test('卡片预览允许服饰复用同一图片，无图服饰计入余量，收藏重绘不重复或漏图', async ({ page }) => {
  const duplicateKeys: string[] = []
  page.on('console', (message) => {
    if (
      message.type() === 'error' &&
      message.text().includes('Encountered two children with the same key')
    )
      duplicateKeys.push(message.text())
  })
  await newProject(page)
  const name = `共享服饰预览 ${page.url().split('/').at(-1)}`
  const response = await page.request.post('/api/library', {
    data: {
      kind: 'character',
      name,
      profile: {
        periods: [
          {
            id: 'teen',
            name: '少年',
            images: [assets[1]],
            outfits: [look('first', '常服'), look('second', '礼服'), { id: 'third', name: '雨衣' }],
          },
          {
            id: 'youth',
            name: '青年',
            images: [assets[1]],
            outfits: [
              look('first-y', '便装'),
              look('second-y', '外套'),
              look('third-y', '运动装'),
              { id: 'fourth-y', name: '泳衣' },
              { id: 'fifth-y', name: '工作服' },
            ],
          },
        ],
      },
    },
  })
  expect(response.status()).toBe(201)
  const item = await response.json()
  const panel = await openLibraryPanel(page)
  await panel
    .getByRole('group', { name: '范围', exact: true })
    .getByRole('button', { name: '全部', exact: true })
    .click()
  const card = panel.getByRole('listitem').filter({ hasText: name })
  await expect(card.locator('.lib-card-cover > img')).toHaveAttribute(
    'src',
    `/api/assets/${assets[1]}/thumb-256`,
  )
  await card.hover()
  const rows = card.locator('.lib-card-peek-row')
  await expect(rows).toHaveCount(2)
  const row = rows.first()
  await expect(rows.last().locator('img')).toHaveCount(3)
  await expect(rows.last().locator('.lib-card-peek-more')).toHaveText('+3')
  await expect(row.locator('img')).toHaveCount(3)
  await expect(row.locator('.lib-card-peek-more')).toHaveText('+1')
  expect(
    await row
      .locator('img')
      .evaluateAll((nodes) => nodes.map((node) => (node as HTMLImageElement).getAttribute('src'))),
  ).toEqual([assets[1], assets[0], assets[0]].map((id) => `/api/assets/${id}/thumb-256`))
  await card.getByRole('button', { name: '收藏', exact: true }).click()
  await expect(card.getByRole('button', { name: '取消收藏', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(row.locator('img')).toHaveCount(3)
  await expect(row.locator('.lib-card-peek-more')).toHaveText('+1')
  expect(duplicateKeys).toEqual([])
  expect((await (await page.request.get(`/api/library/${item.id}`)).json()).profile).toEqual(
    item.profile,
  )
  await expect
    .poll(() =>
      card
        .locator('.lib-card-cover > img')
        .evaluate((img) => (img as HTMLImageElement).naturalWidth),
    )
    .toBeGreaterThan(0)
  await card.screenshot({
    path: test.info().outputPath('shared-outfit-card.png'),
    animations: 'disabled',
  })
  const updated = await page.request.patch(`/api/library/${item.id}`, {
    data: { images: [{ slot: 'full_body', assetId: assets[0] }] },
  })
  expect(updated.ok()).toBe(true)
  await panel.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(panel).toHaveCount(0)
  await openLibraryPanel(page)
  await panel
    .getByRole('group', { name: '范围', exact: true })
    .getByRole('button', { name: '全部', exact: true })
    .click()
  await expect(card.locator('.lib-card-cover > img')).toHaveAttribute(
    'src',
    `/api/assets/${assets[0]}/thumb-256`,
  )
  await expect
    .poll(() =>
      card
        .locator('.lib-card-cover > img')
        .evaluate((img) => (img as HTMLImageElement).naturalWidth),
    )
    .toBeGreaterThan(0)
  expect((await (await page.request.get(`/api/library/${item.id}`)).json()).profile).toEqual(
    item.profile,
  )
})
