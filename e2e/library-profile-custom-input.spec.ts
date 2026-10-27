import { expect, test } from './fixtures'
import { newProject } from './canvas'
import { openLibraryPanel } from './library-ui'

for (const [kind, add, field, name, width] of [
  ['period', '添加时期', '时期名', '自定义阶段', 1440],
  ['outfit', '加服饰', '服饰名', '自定义造型', 800],
  ['outfit', '加服饰', '服饰名', '自定义造型', 320],
  ['expression', '添加表情', '名字', '自定义神态', 390],
] as const) {
  test(`档案自定义 ${kind} ${width}px 组字不提前添加，正常确认只保存一次并保留其他设定`, async ({
    page,
  }, testInfo) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.setViewportSize({ width, height: width === 800 ? 650 : 800 })
    await newProject(page)
    const response = await page.request.post('/api/library', {
      data: {
        kind: 'character',
        name: `中文自定义-${kind}-${width}`,
        description: '保留角色基础设定',
        profile: {
          periods: [
            {
              id: 'teen',
              name: '少年',
              description: '保留时期设定',
              outfits: [{ id: 'uniform', name: '校服', description: '保留服饰设定' }],
            },
          ],
          expressions: [{ id: 'happy', name: '开心', description: '保留表情设定' }],
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
    await panel
      .getByRole('listitem')
      .filter({ hasText: item.name })
      .getByRole('button')
      .first()
      .click()
    await panel
      .getByRole('group', { name: '档案分页', exact: true })
      .getByRole('button', { name: kind === 'expression' ? /^表情/ : /^时期与服饰/ })
      .click()
    await panel.getByRole('button', { name: add, exact: true }).click()
    const pop = panel.locator('.lib-add-pop')
    await pop.getByRole('button', { name: '自定义', exact: true }).click()
    const custom = pop.getByRole('textbox', { name: '自定义名字', exact: true })
    const added = () =>
      kind === 'period'
        ? panel.locator('.lib-lane-period').filter({ hasText: name })
        : panel.getByRole('button', {
            name: kind === 'expression' ? `编辑「${name}」` : `少年 · ${name}`,
            exact: true,
          })
    await custom.fill(name)
    for (const event of [
      { key: 'Enter', isComposing: true },
      { key: 'Enter', keyCode: 229, isComposing: false },
      { key: 'Escape', isComposing: true },
      { key: 'Escape', keyCode: 229, isComposing: false },
    ]) {
      await custom.dispatchEvent('keydown', event)
      await expect(custom).toHaveValue(name)
      await expect(custom).toBeFocused()
      await expect(added()).toHaveCount(0)
    }
    expect((await (await page.request.get(`/api/library/${item.id}`)).json()).profile).toEqual(
      item.profile,
    )
    await expect(custom).toBeInViewport({ ratio: 1 })
    const menuFits = () =>
      pop.evaluate((el) => {
        const menu = el.getBoundingClientRect()
        const clips = [el.closest('.lib-editor-content'), el.closest('.lib-lane-outfits')].filter(
          (clip): clip is Element => !!clip,
        )
        return clips.every((el) => {
          const clip = el.getBoundingClientRect()
          return (
            menu.top >= clip.top - 1 &&
            menu.bottom <= clip.bottom + 1 &&
            menu.left >= clip.left - 1 &&
            menu.right <= clip.right + 1
          )
        })
      })
    await expect.poll(menuFits).toBe(true)
    if (kind === 'outfit' && width === 800) {
      for (const nextWidth of [641, 640, 580, 390, 320, 800]) {
        await page.setViewportSize({ width: nextWidth, height: nextWidth === 800 ? 650 : 800 })
        await expect(custom).toHaveValue(name)
        await expect(custom).toBeFocused()
        await expect.poll(menuFits).toBe(true)
        if (nextWidth === 320)
          await panel.screenshot({ path: testInfo.outputPath('profile-custom-resized.png') })
      }
    }
    await panel.screenshot({ path: testInfo.outputPath('profile-custom-composition.png') })
    await page.keyboard.press('Enter')
    await expect(custom).toHaveCount(0)
    const current = panel.getByRole('textbox', { name: field, exact: true })
    await expect(current).toHaveValue(name)
    await expect(current).toBeFocused()
    await expect(current).toBeInViewport({ ratio: 1 })
    await panel.getByRole('button', { name: '保存', exact: true }).click()
    await expect(panel.getByRole('button', { name: '已保存', exact: true })).toBeDisabled()
    const saved = await (await page.request.get(`/api/library/${item.id}`)).json()
    expect(saved.description).toBe(item.description)
    if (kind === 'period') {
      expect(saved.profile.periods).toHaveLength(2)
      expect(saved.profile.periods[0]).toEqual(item.profile.periods[0])
      expect(saved.profile.periods[1].name).toBe(name)
      expect(saved.profile.expressions).toEqual(item.profile.expressions)
    } else if (kind === 'outfit') {
      expect(saved.profile.periods).toHaveLength(1)
      expect(saved.profile.periods[0]).toMatchObject({
        id: 'teen',
        name: '少年',
        description: '保留时期设定',
      })
      expect(saved.profile.periods[0].outfits).toHaveLength(2)
      expect(saved.profile.periods[0].outfits[0]).toEqual(item.profile.periods[0].outfits[0])
      expect(saved.profile.periods[0].outfits[1].name).toBe(name)
      expect(saved.profile.expressions).toEqual(item.profile.expressions)
    } else {
      expect(saved.profile.periods).toEqual(item.profile.periods)
      expect(saved.profile.expressions).toHaveLength(2)
      expect(saved.profile.expressions[0]).toEqual(item.profile.expressions[0])
      expect(saved.profile.expressions[1].name).toBe(name)
    }
    await panel.getByRole('button', { name: '返回', exact: true }).click()
    await panel
      .getByRole('listitem')
      .filter({ hasText: item.name })
      .getByRole('button')
      .first()
      .click()
    await panel
      .getByRole('group', { name: '档案分页', exact: true })
      .getByRole('button', { name: kind === 'expression' ? /^表情/ : /^时期与服饰/ })
      .click()
    await expect(added()).toHaveCount(1)
    expect(errors).toEqual([])
  })
}
