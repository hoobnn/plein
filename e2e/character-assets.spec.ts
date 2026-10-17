import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, type Locator, type Page, test } from '@playwright/test'
import { byName, edgesInto, elements, newProject } from './canvas'

interface LibraryItem {
  id: string
  name: string
  images: Array<{ slot: string; assetId: string }>
  profile: unknown
}

const SLOTS = [
  { id: 'full_body', label: '全身定妆图' },
  { id: 'portrait', label: '肖像／半身图' },
  { id: 'face_grid', label: '情绪九宫格' },
  { id: 'character_3view', label: '角色设定图' },
] as const

let dir = ''
const created: string[] = []
const file = (index: number) => join(dir, `character-${index}.png`)
const slot = (panel: Locator, id: string) => panel.locator(`[data-character-slot="${id}"]`)
const readItem = async (page: Page, id: string) =>
  (await (await page.request.get(`/api/library/${id}`)).json()) as LibraryItem

test.beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'plein-e2e-character-assets-'))
  // 竖图、方图、横向设定板覆盖完整预览的三种比例；每张颜色不同，资产 id 也不同。
  const colors = ['red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink']
  for (let index = 0; index < 25; index++) {
    const color = colors[index % colors.length]!
    const size = index === 3 ? '192x64' : index === 2 ? '128x128' : `${64 + index * 2}x128`
    execFileSync('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      `color=c=${color}:s=${size}`,
      '-frames:v',
      '1',
      file(index),
    ])
  }
})

test.afterEach(async ({ request }) => {
  for (const id of created.splice(0)) await request.delete(`/api/library/${id}`)
})
test.afterAll(() => rmSync(dir, { recursive: true, force: true }))

async function uploadedImages(page: Page, count = 8) {
  const ids: string[] = []
  for (let index = 0; index < count; index++) {
    const response = await page.request.post('/api/assets', {
      headers: { 'content-type': 'image/png', 'x-file-name': `character-${index}.png` },
      data: readFileSync(file(index)),
    })
    expect(response.status(), await response.text()).toBe(201)
    ids.push(((await response.json()) as { id: string }).id)
  }
  return ids
}

async function uploadToCanvas(page: Page, index: number) {
  const choose = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: '上传', exact: true }).click()
  await (await choose).setFiles(file(index))
  await expect
    .poll(async () => (await elements(page)).filter((e) => e.kind === 'image').length)
    .toBe(1)
  await page.keyboard.press('Escape')
}

async function openLibrary(page: Page) {
  await page.getByRole('button', { name: '资产库', exact: true }).click()
  const panel = page.getByRole('dialog', { name: '资产库', exact: true })
  await panel
    .getByRole('group', { name: '范围', exact: true })
    .getByRole('button', { name: '全部', exact: true })
    .click()
  return panel
}

