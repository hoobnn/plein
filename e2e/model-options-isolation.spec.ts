import { expect, test } from './fixtures'
import type { Locator, Page } from './fixtures'
import { clickElement, newProject, revealGenerator, waitNode } from './canvas'

/** 打开参数面板并恢复当前模型的默认参数 */
async function restoreModelDefaults(page: Page, generator: Locator) {
  await generator.getByRole('button', { name: '参数', exact: true }).click()
  const params = page.getByRole('dialog', { name: '参数', exact: true })
  await params.getByRole('button', { name: '更多参数', exact: true }).click()
  await params.getByRole('button', { name: '恢复模型默认参数', exact: true }).click()
  await page.keyboard.press('Escape')
}

/**
 * 隔离语义已由服务端用例覆盖；「恢复模型默认参数」写回文档并可撤销，
 * 这条链路要同时经过生成器面板、画布文档与撤销栈，只能由真浏览器证明。
 */
test(
  '其他模型损坏数据不影响当前生成，恢复当前模型只修改当前项且可撤销',
  { tag: '@core' },
  async ({ page }) => {
    await newProject(page)
    const model = 'plein/mock:image'
    const other = 'plein/mock:video'
    const id = await page.evaluate(
      ({ model, other }) =>
        window.__plein.addNode({
          type: 'plein/image',
          name: '按模型隔离参数',
          x: 400,
          y: 200,
          params: {
            model,
            prompt: '雨后水杯',
            options: { [model]: { watermark: false }, [other]: null },
          },
        }),
      { model, other },
    )
    await clickElement(page, id)
    const generator = page.getByTestId('generator')
    const edit = generator.getByRole('button', { name: '编辑生成图片', exact: true })
    if (await edit.isVisible()) await edit.click()
    const preview = page.getByTestId('input-preview')
    // 编辑器固定在卡片下方，控件可能在窗口外：先把它移进窗口
    const actual = preview.getByRole('button', { name: /实际输入/ })
    await revealGenerator(page, actual)
    await actual.click()
    const generate = generator.getByRole('button', { name: /^(重新)?生成$/ })
    await expect(generate).toBeEnabled()
    await revealGenerator(page, generate)
    await generate.click()
    await waitNode(page, id)
    const canvas = /#\/c\/([^/?]+)/.exec(page.url())![1]
    const jobs = async () =>
      (await (await page.request.get(`/api/canvases/${canvas}/jobs`)).json()).jobs
    expect((await jobs())[0].input.params.options).toMatchObject({ watermark: false })
    const read = () => page.evaluate((id) => window.__plein.engine.doc.get(id)!.params!.options, id)
    expect(await read()).toEqual({ [model]: { watermark: false }, [other]: null })

    await page.evaluate(
      ({ id, model, other }) => {
        const params = window.__plein.engine.doc.mutable(id)!.get('params') as {
          set(key: string, value: unknown): void
        }
        params.set('options', { [model]: null, [other]: '保留损坏的历史值' })
      },
      { id, model, other },
    )
    await expect(preview).toContainText('参数格式')
    await expect(generate).toBeDisabled()
    expect(await jobs()).toHaveLength(1)

    await restoreModelDefaults(page, generator)
    await expect(preview).not.toContainText('不会提交')
    expect(await read()).toEqual({ [model]: {}, [other]: '保留损坏的历史值' })
    await page.getByRole('button', { name: '撤销', exact: true }).click()
    await expect(preview).toContainText('参数格式')
    await page.getByRole('button', { name: '重做', exact: true }).click()
    await expect(generate).toBeEnabled()
    await revealGenerator(page, generate)
    await generate.click()
    await waitNode(page, id)
    await expect.poll(async () => (await jobs()).length).toBe(2)
    await expect.poll(async () => (await jobs())[0].status).toBe('succeeded')
    expect((await jobs())[0].input.params).not.toHaveProperty('options')
    expect(await read()).toEqual({ [model]: {}, [other]: '保留损坏的历史值' })
  },
)

test('没有专属参数表单的模型仍能恢复损坏历史参数并重新生成', { tag: '@core' }, async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 560 })
  await newProject(page)
  const id = await page.evaluate(() =>
    window.__plein.addNode({
      type: 'plein/video',
      name: '无额外表单的恢复',
      x: 400,
      y: 200,
      params: { model: 'plein/mock:video', prompt: '雨后水杯', options: null },
    }),
  )
  await clickElement(page, id)
  const generator = page.getByTestId('generator')
  const edit = generator.getByRole('button', { name: '编辑生成视频', exact: true })
  if (await edit.isVisible()) await edit.click()
  const preview = page.getByTestId('input-preview')
  const actual = preview.getByRole('button', { name: /实际输入/ })
  await revealGenerator(page, actual)
  await actual.click()
  const generate = generator.getByRole('button', { name: /^(重新)?生成$/ })
  await expect(preview).toContainText('参数格式')
  await expect(generate).toBeDisabled()

  await restoreModelDefaults(page, generator)
  await expect(preview).not.toContainText('不会提交')
  await page.getByRole('button', { name: '撤销', exact: true }).click()
  await expect(preview).toContainText('参数格式')
  await page.getByRole('button', { name: '重做', exact: true }).click()
  await expect(generate).toBeEnabled()
  await revealGenerator(page, generate)
  await generate.click()
  await waitNode(page, id)
  expect(
    await page.evaluate((id) => window.__plein.engine.doc.get(id)!.params!.options, id),
  ).toEqual({ 'plein/mock:video': {} })
})
