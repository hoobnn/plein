import { expect, test } from './fixtures'
import type { LibraryItem } from '../packages/protocol/src'
import { newProject, revealGenerator, waitNode } from './canvas'

test('角色图局部重绘后仍可采用并精确归档，原候选与角色设定保留', async ({ page }) => {
  await newProject(page)
  const created = await page.request.post('/api/library', {
    data: {
      kind: 'character',
      name: 'P2精修角色',
      description: '黑发蓝衣的年轻角色',
      projectId: null,
    },
  })
  expect(created.status()).toBe(201)
  const role = (await created.json()) as LibraryItem
  const source = await page.evaluate((libraryId) => {
    const id = window.__plein.addNode({
      type: 'plein/image',
      name: '角色原候选',
      params: {
        prompt: '黑发蓝衣的年轻角色肖像',
        model: 'plein/mock:image',
        characterAssetTarget: { libraryId, slot: 'portrait' },
      },
      x: 300,
      y: 100,
    })
    window.__plein.engine.selection.set([id])
    return id
  }, role.id)
  await revealGenerator(page)
  const generator = page.getByTestId('generator')
  await generator.getByRole('button', { name: '生成', exact: true }).click()
  await waitNode(page, source)
  const original = await page.evaluate(
    (id) => window.__plein.engine.doc.get(id)!.results![0],
    source,
  )
  await generator.getByRole('button', { name: '局部重绘', exact: true }).click()
  const mask = page.getByRole('dialog', { name: '画重绘区域' })
  await mask.getByRole('button', { name: '框选', exact: true }).click()
  const box = (await mask.getByTestId('mask-canvas').boundingBox())!
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.3)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.7, { steps: 5 })
  await page.mouse.up()
  await mask.getByRole('button', { name: '完成', exact: true }).click()
  await expect(mask).toBeHidden()
  const edit = await page.evaluate(() =>
    [...window.__plein.engine.doc.elements()].find((node) => node.nodeType === 'plein/image-edit')!,
  )
  expect(edit.params!.characterAssetTarget).toEqual({ libraryId: role.id, slot: 'portrait' })
  expect(edit.results ?? []).toHaveLength(0)
  await revealGenerator(page)
  await generator.locator('textarea').first().fill('把衣领改为白色，保持其余细节')
  await generator.getByRole('button', { name: '生成', exact: true }).click()
  await waitNode(page, edit.id)
  await generator.getByRole('button', { name: '归档到角色', exact: true }).click()
  const archive = page.getByRole('dialog', { name: '归档到角色', exact: true })
  await expect(archive.getByText(role.name, { exact: true })).toBeVisible()
  await archive.getByRole('checkbox', { name: '设为独立封面' }).check()
  await archive.getByRole('button', { name: '确认归档', exact: true }).click()
  await expect(archive).toBeHidden()
  const saved = (await (await page.request.get(`/api/library/${role.id}`)).json()) as LibraryItem
  const refined = await page.evaluate(
    (id) => window.__plein.engine.doc.get(id)!.results![0],
    edit.id,
  )
  expect(saved.images).toEqual([{ slot: 'portrait', assetId: refined!.value.assetId }])
  expect(saved.coverAssetId).toBe(refined!.value.assetId)
  expect(saved.projectId).toBeNull()
  expect(saved.description).toBe(role.description)
  expect(
    await page.evaluate((id) => window.__plein.engine.doc.get(id)!.results![0], source),
  ).toEqual(original)
  await page.screenshot({ path: test.info().outputPath('refined-character-archive.png') })
})
