import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { clickElement, newProject, revealGenerator, waitEngine, waitNode } from './canvas'

test(
  '首次生成期间修改输入，结果只进候选，查看采用及撤销刷新不隐式生效',
  { tag: '@core' },
  async ({ page, context }) => {
    await newProject(page)
    const config = '/api/providers/plein/mock/config'
    const original = await (await page.request.get(config)).json()
    const id = await page.evaluate(() =>
      window.__plein.addNode({
        type: 'plein/image',
        name: '首次待采用候选',
        params: { prompt: '透明水杯', model: 'plein/mock:image' },
        x: 400,
        y: 200,
      }),
    )
    try {
      expect(
        (
          await page.request.put(config, {
            data: { settings: { ...original.settings, latencyMs: 3000 } },
          })
        ).ok(),
      ).toBe(true)
      await clickElement(page, id)
      // 编辑器固定在卡片下方，先把它移进窗口再点生成
      await revealGenerator(page)
      const generator = page.getByTestId('generator')
      await generator.getByRole('button', { name: '生成', exact: true }).click()
      await expect(generator.getByRole('button', { name: '取消', exact: true })).toBeEnabled()
      await generator.getByRole('textbox', { name: '提示词', exact: true }).fill('改为陶瓷水杯')
      await waitNode(page, id)
      const adopted = () => page.evaluate((id) => window.__plein.engine.doc.get(id)?.adopted, id)
      await expect.poll(adopted).toBeNull()
      await expect(page.locator('.plein-node-status')).toHaveText('待采用')
      await expect(
        page.locator('.plein-node').getByText('1 个候选待采用，当前没有生效的结果'),
      ).toBeVisible()
      await page
        .locator('.plein-node')
        .screenshot({ path: test.info().outputPath('held-first-candidate.png') })
      const open = () => page.getByRole('button', { name: '查看待采用候选', exact: true }).click()
      await open()
      const viewer = page.getByRole('dialog', { name: '查看「首次待采用候选」', exact: true })
      await viewer.getByRole('button', { name: '采用此候选', exact: true }).click()
      const chosen = await adopted()
      expect(typeof chosen).toBe('string')
      await viewer.getByRole('button', { name: '关闭', exact: true }).click()
      await page.getByRole('button', { name: '撤销', exact: true }).click()
      await expect.poll(adopted).toBeNull()
      await page.reload()
      await waitEngine(page)
      await expect.poll(adopted).toBeNull()
      await open()
      await expect(viewer.getByRole('button', { name: '采用此候选', exact: true })).toBeEnabled()
      await viewer.getByRole('button', { name: '采用此候选', exact: true }).click()
      await expect.poll(adopted).toBe(chosen)
      await viewer.getByRole('button', { name: '关闭', exact: true }).click()
      await page.getByRole('button', { name: '撤销', exact: true }).click()
      await expect.poll(adopted).toBeNull()

      // 真实剪贴板跨画布保留待采用状态；连线不能让下游隐式使用候选。
      await context.grantPermissions(['clipboard-read', 'clipboard-write'])
      await page.evaluate((id) => window.__plein.engine.selection.set([id]), id)
      await page.keyboard.press('ControlOrMeta+c')
      await newProject(page)
      await page.keyboard.press('ControlOrMeta+v')
      const copied = () =>
        page.evaluate(() =>
          [...window.__plein.engine.doc.elements()].find((el) => el.name === '首次待采用候选'),
        )
      await expect.poll(async () => (await copied())?.adopted).toBeNull()
      const source = (await copied())!
      expect(source.results?.[0]?.id).toBe(chosen)
      await expect(page.locator('.plein-node-status')).toHaveText('待采用')
      const downstream = await page.evaluate((source) => {
        const id = window.__plein.addNode({
          type: 'plein/image',
          name: '下游图片',
          params: { model: 'plein/mock:image', prompt: '保持参考素材' },
          x: 1000,
          y: 200,
        })
        window.__plein.connect([source, 'images'], [id, 'references'])
        window.__plein.engine.zoomToFit()
        return id
      }, source.id)
      await clickElement(page, downstream)
      // 编辑器固定在卡片下方，先把它移进窗口再操作里面的控件
      await revealGenerator(page)
      const preview = page.getByTestId('input-preview')
      await preview.getByRole('button', { name: /实际输入/ }).click()
      await expect(generator).toContainText('有候选待采用，请先查看并采用结果')
      await expect(generator.getByRole('button', { name: '生成', exact: true })).toBeDisabled()
      await generator.screenshot({ path: test.info().outputPath('held-upstream-input.png') })
      await generator
        .getByRole('button', { name: '「首次待采用候选」有候选待采用，点击定位来源', exact: true })
        .click()
      await page.getByRole('button', { name: '查看待采用候选', exact: true }).click()
      await viewer.getByRole('button', { name: '采用此候选', exact: true }).click()
      await viewer.getByRole('button', { name: '关闭', exact: true }).click()
      await page.evaluate(() => window.__plein.engine.zoomToFit())
      await clickElement(page, downstream)
      await expect(generator).not.toContainText('有候选待采用')
      await expect(generator.getByRole('button', { name: '生成', exact: true })).toBeEnabled()
      const canvas = /#\/c\/([^/?]+)/.exec(page.url())![1]
      const input = await (
        await page.request.get(`/api/canvases/${canvas}/nodes/${downstream}/input`)
      ).json()
      expect(input.inputs.references).toMatchObject([
        { type: 'image', assetId: source.results![0]!.value.assetId, source: source.id },
      ])
    } finally {
      await page.request.put(config, { data: { settings: original.settings } })
    }
  },
)

