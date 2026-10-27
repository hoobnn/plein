import { expect, type Page, test } from './fixtures'
import { clickElement, newProject, waitEngine } from './canvas'

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

test(
  '保持焦点时提示词跟随同伴正文和引用更新，继续输入不覆盖已同步内容',
  { tag: '@core' },
  async ({ page, context }) => {
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
      const mark = await page
        .getByTestId('generator')
        .getByTestId('mention-highlights')
        .locator('mark')
        .boundingBox()
      const input = await field(page).boundingBox()
      const position = {
        x: mark!.x + mark!.width / 2 - input!.x,
        y: mark!.y + mark!.height / 2 - input!.y,
      }
      await field(page).click({ position })
      expect(await page.evaluate(() => window.__plein.engine.selection.values())).toEqual([id])
      await field(page).click({ position, modifiers: ['ControlOrMeta'] })
      await expect
        .poll(() =>
          page.evaluate(() =>
            window.__plein.engine.selection
              .values()
              .map((id) => window.__plein.engine.doc.get(id)?.name),
          ),
        )
        .toEqual(['协作角色'])
      await clickElement(page, id)
      await page.locator('.plein-node-body mark[role="button"]').click()
      await expect
        .poll(() =>
          page.evaluate(() =>
            window.__plein.engine.selection
              .values()
              .map((id) => window.__plein.engine.doc.get(id)?.name),
          ),
        )
        .toEqual(['协作角色'])
      await clickElement(page, id)
      expect(await saved(page, id)).toBe('同伴写入 @协作角色。')
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
  },
)

for (const replace of [true, false]) {
  test(
    `提示词多行粘贴${replace ? '替换' : '追加'}后，原生撤销重做保留正文与文档`,
    { tag: '@core' },
    async ({ page, context }) => {
      await context.grantPermissions(['clipboard-read', 'clipboard-write'])
      await newProject(page)
      const id = await page.evaluate(() =>
        window.__plein.addNode({
          type: 'plein/text',
          name: '多行历史',
          params: { text: 'Base' },
          x: 0,
          y: 0,
        }),
      )
      await clickElement(page, id)
      const field = page
        .getByTestId('generator')
        .getByRole('textbox', { name: '提示词', exact: true })
      await expect(field).toHaveValue('Base')
      await field.focus()
      await field.press('ControlOrMeta+a')
      if (!replace) await field.press('ArrowRight')
      await page.evaluate(() => navigator.clipboard.writeText('A\nB'))
      await field.press('ControlOrMeta+v')
      const expected = replace ? 'A\nB' : 'BaseA\nB'
      await expect(field).toHaveValue(expected)
      await field.press('ControlOrMeta+z')
      await expect(field).toHaveValue('Base')
      await field.press('ControlOrMeta+Shift+z')
      await expect(field).toHaveValue(expected)
      await expect
        .poll(() => page.evaluate((id) => window.__plein.engine.doc.get(id)?.params?.text, id))
        .toBe(expected)
      expect(await page.evaluate(() => [...window.__plein.engine.doc.elements()].length)).toBe(1)
      await page.reload()
      await page.waitForFunction(() => !!window.__plein)
      await page.getByRole('treeitem', { name: '多行历史 定位到画布', exact: true }).click()
      await expect(field).toHaveValue(expected)
    },
  )
}
