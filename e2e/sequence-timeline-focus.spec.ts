import { expect, type Page, test } from '@playwright/test'
import { centerOf, clickElement, newProject } from './canvas'

async function fixture(page: Page, readOnly = false, multiple = false) {
  await newProject(page)
  const id = await page.evaluate(
    ({ readOnly, multiple }) => {
      const id = window.__plein.addNode({
        type: 'plein/animatic',
        name: '时间线焦点',
        x: 400,
        y: 200,
        params: {
          subtitles: false,
          shots: multiple
            ? [
                { shotId: 'first', duration: 10, dialogue: [] },
                { shotId: 'second', duration: 10, dialogue: [] },
              ]
            : [{ shotId: 'placeholder', duration: 30, dialogue: [] }],
        },
      })
      ;(window.__plein.engine.doc as unknown as { readOnly: boolean }).readOnly = readOnly
      return id
    },
    { readOnly, multiple },
  )
  await clickElement(page, id)
  const at = await centerOf(page, id)
  await page.mouse.dblclick(at.x, at.y)
  const editor = page.getByRole('dialog', { name: '序列', exact: true })
  await expect(editor).toHaveCSS('opacity', '1')
  return {
    id,
    editor,
    timeline: editor.getByRole('region', { name: '时间线', exact: true }),
    zoom: editor.getByRole('slider', { name: '缩放', exact: true }),
  }
}

for (const readOnly of [false, true]) {
  for (const action of ['ruler', 'grip', 'fit', 'zoom-out', 'zoom-in'] as const) {
    test(`时间线 ${action} 后焦点和播放快捷键可用，只读=${readOnly}`, async ({ page }) => {
      if (action === 'fit' && !readOnly) await page.setViewportSize({ width: 390, height: 700 })
      const { editor, timeline, zoom } = await fixture(page, readOnly)
      await zoom.focus()
      await zoom.press('ArrowRight')
      if (action === 'ruler') {
        const scroller = (await editor.locator('.seq-scroll').boundingBox())!
        const ruler = (await editor.locator('.seq-ruler').boundingBox())!
        await page.mouse.click(scroller.x + scroller.width * 0.65, ruler.y + ruler.height / 2)
      } else if (action === 'grip') {
        await editor.getByRole('button', { name: '回到开头', exact: true }).click()
        await zoom.focus()
        const grip = (await editor.locator('.seq-playhead-grip').boundingBox())!
        await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2)
        await page.mouse.down()
        await page.mouse.move(grip.x + 25, grip.y + grip.height / 2, { steps: 3 })
        await page.mouse.up()
      } else if (action === 'fit') {
        await zoom.press('End')
        await editor.getByRole('button', { name: '铺满', exact: true }).click()
      } else if (action === 'zoom-out') {
        await zoom.press('Home')
        await editor.getByRole('button', { name: '放大', exact: true }).click()
        await editor.getByRole('button', { name: '缩小', exact: true }).click()
      } else {
        await zoom.press('End')
        await zoom.press('ArrowLeft')
        await editor.getByRole('button', { name: '放大', exact: true }).click()
      }
      await test.info().attach('focus-before-keyboard.json', {
        body: JSON.stringify(
          await page.evaluate(() => ({
            tag: document.activeElement?.tagName,
            label: document.activeElement?.getAttribute('aria-label'),
          })),
        ),
        contentType: 'application/json',
      })
      await page.keyboard.press('Home')
      await expect(editor.locator('.seq-time')).toHaveText('0:00.0 / 0:30.0')
      await page.keyboard.press('End')
      await expect(editor.locator('.seq-time')).toHaveText('0:30.0 / 0:30.0')
      await expect(timeline).toBeFocused()
      if (action === 'fit' && !readOnly)
        await editor.screenshot({ path: test.info().outputPath('timeline-focus-390.png') })
      for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowLeft')
      await expect(editor.locator('.seq-time')).toHaveText('0:29.9 / 0:30.0')
      await page.keyboard.press('Space')
      await expect(editor.getByRole('button', { name: '播放', exact: true })).toBeVisible()
      await expect(editor.locator('.seq-time')).toHaveText('0:30.0 / 0:30.0')
    })
  }
}

test('缩放滑杆保留原生 Home End 和方向键，不移动播放头', async ({ page }) => {
  const { editor, zoom } = await fixture(page)
  await editor.getByRole('button', { name: '跳到结尾', exact: true }).click()
  await zoom.press('End')
  expect(Number(await zoom.inputValue())).toBeGreaterThan(1)
  await zoom.press('Home')
  await expect(zoom).toHaveValue('0')
  await zoom.press('ArrowRight')
  expect(Number(await zoom.inputValue())).toBeGreaterThan(0)
  await expect(zoom).toBeFocused()
  await expect(editor.locator('.seq-time')).toHaveText('0:30.0 / 0:30.0')
})

for (const readOnly of [false, true]) {
  for (const key of ['Enter', 'Space', 'assistive'] as const) {
    test(`Tab 选择镜头后 ${key} 定位对应开头，只读=${readOnly}`, async ({ page }) => {
      const { id, editor, timeline } = await fixture(page, readOnly, true)
      let runs = 0
      page.on('request', (request) => {
        if (request.method() === 'POST' && /\/nodes\/[^/]+\/run$/.test(request.url())) runs++
      })
      const saved = () => page.evaluate((id) => window.__plein.engine.doc.get(id)?.params, id)
      const before = await saved()
      const clips = timeline.locator('.seq-clip')
      await editor.getByRole('button', { name: '回到开头', exact: true }).focus()
      for (let i = 0; i < 5; i++) await page.keyboard.press('Shift+ArrowRight')
      await expect(editor.locator('.seq-time')).toHaveText('0:05.0 / 0:20.0')
      await clips.first().focus()
      await page.keyboard.press('Tab')
      await expect(clips.nth(1)).toBeFocused()
      await expect(clips.nth(1)).toHaveAttribute('aria-pressed', 'true')
      await expect(editor.locator('.seq-time')).toHaveText('0:05.0 / 0:20.0')
      if (key === 'assistive') await clips.nth(1).evaluate((el: HTMLElement) => el.click())
      else await page.keyboard.press(key)
      await expect(editor.locator('.seq-time')).toHaveText('0:10.0 / 0:20.0')
      await expect(editor.getByRole('button', { name: '播放', exact: true })).toBeVisible()
      await expect(clips.nth(1)).toBeFocused()
      await page.keyboard.press('Shift+ArrowRight')
      await expect(editor.locator('.seq-time')).toHaveText('0:11.0 / 0:20.0')
      await clips
        .nth(1)
        .dispatchEvent('keydown', { key: key === 'Space' ? ' ' : 'Enter', repeat: true })
      await page.keyboard.press('Control+Enter')
      await clips.nth(1).dispatchEvent('keydown', { key: 'Enter', isComposing: true })
      await expect(editor.locator('.seq-time')).toHaveText('0:11.0 / 0:20.0')
      expect(await saved()).toEqual(before)
      expect(runs).toBe(0)
    })
  }
}
