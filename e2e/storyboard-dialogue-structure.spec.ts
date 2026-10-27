import { expect, type Page, test } from '@playwright/test'
import {
  centerOf,
  confirmBatchChecklist,
  newProject,
  showStoryboardCards,
  waitNode,
  zoomTo,
} from './canvas'
import type { StoryboardBatchPlan } from '../packages/protocol/src/storyboard-batch'

async function fixture(page: Page) {
  await newProject(page)
  const id = await page.evaluate(() =>
    window.__plein.addNode({
      type: 'plein/storyboard',
      name: '台词结构操作',
      x: 300,
      y: 200,
      params: {
        shots: [
          {
            id: 'one',
            no: 1,
            duration: 4,
            dialogue: [
              { id: 'a', character: '林晚', line: '原始第一句' },
              { id: 'b', character: '老周', line: '原始第二句' },
            ],
          },
        ],
      },
    }),
  )
  await zoomTo(page, [id])
  const at = await centerOf(page, id)
  await page.mouse.dblclick(at.x, at.y)
  const dialog = page.getByRole('dialog', { name: '分镜表', exact: true })
  await expect(dialog).toBeVisible()
  await showStoryboardCards(dialog)
  const read = () =>
    page.evaluate(
      (id) =>
        (
          window.__plein.engine.doc.get(id)!.params!.shots as Array<{
            dialogue: Array<{ id: string; character: string; line: string }>
          }>
        )[0]!.dialogue,
      id,
    )
  await page.evaluate(() =>
    (
      window.__plein.engine.doc as typeof window.__plein.engine.doc & {
        undo: { stopCapturing(): void }
      }
    ).undo.stopCapturing(),
  )
  return { id, dialog, read }
}

for (const action of ['添加台词', '删除第 1 句', '下移第 1 句']) {
  test(`${action} 独立撤销，不撤回刚保存的另一句台词`, async ({ page }) => {
    const f = await fixture(page)
    const before = await f.read()
    const edited = before.map((line) =>
      line.id === 'b' ? { ...line, line: '保留修改后的第二句' } : line,
    )
    await f.dialog
      .getByRole('textbox', { name: '台词', exact: true })
      .nth(1)
      .fill('老周：保留修改后的第二句')
    await f.dialog.evaluate(async (element, action) => {
      ;(document.activeElement as HTMLElement).blur()
      await Promise.resolve()
      const button = [...element.querySelectorAll<HTMLButtonElement>('button')].find(
        (button) =>
          button.getAttribute('aria-label') === action || button.textContent?.trim() === action,
      )!
      button.click()
    }, action)
    const after = await f.read()
    expect(after).not.toEqual(edited)
    // 焦点移出输入框，撤销才作用在文档上
    await f.dialog.getByRole('button', { name: '添加台词', exact: true }).focus()
    await page.keyboard.press('ControlOrMeta+z')
    await expect.poll(f.read).toEqual(edited)
    await page.keyboard.press('ControlOrMeta+Shift+z')
    await expect.poll(f.read).toEqual(after)
  })
}

test('添加台词立即输入，移动后保留说话人身份，删除直到空白仍可继续编辑', async ({ page }) => {
  const f = await fixture(page)
  await page.setViewportSize({ width: 800, height: 700 })
  const inputs = f.dialog.getByRole('textbox', { name: '台词', exact: true })
  await f.dialog.getByRole('button', { name: '添加台词', exact: true }).click()
  await expect(inputs).toHaveCount(3)
  await expect(inputs.last()).toBeFocused()
  await expect(inputs.last()).toBeInViewport()
  await page.keyboard.type('林晚：新台词')
  await inputs.last().blur()
  const added = (await f.read())[2]!
  await f.dialog.getByRole('button', { name: '上移第 3 句', exact: true }).click()
  await expect(inputs.nth(1)).toBeFocused()
  await expect(inputs.nth(1)).toHaveValue('林晚：新台词')
  expect((await f.read())[1]).toEqual(added)
  await f.dialog.screenshot({ path: test.info().outputPath('dialogue-move-focus-800.png') })
  await f.dialog.getByRole('button', { name: '删除第 2 句', exact: true }).click()
  await expect(inputs.nth(1)).toBeFocused()
  await expect(inputs.nth(1)).toHaveValue('老周：原始第二句')
  await f.dialog.getByRole('button', { name: '删除第 2 句', exact: true }).click()
  await expect(inputs.first()).toBeFocused()
  await expect(inputs.first()).toHaveValue('林晚：原始第一句')
  await f.dialog.getByRole('button', { name: '删除第 1 句', exact: true }).click()
  await expect(inputs).toHaveCount(1)
  await expect(inputs.first()).toBeFocused()
  await expect(inputs.first()).toHaveValue('')
  await page.keyboard.type('林晚：清空后重新输入')
  await inputs.first().blur()
  await expect.poll(async () => (await f.read())[0]!.line).toBe('清空后重新输入')
})

