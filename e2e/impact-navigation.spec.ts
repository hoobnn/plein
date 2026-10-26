import { expect, type Page, test } from '@playwright/test'
import { centerOf, newProject, showStoryboardCards, zoomTo } from './canvas'

async function fixture(page: Page, editorOpen = false) {
  await newProject(page)
  const board = await page.evaluate(() =>
    window.__plein.addNode({
      type: 'plein/storyboard',
      name: '影响入口分镜',
      x: 300,
      y: 200,
      params: {
        shots: [
          {
            id: 'shot-1',
            no: 1,
            duration: 3,
            description: '初始画面',
            imagePrompt: '初始分镜图',
            motionPrompt: '初始运动',
          },
        ],
      },
    }),
  )
  const editor = page.getByRole('dialog', { name: '分镜表', exact: true })
  const open = async () => {
    await zoomTo(page, [board])
    const at = await centerOf(page, board)
    await page.mouse.dblclick(at.x, at.y)
    await expect(editor).toBeVisible()
    await showStoryboardCards(editor)
  }
  await open()
  await editor.getByRole('button', { name: '展开为节点', exact: true }).click()
  await expect(editor).not.toBeVisible()
  const image = await page.evaluate(
    (board) =>
      [...window.__plein.engine.doc.elements()].find((el) => {
        const source = el.params?.source as { storyboard?: string; role?: string } | undefined
        return source?.storyboard === board && source.role === 'image'
      })!.id,
    board,
  )
  const original = await page.evaluate(
    (id) => window.__plein.engine.doc.get(id)?.params?.prompt,
    image,
  )
  await open()
  const prompt = editor.getByLabel('分镜图提示词', { exact: true })
  await prompt.fill('计划改后的分镜图')
  await prompt.blur()
  if (!editorOpen) {
    await editor.getByRole('button', { name: '关闭', exact: true }).click()
    await expect(editor).toHaveCount(0)
  }
  await page.getByRole('button', { name: '查看影响', exact: true }).click()
  const impact = page.getByRole('dialog', { name: '查看影响', exact: true })
  await expect(impact.getByRole('button', { name: '查看差异', exact: true })).toBeVisible()
  return { board, image, original, editor, impact }
}

for (const keep of [false, true]) {
  test(`独立影响面板可${keep ? '确认按节点现状' : '同步分镜计划'}，不依赖打开分镜编辑器`, async ({
    page,
  }) => {
    const f = await fixture(page)
    await f.impact.getByRole('button', { name: '查看差异', exact: true }).click()
    const diff = page.getByRole('dialog', { name: '计划差异', exact: true })
    await expect(diff.getByText('计划改后的分镜图 景别：中景', { exact: true })).toBeVisible()
    if (!keep)
      await page.screenshot({
        path: test.info().outputPath('impact-plan-entry.png'),
        animations: 'disabled',
      })
    await diff
      .getByRole('button', { name: keep ? '不同步，按节点现状' : '同步计划改动', exact: true })
      .click()
    await expect(diff.getByText('没有待处理的差异', { exact: true })).toBeVisible()
    const prompt = await page.evaluate(
      (id) => window.__plein.engine.doc.get(id)?.params?.prompt,
      f.image,
    )
    if (keep) expect(prompt).toBe(f.original)
    else expect(prompt).toContain('计划改后的分镜图')
    await page.keyboard.press('Escape')
    await expect(diff).toHaveCount(0)
    await expect(f.impact.getByRole('button', { name: '查看差异', exact: true })).toHaveCount(0)
    await expect
      .poll(() => f.impact.evaluate((el) => el.contains(document.activeElement)))
      .toBe(true)
  })
}

test('分镜编辑器内查看影响后定位展开节点，关闭遮挡并真正回到画布', async ({ page }) => {
  const f = await fixture(page, true)
  await f.impact.getByRole('button', { name: '镜头图', exact: true }).click()
  await expect(f.impact).toHaveCount(0)
  await expect(f.editor).toHaveCount(0)
  await expect
    .poll(() => page.evaluate(() => window.__plein.engine.selection.values()))
    .toEqual([f.image])
  const at = await centerOf(page, f.image)
  await expect
    .poll(() => page.evaluate((at) => document.elementFromPoint(at.x, at.y)?.tagName, at))
    .toBe('CANVAS')
})

test('报告中的节点同帧被删除后，定位给出提示并重新分析', async ({ page }) => {
  const f = await fixture(page)
  await f.impact.getByRole('button', { name: '镜头图', exact: true }).evaluate((button, id) => {
    const engine = window.__plein.engine as typeof window.__plein.engine & {
      deleteSelection(): void
    }
    engine.selection.set([id])
    engine.deleteSelection()
    ;(button as HTMLButtonElement).click()
  }, f.image)
  await expect(page.locator('.ui-toast')).toContainText('节点已被删除')
  await expect(f.impact).toBeVisible()
  await expect(f.impact.getByRole('button', { name: '镜头图', exact: true })).toHaveCount(0)
})
