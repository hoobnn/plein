import { expect, test } from '@playwright/test'
import { clickElement, newProject } from './canvas'

test('正在编辑长正文时平移与窗口缩小不收起输入框，选区和正文保持', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 560 })
  await newProject(page)
  const id = await page.evaluate(() =>
    window.__plein.addNode({
      type: 'plein/text',
      name: '连续编辑',
      params: { text: '初始正文' },
      x: 400,
      y: 200,
    }),
  )
  await clickElement(page, id)
  await page.evaluate(() =>
    (
      window.__plein.engine as Window['__plein']['engine'] & {
        camera: { panBy(x: number, y: number): void }
      }
    ).camera.panBy(0, -180),
  )
  const panel = page.getByTestId('generator')
  await expect(panel).toHaveAttribute('data-compact', 'false')
  const prompt = panel.getByRole('textbox', { name: '提示词', exact: true })
  const text = '雨后场景，角色拿起透明水杯 🌧️\n'.repeat(80)
  await prompt.fill(text)
  await prompt.evaluate((el) => (el as HTMLTextAreaElement).setSelectionRange(12, 38, 'backward'))
  const selection = () =>
    prompt.evaluate((el) => {
      const input = el as HTMLTextAreaElement
      return [input.selectionStart, input.selectionEnd, input.selectionDirection]
    })
  const before = await selection()
  await page.evaluate(() =>
    (
      window.__plein.engine as Window['__plein']['engine'] & {
        camera: { panBy(x: number, y: number): void }
      }
    ).camera.panBy(0, 180),
  )
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  )
  await expect(panel).toHaveAttribute('data-compact', 'false')
  await expect(prompt).toBeFocused()
  expect(await selection()).toEqual(before)
  await page.setViewportSize({ width: 1000, height: 320 })
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  )
  await expect(panel).toHaveAttribute('data-compact', 'false')
  await expect(prompt).toBeFocused()
  await expect(prompt).toHaveValue(text)
  expect(await selection()).toEqual(before)
  await page.screenshot({ path: 'test-results/generator-long-editing.png' })
  await panel.getByRole('button', { name: '收起编辑器' }).click()
  await expect(panel).toHaveAttribute('data-compact', 'true')
  await panel.getByRole('button', { name: '编辑文本', exact: true }).click()
  await expect(prompt).toHaveValue(text)
  await prompt.evaluate((el) => {
    const input = el as HTMLTextAreaElement
    input.setSelectionRange(input.value.length, input.value.length)
  })
  await page.keyboard.insertText(' tail')
  await expect(prompt).toHaveValue(`${text} tail`)
  await prompt.press('ControlOrMeta+z')
  await expect(prompt).toHaveValue(text)
  await prompt.press('ControlOrMeta+Shift+z')
  await expect(prompt).toHaveValue(`${text} tail`)
  await expect
    .poll(() => page.evaluate((id) => window.__plein.engine.doc.get(id)?.params?.text, id))
    .toBe(`${text} tail`)
})