async function openItem(panel: Locator, name: string) {
  await panel.getByRole('listitem').filter({ hasText: name }).getByRole('button').first().click()
  await expect(
    panel
      .getByRole('group', { name: '档案分页' })
      .getByRole('button', { name: '角色资产', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true')
}

async function save(panel: Locator) {
  await panel.getByRole('button', { name: '保存', exact: true }).click()
  await expect(panel.getByRole('button', { name: '已保存', exact: true })).toBeDisabled()
}

async function screenshotAssets(panel: Locator, path: string) {
  await expect
    .poll(() =>
      panel
        .locator('.lib-hero > img')
        .last()
        .evaluate((node) => {
          const image = node as HTMLImageElement
          return image.complete && image.naturalWidth > 0
        }),
    )
    .toBe(true)
  await panel.locator('.lib-editor-content').evaluate((node) => {
    node.scrollTop = 0
  })
  await panel.screenshot({ path, animations: 'disabled' })
}

test('角色大图失败有恢复入口，切换参考图不串用错误状态且保存不丢内容', async ({ page }) => {
  await newProject(page)
  const ids = await uploadedImages(page, 2)
  const description = '角色的长基础设定与外形细节。'.repeat(200)
  const response = await page.request.post('/api/library', {
    data: {
      kind: 'character',
      name: '角色预览失败恢复',
      description,
      images: [
        { slot: 'full_body', assetId: ids[0] },
        { slot: 'portrait', assetId: ids[1] },
      ],
    },
  })
  expect(response.status()).toBe(201)
  const item = (await response.json()) as LibraryItem
  created.push(item.id)
  let fail = true
  await page.route(`**/api/assets/${ids[0]}/thumb-1024`, (route) =>
    fail ? route.fulfill({ status: 503, body: 'unavailable' }) : route.continue(),
  )
  const panel = await openLibrary(page)
  await openItem(panel, item.name)
  const hero = panel.locator('.lib-hero')
  await expect(hero.getByRole('alert')).toContainText('参考图加载失败')
  await expect(slot(panel, 'full_body').getByText('图片加载失败', { exact: true })).toBeVisible()
  await panel.screenshot({
    path: test.info().outputPath('reference-failure.png'),
    animations: 'disabled',
  })
  const retry = hero.getByRole('button', { name: '重新加载参考图', exact: true })
  await retry.click()
  await expect(hero.getByRole('alert')).toBeVisible()
  expect((await page.request.get(`/api/assets/${ids[0]}`)).ok()).toBe(true)
  await panel.getByRole('button', { name: '预览肖像／半身图', exact: true }).click()
  await expect(hero.getByRole('alert')).toHaveCount(0)
  await expect
    .poll(() =>
      hero
        .locator('img')
        .last()
        .evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0),
    )
    .toBe(true)
  await expect(hero.locator('img').last()).toHaveAttribute('src', new RegExp(ids[1]!))
  await panel.getByRole('button', { name: '预览全身定妆图', exact: true }).click()
  await expect(hero.getByRole('alert')).toBeVisible()
  fail = false
  await retry.click()
  await expect(hero.getByRole('alert')).toHaveCount(0)
  await expect
    .poll(() =>
      hero
        .locator('img')
        .last()
        .evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0),
    )
    .toBe(true)
  await expect(hero.locator('img').last()).toHaveAttribute('src', new RegExp(ids[0]!))
  await slot(panel, 'full_body')
    .getByRole('button', { name: '重新加载全身定妆图', exact: true })
    .click()
  await expect
    .poll(() =>
      slot(panel, 'full_body')
        .locator('img')
        .evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0),
    )
    .toBe(true)
  await panel
    .getByRole('group', { name: '档案分页', exact: true })
    .getByRole('button', { name: '基础设定', exact: true })
    .click()
  await panel.getByRole('textbox', { name: /^基础设定/ }).fill(description + '恢复后补充')
  await save(panel)
  const saved = await readItem(page, item.id)
  expect(saved.images).toEqual(item.images)
  expect((saved as LibraryItem & { description: string }).description).toBe(
    description + '恢复后补充',
  )
})

test('多张竖图组成的参考列整体避让已有内容，连线和参考顺序保持正确', async ({ page }) => {
  await newProject(page)
  const imageIds = await uploadedImages(page, 3)
  const response = await page.request.post('/api/library', {
    data: {
      kind: 'character',
      name: '竖图列避让回归',
      description: '高参考列',
      images: imageIds.map((assetId) => ({ slot: 'extra', assetId })),
    },
  })
  expect(response.status()).toBe(201)
  const item = (await response.json()) as LibraryItem
  created.push(item.id)
  const blocker = await page.evaluate(() => {
    const e = window.__plein.engine
    const view = (
      e as unknown as { camera: { viewRect: { x: number; y: number; w: number; h: number } } }
    ).camera.viewRect
    return window.__plein.addNode({
      type: 'plein/llm',
      name: '参考列上方的已有卡片',
      params: {},
      x: view.x + view.w / 2 - 300,
      y: view.y + view.h / 2 - 500,
    })
  })
  const before = (await elements(page)).map((el) => el.id)
  const panel = await openLibrary(page)
  await openItem(panel, item.name)
  await panel.getByRole('button', { name: '添加到画布', exact: true }).click()
  await expect(panel).toBeHidden()
  const added = (await elements(page)).filter((el) => !before.includes(el.id))
  expect(added).toHaveLength(4)
  const overlap = await page.evaluate(
    ({ blocker, added }) => {
      const doc = window.__plein.engine.doc
      const b = doc.worldRect(blocker)
      return added.some((id) => {
        const a = doc.worldRect(id)
        return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
      })
    },
    { blocker, added: added.map((el) => el.id) },
  )
  expect(overlap).toBe(false)
  const card = added.find((el) => el.nodeType === 'plein/character')!
  const sources = (await edgesInto(page, card.id)).map((edge) => edge[0])
  expect(sources).toHaveLength(3)
  expect(
    await page.evaluate(
      (ids) => ids.map((id) => window.__plein.engine.doc.get(id)?.assetId),
      sources,
    ),
  ).toEqual(imageIds)
})

