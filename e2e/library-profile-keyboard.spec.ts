import { expect, type Page, test } from './fixtures'
import { newProject } from './canvas'
import { openLibraryPanel } from './library-ui'

const profile = () => ({
  periods: [
    {
      id: 'teen',
      name: '少年',
      aliases: ['初中'],
      description: '保留少年设定',
      outfits: [{ id: 'uniform', name: '校服', description: '保留校服材质' }],
    },
    { id: 'youth', name: '青年', description: '保留青年设定' },
  ],
  expressions: [
    { id: 'happy', name: '开心', description: '保留眉眼动作' },
    { id: 'sad', name: '难过' },
  ],
})
async function fixture(page: Page, data: unknown = profile()) {
  await newProject(page)
  const name = `档案键盘 ${page.url().split('/').at(-1)}`
  const response = await page.request.post('/api/library', {
    data: { kind: 'character', name, profile: data },
  })
  expect(response.status()).toBe(201)
  const item = await response.json()
  const panel = await openLibraryPanel(page)
  await panel
    .getByRole('group', { name: '范围', exact: true })
    .getByRole('button', { name: '全部', exact: true })
    .click()
  await panel.getByRole('listitem').filter({ hasText: name }).getByRole('button').first().click()
  const tab = async (expression = false) => {
    await panel
      .getByRole('group', { name: '档案分页', exact: true })
      .getByRole('button', { name: expression ? /^表情/ : /^时期与服饰/ })
      .click()
  }
  const save = async () => {
    await panel.getByRole('button', { name: '保存', exact: true }).click()
    await expect(panel.getByRole('button', { name: '已保存', exact: true })).toBeDisabled()
    return (await (await page.request.get(`/api/library/${item.id}`)).json()).profile
  }
  await tab()
  return { panel, tab, save, item }
}

for (const [role, label, original, updated] of [
  ['时期', '时期名', '少年', '成年'],
  ['服饰', '服饰名', '校服', '便装'],
  ['表情', '名字', '开心', '微笑'],
] as const) {
  test(`${role}名称 Enter 纠错和确认保留输入焦点，Esc 取消后保存正确旧名`, async ({ page }) => {
    if (role === '服饰') await page.setViewportSize({ width: 800, height: 650 })
    const f = await fixture(page)
    if (role === '服饰')
      await f.panel.getByRole('button', { name: '少年 · 校服', exact: true }).click()
    if (role === '表情') {
      await f.tab(true)
      await f.panel.getByRole('button', { name: '编辑「开心」', exact: true }).click()
    }
    const input = f.panel.getByRole('textbox', { name: label, exact: true })
    await input.fill('青年')
    await page.keyboard.press('Enter')
    await expect(input).toHaveAttribute('aria-invalid', 'true')
    await expect(input).toBeFocused()
    await expect(input).toBeInViewport({ ratio: 1 })
    if (role === '服饰')
      await f.panel.screenshot({
        path: test.info().outputPath('profile-name-error-focus.png'),
        animations: 'disabled',
      })
    const errorId = await input.getAttribute('aria-describedby')
    expect(errorId).toBeTruthy()
    await expect(f.panel.locator(`[id="${errorId}"]`)).toBeVisible()
    await expect(f.panel.locator(`[id="${errorId}"]`)).toBeInViewport({ ratio: 1 })
    await input.fill(updated)
    await page.keyboard.press('Enter')
    await expect(input).toBeFocused()
    await expect(input).toHaveAttribute('aria-invalid', 'false')
    await expect(input).toHaveValue(updated)
    await input.fill('临时编辑')
    await page.keyboard.press('Escape')
    await expect(input).toBeFocused()
    await expect(input).toHaveValue(updated)
    const saved = await f.save()
    const value =
      role === '时期'
        ? saved.periods[0]
        : role === '服饰'
          ? saved.periods[0].outfits[0]
          : saved.expressions[0]
    expect(value).toMatchObject({
      id: role === '时期' ? 'teen' : role === '服饰' ? 'uniform' : 'happy',
      name: updated,
    })
    expect(value.aliases).toEqual(role === '时期' ? [original, '初中'] : [original])
    expect(value.description).toContain('保留')
  })
}

