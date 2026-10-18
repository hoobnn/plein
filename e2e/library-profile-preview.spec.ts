import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, type Locator, type Page, test } from '@playwright/test'
import { newProject } from './canvas'

let dir = ''
test.beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'plein-profile-preview-'))
  for (const color of ['blue', 'red', 'green', 'orange'])
    execFileSync('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      `color=c=${color}:s=64x64`,
      '-frames:v',
      '1',
      join(dir, `${color}.png`),
    ])
})
test.afterAll(() => rmSync(dir, { recursive: true, force: true }))
async function images(page: Page) {
  const ids: string[] = []
  for (const color of ['blue', 'red', 'green', 'orange']) {
    const response = await page.request.post('/api/assets', {
      headers: { 'content-type': 'image/png', 'x-file-name': `${color}.png` },
      data: readFileSync(join(dir, `${color}.png`)),
    })
    expect(response.status()).toBe(201)
    ids.push((await response.json()).id)
  }
  return ids
}
async function open(page: Page, name: string, tab: RegExp) {
  await page.getByRole('button', { name: '资产库', exact: true }).click()
  const panel = page.getByRole('dialog', { name: '资产库', exact: true })
  await panel
    .getByRole('group', { name: '范围' })
    .getByRole('button', { name: '全部', exact: true })
    .click()
  await panel.getByRole('listitem').filter({ hasText: name }).getByRole('button').first().click()
  await panel.getByRole('group', { name: '档案分页' }).getByRole('button', { name: tab }).click()
  return panel
}
async function hero(panel: Locator, id: string) {
  await expect(panel.locator('.lib-hero img').last()).toHaveAttribute('src', new RegExp(id))
  await expect
    .poll(() =>
      panel
        .locator('.lib-hero img')
        .last()
        .evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0),
    )
    .toBe(true)
}
async function save(panel: Locator) {
  await panel.getByRole('button', { name: '保存', exact: true }).click()
  await expect(panel.getByRole('button', { name: '已保存', exact: true })).toBeDisabled()
}

