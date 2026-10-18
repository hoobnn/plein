import { expect, test } from '@playwright/test'
import { clickElement, newProject } from './canvas'

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
