import { expect, type Page, test } from '@playwright/test'
import { centerOf, elements, newProject, waitEngine, zoomTo } from './canvas'

async function pasteNote(page: Page, text: string) {
  await newProject(page)
  await page
    .locator('canvas')
    .first()
    .evaluate((canvas, text) => {
      const data = new DataTransfer()
      data.setData('text/plain', text)
      canvas.dispatchEvent(
        new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }),
      )
    }, text)
  await expect
    .poll(async () => (await elements(page)).filter((e) => e.kind === 'markdown').length)
    .toBe(1)
  const id = (await elements(page)).find((e) => e.kind === 'markdown')!.id
  await zoomTo(page, [id])
  return { id, preview: page.locator('.plein-md-preview:not([aria-hidden])') }
}

test('便签中的链接可以真实点击，在新页打开且不改变正文和节点', async ({ page, context }) => {
  await context.route('https://reference.test/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<meta charset="utf-8"><title>参考资料</title><p>受控参考页面</p>',
    }),
  )
  const text = '查看 [参考资料](https://reference.test/guide)\n\n正文应保持完整。'
  const { id, preview } = await pasteNote(page, text)
  const link = preview.getByRole('link', { name: '参考资料' })
  const point = (await link.boundingBox())!
  expect(
    await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('a')?.textContent, {
      x: point.x + point.width / 2,
      y: point.y + point.height / 2,
    }),
  ).toBe('参考资料')
  const popupPromise = page.waitForEvent('popup')
  await link.click()
  const popup = await popupPromise
  await expect(popup).toHaveURL('https://reference.test/guide')
  await expect(popup).toHaveTitle('参考资料')
  expect(await popup.evaluate(() => window.opener)).toBe(null)
  await popup.close()
  expect(await page.evaluate((id) => window.__plein.engine.doc.getText(id)?.toString(), id)).toBe(
    text,
  )
  expect((await elements(page)).map((e) => e.id)).toEqual([id])
  await expect(page.locator('.plein-md-editor')).toHaveCount(0)
  const popups: Page[] = []
  page.on('popup', (popup) => popups.push(popup))
  const cover = await page.evaluate((id) => {
    const r = window.__plein.engine.doc.worldRect(id)
    return window.__plein.addNode({
      type: 'plein/text',
      name: '链接上层卡片',
      params: { text: '' },
      x: r.x,
      y: r.y,
    })
  }, id)
  await expect
    .poll(() =>
      page.evaluate(({ x, y }) => !!document.elementFromPoint(x, y)?.closest('a'), {
        x: point.x + point.width / 2,
        y: point.y + point.height / 2,
      }),
    )
    .toBe(false)
  await page.mouse.click(point.x + point.width / 2, point.y + point.height / 2)
  await expect
    .poll(() => page.evaluate(() => window.__plein.engine.selection.values()))
    .toEqual([cover])
  expect(popups).toHaveLength(0)
})

test('延迟加载的大图适应便签宽度，加载后卡片增高并完整显示后续正文', async ({ page }) => {
  let release = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route('**/markdown-figure.svg', async (route) => {
    await gate
    await route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800"><rect width="1200" height="800" fill="teal"/></svg>',
    })
  })
  try {
    const { id, preview } = await pasteNote(
      page,
      '# 图文便签\n\n![参考图](/markdown-figure.svg)\n\n图片之后的结尾正文。',
    )
    const before = await page.evaluate((id) => window.__plein.engine.doc.worldRect(id).h, id)
    release()
    const image = preview.getByRole('img', { name: '参考图' })
    await expect.poll(() => image.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(1200)
    await expect
      .poll(() =>
        preview.evaluate((el) => {
          const image = el.querySelector('img')!.getBoundingClientRect()
          const box = el.getBoundingClientRect()
          const footer = el.lastElementChild!.getBoundingClientRect()
          return (
            image.right <= box.right &&
            image.left >= box.left &&
            footer.bottom <= box.bottom &&
            image.bottom <= box.bottom
          )
        }),
      )
      .toBe(true)
    expect(
      await page.evaluate((id) => window.__plein.engine.doc.worldRect(id).h, id),
    ).toBeGreaterThan(before)
    await preview.screenshot({ path: test.info().outputPath('markdown-image-ready.png') })
    const loadedHeight = await page.evaluate((id) => window.__plein.engine.doc.worldRect(id).h, id)
    const at = await centerOf(page, id)
    await page.mouse.dblclick(at.x, at.y)
    const editor = page.locator('.plein-md-editor .cm-content')
    await expect(editor).toBeFocused()
    await editor.press('ControlOrMeta+a')
    await page.keyboard.insertText('# 简短便签\n\n已移除图片。')
    await editor.press('Escape')
    await expect(editor).toHaveCount(0)
    await expect(preview.getByRole('img')).toHaveCount(0)
    await expect
      .poll(() => page.evaluate((id) => window.__plein.engine.doc.worldRect(id).h, id))
      .toBeLessThan(loadedHeight)
    await page.reload()
    await waitEngine(page)
    await expect
      .poll(() => page.evaluate((id) => window.__plein.engine.doc.getText(id)?.toString(), id))
      .toBe('# 简短便签\n\n已移除图片。')
  } finally {
    release()
  }
})
