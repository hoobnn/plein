import { expect, test } from '@playwright/test'
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
      const label = kind === 'storyboard' ? '景别' : '转场'
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