test('旧角色图槽兼容四类资产，保存与重分类不丢图，画布保留参考顺序和档案', async ({
  page,
}, testInfo) => {
  await newProject(page)
  const ids = await uploadedImages(page)
  const response = await page.request.post('/api/library', {
    data: {
      kind: 'character',
      name: '四类兼容角色',
      description: '黑发，白色外套',
      images: [
        { slot: 'sheet', assetId: ids[3] },
        { slot: 'extra', assetId: ids[4] },
        { slot: 'emotions', assetId: ids[2] },
        { slot: 'main', assetId: ids[0] },
        { slot: 'legacy-reference', assetId: ids[5] },
        { slot: 'half', assetId: ids[1] },
      ],
      profile: {
        periods: [
          {
            id: 'youth',
            name: '少年',
            description: '短发',
            images: [ids[0]],
            voice: { provider: 'plein/mock', voiceId: 'mock-female' },
            voiceStates: [
              {
                id: 'whisper',
                name: '耳语',
                voice: { provider: 'plein/mock', voiceId: 'mock-male' },
              },
            ],
            outfits: [{ id: 'uniform', name: '校服', description: '蓝白校服', images: [ids[1]] }],
          },
        ],
        expressions: [{ id: 'happy', name: '开心', description: '微笑', images: [ids[2]] }],
      },
    },
  })
  expect(response.status(), await response.text()).toBe(201)
  const initial = (await response.json()) as LibraryItem
  created.push(initial.id)
  for (const [index, { id }] of SLOTS.entries())
    expect(initial.images).toContainEqual({ slot: id, assetId: ids[index] })

  const panel = await openLibrary(page)
  await openItem(panel, initial.name)
  await expect(panel.locator('.lib-character-assets [data-character-slot]')).toHaveCount(4)
  for (const [index, { id, label }] of SLOTS.entries()) {
    const card = slot(panel, id)
    await expect(card.locator('img')).toHaveAttribute('src', new RegExp(ids[index]!))
    await expect(card.locator('img')).toHaveCSS('object-fit', 'contain')
    await card.getByRole('button', { name: `预览${label}`, exact: true }).click()
    await expect(panel.locator('.lib-hero > img').last()).toHaveAttribute(
      'src',
      new RegExp(ids[index]!),
    )
    await expect(panel.locator('.lib-hero > img').last()).toHaveCSS('object-fit', 'contain')
  }
  await screenshotAssets(panel, testInfo.outputPath('character-assets-desktop.png'))

  await page.setViewportSize({ width: 640, height: 900 })
  for (const { id } of SLOTS) {
    const card = slot(panel, id)
    await card.scrollIntoViewIfNeeded()
    const bounds = await card.boundingBox()
    expect(bounds).not.toBeNull()
    expect(bounds!.x).toBeGreaterThanOrEqual(0)
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(641)
  }
  expect(await panel.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true)
  await screenshotAssets(panel, testInfo.outputPath('character-assets-narrow.png'))
  await page.setViewportSize({ width: 1440, height: 900 })

  await panel
    .getByRole('group', { name: '档案分页' })
    .getByRole('button', { name: '基础设定', exact: true })
    .click()
  await panel.getByRole('textbox', { name: '名称', exact: true }).fill('四类兼容角色已编辑')
  await save(panel)
  const saved = await readItem(page, initial.id)
  expect(saved.images).toEqual(initial.images)
  expect(saved.profile).toEqual(initial.profile)
  await panel.getByRole('button', { name: '返回', exact: true }).click()
  await openItem(panel, saved.name)
  for (const [index, { id }] of SLOTS.entries())
    await expect(slot(panel, id).locator('img')).toHaveAttribute('src', new RegExp(ids[index]!))

  // 旧版本未识别的槽位也能重新分类；已占用的肖像图转为其他参考，原图和档案不丢失。
  const extras = panel.locator('details').filter({ hasText: '其他参考' })
  if ((await extras.getAttribute('open')) === null) await extras.locator('summary').click()
  await expect(extras.locator('img')).toHaveCount(2)
  await extras.getByRole('combobox', { name: '参考图 2 的分类', exact: true }).click()
  await page.getByRole('option', { name: '肖像／半身图', exact: true }).click()
  await save(panel)
  const classified = await readItem(page, initial.id)
  expect(classified.images).toHaveLength(6)
  expect(classified.images.map((i) => i.assetId).sort()).toEqual(ids.slice(0, 6).sort())
  expect(classified.images).toContainEqual({ slot: 'portrait', assetId: ids[5] })
  expect(classified.images).toContainEqual({ slot: 'extra', assetId: ids[1] })
  expect(classified.profile).toEqual(initial.profile)

  await panel.getByRole('button', { name: '添加到画布', exact: true }).click()
  await expect(panel).toBeHidden()
  const card = await byName(page, saved.name)
  const references = await edgesInto(page, card.id)
  expect(references).toHaveLength(6)
  const actual = await page.evaluate(
    (references) => references.map(([id]) => window.__plein.engine.doc.get(id)?.assetId),
    references,
  )
  // 沿用既有生成顺序，不能因新的展示次序把设定图和情绪图换位。
  expect(actual).toEqual([ids[0], ids[5], ids[3], ids[2], ids[4], ids[1]])
  expect(
    await page.evaluate((id) => window.__plein.engine.doc.get(id)?.params?.profile, card.id),
  ).toEqual(initial.profile)
})

