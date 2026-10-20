import { expect, test } from '@playwright/test'
import { clickElement, newProject, waitNode } from './canvas'

test('跨平台手选音色在生成前提示，切换正确音色后恢复并产出音频', async ({ page }) => {
  await newProject(page)
  const id = await page.evaluate(() =>
    window.__plein.addNode({
      type: 'plein/speech',
      name: '跨平台音色恢复',
      x: 400,
      y: 200,
      params: {
        model: 'plein/mock:audio',
        text: '换回正确的平台后继续配音。',
        voice: { provider: 'minimax/api', voiceId: 'foreign-voice' },
      },
    }),
  )
  await clickElement(page, id)
  const preview = page.getByTestId('input-preview')
  await expect(preview).toContainText('不会提交')
  await preview.getByRole('button', { name: /实际输入/ }).click()
  await expect(
    preview.getByText(/音色 foreign-voice 属于 minimax\/api，当前配音模型/),
  ).toBeVisible()
  const generate = page.getByRole('button', { name: '生成', exact: true })
  await expect(generate).toBeDisabled()
  await page.getByRole('button', { name: '参数', exact: true }).click()
  await page.getByRole('button', { name: '更多参数', exact: true }).click()
  await page.getByRole('combobox', { name: '音色', exact: true }).click()
  await page.getByRole('option', { name: /Mock 女声/ }).click()
  await expect(preview).not.toContainText('不会提交')
  await expect(generate).toBeEnabled()
  await generate.click()
  await waitNode(page, id)
  const result = await page.evaluate((id) => window.__plein.engine.doc.get(id)!.results![0]!, id)
  expect(result.value.type).toBe('audio')
  const canvas = /#\/c\/([^/?]+)/.exec(page.url())![1]
  const jobs = await (await page.request.get(`/api/canvases/${canvas}/jobs`)).json()
  expect(jobs.jobs.find((job: { nodeId: string }) => job.nodeId === id).input.voice).toEqual({
    provider: 'plein/mock',
    voiceId: 'mock-female',
  })
  await expect(preview).toHaveAttribute('aria-busy', 'false')
  await expect(preview).toContainText('mock-female')
  await expect(preview).not.toContainText('foreign-voice')
  await page.screenshot({ path: test.info().outputPath('speech-voice-recovered.png') })
})

for (const initial of ['mock-female', 'initial-custom']) {
  test(`角色音色从 ${initial} 跟随外部切换，默认选择可以撤销恢复`, async ({ page }) => {
    await newProject(page)
    const id = await page.evaluate(
      (initial) =>
        window.__plein.addNode({
          type: 'plein/character',
          name: '音色状态测试',
          x: 400,
          y: 200,
          params: {
            description: '音色状态',
            voice: { provider: 'plein/mock', voiceId: initial },
          },
        }),
      initial,
    )
    await clickElement(page, id)
    await page.getByRole('button', { name: '更多设置', exact: true }).click()
    const picker = page.getByRole('combobox', { name: '音色', exact: true })
    const provider = page.getByRole('textbox', { name: '音色所属平台', exact: true })
    const voice = page.getByRole('textbox', { name: '音色 ID', exact: true })
    if (initial === 'mock-female') await expect(picker).toContainText('Mock 女声')
    else await expect(voice).toHaveValue(initial)
    const update = async (voiceId: string) =>
      page.evaluate(
        ({ id, voiceId }) => {
          const params = window.__plein.engine.doc.mutable(id)!.get('params') as {
            set(key: string, value: unknown): void
          }
          params.set('voice', { provider: 'plein/mock', voiceId })
        },
        { id, voiceId },
      )
    await update('external-custom')
    await expect(provider).toHaveValue('plein/mock')
    await expect(voice).toHaveValue('external-custom')
    await expect(picker).toHaveText('自定义音色 ID…')
    if (initial === 'initial-custom') {
      await page.setViewportSize({ width: 800, height: 560 })
      await voice.scrollIntoViewIfNeeded()
      await expect(provider).toBeInViewport()
      await expect(voice).toBeInViewport()
      expect(
        await voice.evaluate((el) => {
          const row = el.parentElement!
          return row.scrollWidth <= row.clientWidth
        }),
      ).toBe(true)
      await page.screenshot({
        path: test.info().outputPath('custom-voice-narrow.png'),
        animations: 'disabled',
      })
    }
    await update('mock-female')
    await expect(picker).toContainText('Mock 女声')
    await expect(voice).toHaveCount(0)
    await update('restored-custom')
    await expect(voice).toHaveValue('restored-custom')
    await picker.click()
    await page.getByRole('option', { name: '平台默认音色', exact: true }).click()
    await expect(voice).toHaveCount(0)
    await page.getByRole('button', { name: '撤销', exact: true }).click()
    await expect(voice).toHaveValue('restored-custom')
    await expect(picker).toHaveText('自定义音色 ID…')
  })
}

