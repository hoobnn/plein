import { expect, type Page, test } from './fixtures'
import { centerOf, newProject, waitEngine, zoomTo } from './canvas'
import { slowFile } from './slow-file'

async function seed(page: Page) {
  await newProject(page)
  return page.evaluate(() => {
    const source = window.__plein.addNode({
      type: 'plein/text',
      name: '原始剧本',
      x: -500,
      y: 100,
      params: { text: '甲：回来。\r\n乙：回来。\r\n😀她没有回头。' },
    })
    const board = window.__plein.addNode({
      type: 'plein/storyboard',
      name: '来源映射测试',
      x: 100,
      y: 100,
      params: {
        shots: [
          {
            id: 'one',
            no: 1,
            duration: 3,
            description: '甲转身',
            dialogue: [{ id: 'a', character: '甲', line: '回来。' }],
          },
          {
            id: 'two',
            no: 2,
            duration: 3,
            description: '乙转身',
            dialogue: [{ id: 'b', character: '乙', line: '回来。' }],
          },
        ],
      },
    })
    window.__plein.connect([source, 'text'], [board, 'script'])
    return { source, board }
  })
}
async function open(page: Page, board: string) {
  await page.waitForFunction((id) => !!window.__plein?.engine.doc.get(id), board)
  await zoomTo(page, [board])
  const center = await centerOf(page, board)
  await page.mouse.dblclick(center.x, center.y)
  const dialog = page.getByRole('dialog', { name: '分镜表', exact: true })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: '剧情来源', exact: true }).click()
  return dialog.getByTestId('source-mapping')
}

test('固定原文、显式已读、人工范围、双向定位、改编提案与刷新恢复，零生成', async ({
  page,
}, testInfo) => {
  const { board } = await seed(page)
  const submitted: string[] = []
  page.on('request', (request) => {
    if (request.method() === 'POST' && /\/run(?:-|\?|$)/.test(request.url()))
      submitted.push(request.url())
  })
  let panel = await open(page, board)
  await panel.getByRole('button', { name: '固定为新版本' }).click()
  await expect(panel.getByRole('textbox', { name: '固定原文', exact: true })).toHaveValue(
    '甲：回来。\n乙：回来。\n😀她没有回头。',
  )
  await expect(panel).toContainText('未读：尚未声明核对本版原文')
  const original = panel.getByRole('textbox', { name: '固定原文', exact: true })
  await original.focus()
  await original.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(6, 6))
  for (let i = 0; i < 5; i++) await original.press('Shift+ArrowRight')
  await expect
    .poll(() =>
      original.evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd]),
    )
    .toEqual([6, 11])
  await panel.getByRole('combobox', { name: '原文标注类型' }).selectOption('dialogue')
  await panel.getByRole('button', { name: '将选中原文加入标注' }).click()
  expect(
    await page.evaluate((id) => {
      const record = window.__plein.engine.doc.get(id)!.production!.sourceMap!
      const unit = record.units[0]!
      const snapshot = record.snapshots.find((s) => s.id === unit.snapshotId)!
      return { start: unit.start, end: unit.end, quote: snapshot.text.slice(unit.start, unit.end) }
    }, board),
  ).toEqual({ start: 7, end: 12, quote: '乙：回来。' })
  const unit = panel.getByRole('list', { name: '原文标注', exact: true }).locator('> li').first()
  await expect(unit).toContainText('对白 · 未读')
  await panel.getByRole('button', { name: '我已核对本版原文' }).click()
  await expect(unit).toContainText('未映射')
  await panel.getByRole('combobox', { name: '关联或定位镜头' }).selectOption('two')
  await panel.getByRole('combobox', { name: '覆盖处理' }).selectOption('compress')
  await unit.getByRole('button', { name: '关联所选镜头' }).click()
  await expect(unit).toContainText('已映射')
  await expect(unit).toContainText('压缩')
  await panel.getByRole('region', { name: '镜头对应原文' }).getByRole('button').click()
  await expect(original).toBeFocused()
  await unit.getByRole('button', { name: '定位镜头 2', exact: true }).click()
  await expect(page.getByRole('row', { name: '镜头 02' })).toBeVisible()
  await page.getByRole('button', { name: '剧情来源', exact: true }).click()
  panel = page.getByTestId('source-mapping')
  await panel.getByRole('textbox', { name: '新增改编提案' }).fill('新增等待动作，尚待人工判断')
  await panel.getByRole('button', { name: '保存改编提案' }).click()
  await expect(panel.getByRole('list', { name: '改编提案' })).toContainText('提案（非原文）')
  await panel.screenshot({ path: testInfo.outputPath('source-map-bidirectional.png') })
  await page.reload()
  await waitEngine(page)
  panel = await open(page, board)
  await expect(panel.getByRole('list', { name: '原文标注', exact: true })).toContainText('已映射')
  await expect(panel).toContainText('已显式核对本版原文')
  expect(submitted).toEqual([])
})

