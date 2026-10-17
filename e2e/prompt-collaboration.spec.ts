import { expect, type Page, test } from '@playwright/test'
import { newProject, waitEngine } from './canvas'

async function setup(page: Page) {
  await newProject(page)
  const id = await page.evaluate(() => {
    window.__plein.addNode({ type: 'plein/character', name: '协作角色', params: {}, x: -500, y: 0 })
    return window.__plein.addNode({
      type: 'plein/text',
      name: '协作正文',
      params: { text: '最初正文' },
      x: 400,
      y: 200,
    })
  })
  await open(page)
  return id
}
const open = (page: Page) =>
  page.getByRole('treeitem', { name: '协作正文 定位到画布', exact: true }).click()
const field = (page: Page) =>
  page.getByTestId('generator').getByRole('textbox', { name: '提示词', exact: true })
const saved = (page: Page, id: string) =>
  page.evaluate((id) => window.__plein.engine.doc.get(id)?.params?.text, id)

test('保持焦点时提示词跟随同伴正文和引用更新，继续输入不覆盖已同步内容', async ({
  page,
  context,
}) => {
  const id = await setup(page)
  const peerContext = await context.browser()!.newContext()
  try {
    const peer = await peerContext.newPage()
    await peer.goto(page.url())
    await waitEngine(peer)
    await expect(peer.getByTestId('sync-status')).toHaveAttribute('data-sync', 'connected')
    await open(peer)
    await field(page).fill('本机已保存正文')
    await expect(field(peer)).toHaveValue('本机已保存正文')
    await field(peer).fill('同伴写入 @协作角色。')
    await expect.poll(() => saved(page, id)).toBe('同伴写入 @协作角色。')
    await expect(field(page)).toBeFocused()
    await expect(field(page)).toHaveValue('同伴写入 @协作角色。')
    await expect(
      page.getByTestId('generator').getByTestId('mention-highlights').locator('mark'),
    ).toHaveText('@协作角色')
    await page.screenshot({ path: 'test-results/prompt-focused-remote.png' })
    await field(page).evaluate((input: HTMLTextAreaElement) =>
      input.setSelectionRange(input.value.length, input.value.length),
    )
    await field(page).pressSequentially('继续')
    await expect(field(peer)).toHaveValue('同伴写入 @协作角色。继续')
    await page.getByRole('button', { name: '撤销', exact: true }).click()
    await expect(field(peer)).toHaveValue('同伴写入 @协作角色。')
    await page.getByRole('button', { name: '重做', exact: true }).click()
    await expect(field(peer)).toHaveValue('同伴写入 @协作角色。继续')
    await field(page).fill('@协')
    await expect(page.getByRole('listbox', { name: '引用资产', exact: true })).toBeVisible()
    await field(peer).fill('同伴清空了引用')
    await expect(field(page)).toHaveValue('同伴清空了引用')
    await expect(page.getByRole('listbox', { name: '引用资产', exact: true })).toHaveCount(0)
    await expect(
      page.getByTestId('generator').getByTestId('mention-highlights').locator('mark'),
    ).toHaveCount(0)
  } finally {
    await peerContext.close()
  }
})

test('远端插删前缀保留中间光标、表情和反向选区，输入仍落在原文位置', async ({ page, context }) => {
  await setup(page)
  const peerContext = await context.browser()!.newContext()
  try {
    const peer = await peerContext.newPage()
    await peer.goto(page.url())
    await waitEngine(peer)
    await open(peer)
    await field(page).fill('雨后😀春天的画面')
    await expect(field(peer)).toHaveValue('雨后😀春天的画面')
    await field(page).evaluate((input: HTMLTextAreaElement) => input.setSelectionRange(6, 6))
    await field(peer).fill('序章\n雨后😀春天的画面')
    await expect(field(page)).toHaveValue('序章\n雨后😀春天的画面')
    const selection = () =>
      field(page).evaluate((input: HTMLTextAreaElement) => [
        input.selectionStart,
        input.selectionEnd,
        input.selectionDirection,
      ])
    await expect.poll(async () => (await selection()).slice(0, 2)).toEqual([9, 9])
    await field(page).pressSequentially('！')
    await expect(field(peer)).toHaveValue('序章\n雨后😀春天！的画面')
    await field(page).evaluate((input: HTMLTextAreaElement) =>
      input.setSelectionRange(7, 9, 'backward'),
    )
    await field(peer).fill('雨后😀春天！的画面')
    await expect(field(page)).toHaveValue('雨后😀春天！的画面')
    await expect.poll(selection).toEqual([4, 6, 'backward'])
    await field(page).pressSequentially('夏日')
    await expect(field(peer)).toHaveValue('雨后😀夏日！的画面')
  } finally {
    await peerContext.close()
  }
})

test('放大提示词保持焦点时跟随远端正文，关闭后与画布面板一致', async ({ page, context }) => {
  const id = await setup(page)
  const peerContext = await context.browser()!.newContext()
  try {
    const peer = await peerContext.newPage()
    await peer.goto(page.url())
    await waitEngine(peer)
    await open(peer)
    await page.getByRole('button', { name: '放大编辑提示词', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '编辑提示词', exact: true })
    const enlarged = dialog.getByRole('textbox', { name: '提示词', exact: true })
    await expect(enlarged).toBeFocused()
    await field(peer).fill('放大时收到的远端正文')
    await expect.poll(() => saved(page, id)).toBe('放大时收到的远端正文')
    await expect(enlarged).toHaveValue('放大时收到的远端正文')
    await enlarged.evaluate((input: HTMLTextAreaElement) =>
      input.setSelectionRange(input.value.length, input.value.length),
    )
    await enlarged.pressSequentially('，补充说明')
    await expect(field(peer)).toHaveValue('放大时收到的远端正文，补充说明')
    await enlarged.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(field(page)).toHaveValue('放大时收到的远端正文，补充说明')
  } finally {
    await peerContext.close()
  }
})

test('组词不被远端刷新打断，确认按整字段规则同步且不重复插字', async ({ page, context }) => {
  const id = await setup(page)
  const peerContext = await context.browser()!.newContext()
  try {
    const peer = await peerContext.newPage()
    await peer.goto(page.url())
    await waitEngine(peer)
    await open(peer)
    await field(page).focus()
    await field(page).dispatchEvent('compositionstart', { data: '', bubbles: true })
    await field(page).fill('正在组词')
    await expect(field(peer)).toHaveValue('正在组词')
    await field(peer).fill('同伴的远端正文')
    await expect.poll(() => saved(page, id)).toBe('同伴的远端正文')
    await expect(field(page)).toHaveValue('正在组词')
    await field(page).dispatchEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true })
    await expect(field(page)).toBeFocused()
    // 模拟浏览器最终 compositionend + input 顺序；不借助 fill 提前提交最终值。
    await field(page).evaluate((input: HTMLTextAreaElement) => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        input,
        '确认后的完整正文',
      )
      input.dispatchEvent(
        new CompositionEvent('compositionend', { data: '完整正文', bubbles: true }),
      )
      input.dispatchEvent(
        new InputEvent('input', {
          data: '完整正文',
          inputType: 'insertCompositionText',
          isComposing: false,
          bubbles: true,
        }),
      )
    })
    await expect(field(peer)).toHaveValue('确认后的完整正文')
    await expect(field(page)).toHaveValue('确认后的完整正文')
    await field(page).press('Tab')
    await field(peer).fill('组词结束后的新正文')
    await expect(field(page)).toHaveValue('组词结束后的新正文')
  } finally {
    await peerContext.close()
  }
})
