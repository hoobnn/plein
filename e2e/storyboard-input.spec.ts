import { expect, test } from './fixtures'
import { addNode, byName, clickElement, newProject } from './canvas'

test('分镜补充要求不能替代剧本，连接剧本前禁止提交生成', async ({ page }) => {
  await newProject(page)
  await addNode(page, '分镜')
  const board = await byName(page, '分镜')
  const generator = page.getByTestId('generator')
  await generator.getByRole('textbox', { name: '提示词', exact: true }).fill('两个镜头，无对白')
  await expect(generator).toContainText('需要连入剧本')
  await expect(generator.getByRole('button', { name: '生成', exact: true })).toBeDisabled()
  await page.evaluate((id) => {
    const script = window.__plein.addNode({
      type: 'plein/text',
      name: '剧本',
      params: { text: '雨后，小岚看着桌上的水杯，露出微笑。' },
      x: -700,
      y: 0,
    })
    window.__plein.connect([script, 'text'], [id, 'script'])
  }, board.id)
  await clickElement(page, board.id)
  await expect(generator.getByRole('button', { name: '生成', exact: true })).toBeEnabled()
})