for (const kind of ['image', 'video', 'speech'] as const) {
  test(`${kind} 连续生成候选后，卡片浏览、采用、撤销重做与刷新保持一致`, async ({ page }) => {
    await newProject(page)
    const id = await page.evaluate(
      (kind) =>
        window.__plein.addNode({
          type: `plein/${kind}`,
          name: '候选生命周期',
          params: {
            prompt: '雨后透明水杯',
            text: '雨后，拿起透明水杯。',
            model: `plein/mock:${kind === 'speech' ? 'audio' : kind}`,
          },
          x: 400,
          y: 300,
        }),
      kind,
    )
    await clickElement(page, id)
    // 编辑器固定在卡片下方，先把它移进窗口再点生成
    await revealGenerator(page)
    const generator = page.getByTestId('generator')
    await generator.getByRole('button', { name: '生成', exact: true }).click()
    await waitNode(page, id)
    await generator.getByRole('button', { name: '重新生成', exact: true }).click()
    await expect
      .poll(() => page.evaluate((id) => window.__plein.engine.doc.get(id)?.results?.length, id))
      .toBe(2)
    const adopted = () =>
      page.evaluate((id) => window.__plein.engine.doc.mutable(id)?.get('adopted') as string, id)
    const original = await adopted()
    await page
      .locator('.plein-node')
      .getByRole('button', { name: '下一个结果', exact: true })
      .click()
    const viewer = page.getByRole('dialog', { name: '查看「候选生命周期」', exact: true })
    const adopt = viewer.getByRole('button', { name: '采用此候选', exact: true })
    await expect(adopt).toBeEnabled()
    expect(await adopted()).toBe(original)
    await adopt.click()
    const chosen = await adopted()
    expect(chosen).not.toBe(original)
    if (kind === 'image') {
      const image = viewer.getByRole('img', { name: '候选生命周期', exact: true })
      await expect(image).toBeVisible()
      await expect
        .poll(() => image.evaluate((el) => (el as HTMLImageElement).naturalWidth))
        .toBeGreaterThan(0)
    } else {
      const video = viewer.locator(kind === 'video' ? 'video' : 'audio')
      await expect(video).toBeVisible()
      await expect
        .poll(() => video.evaluate((el) => (el as HTMLMediaElement).readyState))
        .toBeGreaterThanOrEqual(2)
    }
    await viewer.screenshot({
      path: test.info().outputPath('candidate-preview.png'),
      animations: 'disabled',
    })
    const playing =
      kind === 'image'
        ? null
        : await viewer.locator(kind === 'video' ? 'video' : 'audio').elementHandle()
    if (playing) {
      await playing.evaluate(async (el) => {
        const media = el as HTMLMediaElement
        media.loop = true
        await media.play()
      })
      expect(await playing.evaluate((el) => (el as HTMLMediaElement).paused)).toBe(false)
    }
    await viewer.getByRole('button', { name: '关闭', exact: true }).click()
    if (playing) {
      await expect.poll(() => playing.evaluate((el) => (el as HTMLMediaElement).paused)).toBe(true)
      await expect.poll(() => playing.evaluate((el) => el.getAttribute('src'))).toBeNull()
    }
    await page.getByRole('button', { name: '撤销', exact: true }).click()
    await expect.poll(adopted).toBe(original)
    await page.getByRole('button', { name: '重做', exact: true }).click()
    await expect.poll(adopted).toBe(chosen)
    const expectedCount = await page.evaluate((id) => {
      const el = window.__plein.engine.doc.get(id)!
      return `${el.results!.findIndex((result) => result.id === (window.__plein.engine.doc.mutable(id)?.get('adopted') as string)) + 1}/2`
    }, id)
    await expect(page.locator('.plein-node-count')).toHaveText(expectedCount)
    await page.reload()
    await waitEngine(page)
    await expect.poll(adopted).toBe(chosen)
    await clickElement(page, id)
    if (kind === 'speech') {
      const assetId = await page.evaluate(
        ({ id, chosen }) =>
          window.__plein.engine.doc.get(id)!.results!.find((result) => result.id === chosen)!.value
            .assetId,
        { id, chosen },
      )
      const downloaded = page.waitForEvent('download')
      await generator.getByRole('button', { name: '下载', exact: true }).click()
      const file = await downloaded
      expect(await file.failure()).toBeNull()
      const originalFile = await page.request.get(`/api/assets/${assetId}`)
      expect(originalFile.ok()).toBe(true)
      expect(readFileSync((await file.path())!)).toEqual(await originalFile.body())
      await generator.screenshot({
        path: test.info().outputPath('audio-result-actions.png'),
        animations: 'disabled',
      })
    }
    await generator.getByRole('button', { name: '全屏查看', exact: true }).click()
    await expect(viewer.getByRole('button', { name: '已采用', exact: true })).toBeDisabled()
    expect(
      await page.evaluate((id) => window.__plein.engine.doc.get(id)?.results?.length, id),
    ).toBe(2)
  })
}

