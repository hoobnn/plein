import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import { newProject } from './canvas'
import { openLibraryPanel } from './library-ui'

let dir = ''
test.beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'plein-profile-structure-'))
  execFileSync('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'color=c=blue:s=64x64',
    '-frames:v',
    '1',
    join(dir, 'uniform.png'),
  ])
})
test.afterAll(() => rmSync(dir, { recursive: true, force: true }))
async function open(page: Page, name: string) {
  const panel = await openLibraryPanel(page)
  await panel
    .getByRole('group', { name: '范围' })
    .getByRole('button', { name: '全部', exact: true })
    .click()
  await panel.getByRole('listitem').filter({ hasText: name }).getByRole('button').first().click()
  await panel
    .getByRole('group', { name: '档案分页' })
    .getByRole('button', { name: /^时期与服饰/ })
    .click()
  return panel
}

test('服饰不能移入已满时期，键盘跳过已满选项，往返移动与保存保留完整素材和旧名', async ({
  page,
}) => {
  await newProject(page)
  const asset = await page.request.post('/api/assets', {
    headers: { 'content-type': 'image/png', 'x-file-name': 'uniform.png' },
    data: readFileSync(join(dir, 'uniform.png')),
  })
  const image = (await asset.json()).id
  const outfit = {
    id: 'uniform',
    name: '校服',
    aliases: ['旧校服'],
    description: '蓝白校服',
    images: [image],
  }
  const created = await page.request.post('/api/library', {
    data: {
      kind: 'character',
      name: '服饰移动容量回归',
      profile: {
        periods: [
          { id: 'teen', name: '少年', outfits: [outfit] },
          {
            id: 'youth',
            name: '青年',
            outfits: Array.from({ length: 12 }, (_, i) => ({
              id: `look-${i}`,
              name: `服饰${i + 1}`,
            })),
          },
          { id: 'adult', name: '成年' },
        ],
      },
    },
  })
  expect(created.status()).toBe(201)
  const item = await created.json()
  const panel = await open(page, '服饰移动容量回归')
  await panel.getByRole('button', { name: '少年 · 校服', exact: true }).click()
  const belongs = panel.getByRole('combobox', { name: '属于时期', exact: true })
  await belongs.click()
  const full = page.getByRole('option', { name: /青年/ })
  await expect(full).toHaveAttribute('aria-disabled', 'true')
  await expect(full).toContainText('已满')
  await page.screenshot({
    path: test.info().outputPath('full-period-option.png'),
    animations: 'disabled',
  })
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await expect(belongs).toHaveText('成年')
  await expect(panel.getByRole('button', { name: '成年 · 校服', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(panel.locator('.lib-look-editor .lib-strip-tile img')).toHaveAttribute(
    'src',
    new RegExp(image),
  )
  await panel.getByRole('button', { name: '保存', exact: true }).click()
  await expect(panel.getByRole('button', { name: '已保存', exact: true })).toBeDisabled()
  const first = (await (await page.request.get(`/api/library/${item.id}`)).json()).profile.periods
  expect(first[0].outfits).toEqual([])
  expect(first[1].outfits).toHaveLength(12)
  expect(first[2].outfits).toEqual([outfit])
  await belongs.click()
  await page.getByRole('option', { name: '少年', exact: true }).click()
  await expect(belongs).toHaveText('少年')
  await panel.getByRole('button', { name: '保存', exact: true }).click()
  await expect(panel.getByRole('button', { name: '已保存', exact: true })).toBeDisabled()
  const restored = (await (await page.request.get(`/api/library/${item.id}`)).json()).profile
    .periods
  expect(restored[0].outfits).toEqual([outfit])
  expect(restored[1].outfits).toHaveLength(12)
  expect(restored[2].outfits).toEqual([])
})

test('旧名已满时改名保留最近旧名，保存重开及改回旧名保持引用状态', async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 560 })
  await newProject(page)
  const aliases = Array.from({ length: 8 }, (_, i) => `旧名${7 - i}`)
  const created = await page.request.post('/api/library', {
    data: {
      kind: 'character',
      name: '角色旧名容量回归',
      profile: { periods: [{ id: 'teen', name: '少年', aliases }] },
    },
  })
  const item = await created.json()
  const panel = await open(page, '角色旧名容量回归')
  const name = panel.getByRole('textbox', { name: '时期名', exact: true })
  await name.fill('青年')
  await name.blur()
  await expect(panel.getByText(/旧名 少年、/)).toBeVisible()
  await panel.getByText(/旧名 少年、/).scrollIntoViewIfNeeded()
  await panel.screenshot({
    path: test.info().outputPath('recent-aliases.png'),
    animations: 'disabled',
  })
  await panel.getByRole('button', { name: '保存', exact: true }).click()
  await expect(panel.getByRole('button', { name: '已保存', exact: true })).toBeDisabled()
  const read = async () =>
    (await (await page.request.get(`/api/library/${item.id}`)).json()).profile.periods[0]
  expect((await read()).aliases).toEqual(['少年', ...aliases.slice(0, 7)])
  await panel.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(panel).toBeHidden()
  await open(page, '角色旧名容量回归')
  await expect(name).toHaveValue('青年')
  await expect(panel.getByText(/旧名 少年、/)).toBeVisible()
  await name.fill('少年')
  await name.blur()
  await panel.getByRole('button', { name: '保存', exact: true }).click()
  await expect(panel.getByRole('button', { name: '已保存', exact: true })).toBeDisabled()
  expect(await read()).toMatchObject({ name: '少年', aliases: ['青年', ...aliases.slice(0, 7)] })
})

