import { expect, test } from '@playwright/test'
import { centerOf, clickElement, newProject } from './canvas'

for (const [key, label, initial] of [
  ['duration', '样片镜头时长（秒）', 3],
  ['lineDelay', '对白起始延迟（秒）', 2],
  ['lineGap', '对白句间停顿（秒）', 1.2],
] as const) {
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
