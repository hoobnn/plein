import { expect, type Locator, test } from '@playwright/test'
import { centerOf, clickElement, newProject } from './canvas'

async function composingKey(input: Locator, key: string, isComposing: boolean) {
  const prevented = await input.evaluate(
    async (el, { key, isComposing }) => {
      el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: 'zhong' }))
      const event = new KeyboardEvent('keydown', {
        key,
        code: key,
        isComposing,
        keyCode: isComposing ? (key === 'Enter' ? 13 : 27) : 229,
        bubbles: true,
        cancelable: true,
      })
      el.dispatchEvent(event)
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      )
      return event.defaultPrevented
    },
    { key, isComposing },
  )
  expect(prevented).toBe(false)
}
async function endComposition(input: Locator) {
  await input.evaluate(async (el) => {
    el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中' }))
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  })
}

for (const isComposing of [true, false]) {
  test(`分镜 IME Escape 不关闭编辑器，composing=${isComposing}`, async ({ page }) => {
    await newProject(page)
    const id = await page.evaluate(() =>
      window.__plein.addNode({
        type: 'plein/storyboard',
        name: '分镜输入法',
        x: 400,
        y: 200,
        params: {
          shots: [{ id: 'one', no: 1, duration: 3, description: '原始画面', dialogue: [] }],
        },
      }),
    )
    await clickElement(page, id)
    const at = await centerOf(page, id)
    await page.mouse.dblclick(at.x, at.y)
    const editor = page.getByRole('dialog', { name: '分镜表', exact: true })
    const input = editor.getByRole('textbox', { name: '画面', exact: true })
    const read = () =>
      page.evaluate(
        (id) =>
          (window.__plein.engine.doc.get(id)!.params!.shots as Array<{ description: string }>)[0]!
            .description,
        id,
      )
    await input.fill('正在编辑的中文草稿')
    await composingKey(input, 'Escape', isComposing)
    await expect(editor).toHaveCSS('opacity', '1')
    await expect(input).toBeFocused()
    await expect(input).toHaveValue('正在编辑的中文草稿')
    expect(await read()).toBe('原始画面')
    await endComposition(input)
    await input.press('Tab')
    await expect.poll(read).toBe('正在编辑的中文草稿')
    await page.keyboard.press('Escape')
    await expect(editor).toBeHidden()
  })

  test(`序列字幕 IME Enter 不失焦提交，composing=${isComposing}`, async ({ page }) => {
    await newProject(page)
    const id = await page.evaluate(() => {
      const video = window.__plein.addNode({
        type: 'plein/video',
        name: '待生成镜头',
        x: -500,
        y: 200,
        params: {},
      })
      const seq = window.__plein.addNode({
        type: 'plein/sequence',
        name: '字幕输入法',
        x: 400,
        y: 200,
        params: {},
      })
      if (!window.__plein.connect([video, 'video'], [seq, 'clips'])) throw new Error('连线失败')
      return seq
    })
    await clickElement(page, id)
    const at = await centerOf(page, id)
    await page.mouse.dblclick(at.x, at.y)
    const editor = page.getByRole('dialog', { name: '序列', exact: true })
    const input = editor.getByRole('textbox', { name: '字幕', exact: true })
    const read = () =>
      page.evaluate(
        (id) =>
          (
            (window.__plein.engine.doc.get(id)!.params!.clips ?? []) as Array<{ subtitle?: string }>
          )[0]?.subtitle ?? '',
        id,
      )
    await input.fill('还在组词的字幕')
    await composingKey(input, 'Enter', isComposing)
    await expect(input).toBeFocused()
    expect(await read()).toBe('')
    await expect(input).toHaveValue('还在组词的字幕')
    await endComposition(input)
    await input.press('Enter')
    await expect.poll(read).toBe('还在组词的字幕')
    await page.keyboard.press('Escape')
    await expect(editor).toBeHidden()
  })
}

for (const key of ['Enter', 'Escape']) {
  test(`样片秒数 IME ${key} 不提交或取消原草稿`, async ({ page }) => {
    await newProject(page)
    const id = await page.evaluate(() =>
      window.__plein.addNode({
        type: 'plein/animatic',
        name: '秒数输入法',
        x: 400,
        y: 200,
        params: { subtitles: false, shots: [{ shotId: 'one', duration: 3, dialogue: [] }] },
      }),
    )
    await clickElement(page, id)
    const at = await centerOf(page, id)
    await page.mouse.dblclick(at.x, at.y)
    const editor = page.getByRole('dialog', { name: '序列', exact: true })
    const input = editor.getByRole('spinbutton', { name: '样片镜头时长（秒）', exact: true })
    await input.fill('2.5')
    await composingKey(input, key, true)
    await expect(input).toBeFocused()
    await expect(input).toHaveValue('2.5')
    expect(
      await page.evaluate(
        (id) =>
          (window.__plein.engine.doc.get(id)!.params!.shots as Array<{ duration: number }>)[0]!
            .duration,
        id,
      ),
    ).toBe(3)
    await endComposition(input)
    await input.press('Enter')
    await expect
      .poll(() =>
        page.evaluate(
          (id) =>
            (window.__plein.engine.doc.get(id)!.params!.shots as Array<{ duration: number }>)[0]!
              .duration,
          id,
        ),
      )
      .toBe(2.5)
  })
}