test('新角色四类图可上传、替换、移除并从画布补入，保存重开保持分类', async ({ page }) => {
  await newProject(page)
  const ids = await uploadedImages(page)
  await uploadToCanvas(page, 7)

  const panel = await openLibrary(page)
  await panel.locator('header').getByRole('button', { name: '新建角色', exact: true }).click()
  const tabs = panel.getByRole('group', { name: '档案分页' })
  await tabs.getByRole('button', { name: '基础设定', exact: true }).click()
  await panel.getByRole('textbox', { name: '名称', exact: true }).fill('四类上传角色')
  await tabs.getByRole('button', { name: '角色资产', exact: true }).click()
  for (const [index, { id, label }] of SLOTS.entries()) {
    await slot(panel, id).getByLabel(`上传${label}`, { exact: true }).setInputFiles(file(index))
    await expect(slot(panel, id).locator('img')).toHaveAttribute('src', new RegExp(ids[index]!))
  }

  const portrait = slot(panel, 'portrait')
  const replacement = page.waitForEvent('filechooser')
  await portrait.getByRole('button', { name: '替换', exact: true }).click()
  await (await replacement).setFiles(file(6))
  await expect(portrait.locator('img')).toHaveAttribute('src', new RegExp(ids[6]!))
  const grid = slot(panel, 'face_grid')
  await grid.getByRole('button', { name: '移除', exact: true }).click()
  await expect(grid.locator('img')).toHaveCount(0)
  await grid.getByRole('button', { name: '从画布选择情绪九宫格', exact: true }).click()
  const picker = page.locator('.ui-menu[aria-label="从画布选"]')
  await picker.getByTitle('character-7.png', { exact: true }).click()
  await expect(grid.locator('img')).toHaveAttribute('src', new RegExp(ids[7]!))
  await save(panel)

  const items = (await (await page.request.get('/api/library')).json()) as LibraryItem[]
  const saved = items.find((i) => i.name === '四类上传角色')!
  expect(saved).toBeTruthy()
  created.push(saved.id)
  expect(saved.images).toHaveLength(4)
  expect(saved.images).toEqual(
    expect.arrayContaining([
      { slot: 'full_body', assetId: ids[0] },
      { slot: 'character_3view', assetId: ids[3] },
      { slot: 'portrait', assetId: ids[6] },
      { slot: 'face_grid', assetId: ids[7] },
    ]),
  )
  await panel.getByRole('button', { name: '返回', exact: true }).click()
  await openItem(panel, saved.name)
  for (const image of saved.images)
    await expect(slot(panel, image.slot).locator('img')).toHaveAttribute(
      'src',
      new RegExp(image.assetId),
    )
})