for (const [invalid, action, width] of [
  ['青年', '保存', 1440],
  ['少年/错误', '保存并添加到画布', 390],
] as const) {
  test(`角色档案名称无效 ${invalid} 时 ${action} 不能静默保存其他修改`, async ({ page }) => {
    await newProject(page)
    const name = `档案输入校验 ${invalid}`
    const created = await page.request.post('/api/library', {
      data: {
        kind: 'character',
        name,
        profile: {
          periods: [
            { id: 'teen', name: '少年' },
            { id: 'youth', name: '青年' },
          ],
        },
      },
    })
    expect(created.status()).toBe(201)
    const item = await created.json()
    const panel = await open(page, name)
    await page.setViewportSize({ width, height: 700 })
    const original = await page.evaluate(() => [...window.__plein.engine.doc.elements()])
    await panel.getByRole('textbox', { name: '名称', exact: true }).fill(`${name} 修改`)
    const period = panel.getByRole('textbox', { name: '时期名', exact: true })
    await period.fill(invalid)
    const writes: string[] = []
    page.on('request', (r) => {
      if (r.method() === 'PATCH' && r.url().endsWith(`/api/library/${item.id}`))
        writes.push(r.url())
    })
    await panel.getByRole('button', { name: action, exact: true }).click()
    await expect(period).toHaveAttribute('aria-invalid', 'true')
    await expect(
      panel.getByText('请先修正标记的输入，再保存或添加到画布。', { exact: true }),
    ).toBeVisible()
    await expect(period).toBeFocused()
    await expect(period).toBeInViewport({ ratio: 1 })
    expect(writes).toEqual([])
    expect((await (await page.request.get(`/api/library/${item.id}`)).json()).name).toBe(name)
    expect(await page.evaluate(() => [...window.__plein.engine.doc.elements()])).toEqual(original)
    expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
    await panel.screenshot({ path: test.info().outputPath(`profile-invalid-${width}.png`) })
    if (action === '保存') {
      // 删除不保存草稿；无效输入不能把取消删除入口也锁住。
      await panel.getByRole('button', { name: '删除', exact: true }).click()
      const confirm = page.getByRole('dialog', { name: `删除角色「${name}」？`, exact: true })
      await expect(confirm).toBeVisible()
      await confirm.getByRole('button', { name: '取消', exact: true }).click()
      await expect(confirm).toHaveCount(0)
      await expect(period).toHaveValue(invalid)
    }
    await period.fill('成年')
    await panel.getByRole('button', { name: '保存', exact: true }).click()
    await expect(panel.getByRole('button', { name: '已保存', exact: true })).toBeDisabled()
    const saved = await (await page.request.get(`/api/library/${item.id}`)).json()
    expect(saved.profile.periods[0]).toMatchObject({ name: '成年', aliases: ['少年'] })
    expect(saved.name).toBe(`${name} 修改`)
  })
}