test('角色名称草稿在平移时不失焦或提前提交，手动收起后保存并可撤销', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 560 })
  await newProject(page)
  const id = await page.evaluate(() =>
    window.__plein.addNode({
      type: 'plein/character',
      name: '原角色名称',
      params: {},
      x: 400,
      y: 200,
    }),
  )
  await clickElement(page, id)
  await page.evaluate(() =>
    (
      window.__plein.engine as Window['__plein']['engine'] & {
        camera: { panBy(x: number, y: number): void }
      }
    ).camera.panBy(0, -180),
  )
  const panel = page.getByTestId('generator')
  await expect(panel).toHaveAttribute('data-compact', 'false')
  const name = panel.getByRole('textbox', { name: '节点名称', exact: true })
  await name.fill('尚未提交的角色草稿')
  await page.evaluate(() =>
    (
      window.__plein.engine as Window['__plein']['engine'] & {
        camera: { panBy(x: number, y: number): void }
      }
    ).camera.panBy(0, 180),
  )
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  )
  await expect(name).toBeFocused()
  await expect(name).toHaveValue('尚未提交的角色草稿')
  expect(await page.evaluate((id) => window.__plein.engine.doc.get(id)?.name, id)).toBe(
    '原角色名称',
  )
  await panel.getByRole('button', { name: '收起编辑器' }).click()
  await expect(panel).toHaveAttribute('data-compact', 'true')
  await expect
    .poll(() => page.evaluate((id) => window.__plein.engine.doc.get(id)?.name, id))
    .toBe('尚未提交的角色草稿')
  await page.getByRole('button', { name: '撤销', exact: true }).click()
  await expect
    .poll(() => page.evaluate((id) => window.__plein.engine.doc.get(id)?.name, id))
    .toBe('原角色名称')
  await page.getByRole('button', { name: '重做', exact: true }).click()
  await expect
    .poll(() => page.evaluate((id) => window.__plein.engine.doc.get(id)?.name, id))
    .toBe('尚未提交的角色草稿')
  await panel.getByRole('button', { name: '编辑角色', exact: true }).click()
  await expect(name).toHaveValue('尚未提交的角色草稿')
})

test('生成受理等待时按钮与快捷键共享保护，重开生成器保留等待和新草稿，失败后可生成', async ({
  page,
}) => {
  await newProject(page)
  const id = await page.evaluate(() =>
    window.__plein.addNode({
      type: 'plein/image',
      name: '受理等待图片',
      params: { prompt: '透明水杯', model: 'plein/mock:image' },
      x: 400,
      y: 200,
    }),
  )
  await clickElement(page, id)
  const generator = page.getByTestId('generator')
  const submit = generator.getByRole('button', { name: '生成', exact: true })
  await expect(submit).toBeEnabled()
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let calls = 0
  await page.route(`**/nodes/${id}/run`, async (route) => {
    if (++calls === 1) {
      await gate
      return route.fulfill({
        status: 503,
        json: { error: 'submit_wait', message: '生成受理暂不可用' },
      })
    }
    await route.continue()
  })
  try {
    await submit.click()
    await expect.poll(() => calls).toBe(1)
    await expect(submit).toBeDisabled()
    await expect(submit).toHaveAttribute('aria-busy', 'true')
    await expect(
      generator.getByRole('status').filter({ hasText: '正在提交生成请求…' }),
    ).toBeVisible()
    const prompt = generator.getByRole('textbox', { name: '提示词', exact: true })
    await prompt.fill('等待期间继续编辑的蓝色水杯')
    await prompt.press('ControlOrMeta+Enter')
    expect(calls).toBe(1)
    await page.evaluate(() => window.__plein.engine.selection.set([]))
    await expect(generator).toBeHidden()
    await clickElement(page, id)
    await expect(submit).toBeDisabled()
    await expect(prompt).toHaveValue('等待期间继续编辑的蓝色水杯')
    await generator.screenshot({
      path: test.info().outputPath('generator-submit-wait.png'),
      animations: 'disabled',
    })
    release()
    await expect(page.getByText('生成受理暂不可用', { exact: true })).toBeVisible()
    await expect(submit).toBeEnabled()
    await page.waitForLoadState('networkidle')
    const response = page.waitForResponse(
      (res) => res.url().endsWith(`/nodes/${id}/run`) && res.request().method() === 'POST',
    )
    await submit.click()
    expect((await response).status()).toBe(202)
    await expect
      .poll(() => page.evaluate((id) => window.__plein.engine.doc.get(id)?.results?.length, id))
      .toBe(1)
    expect(calls).toBe(2)
  } finally {
    release()
  }
})