test('角色图片上传完成前暂停保存和其他选图，完成后保存不丢失新图片', async ({ page }) => {
  await newProject(page)
  const ids = await uploadedImages(page)
  await uploadToCanvas(page, 7)
  const panel = await openLibrary(page)
  await panel.locator('header').getByRole('button', { name: '新建角色', exact: true }).click()
  await panel.getByRole('textbox', { name: '名称', exact: true }).fill('上传等待角色')

  let release!: () => void
  let started!: () => void
  let uploads = 0
  const held = new Promise<void>((resolve) => (release = resolve))
  const uploading = new Promise<void>((resolve) => (started = resolve))
  await page.route('**/api/assets', async (route) => {
    if (route.request().method() !== 'POST' || uploads > 0) {
      await route.continue()
      return
    }
    uploads++
    const response = await route.fetch()
    started()
    await held
    await route.fulfill({ response })
  })

  await slot(panel, 'full_body')
    .getByLabel('上传全身定妆图', { exact: true })
    .setInputFiles(file(0))
  await uploading
  try {
    await expect(panel.getByRole('status')).toHaveText('图片上传中…')
    await expect(panel.getByRole('button', { name: '保存', exact: true })).toBeDisabled()
    await expect(
      panel.getByRole('button', { name: '保存并添加到画布', exact: true }),
    ).toBeDisabled()
    for (const { id, label } of SLOTS) {
      const card = slot(panel, id)
      await expect(card.getByLabel(`上传${label}`, { exact: true })).toBeDisabled()
      await expect(
        card.getByRole('button', { name: `从画布选择${label}`, exact: true }),
      ).toBeDisabled()
      if (id !== 'full_body')
        await expect(card.getByRole('button', { name: '上传', exact: true })).toBeDisabled()
    }
    expect(uploads).toBe(1)
  } finally {
    release()
  }

  await expect(panel.getByRole('status')).toBeHidden()
  await expect(slot(panel, 'full_body').locator('img')).toHaveAttribute('src', new RegExp(ids[0]!))
  await expect(
    slot(panel, 'portrait').getByRole('button', { name: '上传', exact: true }),
  ).toBeEnabled()
  await save(panel)
  const items = (await (await page.request.get('/api/library')).json()) as LibraryItem[]
  const saved = items.find((item) => item.name === '上传等待角色')!
  expect(saved).toBeTruthy()
  created.push(saved.id)
  expect(saved.images).toEqual([{ slot: 'full_body', assetId: ids[0] }])
  await panel.getByRole('button', { name: '返回', exact: true }).click()
  await openItem(panel, saved.name)
  await expect(slot(panel, 'full_body').locator('img')).toHaveAttribute('src', new RegExp(ids[0]!))
})

test('24张其他参考达到上限时禁止再添加，仍可无损归入四类图片', async ({ page }) => {
  await newProject(page)
  const ids = await uploadedImages(page, 25)
  await uploadToCanvas(page, 24)
  const response = await page.request.post('/api/library', {
    data: {
      kind: 'character',
      name: '参考已满角色',
      images: ids.slice(0, 24).map((assetId) => ({ slot: 'extra', assetId })),
    },
  })
  expect(response.status(), await response.text()).toBe(201)
  const initial = (await response.json()) as LibraryItem
  created.push(initial.id)
  const panel = await openLibrary(page)
  await openItem(panel, initial.name)
  await expect(panel.getByText('已达到 24 张参考图上限。', { exact: true })).toBeVisible()
  for (const { id, label } of SLOTS) {
    const card = slot(panel, id)
    await expect(card.getByLabel(`上传${label}`, { exact: true })).toBeDisabled()
    await expect(card.getByRole('button', { name: '上传', exact: true })).toBeDisabled()
    await expect(
      card.getByRole('button', { name: `从画布选择${label}`, exact: true }),
    ).toBeDisabled()
  }
  const extras = panel.locator('details').filter({ hasText: '其他参考' })
  await expect(extras.locator('img')).toHaveCount(24)
  await extras.getByRole('combobox', { name: '参考图 1 的分类', exact: true }).click()
  await page.getByRole('option', { name: '全身定妆图', exact: true }).click()
  await expect(slot(panel, 'full_body').locator('img')).toHaveAttribute('src', new RegExp(ids[0]!))
  await expect(extras.locator('img')).toHaveCount(23)
  await expect(
    slot(panel, 'full_body').getByRole('button', { name: '替换', exact: true }),
  ).toBeEnabled()
  await expect(
    slot(panel, 'portrait').getByRole('button', { name: '上传', exact: true }),
  ).toBeDisabled()
  await save(panel)
  const saved = await readItem(page, initial.id)
  expect(saved.images).toHaveLength(24)
  expect(saved.images.map((image) => image.assetId).sort()).toEqual(ids.slice(0, 24).sort())
  expect(saved.images).toContainEqual({ slot: 'full_body', assetId: ids[0] })
  expect(saved.images.filter((image) => image.slot === 'extra')).toHaveLength(23)
})
