import { expect, type Page, test } from '@playwright/test'
import { centerOf, newProject, showStoryboardCards, zoomTo } from './canvas'

async function fixture(page: Page, names = ['日景分镜', '夜景分镜']) {
  await newProject(page)
  const boards: Array<{ id: string; image: string; prompt: unknown }> = []
  for (const [index, name] of names.entries()) {
    const id = await page.evaluate(
      ({ index, name }) =>
        window.__plein.addNode({
          type: 'plein/storyboard',
          name,
          x: index * 1400,
          y: 200,
          params: {
            shots: [
              {
                id: 'shot-1',
                no: 1,
                duration: 3,
                description: '画面',
                imagePrompt: `原画面${index}`,
                motionPrompt: '静止',
              },
            ],
          },
        }),
      { index, name },
    )
    const editor = page.getByRole('dialog', { name: '分镜表', exact: true })
    const open = async () => {
      await zoomTo(page, [id])
      const at = await centerOf(page, id)
      await page.mouse.dblclick(at.x, at.y)
      await expect(editor).toBeVisible()
      await showStoryboardCards(editor)
    }
    await open()
    await editor.getByRole('button', { name: '展开为节点', exact: true }).click()
    await expect(editor).toHaveCount(0)
    const image = await page.evaluate(
      (id) =>
        [...window.__plein.engine.doc.elements()].find((el) => {
          const source = el.params?.source as { storyboard?: string; role?: string } | undefined
          return source?.storyboard === id && source.role === 'image'
        })!.id,
      id,
    )
    const prompt = await page.evaluate(
      (id) => window.__plein.engine.doc.get(id)?.params?.prompt,
      image,
    )
    await open()
    await editor.getByLabel('分镜图提示词', { exact: true }).fill(`计划画面${index}`)
    await editor.getByRole('button', { name: '关闭', exact: true }).click()
    await expect(editor).toHaveCount(0)
    boards.push({ id, image, prompt })
  }
  await page.getByRole('button', { name: '查看影响', exact: true }).click()
  const impact = page.getByRole('dialog', { name: '查看影响', exact: true })
  await expect(impact.getByRole('button', { name: '查看差异', exact: true })).toHaveCount(2)
  return { boards, impact }
}

test('相同镜号的不同分镜明确标出来源，同步只修改选中的分镜', async ({ page }) => {
  const f = await fixture(page)
  const row = f.impact.getByRole('listitem', { name: '夜景分镜 · 镜头 01', exact: true })
  await expect(row).toBeVisible()
  await expect(
    row.getByRole('button', { name: '查看差异', exact: true }),
  ).toHaveAccessibleDescription(/夜景分镜.*镜头 01/)
  await row.getByRole('button', { name: '查看差异', exact: true }).click()
  const diff = page.getByRole('dialog', { name: '计划差异', exact: true })
  await expect(diff.getByTestId('storyboard-source')).toHaveText('分镜：夜景分镜')
  await diff.getByRole('button', { name: '同步计划改动', exact: true }).click()
  await expect(diff.getByText('没有待处理的差异', { exact: true })).toBeVisible()
  expect(
    await page.evaluate(
      (id) => window.__plein.engine.doc.get(id)?.params?.prompt,
      f.boards[0]!.image,
    ),
  ).toBe(f.boards[0]!.prompt)
  expect(
    await page.evaluate(
      (id) => window.__plein.engine.doc.get(id)?.params?.prompt,
      f.boards[1]!.image,
    ),
  ).toContain('计划画面1')
})

test('同名分镜使用一致的来源序号，确认节点现状不会影响另一份分镜', async ({ page }) => {
  const f = await fixture(page, ['同名分镜', '同名分镜'])
  const sorted = [...f.boards].sort((a, b) => (a.id < b.id ? -1 : 1))
  const row = f.impact.getByRole('listitem', { name: '同名分镜（同名 2） · 镜头 01', exact: true })
  await row.getByRole('button', { name: '查看差异', exact: true }).click()
  const diff = page.getByRole('dialog', { name: '计划差异', exact: true })
  await expect(diff.getByTestId('storyboard-source')).toHaveText('分镜：同名分镜（同名 2）')
  await diff.getByRole('button', { name: '不同步，按节点现状', exact: true }).click()
  await expect(diff.getByText('没有待处理的差异', { exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(row).toHaveCount(0)
  await expect(
    f.impact.getByRole('listitem', { name: '同名分镜（同名 1） · 镜头 01', exact: true }),
  ).toBeVisible()
  for (const board of sorted)
    expect(
      await page.evaluate((id) => window.__plein.engine.doc.get(id)?.params?.prompt, board.image),
    ).toBe(board.prompt)
})

test('长来源名在窄窗口不挤出操作按钮，重命名后差异窗口与列表同步更新', async ({ page }) => {
  const name = '雨后玻璃水杯与人物分镜'.repeat(18)
  const f = await fixture(page, [name, '另一份分镜'])
  await page.setViewportSize({ width: 390, height: 700 })
  const row = f.impact.getByRole('listitem', { name: `${name} · 镜头 01`, exact: true })
  await expect(row).toBeVisible()
  expect(await row.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
  await row.getByRole('button', { name: '查看差异', exact: true }).click()
  const diff = page.getByRole('dialog', { name: '计划差异', exact: true })
  const source = diff.getByTestId('storyboard-source')
  await expect(source).toHaveAttribute('title', name)
  await expect(diff.getByRole('button', { name: '同步计划改动', exact: true })).toBeInViewport()
  expect(await diff.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
  await page.screenshot({
    path: test.info().outputPath('storyboard-source-long.png'),
    animations: 'disabled',
  })
  await page.evaluate(
    (id) =>
      (
        window.__plein.engine.doc.mutable(id) as unknown as {
          set(key: string, value: unknown): void
        }
      ).set('name', '改名后的分镜'),
    f.boards[0]!.id,
  )
  await expect(source).toHaveText('分镜：改名后的分镜')
  await page.screenshot({
    path: test.info().outputPath('storyboard-source-narrow.png'),
    animations: 'disabled',
  })
  await page.keyboard.press('Escape')
  await expect(
    f.impact.getByRole('listitem', { name: '改名后的分镜 · 镜头 01', exact: true }),
  ).toBeVisible()
})
