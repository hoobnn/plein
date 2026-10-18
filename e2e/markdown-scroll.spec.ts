import { expect, test } from '@playwright/test'
import { elements, newProject, zoomTo } from './canvas'

for (const kind of ['代码块', '表格']) {
  test(`便签的超宽${kind}可用滚轮和键盘查看，不移动画布或节点`, async ({ page }) => {
    await newProject(page)
    const text =
      kind === '代码块'
        ? `# 代码示例\n\n\`\`\`text\n${'long_value_'.repeat(35)}代码末尾\n第二行\n\`\`\`\n\n结尾正文。`
        : `# 分镜表\n\n| ${Array.from({ length: 12 }, (_, i) => `字段${i + 1}`).join(' | ')} |\n| ${Array(12).fill('---').join(' | ')} |\n| ${Array.from({ length: 12 }, (_, i) => `内容${i + 1}`).join(' | ')} |\n\n结尾正文。`
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
    const preview = page.locator('.plein-md-preview:not([aria-hidden])')
    const content = preview.locator(kind === '代码块' ? 'pre code' : 'table')
    const p = (await preview.boundingBox())!
    const box = (await content.boundingBox())!
    const at = { x: p.x + 60, y: box.y + 12 }
    expect(
      await page.evaluate(
        ({ x, y }) => !!document.elementFromPoint(x, y)?.closest('pre, table'),
        at,
      ),
    ).toBe(true)
    const region = preview.getByRole('region', { name: kind, exact: true })
    const before = await page.evaluate((id) => {
      const e = window.__plein.engine
      return {
        geometry: e.doc.worldRect(id),
        at: e.worldToClient(0, 0),
        selected: e.selection.values(),
      }
    }, id)
    await region.focus()
    for (const key of ['Delete', 'Backspace', 'ControlOrMeta+z']) await page.keyboard.press(key)
    expect((await elements(page)).map((e) => e.id)).toEqual([id])
    expect(
      await region.evaluate((el) => {
        const data = new DataTransfer()
        const event = new ClipboardEvent('copy', {
          bubbles: true,
          cancelable: true,
          clipboardData: data,
        })
        el.dispatchEvent(event)
        return event.defaultPrevented
      }),
    ).toBe(false)
    await page.keyboard.press('ArrowRight')
    await expect.poll(() => region.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0)
    await region.evaluate((el) => {
      el.scrollLeft = 0
    })
    await page.mouse.move(at.x, at.y)
    await page.mouse.wheel(220, 0)
    await expect.poll(() => region.evaluate((el) => el.scrollLeft)).toBeGreaterThan(100)
    expect(
      await page.evaluate((id) => {
        const e = window.__plein.engine
        return {
          geometry: e.doc.worldRect(id),
          at: e.worldToClient(0, 0),
          selected: e.selection.values(),
        }
      }, id),
    ).toEqual(before)
    await region.evaluate((el) => {
      el.scrollLeft = el.scrollWidth
    })
    await expect(region).toContainText(kind === '代码块' ? '代码末尾' : '内容12')
    expect(
      await region.evaluate((el, kind) => {
        let tail: DOMRect
        if (kind === '代码块') {
          const text = el.querySelector('code')!.firstChild!
          const start = text.textContent!.indexOf('代码末尾')
          const range = document.createRange()
          range.setStart(text, start)
          range.setEnd(text, start + 4)
          tail = range.getBoundingClientRect()
        } else tail = el.querySelector('td:last-child')!.getBoundingClientRect()
        const box = el.getBoundingClientRect()
        return tail.left >= box.left - 1 && tail.right <= box.right + 1
      }, kind),
    ).toBe(true)
    await preview.screenshot({ path: test.info().outputPath(`markdown-${kind}-scrolled.png`) })
    await region.evaluate((el) => {
      el.scrollLeft = 0
    })
    await page.keyboard.down('Shift')
    await page.mouse.wheel(0, 180)
    await page.keyboard.up('Shift')
    await expect.poll(() => region.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0)
    const scale = () =>
      page.evaluate(() => {
        const e = window.__plein.engine
        return e.worldToClient(100, 0).x - e.worldToClient(0, 0).x
      })
    const scaleBefore = await scale()
    const zoomKey = kind === '代码块' ? 'Control' : 'Meta'
    await page.keyboard.down(zoomKey)
    await page.mouse.wheel(0, -40)
    await page.keyboard.up(zoomKey)
    await expect.poll(scale).toBeGreaterThan(scaleBefore)
    const yBefore = await page.evaluate(() => window.__plein.engine.worldToClient(0, 0).y)
    await page.mouse.wheel(0, 50)
    await expect
      .poll(() => page.evaluate(() => window.__plein.engine.worldToClient(0, 0).y))
      .toBeLessThan(yBefore)
    await page.keyboard.press('Escape')
    await expect(region).not.toBeFocused()
    expect(await page.evaluate(() => window.__plein.engine.selection.values())).toEqual(
      before.selected,
    )
    expect(await page.evaluate((id) => window.__plein.engine.doc.getText(id)?.toString(), id)).toBe(
      text,
    )
  })
}