test('运行已受理但应答未返回时仍可取消，不被提交等待锁住', async ({ page }) => {
  await newProject(page)
  const config = '/api/providers/plein/mock/config'
  const original = await (await page.request.get(config)).json()
  expect(
    (
      await page.request.put(config, {
        data: { settings: { ...original.settings, latencyMs: 20000 } },
      })
    ).ok(),
  ).toBe(true)
  const id = await page.evaluate(() =>
    window.__plein.addNode({
      type: 'plein/image',
      name: '受理后取消',
      params: { prompt: '透明水杯', model: 'plein/mock:image' },
      x: 400,
      y: 200,
    }),
  )
  const canvas = new URL(page.url()).hash.split('/').at(-1)!
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let accepted = false
  await page.route(`**/nodes/${id}/run`, async (route) => {
    const response = await route.fetch()
    accepted = response.status() === 202
    await gate
    await route.fulfill({ response })
  })
  try {
    await clickElement(page, id)
    const generator = page.getByTestId('generator')
    await generator.getByRole('button', { name: '生成', exact: true }).click()
    await expect.poll(() => accepted).toBe(true)
    const cancel = generator.getByRole('button', { name: '取消', exact: true })
    await expect(cancel).toBeEnabled()
    await expect(cancel).toHaveAttribute('aria-busy', 'false')
    await expect(generator.getByText('正在提交生成请求…', { exact: true })).toHaveCount(0)
    await cancel.click()
    await expect
      .poll(() => page.evaluate((id) => window.__plein.engine.doc.get(id)?.run?.status, id))
      .toBe('canceled')
    release()
    await expect(generator.getByRole('button', { name: '生成', exact: true })).toBeEnabled()
    expect(
      await page.evaluate((id) => window.__plein.engine.doc.get(id)?.results?.length ?? 0, id),
    ).toBe(0)
  } finally {
    release()
    await page.request.post(`/api/canvases/${canvas}/nodes/${id}/cancel`)
    await page.request.put(config, { data: { settings: original.settings } })
  }
})

for (const mode of ['composition', 'legacy229'] as const) {
  for (const key of ['Enter', 'Escape']) {
    test(`角色名称 ${mode} 的 ${key} 不提交或清除草稿，正式改名后引用随撤销重做恢复`, async ({
      page,
    }) => {
      await newProject(page)
      const ids = await page.evaluate(() => ({
        role: window.__plein.addNode({
          type: 'plein/character',
          name: '组字角色',
          params: {},
          x: 400,
          y: 200,
        }),
        text: window.__plein.addNode({
          type: 'plein/text',
          name: '名称引用正文',
          params: { text: '@组字角色 拿起水杯' },
          x: 900,
          y: 200,
        }),
      }))
      await clickElement(page, ids.role)
      const generator = page.getByTestId('generator')
      const name = generator.getByRole('textbox', { name: '节点名称', exact: true })
      await name.fill('角色新名')
      await name.evaluate(
        (el, { key, mode }) =>
          el.dispatchEvent(
            new KeyboardEvent('keydown', {
              key,
              code: key,
              bubbles: true,
              cancelable: true,
              isComposing: mode === 'composition',
              keyCode: mode === 'legacy229' ? 229 : key === 'Enter' ? 13 : 27,
            }),
          ),
        { key, mode },
      )
      await expect(name).toBeFocused()
      await expect(name).toHaveValue('角色新名')
      expect(await page.evaluate((id) => window.__plein.engine.doc.get(id)?.name, ids.role)).toBe(
        '组字角色',
      )
      await name.press('Enter')
      await expect
        .poll(() => page.evaluate((id) => window.__plein.engine.doc.get(id)?.name, ids.role))
        .toBe('角色新名')
      await clickElement(page, ids.text)
      const mark = generator.getByTestId('mention-highlights').locator('mark')
      await expect(mark).toHaveAttribute('data-state', 'missing')
      await page.getByRole('button', { name: '撤销', exact: true }).click()
      await expect(mark).toHaveAttribute('data-state', 'resolved')
      await page.getByRole('button', { name: '重做', exact: true }).click()
      await expect(mark).toHaveAttribute('data-state', 'missing')
    })
  }
}
