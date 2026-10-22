import { expect, type Page, test } from '@playwright/test'
import { centerOf, clickElement, newProject, waitEngine } from './canvas'

for (const [key, label, initial] of [['duration', '样片镜头时长（秒）', 3]] as const) {
  test(`${label}支持清空后逐字输入小数，提交前不改保存值`, async ({ page }) => {
    await newProject(page)
    const id = await page.evaluate(() =>
      window.__plein.addNode({
        type: 'plein/animatic',
        name: '样片数值编辑',
        x: 400,
        y: 200,
        params: {
          subtitles: false,
          shots: [
            { shotId: 'one', duration: 3, lineDelay: 2, lineGap: 1.2, dialogue: [] },
            { shotId: 'two', duration: 6, lineDelay: 5, lineGap: 0.7, dialogue: [] },
          ],
        },
      }),
    )
    await clickElement(page, id)
    const at = await centerOf(page, id)
    await page.mouse.dblclick(at.x, at.y)
    const editor = page.getByRole('dialog', { name: '序列', exact: true })
    const input = editor.getByRole('spinbutton', { name: label, exact: true })
    const saved = () =>
      page.evaluate(
        ({ id, key }) =>
          (window.__plein.engine.doc.get(id)!.params!.shots as Array<Record<string, unknown>>)[0]![
            key
          ],
        { id, key },
      )
    await input.focus()
    await input.press('ControlOrMeta+a')
    await input.press('Backspace')
    await expect(input).toHaveValue('')
    await input.pressSequentially('0.5')
    await expect(input).toHaveValue('0.5')
    expect(await saved()).toBe(initial)
    await input.press('Enter')
    await expect.poll(saved).toBe(0.5)
    await expect(input).toHaveValue('0.5')
    await input.fill('')
    await input.blur()
    await expect(input).toHaveValue('0.5')
    expect(await saved()).toBe(0.5)
    await expect(editor.getByRole('alert')).toContainText('已保留原设置')
    await input.fill(key === 'duration' ? '0.1' : key === 'lineDelay' ? '-1' : '11')
    await input.blur()
    await expect(input).toHaveValue('0.5')
    expect(await saved()).toBe(0.5)
    await expect(input).toHaveAttribute('aria-invalid', 'true')
    await expect(editor.getByRole('alert')).toContainText('已保留原设置')
    if (key === 'duration')
      await editor
        .locator('.seq-inspector')
        .screenshot({ path: test.info().outputPath('number-error.png') })
    await input.fill('1.5')
    await input.press('Enter')
    await expect.poll(saved).toBe(1.5)
    await expect(editor.getByRole('alert')).toHaveCount(0)
    await input.fill('1.8')
    await page.evaluate(
      ({ id, key }) => {
        const doc = window.__plein.engine.doc
        const shots = doc.get(id)!.params!.shots as Array<Record<string, unknown>>
        const params = doc.mutable(id)!.get('params') as { set(key: string, value: unknown): void }
        params.set(
          'shots',
          shots.map((shot, i) => (i === 0 ? { ...shot, [key]: 2.25 } : shot)),
        )
      },
      { id, key },
    )
    await expect(input).toHaveValue('2.25')
    await input.blur()
    expect(await saved()).toBe(2.25)
    await input.fill('2.6')
    await editor.locator('.seq-clip').nth(1).click()
    await expect.poll(saved).toBe(2.6)
    await expect(editor.locator('.seq-time > span').first()).toHaveText(
      key === 'duration' ? '0:02.6' : '0:03.0',
    )
    await expect(input).toHaveValue(String(key === 'duration' ? 6 : key === 'lineDelay' ? 5 : 0.7))
    await input.fill('-1')
    await input.blur()
    await expect(editor.getByRole('alert')).toContainText('已保留原设置')
    await editor.locator('.seq-clip').first().click()
    await expect(input).toHaveValue('2.6')
    await expect(editor.getByRole('alert')).toHaveCount(0)
    await input.fill('2.9')
    await input.press('Escape')
    await expect(editor).toBeHidden()
    expect(await saved()).toBe(2.6)
    await clickElement(page, id)
    const again = await centerOf(page, id)
    await page.mouse.dblclick(again.x, again.y)
    await expect(input).toHaveValue('2.6')
  })
}

