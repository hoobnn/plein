import { expect, type Page, test } from '@playwright/test'
import { elements, newProject, zoomTo } from './canvas'

async function setup(page: Page, kind: string) {
  await newProject(page)
  const background = await page.evaluate(() =>
    window.__plein.addNode({
      type: 'plein/text',
      name: '选区外的背景',
      params: { text: '保留背景正文' },
      x: -1000,
      y: -1000,
    }),
  )
  const base =
    kind === '代码块'
      ? `# 选区外的标题\n\n\`\`\`text\n${'value_'.repeat(80)}代码尾部\n第二行\n\`\`\`\n\n不应被复制的便签结尾。`
      : `# 选区外的标题\n\n| ${Array.from({ length: 12 }, (_, i) => `字段${i + 1}`).join(' | ')} |\n| ${Array(12).fill('---').join(' | ')} |\n| ${Array.from({ length: 12 }, (_, i) => `内容${i + 1}`).join(' | ')} |\n\n不应被复制的便签结尾。`
  const text =
    base +
    (kind === '代码块'
      ? '\n\n```text\n另一个代码区不应被复制\n```'
      : '\n\n| 其他表 |\n| --- |\n| 另一个表格不应被复制 |')
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
  const region = page
    .locator('.plein-md-preview:not([aria-hidden])')
    .getByRole('region', { name: kind, exact: true })
    .first()
  const intact = async () => {
    expect((await elements(page)).map((e) => e.id).sort()).toEqual([id, background].sort())
    expect(await page.evaluate((id) => window.__plein.engine.doc.getText(id)?.toString(), id)).toBe(
      text,
    )
    expect(
      await page.evaluate((id) => window.__plein.engine.doc.get(id)?.params?.text, background),
    ).toBe('保留背景正文')
  }
  return { id, region, intact }
}

for (const kind of ['代码块']) {
  test(`${kind} 的斜向滚动按主方向分流，Shift 优先横向`, async ({ page }) => {
    const { id, region, intact } = await setup(page, kind)
    const origin = () => page.evaluate(() => window.__plein.engine.worldToClient(0, 0))
    const before = await origin()
    const geometry = await page.evaluate((id) => window.__plein.engine.doc.worldRect(id), id)
    let r = (await region.boundingBox())!
    await page.mouse.move(r.x + 30, r.y + 20)
    await page.mouse.wheel(3, 70)
    await expect.poll(async () => (await origin()).y).toBeLessThan(before.y)
    expect(await region.evaluate((el) => el.scrollLeft)).toBe(0)
    r = (await region.boundingBox())!
    await page.mouse.move(r.x + 30, r.y + 20)
    const panned = await origin()
    await page.keyboard.down('Shift')
    await page.mouse.wheel(3, 80)
    await page.keyboard.up('Shift')
    await expect.poll(() => region.evaluate((el) => el.scrollLeft)).toBeGreaterThan(50)
    expect(await origin()).toEqual(panned)
    const left = await region.evaluate((el) => el.scrollLeft)
    await page.mouse.wheel(90, 3)
    await expect.poll(() => region.evaluate((el) => el.scrollLeft)).toBeGreaterThan(left + 30)
    expect(await origin()).toEqual(panned)
    expect(await page.evaluate((id) => window.__plein.engine.doc.worldRect(id), id)).toEqual(
      geometry,
    )
    await intact()
  })
}

for (const kind of ['代码块', '表格']) {
  test(`${kind} 全选只包含当前区域，Esc 先取消文本选择再退出焦点`, async ({ page }) => {
    const { region, intact } = await setup(page, kind)
    await region.focus()
    const text = (await region.innerText()).trim()
    for (const key of ['Control+a', 'Meta+a']) {
      await page.keyboard.press(key)
      expect(await page.evaluate(() => window.getSelection()?.toString().trim())).toBe(text)
    }
    await expect(region).toBeFocused()
    const selected = await page.evaluate(() => window.__plein.engine.selection.values())
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
    await page.screenshot({ path: test.info().outputPath(`markdown-${kind}-selection.png`) })
    await page.keyboard.press('Escape')
    await expect(region).toBeFocused()
    expect(await page.evaluate(() => window.getSelection()?.isCollapsed)).toBe(true)
    await page.keyboard.press('Escape')
    await expect(region).not.toBeFocused()
    expect(await page.evaluate(() => window.__plein.engine.selection.values())).toEqual(selected)
    await region.focus()
    await page.keyboard.press('Control+k')
    const palette = page.getByRole('dialog', { name: '命令面板', exact: true })
    await expect(palette).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(palette).toHaveCount(0)
    await region.focus()
    await region.evaluate((el) => {
      const heading = el.closest('.plein-md-content')!.querySelector('h1')!
      window.getSelection()!.selectAllChildren(heading)
    })
    await page.keyboard.press('Escape')
    await expect(region).not.toBeFocused()
    expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('选区外的标题')
    await intact()
  })
}
