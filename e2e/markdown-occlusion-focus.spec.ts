import { expect, type Page, test } from '@playwright/test'
import { elements, newProject, settle, zoomTo } from './canvas'

async function setup(page: Page) {
  await newProject(page)
  await page
    .locator('canvas')
    .first()
    .evaluate((canvas) => {
      const data = new DataTransfer()
      data.setData(
        'text/plain',
        '[可见入口](https://reference.test/visible)\n\n占位 占位 占位 占位 [隐藏引用](https://reference.test/hidden)\n\n```text\n可见代码区\n```',
      )
      canvas.dispatchEvent(
        new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }),
      )
    })
  await expect
    .poll(async () => (await elements(page)).filter((e) => e.kind === 'markdown').length)
    .toBe(1)
  const id = (await elements(page)).find((e) => e.kind === 'markdown')!.id
  await zoomTo(page, [id])
  const preview = page.locator('.plein-md-preview:not([aria-hidden])')
  return {
    id,
    preview,
    first: preview.locator('a[href$="/visible"]'),
    hidden: preview.locator('a[href$="/hidden"]'),
    code: preview.locator('[data-plein-scroll]'),
  }
}

async function moveCover(page: Page, id: string) {
  await page.evaluate((id) => {
    ;(window.__plein.engine.doc.mutable(id) as unknown as { set(k: string, v: unknown): void }).set(
      'x',
      2000,
    )
  }, id)
}

test('局部遮挡的便签链接跳过 Tab，露出的代码区可聚焦，移开遮挡后恢复', async ({ page }) => {
  const f = await setup(page)
  const mask = await f.hidden.evaluate((el) => {
    const root = el.closest('.plein-md-preview')!.getBoundingClientRect()
    const r = el.getBoundingClientRect()
    return { x: r.x - root.x, y: r.y - root.y, w: r.width, h: r.height, width: root.width }
  })
  const cover = await page.evaluate(
    ({ id, mask }) => {
      const e = window.__plein.engine
      const r = e.doc.worldRect(id)
      const scale = r.w / mask.width
      const cover = window.__plein.addNode({
        type: 'plein/text',
        name: '局部遮挡',
        params: { text: '' },
        x: r.x + mask.x * scale - 4,
        y: r.y + mask.y * scale - 4,
      })
      const m = e.doc.mutable(cover) as unknown as { set(k: string, v: unknown): void }
      m.set('w', mask.w * scale + 8)
      m.set('h', mask.h * scale + 8)
      return cover
    },
    { id: f.id, mask },
  )
  await expect.poll(() => f.preview.evaluate((el) => el.style.clipPath)).not.toBe('')
  await f.first.focus()
  await page.keyboard.press('Tab')
  await expect(f.code).toBeFocused()
  await expect(f.hidden).not.toBeFocused()
  expect(await f.preview.evaluate((el: HTMLElement) => el.inert)).toBe(false)
  await page.evaluate(() => {
    ;(window.__plein.engine as unknown as { zoomTo(level: number): void }).zoomTo(1.3)
  })
  await settle(page, f.id)
  await page.evaluate((id) => {
    const text = window.__plein.engine.doc.getText(id)!
    const next = text.toString().replace('隐藏引用', '更新引用')
    text.delete(0, text.length)
    text.insert(0, next)
  }, f.id)
  await expect(f.hidden).toHaveText('更新引用')
  await f.first.focus()
  await page.keyboard.press('Tab')
  await expect(f.code).toBeFocused()
  await page.screenshot({ path: test.info().outputPath('markdown-partial-focus.png') })
  await moveCover(page, cover)
  await expect.poll(() => f.preview.evaluate((el) => el.style.clipPath)).toBe('')
  await f.first.focus()
  await page.keyboard.press('Tab')
  await expect(f.hidden).toBeFocused()
})

test('完全遮挡便签会撤下不可见焦点，恢复后链接和滚动区重新可用', async ({ page }) => {
  const f = await setup(page)
  await f.code.focus()
  await expect(f.code).toBeFocused()
  const cover = await page.evaluate((id) => {
    const e = window.__plein.engine
    const r = e.doc.worldRect(id)
    const cover = window.__plein.addNode({
      type: 'plein/text',
      name: '完整遮挡',
      params: { text: '' },
      x: r.x - 20,
      y: r.y - 20,
    })
    const m = e.doc.mutable(cover) as unknown as { set(k: string, v: unknown): void }
    m.set('w', r.w + 40)
    m.set('h', r.h + 40)
    return cover
  }, f.id)
  await expect
    .poll(() => f.preview.evaluate((el) => el.style.clipPath))
    .toMatch(/M[ ,]*0[ ,]*0[ ,]*Z/)
  await expect(f.code).not.toBeFocused()
  expect(await f.preview.evaluate((el: HTMLElement) => el.inert)).toBe(true)
  await f.hidden.focus()
  await expect(f.hidden).not.toBeFocused()
  await moveCover(page, cover)
  await expect.poll(() => f.preview.evaluate((el) => el.style.clipPath)).toBe('')
  await f.code.focus()
  await expect(f.code).toBeFocused()
  expect((await elements(page)).map((e) => e.id).sort()).toEqual([f.id, cover].sort())
})
