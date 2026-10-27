import { expect, test } from './fixtures'
import { centerOf, clickElement, newProject } from './canvas'

for (const kind of ['storyboard', 'sequence'] as const) {
  for (const action of ['choose', 'space', 'cancel'] as const) {
    test(`${kind} 下拉菜单键盘 ${action} 不触发父级编辑器`, async ({ page }) => {
      await newProject(page)
      const id = await page.evaluate(
        (kind) =>
          window.__plein.addNode({
            type: kind === 'storyboard' ? 'plein/storyboard' : 'plein/animatic',
            name: '下拉键盘',
            x: 400,
            y: 200,
            params:
              kind === 'storyboard'
                ? {
                    shots: [
                      {
                        id: 'one',
                        no: 1,
                        duration: 3,
                        shotSize: '中景',
                        description: '保留的画面',
                        dialogue: [],
                      },
                    ],
                  }
                : { subtitles: false, shots: [{ shotId: 'one', duration: 3, dialogue: [] }] },
          }),
        kind,
      )
      await clickElement(page, id)
      const at = await centerOf(page, id)
      await page.mouse.dblclick(at.x, at.y)
      const editor = page.getByRole('dialog', {
        name: kind === 'storyboard' ? '分镜表' : '序列',
        exact: true,
      })
      if (kind === 'sequence')
        await editor.getByRole('button', { name: '成片', exact: true }).click()
      // 表格视图的景别下拉按镜头编号命名
      const label = kind === 'storyboard' ? '镜头 1 景别' : '转场'
      const trigger = editor.getByRole('combobox', { name: label, exact: true })
      const list = page.getByRole('listbox')
      const initial = await trigger.innerText()
      const params = () => page.evaluate((id) => window.__plein.engine.doc.get(id)!.params, id)
      const before = await params()
      const bounds = await page.evaluate((id) => window.__plein.engine.doc.worldRect(id), id)
      const time = kind === 'sequence' ? await editor.locator('.seq-time').innerText() : undefined
      if (action !== 'cancel') {
        await trigger.focus()
        await trigger.press('ArrowDown')
        await expect(list).toBeVisible()
        await expect(list).toHaveAccessibleName(label)
        await page.keyboard.press('End')
        const last = await list.getByRole('option').last().innerText()
        await page.keyboard.press(action === 'space' ? 'Space' : 'Enter')
        await expect(list).toBeHidden()
        await expect(trigger).toHaveText(last)
        await expect(trigger).toBeFocused()
        const saved = await params()
        if (kind === 'storyboard')
          expect((saved!.shots as Array<{ shotSize: string }>)[0]!.shotSize).toBe(last)
        else expect(saved!.transition).toBe(last)
      } else {
        await trigger.click()
        await expect(list).toBeVisible()
        await expect(list).toHaveAccessibleName(label)
        await page.keyboard.press('ArrowDown')
        await page.keyboard.press('Escape')
        await page.evaluate(
          () =>
            new Promise<void>((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
            ),
        )
        await expect(list).toBeHidden()
        await expect(editor).toHaveCSS('opacity', '1')
        await expect(trigger).toBeFocused()
        await expect(trigger).toHaveText(initial)
        expect(await params()).toEqual(before)
      }
      expect(await page.evaluate(() => window.__plein.engine.selection.values())).toEqual([id])
      expect(await page.evaluate((id) => window.__plein.engine.doc.worldRect(id), id)).toEqual(
        bounds,
      )
      if (time) await expect(editor.locator('.seq-time')).toHaveText(time)
      if (kind === 'sequence')
        await expect(
          editor.locator('.seq-monitor').getByRole('button', { name: '播放', exact: true }),
        ).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(editor).toBeHidden()
    })
  }
}

for (const kind of ['storyboard', 'sequence'] as const) {
  for (const key of ['Escape', 'Space', 'ArrowRight']) {
    test(`${kind} 上层设置接收 ${key}，不关闭或控制背景编辑器`, async ({ page }) => {
      await newProject(page)
      const id = await page.evaluate(
        (kind) =>
          window.__plein.addNode({
            type: kind === 'storyboard' ? 'plein/storyboard' : 'plein/animatic',
            name: '上层设置键盘归属',
            x: 400,
            y: 200,
            params:
              kind === 'storyboard'
                ? {
                    shots: [
                      { id: 'one', no: 1, duration: 3, description: '保留画面', dialogue: [] },
                    ],
                  }
                : { subtitles: false, shots: [{ shotId: 'one', duration: 3, dialogue: [] }] },
          }),
        kind,
      )
      await clickElement(page, id)
      const at = await centerOf(page, id)
      await page.mouse.dblclick(at.x, at.y)
      const editor = page.getByRole('dialog', {
        name: kind === 'storyboard' ? '分镜表' : '序列',
        exact: true,
      })
      await expect(editor).toBeVisible()
      const before = await page.evaluate((id) => window.__plein.engine.doc.get(id)!.params, id)
      const time = kind === 'sequence' ? await editor.locator('.seq-time').innerText() : undefined
      await page.evaluate(() => window.dispatchEvent(new CustomEvent('plein:open-settings')))
      const settings = page.getByRole('dialog', { name: '设置', exact: true })
      await expect(settings).toBeVisible()
      const close = settings.getByRole('button', { name: '关闭', exact: true })
      await close.focus()
      await close.press(key)
      if (key === 'ArrowRight') {
        await expect(settings).toBeVisible()
        if (time) await expect(page.locator('.seq-editor .seq-time')).toHaveText(time)
        await close.click()
      }
      await expect(settings).toHaveCount(0)
      await expect(editor).toBeVisible()
      await expect(editor).toHaveCSS('opacity', '1')
      expect(await page.evaluate((id) => window.__plein.engine.doc.get(id)!.params, id)).toEqual(
        before,
      )
      if (time) {
        await expect(editor.locator('.seq-time')).toHaveText(time)
        await expect(
          editor.locator('.seq-monitor').getByRole('button', { name: '播放', exact: true }),
        ).toBeVisible()
      }
    })
  }
}

test('序列按钮上的空格激活该按钮，回到开头与关闭不误启动播放', async ({ page }) => {
  await newProject(page)
  const id = await page.evaluate(() =>
    window.__plein.addNode({
      type: 'plein/animatic',
      name: '按钮空格归属',
      x: 400,
      y: 200,
      params: { subtitles: false, shots: [{ shotId: 'one', duration: 3, dialogue: [] }] },
    }),
  )
  await clickElement(page, id)
  const at = await centerOf(page, id)
  await page.mouse.dblclick(at.x, at.y)
  const editor = page.getByRole('dialog', { name: '序列', exact: true })
  const monitor = editor.locator('.seq-monitor')
  const start = monitor.getByRole('button', { name: '回到开头', exact: true })
  await start.focus()
  await page.keyboard.press('Shift+ArrowRight')
  await expect(monitor.locator('.seq-time > span').first()).toHaveText('0:01.0')
  await start.press('Space')
  await expect(monitor.locator('.seq-time > span').first()).toHaveText('0:00.0')
  await expect(monitor.getByRole('button', { name: '播放', exact: true })).toBeVisible()
  await monitor.locator('.seq-stage').click()
  await page.keyboard.press('Space')
  await expect(monitor.getByRole('button', { name: '暂停', exact: true })).toBeVisible()
  await page.keyboard.press('Space')
  await expect(monitor.getByRole('button', { name: '播放', exact: true })).toBeVisible()
  await editor.focus()
  await editor.press('Space')
  await expect(monitor.getByRole('button', { name: '暂停', exact: true })).toBeVisible()
  await editor.press('Space')
  await expect(monitor.getByRole('button', { name: '播放', exact: true })).toBeVisible()
  await editor.getByRole('button', { name: '关闭', exact: true }).press('Space')
  await expect(editor).toHaveCount(0)
  expect(await page.evaluate(() => window.__plein.engine.selection.values())).toEqual([id])
})