test('中文输入法的旧式 229 确认与取消不提前提交或清除档案名称', async ({ page }) => {
  const f = await fixture(page)
  const input = f.panel.getByRole('textbox', { name: '时期名', exact: true })
  await input.fill('正在选字')
  await input.dispatchEvent('keydown', { key: 'Enter', keyCode: 229, isComposing: false })
  await expect(f.panel.locator('.lib-lane-period').filter({ hasText: '少年' })).toHaveCount(1)
  await expect(input).toBeFocused()
  await input.dispatchEvent('keydown', { key: 'Escape', keyCode: 229, isComposing: false })
  await expect(input).toHaveValue('正在选字')
  await input.dispatchEvent('keydown', { key: 'Enter', isComposing: true })
  await expect(input).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(input).toHaveValue('少年')
  await input.dispatchEvent('keydown', { key: 'Escape', keyCode: 229, isComposing: false })
  await expect(input).toBeFocused()
  await expect(f.panel.getByRole('button', { name: '已保存', exact: true })).toBeDisabled()
})

test('键盘删除时期及末项后焦点回到相邻时期或添加入口，保存保留其他档案', async ({ page }) => {
  const f = await fixture(page)
  await f.panel.getByRole('button', { name: '删除时期「少年」', exact: true }).focus()
  await page.keyboard.press('Enter')
  const youth = f.panel.locator('.lib-lane-period').filter({ hasText: '青年' })
  await expect(youth).toBeFocused()
  await expect(f.panel.getByRole('textbox', { name: '时期名', exact: true })).toHaveValue('青年')
  await f.panel.getByRole('button', { name: '删除时期「青年」', exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect(f.panel.getByRole('button', { name: '添加时期', exact: true })).toBeFocused()
  const saved = await f.save()
  expect(saved).toEqual({ ...f.item.profile, periods: [] })
  expect(saved.expressions.map((x: { id: string }) => x.id)).toEqual(['happy', 'sad'])
})

test('键盘删除服饰后回到所属时期，描述和其他时期完整保留', async ({ page }) => {
  const f = await fixture(page)
  await f.panel.getByRole('button', { name: '少年 · 校服', exact: true }).click()
  await f.panel.getByRole('button', { name: '删除服饰「校服」', exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect(f.panel.locator('.lib-lane-period').filter({ hasText: '少年' })).toBeFocused()
  const saved = await f.save()
  expect(saved.periods[0]).toMatchObject({
    id: 'teen',
    name: '少年',
    description: '保留少年设定',
    aliases: ['初中'],
    outfits: [],
  })
  expect(saved.periods[1]).toMatchObject({ id: 'youth', description: '保留青年设定' })
  expect(saved).toEqual({
    ...f.item.profile,
    periods: [{ ...f.item.profile.periods[0], outfits: [] }, f.item.profile.periods[1]],
  })
})

test('表情删除后聚焦邻项，末项退出后可直接键盘开始添加', async ({ page }) => {
  const f = await fixture(page)
  await f.tab(true)
  await f.panel.getByRole('button', { name: '编辑「开心」', exact: true }).click()
  await f.panel
    .locator('.lib-look-editor')
    .getByRole('button', { name: '删除', exact: true })
    .focus()
  await page.keyboard.press('Enter')
  const next = f.panel.getByRole('button', { name: '编辑「难过」', exact: true })
  await expect(next).toBeFocused()
  await page.keyboard.press('Enter')
  await f.panel
    .locator('.lib-look-editor')
    .getByRole('button', { name: '删除', exact: true })
    .focus()
  await page.keyboard.press('Enter')
  const add = f.panel.getByRole('button', { name: '添加表情', exact: true })
  await expect(add).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(
    f.panel.locator('.lib-add-pop').getByRole('button', { name: '开心', exact: true }),
  ).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(add).toBeFocused()
  expect(await f.save()).toEqual({ ...f.item.profile, expressions: [] })
})

test('添加菜单与自定义输入逐层 Esc 返回原按钮，取消不改写任何档案', async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 650 })
  const f = await fixture(page)
  const add = f.panel.getByRole('button', { name: '添加时期', exact: true })
  await add.focus()
  await page.keyboard.press('Enter')
  const pop = f.panel.locator('.lib-add-pop')
  await expect(pop.getByRole('button', { name: '童年', exact: true })).toBeFocused()
  await expect(pop).toBeInViewport({ ratio: 1 })
  await f.panel.screenshot({
    path: test.info().outputPath('profile-add-keyboard.png'),
    animations: 'disabled',
  })
  await pop.getByRole('button', { name: '自定义', exact: true }).click()
  const custom = pop.getByRole('textbox', { name: '自定义名字', exact: true })
  await custom.fill('暂时输入')
  await page.keyboard.press('Escape')
  await expect(pop.getByRole('button', { name: '自定义', exact: true })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(pop).toHaveCount(0)
  await expect(add).toBeFocused()
  await expect(f.panel.getByRole('textbox', { name: '时期名', exact: true })).toHaveValue('少年')
  await expect(f.panel.getByRole('button', { name: '已保存', exact: true })).toBeDisabled()
})

test('键盘添加第八个时期后入口退出，聚焦新名称并可删除后继续添加', async ({ page }) => {
  const periods = Array.from({ length: 7 }, (_, i) => ({
    id: `p${i}`,
    name: `阶段${i + 1}`,
    description: `保留${i}`,
  }))
  const f = await fixture(page, { periods })
  await f.panel.getByRole('button', { name: '添加时期', exact: true }).click()
  const choice = f.panel.locator('.lib-add-pop').getByRole('button', { name: '青年', exact: true })
  await choice.focus()
  await page.keyboard.press('Enter')
  const input = f.panel.getByRole('textbox', { name: '时期名', exact: true })
  await expect(input).toHaveValue('青年')
  await expect(input).toBeFocused()
  await expect(f.panel.getByRole('button', { name: '添加时期', exact: true })).toHaveCount(0)
  expect((await f.save()).periods).toHaveLength(8)
  await f.panel.getByRole('button', { name: '删除时期「青年」', exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect(f.panel.locator('.lib-lane-period').filter({ hasText: '阶段7' })).toBeFocused()
  await expect(f.panel.getByRole('button', { name: '添加时期', exact: true })).toBeVisible()
  expect((await f.save()).periods.map((x: { id: string }) => x.id)).toEqual(
    periods.map((x) => x.id),
  )
})

test('状态次音色填满第六项后聚焦新状态，删除后回到邻项并恢复添加', async ({ page }) => {
  const states = Array.from({ length: 5 }, (_, i) => ({
    id: `s${i}`,
    name: `状态${i + 1}`,
    voice: { provider: 'mock', voiceId: `voice${i}` },
  }))
  const f = await fixture(page, { periods: [{ id: 'one', name: '少年', voiceStates: states }] })
  const choice = f.panel.getByRole('button', { name: '生病', exact: true })
  await choice.focus()
  await page.keyboard.press('Enter')
  const names = f.panel.getByRole('textbox', { name: '状态', exact: true })
  await expect(names).toHaveCount(6)
  await expect(names.last()).toBeFocused()
  const filled = await f.save()
  expect(filled.periods[0].voiceStates).toHaveLength(6)
  expect(filled.periods[0].voiceStates.slice(0, 5)).toEqual(
    states.map((x) => ({ ...x, aliases: [] })),
  )
  await f.panel.getByRole('button', { name: '删除次音色「生病」', exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect(names.last()).toBeFocused()
  await expect(names.last()).toHaveValue('状态5')
  await expect(f.panel.getByRole('button', { name: '生病', exact: true })).toBeVisible()
  expect((await f.save()).periods[0].voiceStates).toEqual(
    states.map((x) => ({ ...x, aliases: [] })),
  )
})