test('重名角色绑定后移动台词，批量配音实际输入仍使用各自音色与文本', async ({ page }) => {
  const f = await fixture(page)
  const speakers = await page.evaluate(() =>
    ['mock-female', 'mock-male'].map((voiceId, i) =>
      window.__plein.addNode({
        type: 'plein/character',
        name: '林晚',
        x: -1500,
        y: i * 700,
        params: { voice: { provider: 'plein/mock', voiceId } },
      }),
    ),
  )
  const second = f.dialog.getByRole('textbox', { name: '台词', exact: true }).nth(1)
  await second.fill('林晚：原始第二句')
  await second.blur()
  for (const [i, lineId] of ['a', 'b'].entries()) {
    const row = f.dialog.locator(`[data-dialogue-id="${lineId}"]`)
    const trigger = row.getByRole('combobox', { name: '说话人绑定：林晚', exact: true })
    await trigger.click()
    await page
      .locator('.ui-select-popup:not([data-closed]):not([data-closing])')
      .getByRole('option', { name: `林晚 · ${speakers[i]!.slice(-6)}`, exact: true })
      .click()
  }
  const open = async () => {
    await zoomTo(page, [f.id])
    const at = await centerOf(page, f.id)
    await page.mouse.dblclick(at.x, at.y)
    await expect(f.dialog).toBeVisible()
  }
  await f.dialog.getByRole('button', { name: '展开为节点', exact: true }).click()
  await expect(f.dialog).toHaveCount(0)
  await open()
  await f.dialog.getByRole('button', { name: '下移第 1 句', exact: true }).click()
  expect((await f.read()).map((line) => line.id)).toEqual(['b', 'a'])
  await f.dialog.getByRole('button', { name: '更新展开', exact: true }).click()
  if (!(await f.dialog.isVisible())) await open()
  const preview = page.waitForResponse((response) =>
    response.url().endsWith('/storyboard-batch/preview'),
  )
  await f.dialog.getByRole('button', { name: '批量配音', exact: true }).click()
  const response = await preview
  expect(response.ok()).toBe(true)
  const plan = (await response.json()) as StoryboardBatchPlan
  const rows = plan.rows.filter((row) => row.action === 'run')
  expect(rows).toHaveLength(2)
  for (const row of rows) {
    const source = await page.evaluate(
      (id) =>
        window.__plein.engine.doc.get(id)!.params!.source as { dialogueId: string; line: number },
      row.nodeId!,
    )
    const first = source.dialogueId === 'a'
    expect(['a', 'b']).toContain(source.dialogueId)
    expect(row.input!.prompt).toBe(first ? '原始第一句' : '原始第二句')
    expect(row.input!.voice).toEqual({
      provider: 'plein/mock',
      voiceId: first ? 'mock-female' : 'mock-male',
    })
  }
  const checklist = page.getByRole('dialog', { name: '批量生成清单', exact: true })
  // 「查看实际输入」里套着「生效参数与参考顺序」，只展开每层自己的折叠块
  for (const detail of await checklist.locator('details').all()) {
    await detail.locator(':scope > summary').click()
  }
  await expect(checklist).toContainText('原始第一句')
  await expect(checklist).toContainText('原始第二句')
  expect(await confirmBatchChecklist(page)).toBe(2)
  for (const row of rows) {
    await waitNode(page, row.nodeId!)
    const result = await page.evaluate(
      (id) => window.__plein.engine.doc.get(id)!.results,
      row.nodeId!,
    )
    expect(result).toHaveLength(1)
  }
})
