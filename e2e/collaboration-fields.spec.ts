import { expect, type Page, test } from '@playwright/test'
import { newProject, revealGenerator, waitEngine } from './canvas'

async function character(page: Page) {
  await newProject(page)
  const id = await page.evaluate(() =>
    window.__plein.addNode({
      type: 'plein/character',
      name: '协作角色',
      params: {},
      x: 400,
      y: 200,
    }),
  )
  await page.getByRole('treeitem', { name: '协作角色 定位到画布', exact: true }).click()
  return id
}

const nameField = (page: Page) => page.getByRole('textbox', { name: '节点名称', exact: true })
const savedName = (page: Page, id: string) =>
  page.evaluate((id) => window.__plein.engine.doc.get(id)?.name, id)

test(
  '角色名称远端更新不覆盖未提交草稿，用户可明确选择名称',
  { tag: '@core' },
  async ({ page, context }) => {
    const id = await character(page)
    // 编辑器固定在卡片下方，先把它移进窗口再点里面的控件
    await revealGenerator(page)
    const peerContext = await context.browser()!.newContext()
    try {
      const peer = await peerContext.newPage()
      await peer.goto(page.url())
      await waitEngine(peer)
      await expect(peer.getByTestId('sync-status')).toHaveAttribute('data-sync', 'connected')
      await expect.poll(() => savedName(peer, id)).toBe('协作角色')
      await nameField(page).fill('我的未提交名称')
      const rename = async (before: string, after: string) => {
        await peer.getByRole('treeitem', { name: `${before} 定位到画布`, exact: true }).dblclick()
        const input = peer.getByRole('tree').getByRole('textbox', { name: '元素名称', exact: true })
        await input.fill(after)
        await input.press('Enter')
        await expect.poll(() => savedName(page, id)).toBe(after)
      }
      await rename('协作角色', '同伴已保存名称')
      await expect(nameField(page)).toHaveValue('我的未提交名称')
      const panel = page.getByTestId('generator')
      await expect(panel.getByRole('status')).toContainText('同伴已保存名称')
      await page.screenshot({ path: test.info().outputPath('name-conflict.png') })
      // 冲突时失焦不应无意覆盖同伴刚提交的名称。
      await nameField(page).press('Tab')
      expect(await savedName(page, id)).toBe('同伴已保存名称')
      // 冲突提示出现在面板里，位置可能落在可视区外：移进窗口再滚进来
      const useRemote = panel.getByRole('button', { name: '使用更新后的名称', exact: true })
      await revealGenerator(page, useRemote)
      await useRemote.click()
      await expect(nameField(page)).toHaveValue('同伴已保存名称')
      await expect(panel.getByRole('status')).toHaveCount(0)

      await nameField(page).fill('确认保留的名称')
      await rename('同伴已保存名称', '同伴再次改名')
      await expect(nameField(page)).toHaveValue('确认保留的名称')
      await panel.getByRole('button', { name: '保留当前输入', exact: true }).click()
      await expect.poll(() => savedName(peer, id)).toBe('确认保留的名称')
      await expect(panel.getByRole('status')).toHaveCount(0)

      // Esc 采用最新保存值；未修改输入时则直接跟随远端，不制造冲突。
      await nameField(page).fill('放弃的冲突草稿')
      await rename('确认保留的名称', '同伴第三次改名')
      await expect(panel.getByRole('status')).toContainText('同伴第三次改名')
      await nameField(page).press('Escape')
      await expect(nameField(page)).toHaveValue('同伴第三次改名')
      await expect(panel.getByRole('status')).toHaveCount(0)
      await rename('同伴第三次改名', '未编辑时的最新名称')
      await expect(nameField(page)).toHaveValue('未编辑时的最新名称')
      await expect(panel.getByRole('status')).toHaveCount(0)

      await nameField(page).fill('回车确认的名称')
      await rename('未编辑时的最新名称', '回车前远端名称')
      await expect(panel.getByRole('status')).toContainText('回车前远端名称')
      await nameField(page).press('Enter')
      await expect.poll(() => savedName(peer, id)).toBe('回车确认的名称')
      await expect(panel.getByRole('status')).toHaveCount(0)

      const longName = '同伴的超长角色名称'.repeat(12)
      await nameField(page).fill('小窗口保留的草稿')
      await rename('回车确认的名称', longName)
      await expect(panel.getByRole('status')).toContainText(longName)
      await page.setViewportSize({ width: 800, height: 560 })
      await panel
        .getByRole('button', { name: '使用更新后的名称', exact: true })
        .scrollIntoViewIfNeeded()
      await page.screenshot({ path: test.info().outputPath('name-conflict-narrow.png') })
      await panel.getByRole('button', { name: '使用更新后的名称', exact: true }).click()
      await expect(nameField(page)).toHaveValue(longName)
      // 编辑器固定 840px 宽，窄窗口里右侧会超出；左边缘留在窗口内就还能操作
      const bounds = await panel.boundingBox()
      expect(bounds!.x).toBeGreaterThanOrEqual(0)
      expect(bounds!.x).toBeLessThanOrEqual(800)
      await page.reload()
      await waitEngine(page)
      await expect.poll(() => savedName(page, id)).toBe(longName)
    } finally {
      await peerContext.close()
    }
  },
)

test('角色名称按 Esc 取消草稿，保留选中节点与已保存名称', async ({ page }) => {
  const id = await character(page)
  await nameField(page).fill('应该取消的名称')
  await nameField(page).press('Escape')
  await expect(nameField(page)).toHaveValue('协作角色')
  expect(await savedName(page, id)).toBe('协作角色')
  await expect(page.getByTestId('generator')).toBeVisible()
  // 编辑器固定在卡片下方，先把它移进窗口再点里面的控件
  await revealGenerator(page)
})

test('名称正常失焦保存、空值恢复、输入法确认隔离与撤销边界', async ({ page }) => {
  const id = await character(page)
  const input = nameField(page)
  await input.fill('  正常保存  ')
  await input.press('Tab')
  await expect.poll(() => savedName(page, id)).toBe('正常保存')
  await expect(input).toHaveValue('正常保存')
  await input.fill('   ')
  await input.press('Enter')
  await expect(input).toHaveValue('正常保存')
  expect(await savedName(page, id)).toBe('正常保存')

  await input.fill('输入法草稿')
  await input.dispatchEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true })
  await expect(input).toBeFocused()
  expect(await savedName(page, id)).toBe('正常保存')
  await input.dispatchEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true })
  await expect(input).toHaveValue('输入法草稿')
  await input.press('Escape')
  await expect(input).toHaveValue('正常保存')

  await input.fill('独立撤销的名称')
  // 紧邻确认的文档事务，不能靠等待超过捕获窗口来证明撤销隔离。
  await page.evaluate((id) => {
    const doc = window.__plein.engine.doc as unknown as {
      origin: unknown
      ydoc: { transact(fn: () => void, origin: unknown): void }
      mutable(id: string): { set(k: string, v: number): void }
    }
    doc.ydoc.transact(() => doc.mutable(id).set('x', 455), doc.origin)
  }, id)
  await input.press('Enter')
  await page.getByRole('button', { name: '撤销', exact: true }).click()
  await expect(input).toHaveValue('正常保存')
  expect(await page.evaluate((id) => window.__plein.engine.doc.worldRect(id).x, id)).toBe(455)
  await page.getByRole('button', { name: '重做', exact: true }).click()
  await expect(input).toHaveValue('独立撤销的名称')
})
