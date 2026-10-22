import { expect, test } from '@playwright/test'
import { clickElement, newProject, waitNode } from './canvas'

test(`窄窗口长语气指令不适用时可显式清空、撤销重做并换模型生成`, async ({ page }) => {
  const config = '/api/providers/minimax/api/config'
  const original = await (await page.request.get(config)).json()
  const placeholder = !original.secrets.MINIMAX_API_KEY
  expect(
    (
      await page.request.put(config, {
        data: {
          enabled: true,
          ...(placeholder ? { secrets: { MINIMAX_API_KEY: 'local-e2e-never-submitted' } } : {}),
        },
      })
    ).ok(),
  ).toBe(true)
  const instruction = `低声哭腔：${'quiet'.repeat(160)}`
  const submitted: string[] = []
  page.on('request', (request) => {
    if (request.method() === 'POST' && /\/nodes\/[^/]+\/run$/.test(request.url()))
      submitted.push(request.url())
  })
  try {
    await page.setViewportSize({ width: 800, height: 560 })
    await newProject(page)
    const id = await page.evaluate(
      (instruction) =>
        window.__plein.addNode({
          type: 'plein/speech',
          name: '语气恢复配音',
          x: 400,
          y: 200,
          params: {
            model: 'minimax/api:speech-2.8-hd',
            text: '保留台词，修正语气设置。',
            instruction,
          },
        }),
      instruction,
    )
    await clickElement(page, id)
    const generator = page.getByTestId('generator')
    const expand = generator.getByRole('button', { name: /^编辑/ })
    if (await expand.isVisible()) await expand.click()
    const preview = page.getByTestId('input-preview')
    await expect(preview).toContainText('不会提交')
    await preview.getByRole('button', { name: /实际输入/ }).click()
    expect(await preview.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
    const clear = generator.getByRole('button', { name: '清空语气指令', exact: true })
    await expect(clear).toBeVisible()
    await expect(clear).toBeInViewport({ ratio: 1 })
    await expect(generator.getByRole('button', { name: '生成', exact: true })).toBeDisabled()
    expect(submitted).toEqual([])
    await generator.screenshot({ path: test.info().outputPath('unsupported-instruction.png') })
    await clear.click()
    const text = generator.getByRole('textbox', { name: '提示词', exact: true })
    await expect(text).toBeFocused()
    await expect(text).toHaveValue('保留台词，修正语气设置。')
    await expect(clear).toHaveCount(0)
    await expect(preview).not.toContainText('不会提交')
    await page.getByRole('button', { name: '撤销', exact: true }).click()
    await expect(clear).toBeVisible()
    await expect(preview).toContainText('不会提交')
    expect(
      await page.evaluate((id) => window.__plein.engine.doc.get(id)!.params!.instruction, id),
    ).toBe(instruction)
    await page.getByRole('button', { name: '重做', exact: true }).click()
    await expect(clear).toHaveCount(0)
    await expect(preview).not.toContainText('不会提交')
    expect(submitted).toEqual([])
    await generator.getByRole('button', { name: '模型', exact: true }).click()
    await page.getByRole('textbox', { name: '搜索模型', exact: true }).fill('Mock 音频')
    await page.getByRole('option', { name: /Mock 音频/ }).click()
    await expect(generator.getByRole('button', { name: '生成', exact: true })).toBeEnabled()
    await generator.getByRole('button', { name: '生成', exact: true }).click()
    await waitNode(page, id)
    expect(submitted).toHaveLength(1)
    const canvas = /#\/c\/([^/?]+)/.exec(page.url())![1]
    const jobs = await (await page.request.get(`/api/canvases/${canvas}/jobs`)).json()
    expect(jobs.jobs[0].input.model.ref).toBe('plein/mock:audio')
    expect(jobs.jobs[0].input.params.instruction).toBe('')
  } finally {
    expect(
      (
        await page.request.put(config, {
          data: {
            enabled: original.enabled,
            ...(placeholder ? { secrets: { MINIMAX_API_KEY: null } } : {}),
          },
        })
      ).ok(),
    ).toBe(true)
  }
})
