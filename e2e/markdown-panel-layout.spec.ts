import { expect, type Page, test } from '@playwright/test'
import { elements, newProject, settle } from './canvas'

async function setup(page: Page, left: number) {
  await newProject(page)
  const text = [
    '首行正文',
    ...Array.from({ length: 40 }, (_, i) => `第 ${i + 1} 行：完整保留的长正文。`),
    '末尾正文',
  ].join('\n')
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
  await page.evaluate(
    ({ id, left }) => {
      const e = window.__plein.engine as Window['__plein']['engine'] & {
        zoomTo(z: number): void
        camera: { panBy(x: number, y: number): void }
      }
      e.zoomTo(1)
      const r = e.doc.worldRect(id)
      const p = e.worldToClient(r.x, r.y)
      e.camera.panBy(left - p.x, 120 - p.y)
    },
    { id, left },
  )
  await settle(page, id)
  await page.mouse.dblclick(left + 30, 145)
  const editor = page.locator('.plein-md-editor .cm-content')
  const frame = page.locator('.plein-md-editor .cm-editor')
  const caret = page.locator('.plein-md-editor .cm-cursor')
  await expect(editor).toBeFocused()
  await editor.press('ControlOrMeta+End')
  await expect(caret).toBeInViewport({ ratio: 0.999 })
  const camera = () =>
    page.evaluate(() => {
      const c = (
        window.__plein.engine as unknown as { camera: { x: number; y: number; zoom: number } }
      ).camera
      return { x: c.x, y: c.y, zoom: c.zoom }
    })
  const initial = await camera()
  const intact = async () => {
    expect(await camera()).toEqual(initial)
    expect(await page.evaluate((id) => window.__plein.engine.doc.getText(id)?.toString(), id)).toBe(
      text,
    )
    expect(
      await page.evaluate(() => document.querySelector('.plein-overlay')!.parentElement!.scrollTop),
    ).toBe(0)
  }
  return { id, editor, frame, caret, intact }
}

test('编辑中调整和收起侧栏立即更新编辑区域，光标与正文保留', async ({ page }) => {
  const f = await setup(page, 300)
  const handle = page.getByRole('separator', { name: '调整侧栏宽度', exact: true })
  await handle.focus()
  for (let i = 0; i < 6; i++) await page.keyboard.press('Shift+ArrowRight')
  await expect(handle).toHaveAttribute('aria-valuenow', '480')
  await expect.poll(async () => (await f.frame.boundingBox())!.x).toBeGreaterThanOrEqual(492)
  await f.editor.focus()
  await expect(f.editor).toBeFocused()
  await expect(f.caret).toBeInViewport({ ratio: 0.999 })
  await page.keyboard.press('ControlOrMeta+Backslash')
  await expect(page.getByRole('button', { name: '展开侧栏', exact: true })).toBeVisible()
  await expect.poll(async () => Math.round((await f.frame.boundingBox())!.x)).toBe(300)
  await expect(f.editor).toBeFocused()
  await expect(f.caret).toBeInViewport({ ratio: 0.999 })
  await f.intact()
})

test('编辑中打开和收起助手面板立即更新右侧边界', async ({ page }) => {
  const f = await setup(page, 900)
  await page.getByRole('button', { name: '打开助手', exact: true }).click()
  await expect(page.getByRole('button', { name: '收起助手', exact: true })).toBeVisible()
  await expect(page.getByRole('textbox', { name: '让小满帮你做点什么…' })).toBeFocused()
  await expect
    .poll(async () => {
      const r = (await f.frame.boundingBox())!
      return r.x + r.width
    })
    .toBeLessThanOrEqual(1016)
  await f.editor.focus()
  await expect(f.editor).toBeFocused()
  await expect(f.caret).toBeInViewport({ ratio: 0.999 })
  await page.getByRole('button', { name: '收起助手', exact: true }).click()
  await expect.poll(async () => Math.round((await f.frame.boundingBox())!.width)).toBe(360)
  await f.editor.focus()
  await expect(f.caret).toBeInViewport({ ratio: 0.999 })
  await f.intact()
})

test('编辑中缩小窗口保留光标可见并可继续追加正文', async ({ page }) => {
  const f = await setup(page, 600)
  await page.setViewportSize({ width: 800, height: 600 })
  await expect
    .poll(async () => {
      const r = (await f.frame.boundingBox())!
      return r.x + r.width <= 800 && r.y + r.height <= 536
    })
    .toBe(true)
  await expect(f.editor).toBeFocused()
  await expect(f.caret).toBeInViewport({ ratio: 0.999 })
  await f.intact()
  await page.keyboard.insertText('，缩小后追加')
  await expect(f.caret).toBeInViewport({ ratio: 0.999 })
  await expect
    .poll(() =>
      page.evaluate(
        (id) => window.__plein.engine.doc.getText(id)?.toString().endsWith('末尾正文，缩小后追加'),
        f.id,
      ),
    )
    .toBe(true)
  await page.screenshot({ path: test.info().outputPath('markdown-resized-editor.png') })
})
