import { readFileSync } from 'node:fs'
import { expect, test, type Download } from './fixtures'
import { newProject, waitNode } from './canvas'

for (const mode of ['filter', 'empty-filter', 'delete-undo', 'result', 'sort', 'rapid'] as const) {
  test(`历史选择 ${mode} 保留可见身份且不复活旧勾选`, async ({ page }) => {
    await newProject(page)
    const ids = await page.evaluate(() =>
      ['历史甲', '历史乙', '历史丙'].map((name, i) =>
        window.__plein.addNode({
          type: i === 2 ? 'plein/speech' : 'plein/image',
          name,
          params:
            i === 2
              ? { model: 'plein/mock:audio', text: '你好' }
              : { model: 'plein/mock:image', prompt: `${name} 水杯` },
          x: 300 + i * 400,
          y: 200,
        }),
      ),
    )
    const canvas = decodeURIComponent(page.url().split('#/c/')[1]!)
    for (const id of ids) {
      await expect
        .poll(async () =>
          (await page.request.get(`/api/canvases/${canvas}/nodes/${id}/input`)).status(),
        )
        .toBe(200)
      expect(
        (await page.request.post(`/api/canvases/${canvas}/nodes/${id}/run`, { data: {} })).status(),
      ).toBe(202)
      await waitNode(page, id)
    }
    await page.getByRole('button', { name: '生成历史', exact: true }).click()
    const panel = page.getByRole('dialog', { name: '生成历史', exact: true })
    const check = (name: string) =>
      panel.getByRole('checkbox', { name: `选择「${name}」`, exact: true })
    await check('历史甲').check()
    await panel.getByRole('button', { name: '全选', exact: true }).click()
    await expect(panel.getByText('已选 3 项', { exact: true })).toBeVisible()
    if (mode === 'rapid') {
      await panel.getByRole('button', { name: '取消选择', exact: true }).click()
      await panel
        .getByRole('checkbox')
        .evaluateAll((nodes) => nodes.forEach((node) => (node as HTMLInputElement).click()))
      await expect(panel.getByRole('checkbox', { checked: true })).toHaveCount(3, { timeout: 1500 })
      await expect(panel.getByText('已选 3 项', { exact: true })).toBeVisible()
    } else if (mode === 'filter' || mode === 'empty-filter') {
      await panel.getByRole('button', { name: mode === 'filter' ? /^图片/ : /^视频/ }).click()
      if (mode === 'filter')
        await expect(panel.getByText('已选 2 项', { exact: true })).toBeVisible()
      else await expect(panel.getByText('没有符合筛选条件的结果', { exact: true })).toBeVisible()
      await panel.getByRole('button', { name: /^全部/ }).click()
      await expect(check('历史丙')).not.toBeChecked({ timeout: 1500 })
      await expect(check('历史甲')).toBeChecked({ checked: mode === 'filter' })
      await expect(check('历史乙')).toBeChecked({ checked: mode === 'filter' })
    } else if (mode === 'delete-undo') {
      await page.evaluate((id) => {
        const engine = window.__plein.engine as typeof window.__plein.engine & {
          deleteSelection(): void
          doc: { undo: { stopCapturing(): void } }
        }
        engine.doc.undo.stopCapturing()
        engine.selection.set([id])
        engine.deleteSelection()
      }, ids[0]!)
      await expect(check('历史甲')).toHaveCount(0)
      await expect(panel.getByText('已选 2 项', { exact: true })).toBeVisible()
      await page.evaluate(() =>
        (window.__plein.engine.doc as unknown as { undo: { undo(): void } }).undo.undo(),
      )
      await expect(check('历史甲')).not.toBeChecked({ timeout: 1500 })
      await expect(check('历史乙')).toBeChecked()
      await expect(check('历史丙')).toBeChecked()
    } else if (mode === 'result') {
      const results = await page.evaluate((id) => {
        const doc = window.__plein.engine.doc
        const old = doc.get(id)!.results!
        ;(doc.mutable(id) as unknown as { set(k: string, v: unknown): void }).set('results', [])
        return old
      }, ids[0]!)
      await expect(check('历史甲')).toHaveCount(0)
      await page.evaluate(
        ({ id, results }) =>
          (
            window.__plein.engine.doc.mutable(id) as unknown as { set(k: string, v: unknown): void }
          ).set('results', results),
        { id: ids[0]!, results },
      )
      await expect(check('历史甲')).not.toBeChecked({ timeout: 1500 })
      await expect(check('历史乙')).toBeChecked()
    } else {
      await panel.getByRole('button', { name: '最新在前', exact: true }).click()
      expect(
        await panel
          .getByRole('checkbox')
          .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('aria-label'))),
      ).toEqual(['选择「历史甲」', '选择「历史乙」', '选择「历史丙」'])
      await expect(panel.getByRole('checkbox', { checked: true })).toHaveCount(3)
      const assets = await page.evaluate(
        (ids) =>
          ids.map((id) => window.__plein.engine.doc.get(id)!.results![0]!.value.assetId as string),
        ids,
      )
      const bytes = await Promise.all(
        assets.map(async (id) => (await page.request.get(`/api/assets/${id}`)).body()),
      )
      const files: Download[] = []
      page.on('download', (file) => files.push(file))
      await panel.getByRole('button', { name: '下载', exact: true }).click()
      await expect.poll(() => files.length).toBe(3)
      for (let i = 0; i < 3; i++) {
        expect(await files[i]!.failure()).toBeNull()
        expect(files[i]!.suggestedFilename()).toBe(
          `历史${['甲', '乙', '丙'][i]}-${i + 1}.${i === 2 ? 'wav' : 'png'}`,
        )
        expect(readFileSync((await files[i]!.path())!)).toEqual(bytes[i])
      }
    }
    await panel.screenshot({
      path: test.info().outputPath('history-selection.png'),
      animations: 'disabled',
    })
    if (mode === 'empty-filter') {
      await expect(panel.getByRole('button', { name: '放到画布上', exact: true })).toHaveCount(0)
    } else if (mode !== 'sort') {
      const chosen = mode === 'filter' ? ids.slice(0, 2) : mode === 'rapid' ? ids : ids.slice(1)
      const expected = await page.evaluate(
        (ids) =>
          ids
            .map((id) => window.__plein.engine.doc.get(id)!.results![0]!.value.assetId as string)
            .sort(),
        chosen,
      )
      await panel.getByRole('button', { name: '放到画布上', exact: true }).click()
      await expect
        .poll(() =>
          page.evaluate(() =>
            [...window.__plein.engine.doc.elements()]
              .filter((el) => el.kind === 'image' || el.kind === 'audio')
              .map((el) => el.assetId!)
              .sort(),
          ),
        )
        .toEqual(expected)
    }
  })
}
