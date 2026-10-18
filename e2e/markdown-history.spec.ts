import { expect, type Page, test } from '@playwright/test'
import { centerOf, elements, newProject, waitEngine } from './canvas'

async function note(page: Page) {
  await newProject(page)
  const other = await page.evaluate(() => {
    const id = window.__plein.addNode({
      type: 'plein/text',
      name: '保留的背景节点',
      params: { text: '不参与便签撤销' },
      x: -1000,
      y: -1000,
    })
    window.__plein.engine.selection.set([])
    return id
  })
  await page
    .locator('canvas')
    .first()
    .evaluate((canvas) => {
      const data = new DataTransfer()
      data.setData('text/plain', '便签原始正文')
      canvas.dispatchEvent(
        new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }),
      )
    })
  await expect
    .poll(async () => (await elements(page)).filter((el) => el.kind === 'markdown').length)
    .toBe(1)
  const id = (await elements(page)).find((el) => el.kind === 'markdown')!.id
  const point = await centerOf(page, id)
  await page.mouse.dblclick(point.x, point.y)
  const editor = page.locator('.plein-md-editor .cm-content')
  await expect(editor).toBeFocused()
  const read = () => page.evaluate((id) => window.__plein.engine.doc.getText(id)?.toString(), id)
  const intact = async () => {
    expect((await elements(page)).map((el) => el.id).sort()).toEqual([id, other].sort())
    expect(
      await page.evaluate((id) => window.__plein.engine.doc.get(id)?.params?.text, other),
    ).toBe('不参与便签撤销')
  }
  return { id, editor, read, intact }
}

test('便签键盘撤销重做修改正文，不修改背景节点，退出刷新后保留内容', async ({ page }) => {
  const f = await note(page)
  await f.editor.press('End')
  await page.keyboard.insertText('，追加文字')
  await expect.poll(f.read).toBe('便签原始正文，追加文字')
  await f.editor.press('ControlOrMeta+z')
  await expect.poll(f.read).toBe('便签原始正文')
  await f.editor.press('ControlOrMeta+z')
  await expect.poll(f.read).toBe('便签原始正文')
  await f.intact()
  await expect(f.editor).toBeFocused()
  await f.editor.press('ControlOrMeta+Shift+z')
  await expect.poll(f.read).toBe('便签原始正文，追加文字')
  await expect(f.editor).toContainText('追加文字')
  await f.intact()
  await f.editor.press('Escape')
  await expect(page.locator('.plein-md-editor')).toHaveCount(0)
  await page.reload()
  await waitEngine(page)
  await expect.poll(f.read).toBe('便签原始正文，追加文字')
  await f.intact()
  await page.evaluate((id) => window.__plein.engine.zoomToFit([id]), f.id)
  const point = await centerOf(page, f.id)
  await page.mouse.dblclick(point.x, point.y)
  await expect(f.editor).toBeFocused()
  await expect(f.editor).toContainText('追加文字')
  await f.editor.press('End')
  await page.keyboard.insertText('，重开追加')
  await expect.poll(f.read).toBe('便签原始正文，追加文字，重开追加')
  await f.editor.press('ControlOrMeta+z')
  await expect.poll(f.read).toBe('便签原始正文，追加文字')
  await f.editor.press('ControlOrMeta+Shift+z')
  await expect.poll(f.read).toBe('便签原始正文，追加文字，重开追加')
  await expect(f.editor).toContainText('重开追加')
  await f.intact()
})

test('同伴追加正文后，本机撤销只移除本机编辑，重做仍保留同伴内容', async ({ page, browser }) => {
  const f = await note(page)
  const context = await browser.newContext({ baseURL: new URL(page.url()).origin })
  try {
    const peer = await context.newPage()
    await peer.goto(page.url())
    await waitEngine(peer)
    await expect
      .poll(() => peer.evaluate((id) => !!window.__plein.engine.doc.get(id), f.id))
      .toBe(true)
    await peer.evaluate((id) => window.__plein.engine.zoomToFit([id]), f.id)
    const point = await centerOf(peer, f.id)
    await peer.mouse.dblclick(point.x, point.y)
    const other = peer.locator('.plein-md-editor .cm-content')
    await expect(other).toBeFocused()
    const readPeer = () =>
      peer.evaluate((id) => window.__plein.engine.doc.getText(id)?.toString(), f.id)
    await f.editor.press('End')
    await page.keyboard.insertText('，本机追加')
    await expect.poll(readPeer).toBe('便签原始正文，本机追加')
    await other.press('End')
    await peer.keyboard.insertText('，同伴追加')
    await expect.poll(f.read).toBe('便签原始正文，本机追加，同伴追加')
    await f.editor.press('ControlOrMeta+z')
    await expect.poll(f.read).toBe('便签原始正文，同伴追加')
    await expect.poll(readPeer).toBe('便签原始正文，同伴追加')
    await expect(f.editor).not.toContainText('本机追加')
    await expect(other).toContainText('同伴追加')
    await f.intact()
    await f.editor.press('ControlOrMeta+Shift+z')
    await expect.poll(f.read).toBe('便签原始正文，本机追加，同伴追加')
    await expect.poll(readPeer).toBe('便签原始正文，本机追加，同伴追加')
    await expect(f.editor).toContainText('本机追加')
    await expect(other).toContainText('本机追加')
    await f.intact()
  } finally {
    await context.close()
  }
})

test('便签复制剪切粘贴和各自撤销重做只影响正文，不新增或删除画布节点', async ({ page }) => {
  const f = await note(page)
  await f.editor.press('ControlOrMeta+a')
  const copy = await f.editor.evaluate((node) => {
    const data = new DataTransfer()
    node.dispatchEvent(
      new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData: data }),
    )
    return data.getData('text/plain')
  })
  expect(copy).toBe('便签原始正文')
  const cut = await f.editor.evaluate((node) => {
    const data = new DataTransfer()
    node.dispatchEvent(
      new ClipboardEvent('cut', { bubbles: true, cancelable: true, clipboardData: data }),
    )
    return data.getData('text/plain')
  })
  expect(cut).toBe(copy)
  await expect.poll(f.read).toBe('')
  await f.intact()
  await f.editor.press('ControlOrMeta+z')
  await expect.poll(f.read).toBe(copy)
  await f.editor.press('ControlOrMeta+Shift+z')
  await expect.poll(f.read).toBe('')
  await f.editor.evaluate((node) => {
    const data = new DataTransfer()
    data.setData('text/plain', '便签粘贴的新正文')
    node.dispatchEvent(
      new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }),
    )
  })
  await expect.poll(f.read).toBe('便签粘贴的新正文')
  await f.intact()
  await f.editor.press('ControlOrMeta+z')
  await expect.poll(f.read).toBe('')
  await f.editor.press('ControlOrMeta+Shift+z')
  await expect.poll(f.read).toBe('便签粘贴的新正文')
  await f.intact()
  await expect(f.editor).toContainText('便签粘贴的新正文')
  await page.screenshot({
    path: test.info().outputPath('markdown-redo.png'),
    animations: 'disabled',
  })
})