test('样片秒数提交后撤销重做，重新打开显示保存值', async ({ page }) => {
  await newProject(page)
  const id = await page.evaluate(() =>
    window.__plein.addNode({
      type: 'plein/animatic',
      name: '秒数撤销',
      x: 400,
      y: 200,
      params: { subtitles: false, shots: [{ shotId: 'one', duration: 3, dialogue: [] }] },
    }),
  )
  const open = async () => {
    await clickElement(page, id)
    const at = await centerOf(page, id)
    await page.mouse.dblclick(at.x, at.y)
  }
  await open()
  // 隔离受控建节点的准备事务，撤销只检查真实界面提交的数值编辑。
  await page.evaluate(() =>
    (
      window.__plein.engine.doc as unknown as { undo: { stopCapturing(): void } }
    ).undo.stopCapturing(),
  )
  const editor = page.getByRole('dialog', { name: '序列', exact: true })
  const input = editor.getByRole('spinbutton', { name: '样片镜头时长（秒）', exact: true })
  await input.fill('2.5')
  await input.press('Enter')
  const read = () =>
    page.evaluate(
      (id) =>
        (window.__plein.engine.doc.get(id)!.params!.shots as Array<{ duration: number }>)[0]!
          .duration,
      id,
    )
  await expect.poll(read).toBe(2.5)
  await editor.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(editor).toBeHidden()
  await page.getByRole('button', { name: '撤销', exact: true }).click()
  await expect.poll(read).toBe(3)
  await open()
  await expect(input).toHaveValue('3')
  await editor.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(editor).toBeHidden()
  await page.getByRole('button', { name: '重做', exact: true }).click()
  await expect.poll(read).toBe(2.5)
  await open()
  await expect(input).toHaveValue('2.5')
})

async function filmNumber(page: Page) {
  await newProject(page)
  const id = await page.evaluate(() =>
    window.__plein.addNode({
      type: 'plein/animatic',
      name: '成片数值编辑',
      x: 400,
      y: 200,
      params: {
        subtitles: false,
        transition: '叠化',
        transitionDuration: 1.2,
        shots: [{ shotId: 'one', duration: 3, dialogue: [] }],
      },
    }),
  )
  const open = async () => {
    await clickElement(page, id)
    const at = await centerOf(page, id)
    await page.mouse.dblclick(at.x, at.y)
    await page
      .getByRole('dialog', { name: '序列', exact: true })
      .getByRole('button', { name: '成片', exact: true })
      .click()
  }
  await open()
  const editor = page.getByRole('dialog', { name: '序列', exact: true })
  const input = editor.getByRole('spinbutton', { name: '转场时长（秒）', exact: true })
  const saved = () =>
    page.evaluate((id) => window.__plein.engine.doc.get(id)!.params!.transitionDuration, id)
  return { id, open, editor, input, saved }
}

for (const raw of ['1e']) {
  test(`成片转场时长未完成输入 ${raw} 不误当清空，主动清空仍恢复默认值`, async ({ page }) => {
    const f = await filmNumber(page)
    await f.input.fill('')
    await f.input.pressSequentially(raw)
    expect(await f.input.evaluate((input: HTMLInputElement) => input.validity.badInput)).toBe(true)
    await f.input.press('Tab')
    expect(await f.saved()).toBe(1.2)
    await expect(f.input).toHaveValue('1.2')
    await expect(f.input).toHaveAttribute('aria-invalid', 'true')
    await expect(f.input).toHaveAccessibleDescription('请输入有效的非负数字，已保留原设置')
    if (raw === '1e') {
      await f.editor.getByRole('alert').scrollIntoViewIfNeeded()
      await f.editor
        .locator('.seq-inspector')
        .screenshot({ path: test.info().outputPath('film-number-error.png') })
    }
    await f.input.fill('-1')
    await f.input.blur()
    expect(await f.saved()).toBe(1.2)
    await expect(f.input).toHaveValue('1.2')
    await f.input.fill('1.5')
    await f.input.press('Enter')
    expect(await f.saved()).toBe(1.5)
    await expect(f.editor.getByRole('alert')).toHaveCount(0)
    await f.input.fill('')
    await f.input.blur()
    expect(await f.saved()).toBe(0.5)
    await expect(f.input).toHaveValue('0.5')
    await f.input.fill('3')
    await f.input.press('Enter')
    expect(await f.saved()).toBe(2)
    await expect(f.input).toHaveValue('2')
  })
}

