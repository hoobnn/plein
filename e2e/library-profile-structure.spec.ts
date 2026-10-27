import { expect, type Page, test } from './fixtures'
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
