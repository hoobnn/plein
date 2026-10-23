import { expect, type Page, test } from '@playwright/test'
import { centerOf, newProject, zoomTo } from './canvas'

async function fixture(page: Page, multiple = false, missingBoard = false) {
  await newProject(page)
  const ids = await page.evaluate(
    ({ multiple, missingBoard }) => {
      const add = window.__plein.addNode
      const board = add({
        type: 'plein/storyboard',
        name: '返回成片来源',
        x: 0,
        y: 0,
        params: { shots: [{ id: 'one', no: 1, duration: 3 }] },
      })
      const source = { storyboard: board, shot: 'one', role: 'video' }
      const media = add({
        type: 'plein/video',
        name: '关联镜头素材',
        x: 500,
        y: 0,
        params: { source },
      })
      const film = add({
        type: 'plein/sequence',
        name: multiple ? '导演版' : '当前成片',
        x: 1000,
        y: 0,
        params: { aspectRatio: '16:9' },
      })
      if (!window.__plein.connect([media, 'video'], [film, 'clips'])) throw new Error('连接失败')
      let second = ''
      if (multiple) {
        second = add({
          type: 'plein/sequence',
          name: '导演版',
          x: 1500,
          y: 0,
          params: { aspectRatio: '9:16' },
        })
        if (!window.__plein.connect([media, 'video'], [second, 'clips']))
          throw new Error('第二条连接失败')
      }
      const draft = add({
        type: 'plein/animatic',
        name: '导航样片草稿',
        x: 300,
        y: 700,
        params: { boardId: board, shots: [{ shotId: 'one', duration: 3, dialogue: [] }] },
      })
      if (missingBoard) {
        const engine = window.__plein.engine as typeof window.__plein.engine & {
          deleteSelection(): void
        }
        engine.selection.set([board])
        engine.deleteSelection()
      }
      return { board, media, film, second, draft }
    },
    { multiple, missingBoard },
  )
  await zoomTo(page, [ids.draft])
  const at = await centerOf(page, ids.draft)
  await page.mouse.dblclick(at.x, at.y)
  const editor = page.getByRole('dialog', { name: '序列', exact: true })
  await expect(editor.getByRole('heading', { name: '导航样片草稿', exact: true })).toBeVisible()
  const read = () =>
    page.evaluate(() =>
      [...window.__plein.engine.doc.elements()].map((el) => ({
        id: el.id,
        name: el.name,
        params: el.params,
      })),
    )
  return { ids, editor, read }
}

for (const missing of [false, true]) {
  test(`唯一成片${missing ? '在来源分镜删除后' : ''}可正确切回，导航不改剪辑数据`, async ({
    page,
  }) => {
    const f = await fixture(page, false, missing)
    const before = await f.read()
    await f.editor.getByRole('button', { name: '切回成片', exact: true }).click()
    await expect(f.editor.getByRole('heading', { name: '当前成片', exact: true })).toBeVisible()
    expect(await f.read()).toEqual(before)
  })
}

test('多个同名成片显示可消歧选项，Esc仅关菜单，键盘可打开指定成片', async ({ page }) => {
  const f = await fixture(page, true)
  await page.setViewportSize({ width: 390, height: 700 })
  const before = await f.read()
  expect(await f.editor.getByRole('button', { name: '切回成片', exact: true }).count()).toBe(0)
  const chooser = f.editor.getByRole('combobox', { name: '选择成片序列', exact: true })
  await chooser.click()
  const options = page.getByRole('option').filter({ hasText: '导演版 · ' })
  await expect(options).toHaveCount(2)
  const labels = await options.allTextContents()
  expect(new Set(labels).size).toBe(2)
  await f.editor.screenshot({
    path: test.info().outputPath('ambiguous-film-chooser.png'),
    animations: 'disabled',
  })
  await page.keyboard.press('Escape')
  await expect(page.getByRole('listbox')).not.toBeVisible()
  await expect(f.editor.getByRole('heading', { name: '导航样片草稿', exact: true })).toBeVisible()
  await chooser.click()
  await expect(page.getByRole('listbox')).toBeVisible()
  await page.keyboard.press('End')
  await expect(options.last()).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(f.editor.getByRole('heading', { name: '导演版', exact: true })).toBeVisible()
  await f.editor.getByRole('button', { name: '成片', exact: true }).click()
  await expect(f.editor.getByRole('button', { name: '竖屏 9:16', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  expect(await f.read()).toEqual(before)
})

for (const change of ['delete', 'ambiguous'] as const) {
  test(`旧切回按钮遇到 ${change} 不跳错，恢复后可继续选择`, async ({ page }) => {
    const f = await fixture(page)
    await f.editor.getByRole('button', { name: '切回成片', exact: true }).evaluate(
      (button, { ids, change }) => {
        const engine = window.__plein.engine as typeof window.__plein.engine & {
          deleteSelection(): void
          doc: {
            undo: { stopCapturing(): void }
          }
        }
        if (change === 'delete') {
          engine.doc.undo.stopCapturing()
          engine.selection.set([ids.film])
          engine.deleteSelection()
          engine.doc.undo.stopCapturing()
        } else {
          const second = window.__plein.addNode({
            type: 'plein/sequence',
            name: '新增成片版本',
            x: 1500,
            y: 0,
            params: { aspectRatio: '9:16' },
          })
          window.__plein.connect([ids.media, 'video'], [second, 'clips'])
        }
        ;(button as HTMLButtonElement).click()
      },
      { ids: f.ids, change },
    )
    await expect(f.editor.getByRole('heading', { name: '导航样片草稿', exact: true })).toBeVisible()
    await expect(f.editor.getByRole('alert')).toContainText('已变化')
    if (change === 'ambiguous') {
      await f.editor.getByRole('combobox', { name: '选择成片序列', exact: true }).click()
      await page.getByRole('option', { name: '新增成片版本', exact: true }).click()
      await expect(
        f.editor.getByRole('heading', { name: '新增成片版本', exact: true }),
      ).toBeVisible()
    } else {
      await page.evaluate(() =>
        (window.__plein.engine as typeof window.__plein.engine & { undo(): void }).undo(),
      )
      await f.editor.getByRole('button', { name: '切回成片', exact: true }).click()
      await expect(f.editor.getByRole('heading', { name: '当前成片', exact: true })).toBeVisible()
    }
  })
}

for (const change of ['delete'] as const) {
  test(`选择菜单中的成片 ${change} 后拒绝旧选项，仍可切到剩余成片`, async ({ page }) => {
    const f = await fixture(page, true)
    await f.editor.getByRole('combobox', { name: '选择成片序列', exact: true }).click()
    const option = page.getByRole('option', { name: new RegExp(f.ids.second.slice(-6)) })
    await option.evaluate(
      (element, { ids }) => {
        const engine = window.__plein.engine as typeof window.__plein.engine & {
          deleteSelection(): void
        }
        engine.selection.set([ids.second])
        engine.deleteSelection()
        ;(element as HTMLElement).click()
      },
      { ids: f.ids },
    )
    await expect(f.editor.getByRole('heading', { name: '导航样片草稿', exact: true })).toBeVisible()
    await expect(f.editor.getByRole('alert')).toContainText('已变化')
    await f.editor.getByRole('button', { name: '切回成片', exact: true }).click()
    await expect(f.editor.getByRole('heading', { name: '导演版', exact: true })).toBeVisible()
    await f.editor.getByRole('button', { name: '成片', exact: true }).click()
    await expect(f.editor.getByRole('button', { name: '横屏 16:9', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
  })
}
