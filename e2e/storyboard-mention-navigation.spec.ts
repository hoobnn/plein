import { expect, type Locator, type Page, test } from '@playwright/test'
import { centerOf, clickElement, newProject } from './canvas'

async function setup(page: Page) {
  await newProject(page)
  const ids = await page.evaluate(() => {
    const target = window.__plein.addNode({
      type: 'plein/character',
      name: '引用角色',
      x: -600,
      y: 200,
      params: {},
    })
    const board = window.__plein.addNode({
      type: 'plein/storyboard',
      name: '引用草稿测试',
      x: 400,
      y: 200,
      params: {
        shots: [
          { id: 'one', no: 1, duration: 3, description: '原始画面 @引用角色。', dialogue: [] },
        ],
      },
    })
    return { target, board }
  })
  const open = async () => {
    await clickElement(page, ids.board)
    const at = await centerOf(page, ids.board)
    await page.mouse.dblclick(at.x, at.y)
  }
  await open()
  await page.evaluate(() =>
    (
      window.__plein.engine.doc as unknown as { undo: { stopCapturing(): void } }
    ).undo.stopCapturing(),
  )
  const editor = page.getByRole('dialog', { name: '分镜表', exact: true })
  const cell = editor.locator('[data-storyboard-field="画面"]').first()
  const input = cell.getByRole('textbox', { name: '画面', exact: true })
  const saved = () =>
    page.evaluate(
      (id) =>
        (window.__plein.engine.doc.get(id)!.params!.shots as Array<{ description: string }>)[0]!
          .description,
      ids.board,
    )
  return { ids, open, editor, cell, input, saved }
}

async function locate(input: Locator, cell: Locator) {
  await input.scrollIntoViewIfNeeded()
  await input.evaluate((el: HTMLTextAreaElement) => {
    el.scrollTop = 0
    el.dispatchEvent(new Event('scroll'))
  })
  const mark = (await cell.getByTestId('mention-highlights').locator('mark').first().boundingBox())!
  const box = (await input.boundingBox())!
  await input.click({
    position: { x: mark.x + mark.width / 2 - box.x, y: mark.y + mark.height / 2 - box.y },
    modifiers: ['ControlOrMeta'],
  })
}

test('分镜未提交文本中点击引用定位会先保存，返回和撤销重做保持一致', async ({ page }) => {
  const { ids, open, editor, cell, input, saved } = await setup(page)
  const text = '补充镜头，@引用角色 走进画面。😀'
  await input.fill(text)
  expect(await saved()).toBe('原始画面 @引用角色。')
  await locate(input, cell)
  await expect(editor).toBeHidden()
  await expect
    .poll(() => page.evaluate(() => window.__plein.engine.selection.values()))
    .toEqual([ids.target])
  await expect.poll(saved).toBe(text)
  await page.getByRole('button', { name: '撤销', exact: true }).click()
  await expect.poll(saved).toBe('原始画面 @引用角色。')
  await page.getByRole('button', { name: '重做', exact: true }).click()
  await expect.poll(saved).toBe(text)
  await open()
  await expect(input).toHaveValue(text)
})

for (const choice of ['使用最新内容', '保留当前输入']) {
  test(`引用定位遇到未决文本冲突时保留编辑，${choice}后才离开`, async ({ page }) => {
    const { ids, editor, cell, input, saved } = await setup(page)
    const narrow = choice === '保留当前输入'
    if (narrow) {
      await page.setViewportSize({ width: 800, height: 560 })
      // 卡片视图里画面框更高，冲突提示会被顶到视野外：
      // 定位时界面要自己把它滚回来。
      await editor.getByRole('button', { name: '详细卡片', exact: true }).click()
    }
    const mine = '本机草稿 @引用角色，尚未提交。' + (narrow ? '\n补充长镜头说明。'.repeat(40) : '')
    const latest = '其他位置更新 @引用角色。'
    await input.fill(mine)
    await page.evaluate(
      ({ id, latest }) => {
        const doc = window.__plein.engine.doc
        const shots = doc.get(id)!.params!.shots as Array<Record<string, unknown>>
        const params = doc.mutable(id)!.get('params') as { set(key: string, value: unknown): void }
        params.set(
          'shots',
          shots.map((shot) => ({ ...shot, description: latest })),
        )
      },
      { id: ids.board, latest },
    )
    await expect(cell.getByRole('status')).toContainText('画面已在其他位置更新')
    if (narrow) {
      await input.evaluate((el) => el.scrollIntoView({ block: 'end' }))
      await expect(cell.getByRole('status')).not.toBeInViewport()
    }
    await locate(input, cell)
    await expect(editor).toBeVisible()
    await expect(editor).toHaveCSS('opacity', '1')
    await expect(cell.getByRole('status')).toBeInViewport()
    await expect(cell.getByRole('button', { name: '使用最新内容', exact: true })).toBeInViewport()
    await expect(cell.getByRole('button', { name: '保留当前输入', exact: true })).toBeInViewport()
    if (narrow)
      await page.screenshot({ path: test.info().outputPath('locate-conflict-visible.png') })
    await expect(input).toHaveValue(mine)
    expect(await saved()).toBe(latest)
    expect(await page.evaluate(() => window.__plein.engine.selection.values())).toEqual([ids.board])
    await cell.getByRole('button', { name: choice, exact: true }).click()
    await locate(input, cell)
    await expect(editor).toBeHidden()
    await expect
      .poll(() => page.evaluate(() => window.__plein.engine.selection.values()))
      .toEqual([ids.target])
    expect(await saved()).toBe(choice === '使用最新内容' ? latest : mine)
  })
}