test('手动自定义音色清空或输入预置 ID 时保持编辑入口', async ({ page }) => {
  await newProject(page)
  const id = await page.evaluate(() =>
    window.__plein.addNode({
      type: 'plein/character',
      name: '手动音色',
      x: 400,
      y: 200,
      params: {},
    }),
  )
  await clickElement(page, id)
  await page.getByRole('button', { name: '更多设置', exact: true }).click()
  const picker = page.getByRole('combobox', { name: '音色', exact: true })
  await picker.click()
  await page.getByRole('option', { name: '自定义音色 ID…', exact: true }).click()
  const provider = page.getByRole('textbox', { name: '音色所属平台', exact: true })
  const voice = page.getByRole('textbox', { name: '音色 ID', exact: true })
  await expect(provider).toHaveValue('')
  await expect(voice).toHaveValue('')
  await provider.fill('plein/mock')
  await voice.fill('mock-female')
  await expect(picker).toHaveText('自定义音色 ID…')
  await expect(voice).toBeVisible()
  await voice.fill('')
  await provider.fill('')
  await expect(voice).toBeVisible()
  await expect(picker).toHaveText('自定义音色 ID…')
  await picker.click()
  await page.getByRole('option', { name: /Mock 女声/ }).click()
  await expect(voice).toHaveCount(0)
  expect(await page.evaluate((id) => window.__plein.engine.doc.get(id)!.params!.voice, id)).toEqual(
    { provider: 'plein/mock', voiceId: 'mock-female' },
  )
})

test('复制空白的音色在界面、生成预检与实际配音执行中保持一致', async ({ page }) => {
  await newProject(page)
  const id = await page.evaluate(() =>
    window.__plein.addNode({
      type: 'plein/speech',
      name: '复制音色配音',
      x: 400,
      y: 200,
      params: {
        model: 'plein/mock:audio',
        text: '这是音色边界检查。',
        voice: { provider: ' plein/mock ', voiceId: ' mock-female\t' },
      },
    }),
  )
  await clickElement(page, id)
  await page.getByRole('button', { name: '参数', exact: true }).click()
  await page.getByRole('button', { name: '更多参数', exact: true }).click()
  await expect(page.getByRole('combobox', { name: '音色', exact: true })).toContainText('Mock 女声')
  const canvas = /#\/c\/([^/?]+)/.exec(page.url())![1]
  const endpoint = `/api/canvases/${canvas}/nodes/${id}`
  const prepared = await (await page.request.get(`${endpoint}/input`)).json()
  expect(prepared.voice).toEqual({ provider: 'plein/mock', voiceId: 'mock-female' })
  const response = await page.request.post(`${endpoint}/run`, {
    data: { expect: prepared.inputHash },
  })
  expect(response.status()).toBe(202)
  await waitNode(page, id)
  expect(
    await page.evaluate((id) => window.__plein.engine.doc.get(id)!.results!.length, id),
  ).toBeGreaterThan(0)
})