test('成片转场时长草稿按 Esc 关闭不保存，重新打开保留原值', async ({ page }) => {
  const f = await filmNumber(page)
  await f.input.fill('1.8')
  await f.input.press('Escape')
  await expect(f.editor).toBeHidden()
  expect(await f.saved()).toBe(1.2)
  await f.open()
  await expect(f.input).toHaveValue('1.2')
})

test('成片转场时长提交可撤销重做，关闭重开保持已保存值', async ({ page }) => {
  const f = await filmNumber(page)
  await page.evaluate(() =>
    (
      window.__plein.engine.doc as unknown as { undo: { stopCapturing(): void } }
    ).undo.stopCapturing(),
  )
  await f.input.fill('1.5')
  await f.input.press('Enter')
  expect(await f.saved()).toBe(1.5)
  await f.editor.getByRole('button', { name: '关闭', exact: true }).focus()
  await page.keyboard.press('ControlOrMeta+z')
  await expect(f.input).toHaveValue('1.2')
  expect(await f.saved()).toBe(1.2)
  await page.keyboard.press('ControlOrMeta+Shift+z')
  await expect(f.input).toHaveValue('1.5')
  await f.editor.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(f.editor).toBeHidden()
  await f.open()
  await expect(f.input).toHaveValue('1.5')
})

for (const keepDraft of [false, true]) {
  test(`成片秒数协作更新后失焦不覆盖，可${keepDraft ? '保留草稿' : '使用最新数值'}`, async ({
    page,
    context,
  }) => {
    const f = await filmNumber(page)
    const peerContext = await context.browser()!.newContext()
    try {
      const peer = await peerContext.newPage()
      await peer.goto(page.url())
      await waitEngine(peer)
      await expect
        .poll(() => peer.evaluate((id) => !!window.__plein.engine.doc.get(id), f.id))
        .toBe(true)
      await clickElement(peer, f.id)
      const at = await centerOf(peer, f.id)
      await peer.mouse.dblclick(at.x, at.y)
      const other = peer.getByRole('dialog', { name: '序列', exact: true })
      await other.getByRole('button', { name: '成片', exact: true }).click()
      await f.input.fill('1.8')
      await other.getByRole('spinbutton', { name: '转场时长（秒）', exact: true }).fill('0.8')
      await other.getByRole('spinbutton', { name: '转场时长（秒）', exact: true }).press('Enter')
      await expect.poll(f.saved).toBe(0.8)
      await f.input.press('Tab')
      expect(await f.saved()).toBe(0.8)
      await expect(f.input).toHaveValue('1.8')
      await expect(f.editor.getByRole('status')).toContainText('设置已更新为 0.8')
      if (!keepDraft) {
        await f.editor.getByRole('status').scrollIntoViewIfNeeded()
        await f.editor
          .locator('.seq-inspector')
          .screenshot({ path: test.info().outputPath('seconds-conflict.png') })
      }
      await f.editor
        .getByRole('button', { name: keepDraft ? '保留当前数值' : '使用最新数值', exact: true })
        .click()
      await expect(f.input).toHaveValue(keepDraft ? '1.8' : '0.8')
      await expect(f.input).toBeFocused()
      await expect(f.editor.getByRole('status')).toHaveCount(0)
      expect(await f.saved()).toBe(keepDraft ? 1.8 : 0.8)
    } finally {
      await peerContext.close()
    }
  })
}
