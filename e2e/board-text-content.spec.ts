import { expect, test } from './fixtures'
import { clickElement, newProject } from './canvas'

test('手写文本直接显示正文，编辑与撤销后预览和筛选同步', async ({ page }) => {
  await newProject(page)
  const id = await page.evaluate(() =>
    window.__plein.addNode({
      type: 'plein/text',
      name: '手写文案',
      params: { text: '第一行画面说明\n第二行台词' },
      x: 300,
      y: 200,
    }),
  )
  await page.getByRole('button', { name: '故事板', exact: true }).click()
  const column = page.getByRole('region', { name: '文本', exact: true })
  const card = column.locator('.board-text')
  await expect(card).toContainText('第一行画面说明')
  await column.getByRole('button', { name: '筛选', exact: true }).click()
  await page.getByRole('menuitemradio', { name: '已生成', exact: true }).click()
  await expect(card).toHaveCount(1)
  await page.evaluate((id) => {
    const doc = window.__plein.engine.doc as typeof window.__plein.engine.doc & {
      undo: { stopCapturing(): void }
      origin: unknown
      ydoc: { transact(fn: () => void, origin: unknown): void }
    }
    doc.undo.stopCapturing()
    const params = doc.mutable(id)!.get('params') as { set(key: string, value: unknown): void }
    doc.ydoc.transact(() => params.set('text', '   \n  '), doc.origin)
  }, id)
  await expect(card).toHaveCount(0)
  expect(await page.evaluate((id) => window.__plein.engine.doc.get(id)?.params?.text, id)).toBe(
    '   \n  ',
  )
  await page.evaluate(() =>
    (window.__plein.engine as typeof window.__plein.engine & { undo(): void }).undo(),
  )
  await expect(card).toContainText('第一行画面说明')
  await page.evaluate(() =>
    (window.__plein.engine as typeof window.__plein.engine & { redo(): void }).redo(),
  )
  await expect(card).toHaveCount(0)
  await page.evaluate(() =>
    (window.__plein.engine as typeof window.__plein.engine & { undo(): void }).undo(),
  )
  await expect(card).toContainText('第二行台词')
  await card.click()
  await expect
    .poll(() => page.evaluate(() => window.__plein.engine.selection.values()))
    .toEqual([id])
})

for (const width of [420]) {
  test(`生成文本空白不算完成，多行与超长正文不撑破 ${width}px 卡片`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await newProject(page)
    await page.evaluate(() => {
      for (const [i, text] of [
        '   \n\t',
        '第一行\n第二行\n第三行',
        'LongWord'.repeat(200),
      ].entries()) {
        const id = window.__plein.addNode({
          type: 'plein/llm',
          name: `文案${i}`,
          params: {},
          x: 300,
          y: i * 400,
        })
        const node = window.__plein.engine.doc.mutable(id) as unknown as {
          set(key: string, value: unknown): void
        }
        node.set('results', [
          {
            id: `result${i}`,
            port: 'text',
            runId: 'text-fixture',
            at: 1,
            value: { type: 'text', text },
          },
        ])
        node.set('adopted', `result${i}`)
      }
    })
    await page.getByRole('button', { name: '故事板', exact: true }).click()
    const column = page.getByRole('region', { name: '文本', exact: true })
    await column.getByRole('button', { name: '筛选', exact: true }).click()
    await page.getByRole('menuitemradio', { name: '已生成', exact: true }).click()
    await expect(column.locator('.board-text')).toHaveCount(2)
    const multiline = column
      .locator('.board-text')
      .filter({ hasText: '文案1' })
      .locator('.line-clamp-2')
    expect(
      await multiline.evaluate((el) => {
        const style = getComputedStyle(el)
        return {
          whiteSpace: style.whiteSpace,
          height: el.getBoundingClientRect().height,
          line: parseFloat(style.lineHeight),
        }
      }),
    ).toMatchObject({ whiteSpace: 'pre-line' })
    for (const card of await column.locator('.board-text').all()) {
      const preview = card.locator('.line-clamp-2')
      const geometry = await preview.evaluate((el) => ({
        height: el.getBoundingClientRect().height,
        line: parseFloat(getComputedStyle(el).lineHeight),
        width: el.clientWidth,
        scrollWidth: el.scrollWidth,
      }))
      expect(geometry.height).toBeLessThanOrEqual(geometry.line * 2 + 1)
      expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.width + 1)
    }
    await page.screenshot({
      path: test.info().outputPath('board-text-content.png'),
      animations: 'disabled',
    })
  })
}

test('通过编辑器修改手写文本后展示当前正文，清空时不回退到旧运行结果', async ({ page }) => {
  await newProject(page)
  const id = await page.evaluate(() => {
    const id = window.__plein.addNode({
      type: 'plein/text',
      name: '编辑文案',
      params: { text: '初始正文' },
      x: 300,
      y: 200,
    })
    const node = window.__plein.engine.doc.mutable(id) as unknown as {
      set(key: string, value: unknown): void
    }
    node.set('results', [
      {
        id: 'old',
        port: 'text',
        runId: 'old-run',
        at: 1,
        value: { type: 'text', text: '已经过期的运行结果' },
      },
    ])
    node.set('adopted', 'old')
    return id
  })
  await clickElement(page, id)
  const generator = page.getByTestId('generator')
  const edit = generator.getByRole('button', { name: '编辑文本', exact: true })
  if (await edit.isVisible()) await edit.click()
  const input = generator.getByRole('textbox', { name: '提示词', exact: true })
  await expect(input).toHaveValue('初始正文')
  await input.fill('编辑后的正文')
  await page.getByRole('button', { name: '故事板', exact: true }).click()
  const card = page.getByRole('region', { name: '文本', exact: true }).locator('.board-text')
  await expect(card).toContainText('编辑后的正文')
  await expect(card).not.toContainText('已经过期的运行结果')
  await card.click()
  if (await edit.isVisible()) await edit.click()
  await input.fill('')
  await page.getByRole('button', { name: '故事板', exact: true }).click()
  await expect(card).toHaveText('编辑文案')
})