test('来源修改只提示并保留旧快照，固定新版不自动重绑相同对白', async ({ page }, testInfo) => {
  const { board, source } = await seed(page)
  const panel = await open(page, board)
  await panel.getByRole('button', { name: '固定为新版本' }).click()
  const original = panel.getByRole('textbox', { name: '固定原文', exact: true })
  const before = await original.inputValue()
  await page.evaluate((id) => {
    const params = window.__plein.engine.doc.mutable(id)!.get('params') as {
      set(key: string, value: unknown): void
    }
    params.set('text', '乙：回来。\n甲：回来。\n新的结尾。')
  }, source)
  await expect(panel).toContainText('来源已修改')
  await expect(original).toHaveValue(before)
  await panel.getByRole('button', { name: '固定为新版本' }).click()
  await expect(original).toHaveValue('乙：回来。\n甲：回来。\n新的结尾。')
  await expect(panel.getByRole('combobox', { name: '固定原文版本' }).locator('option')).toHaveCount(
    2,
  )
  await expect(
    panel.getByRole('list', { name: '原文标注', exact: true }).locator('> li'),
  ).toHaveCount(0)
  await panel.screenshot({ path: testInfo.outputPath('source-map-new-version.png') })
})

test('协作者固定新版后，已选原文范围仍属于原固定版本', async ({ page, browser }) => {
  const { board, source } = await seed(page)
  const panel = await open(page, board)
  await panel.getByRole('button', { name: '固定为新版本' }).click()
  const snapshotId = await page.evaluate(
    (id) => window.__plein.engine.doc.get(id)!.production!.sourceMap!.snapshots[0]!.id,
    board,
  )
  const original = panel.getByRole('textbox', { name: '固定原文', exact: true })
  await original.focus()
  await original.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(6, 6))
  for (let i = 0; i < 5; i++) await original.press('Shift+ArrowRight')
  await expect
    .poll(() =>
      original.evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd]),
    )
    .toEqual([6, 11])
  const context = await browser.newContext()
  try {
    const peer = await context.newPage()
    await peer.goto(page.url())
    await waitEngine(peer)
    const peerPanel = await open(peer, board)
    await peer.evaluate((id) => {
      const params = window.__plein.engine.doc.mutable(id)!.get('params') as {
        set(key: string, value: unknown): void
      }
      params.set('text', '另一部故事，与原来的内容和范围不同。')
    }, source)
    await expect(peerPanel).toContainText('来源已修改')
    await peerPanel.getByRole('button', { name: '固定为新版本' }).click()
    await expect(
      panel.getByRole('combobox', { name: '固定原文版本' }).locator('option'),
    ).toHaveCount(2)
    await expect(original).toHaveValue('甲：回来。\n乙：回来。\n😀她没有回头。')
    await panel.getByRole('button', { name: '将选中原文加入标注' }).click()
    await expect
      .poll(() =>
        page.evaluate((id) => {
          const record = window.__plein.engine.doc.get(id)!.production!.sourceMap!
          const unit = record.units[0]
          return (
            unit && {
              snapshotId: unit.snapshotId,
              quote: record.snapshots
                .find((snapshot) => snapshot.id === unit.snapshotId)!
                .text.slice(unit.start, unit.end),
            }
          )
        }, board),
      )
      .toEqual({ snapshotId, quote: '乙：回来。' })
  } finally {
    await context.close()
  }
})

// 这批用例要跑真实渲染、编码或很大的工程，单条本来就慢
slowFile(test)