for (const [base, expected] of [
  ['ABCDEFGHIJKLMNOPQRST', 'ABCDEFGHIJKLMNOPQRS2'],
  ['😀'.repeat(10), `${'😀'.repeat(9)}2`],
  ['👩‍🚀'.repeat(4), `${'👩‍🚀'.repeat(3)}2`],
  ['e\u0301'.repeat(10), `${'e\u0301'.repeat(9)}2`],
] as const) {
  test(`重复添加满长档案名 ${base} 后仍可保存，自动序号不破坏文字`, async ({ page }) => {
    await newProject(page)
    const name = `长名称回归 ${base}`
    const created = await page.request.post('/api/library', {
      data: { kind: 'character', name, profile: { periods: [{ id: 'one', name: base }] } },
    })
    expect(created.status()).toBe(201)
    const item = await created.json()
    const panel = await open(page, name)
    await panel.getByRole('button', { name: '添加时期', exact: true }).click()
    await panel
      .getByRole('list', { name: '时期与服饰', exact: true })
      .getByRole('button', { name: '自定义', exact: true })
      .click()
    const custom = panel.getByRole('textbox', { name: '自定义名字', exact: true })
    await custom.fill(base)
    await custom.press('Enter')
    await expect(panel.getByRole('textbox', { name: '时期名', exact: true })).toHaveValue(expected)
    await panel.getByRole('button', { name: '保存', exact: true }).click()
    await expect(panel.getByRole('button', { name: '已保存', exact: true })).toBeDisabled()
    const saved = await (await page.request.get(`/api/library/${item.id}`)).json()
    expect(saved.profile.periods.map((p: { name: string }) => p.name)).toEqual([base, expected])
    await panel.getByRole('textbox', { name: '时期名', exact: true }).scrollIntoViewIfNeeded()
    await panel.screenshot({
      path: test.info().outputPath('profile-auto-name.png'),
      animations: 'disabled',
    })
  })
}

test('大量名称和旧名占用时，自动命名继续查找空闲序号而不依赖时间戳', async ({ page }) => {
  await newProject(page)
  await page.clock.setFixedTime(new Date('2026-10-19T00:00:00.001Z'))
  const created = await page.request.post('/api/library', {
    data: {
      kind: 'character',
      name: '档案序号边界',
      profile: {
        periods: [
          {
            id: 'period',
            name: '开心',
            aliases: Array.from({ length: 8 }, (_, i) => `开心${100 + i}`),
          },
        ],
        expressions: Array.from({ length: 11 }, (_, i) => ({
          id: `expression-${i}`,
          name: `开心${i * 9 + 1}`,
          aliases: Array.from({ length: 8 }, (_, j) => `开心${i * 9 + j + 2}`),
        })),
      },
    },
  })
  expect(created.status()).toBe(201)
  const item = await created.json()
  const panel = await open(page, '档案序号边界')
  await panel
    .getByRole('group', { name: '档案分页' })
    .getByRole('button', { name: /^表情/ })
    .click()
  await panel.getByRole('button', { name: '添加表情', exact: true }).click()
  await panel.getByRole('button', { name: '开心', exact: true }).click()
  await expect(panel.getByRole('textbox', { name: '名字', exact: true })).toHaveValue('开心108')
  await panel.getByRole('button', { name: '保存', exact: true }).click()
  await expect(panel.getByRole('button', { name: '已保存', exact: true })).toBeDisabled()
  const saved = await (await page.request.get(`/api/library/${item.id}`)).json()
  expect(saved.profile.expressions.at(-1).name).toBe('开心108')
})