test('表情重命名同步大图标题，收起与删除后不残留旧预览', async ({ page }) => {
  await newProject(page)
  const [base, happy, sad] = await images(page)
  const created = await page.request.post('/api/library', {
    data: {
      kind: 'character',
      name: '表情预览一致性',
      images: [{ slot: 'portrait', assetId: base }],
      profile: {
        expressions: [
          { id: 'happy', name: '开心', images: [happy] },
          { id: 'sad', name: '难过', images: [sad] },
        ],
      },
    },
  })
  const item = await created.json()
  const panel = await open(page, '表情预览一致性', /^表情/)
  await panel.getByRole('button', { name: '编辑「开心」', exact: true }).click()
  const name = panel.getByRole('textbox', { name: '名字', exact: true })
  await name.fill('微笑')
  await name.blur()
  await expect(panel.locator('.lib-hero-caption')).toContainText('微笑')
  await hero(panel, happy!)
  await save(panel)
  await panel.getByRole('button', { name: '编辑「微笑」', exact: true }).click()
  await page.mouse.move(5, 5)
  await expect(panel.locator('.lib-look-editor')).toHaveCount(0)
  await hero(panel, base!)
  await expect(panel.locator('.lib-hero-caption')).not.toContainText('微笑')
  await panel.screenshot({
    path: test.info().outputPath('expression-collapsed.png'),
    animations: 'disabled',
  })
  await panel.getByRole('button', { name: '编辑「难过」', exact: true }).click()
  await hero(panel, sad!)
  await panel.locator('.lib-look-editor').getByRole('button', { name: '删除', exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect(panel.locator('.lib-look-editor')).toHaveCount(0)
  await hero(panel, base!)
  await save(panel)
  const saved = await (await page.request.get(`/api/library/${item.id}`)).json()
  expect(saved.profile.expressions).toEqual([
    { id: 'happy', name: '微笑', aliases: ['开心'], description: '', images: [happy] },
  ])
  await panel.getByRole('button', { name: '编辑「微笑」', exact: true }).hover()
  await hero(panel, happy!)
  await panel.getByRole('button', { name: '角色资产', exact: true }).focus()
  await page.keyboard.press('Enter')
  await hero(panel, base!)
  await expect(panel.locator('.lib-hero-caption')).not.toContainText('微笑')
})

test('悬停从时期移到基础参考后保持新预览，移开再恢复选中时期', async ({ page }) => {
  await newProject(page)
  const [base, teen, , portrait] = await images(page)
  await page.request.post('/api/library', {
    data: {
      kind: 'character',
      name: '跨区域悬停回归',
      images: [
        { slot: 'full_body', assetId: base },
        { slot: 'portrait', assetId: portrait },
      ],
      profile: { periods: [{ id: 'teen', name: '少年', images: [teen] }] },
    },
  })
  const panel = await open(page, '跨区域悬停回归', /^时期与服饰/)
  await panel.locator('.lib-lane-period').first().hover()
  await hero(panel, teen!)
  await panel
    .getByRole('list', { name: '参考图', exact: true })
    .getByRole('button', { name: '肖像／半身图', exact: true })
    .hover()
  await hero(panel, portrait!)
  await page.mouse.move(5, 5)
  await hero(panel, teen!)
})

for (const role of ['时期', '服饰'] as const) {
  test(`${role}缩略图仍在鼠标下时重命名，大图标题和保存内容同步`, async ({ page }) => {
    await newProject(page)
    const [base, teen, outfit] = await images(page)
    const assetName = `${role}悬停改名回归`
    const created = await page.request.post('/api/library', {
      data: {
        kind: 'character',
        name: assetName,
        images: [{ slot: 'portrait', assetId: base }],
        profile: {
          periods: [
            {
              id: 'teen',
              name: '少年',
              images: [teen],
              outfits: [{ id: 'uniform', name: '校服', images: [outfit] }],
            },
          ],
        },
      },
    })
    const item = await created.json()
    const panel = await open(page, assetName, /^时期与服饰/)
    if (role === '时期') await panel.locator('.lib-lane-period').first().click()
    else await panel.getByRole('button', { name: '少年 · 校服', exact: true }).click()
    const name = panel.getByRole('textbox', {
      name: role === '时期' ? '时期名' : '服饰名',
      exact: true,
    })
    await name.fill(role === '时期' ? '青年' : '运动服')
    await name.blur()
    await expect(panel.locator('.lib-hero-caption')).toContainText(
      role === '时期' ? '青年时期' : '少年 · 运动服',
    )
    await hero(panel, role === '时期' ? teen! : outfit!)
    await save(panel)
    const saved = (await (await page.request.get(`/api/library/${item.id}`)).json()).profile
      .periods[0]
    expect(role === '时期' ? saved : saved.outfits[0]).toMatchObject({
      name: role === '时期' ? '青年' : '运动服',
      aliases: [role === '时期' ? '少年' : '校服'],
      images: [role === '时期' ? teen : outfit],
    })
  })
}

test('时期排序保持选中项，逐次删除切到相邻项，删空后恢复基础参考且素材仍在', async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 560 })
  await newProject(page)
  const [base, teen, youth, adult] = await images(page)
  const created = await page.request.post('/api/library', {
    data: {
      kind: 'character',
      name: '时期删除预览一致性',
      images: [{ slot: 'portrait', assetId: base }],
      profile: {
        periods: [
          { id: 'teen', name: '少年', images: [teen], outfits: [{ id: 'uniform', name: '校服' }] },
          { id: 'youth', name: '青年', images: [youth] },
          { id: 'adult', name: '成年', images: [adult] },
        ],
      },
    },
  })
  const item = await created.json()
  const panel = await open(page, '时期删除预览一致性', /^时期与服饰/)
  await panel.locator('.lib-lane-period').filter({ hasText: '青年' }).click()
  const name = panel.getByRole('textbox', { name: '时期名', exact: true })
  await panel.getByRole('button', { name: '往前挪', exact: true }).click()
  await expect(name).toHaveValue('青年')
  await expect(panel.locator('.lib-lane-period').first()).toContainText('青年')
  await hero(panel, youth!)
  await panel.getByRole('button', { name: '往后挪', exact: true }).click()
  await expect(panel.locator('.lib-lane-period').first()).toContainText('少年')
  await panel.getByRole('button', { name: '删除时期「青年」', exact: true }).click()
  await expect(name).toHaveValue('少年')
  await hero(panel, teen!)
  await panel.getByRole('button', { name: '删除时期「少年」', exact: true }).click()
  await expect(name).toHaveValue('成年')
  await hero(panel, adult!)
  await save(panel)
  expect(
    (await (await page.request.get(`/api/library/${item.id}`)).json()).profile.periods.map(
      (p: { id: string }) => p.id,
    ),
  ).toEqual(['adult'])
  await panel.getByRole('button', { name: '删除时期「成年」', exact: true }).click()
  await expect(panel.locator('.lib-look-editor')).toHaveCount(0)
  await hero(panel, base!)
  await save(panel)
  expect((await (await page.request.get(`/api/library/${item.id}`)).json()).profile).toBeNull()
  for (const id of [base, teen, youth, adult])
    expect((await page.request.get(`/api/assets/${id}/meta`)).ok()).toBe(true)
})
