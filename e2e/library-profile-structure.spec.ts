import { expect, type Page, test } from '@playwright/test'
import { newProject } from './canvas'
import { openLibraryPanel } from './library-ui'

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