test('LLM 长文本候选在窄屏完整换行，明确采用后可从生成器重新查看', async ({ page }) => {
  await newProject(page)
  const token = 'SceneDescription'.repeat(40)
  const id = await page.evaluate(
    (token) =>
      window.__plein.addNode({
        type: 'plein/llm',
        name: '文本候选预览',
        params: { model: 'plein/mock:chat', prompt: `雨后镜头\n${token}\n保留结尾。` },
        x: 400,
        y: 300,
      }),
    token,
  )
  await clickElement(page, id)
  // 编辑器固定在卡片下方，先把它移进窗口再点生成
  await revealGenerator(page)
  const generator = page.getByTestId('generator')
  await generator.getByRole('button', { name: '生成', exact: true }).click()
  await waitNode(page, id)
  await generator.getByRole('button', { name: '重新生成', exact: true }).click()
  await expect
    .poll(() => page.evaluate((id) => window.__plein.engine.doc.get(id)?.results?.length, id))
    .toBe(2)
  await page.locator('.plein-node').getByRole('button', { name: '下一个结果', exact: true }).click()
  const viewer = page.getByRole('dialog', { name: '查看「文本候选预览」', exact: true })
  await page.setViewportSize({ width: 320, height: 700 })
  const text = viewer.getByRole('textbox', { name: '候选正文', exact: true })
  await expect(text).toContainText(token)
  await expect(text).toContainText('保留结尾。')
  const layout = await text.evaluate((el) => ({ width: el.clientWidth, content: el.scrollWidth }))
  expect(layout.content).toBeLessThanOrEqual(layout.width)
  const beforeReading = await page.evaluate(
    (id) => window.__plein.engine.doc.mutable(id)?.get('adopted'),
    id,
  )
  await text.focus()
  await expect(text).toBeFocused()
  await text.press('PageDown')
  await expect.poll(() => text.evaluate((el) => el.scrollTop)).toBeGreaterThan(0)
  await text.press('ControlOrMeta+a')
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(
    await text.textContent(),
  )
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await text.press('ControlOrMeta+c')
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(await text.textContent())
  await text.press('ArrowRight')
  await text.press('Enter')
  expect(
    await page.evaluate((id) => window.__plein.engine.doc.mutable(id)?.get('adopted'), id),
  ).toBe(beforeReading)
  await expect(viewer.getByRole('button', { name: '采用此候选', exact: true })).toBeEnabled()
  await viewer.getByRole('button', { name: '采用此候选', exact: true }).click()
  await viewer.screenshot({
    path: test.info().outputPath('llm-preview-320.png'),
    animations: 'disabled',
  })
  await viewer.getByRole('button', { name: '关闭', exact: true }).click()
  // 编辑器固定 840px 宽，窄窗口里点不到右边的操作；先回到宽窗口再从生成器重新查看
  await page.setViewportSize({ width: 1440, height: 900 })
  await revealGenerator(page)
  await generator.getByRole('button', { name: '全屏查看', exact: true }).click()
  await expect(viewer.getByRole('button', { name: '已采用', exact: true })).toBeDisabled()
  await expect(text).toContainText(token)
})
