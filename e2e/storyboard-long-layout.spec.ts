import { expect, test } from './fixtures'
import { centerOf, newProject, zoomTo } from './canvas'

for (const [width, height] of [
  [320, 600],
  [1440, 600],
  [640, 360],
  [390, 480],
] as const) {
  test(`${width}×${height} 四十镜头能滚动编辑末镜、折叠并保留选区与内容`, async ({ page }) => {
    await newProject(page)
    const id = await page.evaluate(() =>
      window.__plein.addNode({
        type: 'plein/storyboard',
        name: '四十镜头的长分镜计划与连续编辑验收',
        x: 300,
        y: 200,
        params: {
          shots: Array.from({ length: 40 }, (_, i) => ({
            id: `long-shot-${i + 1}`,
            no: i + 1,
            duration: 3,
            description: `第${i + 1}镜画面。` + '雨后晨光落在木桌与透明玻璃杯上。'.repeat(5),
            imagePrompt: '保持主体、环境和道具的一致性。'.repeat(8),
          })),
        },
      }),
    )
    await zoomTo(page, [id])
    const at = await centerOf(page, id)
    await page.mouse.dblclick(at.x, at.y)
    const dialog = page.getByRole('dialog', { name: '分镜表', exact: true })
    await dialog.getByRole('button', { name: '详细卡片', exact: true }).click()
    await expect(dialog.getByRole('article')).toHaveCount(40)
    await page.setViewportSize({ width, height })
    const body = dialog.getByTestId('storyboard-shots')
    const last = dialog.getByRole('article').last()
    const input = last.getByLabel('画面', { exact: true })
    await input.scrollIntoViewIfNeeded()
    const reachable = await input.evaluate((el) => {
      const box = el.getBoundingClientRect()
      const scroller = el.closest('[data-testid="storyboard-shots"]')!.getBoundingClientRect()
      const x = box.x + box.width / 2
      const y = Math.max(box.top, scroller.top) + Math.min(box.height, scroller.height) / 2
      return y < scroller.bottom && el.contains(document.elementFromPoint(x, y))
    })
    expect(reachable).toBe(true)
    await input.click()
    await input.fill('末镜修改：主角拿起透明水杯。')
    await last.getByRole('checkbox', { name: '选择镜头 40', exact: true }).check()
    await last.getByRole('button', { name: '收起镜头 40', exact: true }).click()
    await expect(input).toBeHidden()
    await last.getByRole('button', { name: '展开镜头 40', exact: true }).click()
    await expect(input).toHaveValue('末镜修改：主角拿起透明水杯。')
    await dialog.getByRole('button', { name: '收起全部镜头', exact: true }).click()
    await expect(dialog.getByRole('button', { name: /^展开镜头 \d/ })).toHaveCount(40)
    await dialog.getByRole('button', { name: '展开全部镜头', exact: true }).click()
    await expect(last.getByRole('checkbox')).toBeChecked()
    await expect(input).toHaveValue('末镜修改：主角拿起透明水杯。')
    expect(await body.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
    await input.scrollIntoViewIfNeeded()
    await input.click()
    await dialog.screenshot({ path: test.info().outputPath(`long-shots-${width}.png`) })
    await dialog.getByRole('button', { name: '关闭', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    expect(
      await page.evaluate(
        (id) =>
          (window.__plein.engine.doc.get(id)!.params!.shots as { description: string }[]).at(-1)!
            .description,
        id,
      ),
    ).toBe('末镜修改：主角拿起透明水杯。')
  })
}
