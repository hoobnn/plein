import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { expect, test, type Page } from './fixtures'
import { addNode, centerOf, elements, newProject, waitEngine, waitNode, zoomTo } from './canvas'

const dialog = (page: Page) => page.getByRole('dialog', { name: '动态合成', exact: true })
async function openMotion(page: Page) {
  await newProject(page)
  await addNode(page, '动态合成')
  await expect
    .poll(async () => (await elements(page)).filter((el) => el.nodeType === 'plein/motion').length)
    .toBe(1)
  const node = (await elements(page)).find((el) => el.nodeType === 'plein/motion')!
  await page.keyboard.press('Escape')
  await zoomTo(page, [node.id])
  const at = await centerOf(page, node.id)
  await page.mouse.dblclick(at.x, at.y)
  await expect(dialog(page)).toBeVisible()
  return node.id
}
const overrides = (page: Page, id: string) =>
  page.evaluate((nodeId) => window.__plein.engine.doc.get(nodeId)?.params?.overrides ?? {}, id)
async function edit(page: Page, label: string, value: string) {
  await dialog(page).getByRole('textbox', { name: label, exact: true }).fill(value)
  await dialog(page).getByRole('textbox', { name: label, exact: true }).press('Tab')
}

test(
  '动态合成：真实 SDK 编辑、隔离预览播放寻址、修改重载与唯一撤销',
  { tag: '@core' },
  async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    const id = await openMotion(page)
    const panel = dialog(page)
    await expect(panel.locator('.motion-preview')).toHaveAttribute('data-state', 'ready')
    const firstUrl = await panel.locator('iframe').getAttribute('src')
    expect(new URL(firstUrl!).origin).not.toBe(new URL(page.url()).origin)
    expect(new URL(firstUrl!).hostname).toBe('localhost')
    await panel.getByRole('button', { name: '播放预览', exact: true }).click()
    await expect(panel.getByRole('button', { name: '暂停预览', exact: true })).toBeVisible()
    await expect.poll(() => panel.locator('.motion-preview-notice').count()).toBe(0)
    await panel.getByRole('button', { name: '暂停预览', exact: true }).click()
    const seek = panel.getByRole('slider', { name: '预览时间' })
    await seek.focus()
    await seek.press('End')
    await expect(panel.getByLabel('当前预览时间')).toContainText(/0:0[56]\./)
    await edit(page, '标题文案', '在 Plein 中继续创作')
    await expect
      .poll(() => overrides(page, id))
      .toMatchObject({ 'hf-title.text': '在 Plein 中继续创作' })
    await expect.poll(() => panel.locator('iframe').getAttribute('src')).not.toBe(firstUrl)
    await expect(panel.locator('.motion-preview')).toHaveAttribute('data-state', 'ready')
    await expect(panel.getByLabel('当前预览时间')).toContainText(/0:0[56]\./)
    await edit(page, '水平位置', '16%')
    await expect.poll(() => overrides(page, id)).toMatchObject({ 'hf-title.style.left': '16%' })
    await panel.getByRole('button', { name: '撤销动态合成编辑', exact: true }).click()
    await expect.poll(() => overrides(page, id)).toEqual({ 'hf-title.text': '在 Plein 中继续创作' })
    await panel.getByRole('button', { name: '重做动态合成编辑', exact: true }).click()
    await expect.poll(() => overrides(page, id)).toMatchObject({ 'hf-title.style.left': '16%' })
    expect((await elements(page)).find((el) => el.id === id)?.results).toBe(0)
    await expect(panel.locator('.motion-preview')).toHaveAttribute('data-state', 'ready')
    const bar = await panel.getByRole('slider', { name: '预览时间' }).boundingBox()
    await page.mouse.click(bar!.x + bar!.width * 0.4, bar!.y + bar!.height / 2)
    await expect(panel.getByLabel('当前预览时间')).toContainText('0:02.')
    await panel.screenshot({
      path: test.info().outputPath('motion-editor.png'),
      animations: 'disabled',
    })
    expect(errors).toEqual([])
  },
)

test('动态合成：关闭释放预览，迟到会话不挂载，卡片入口可重开', async ({ page, request }) => {
  const id = await openMotion(page)
  await expect(dialog(page).locator('.motion-preview')).toHaveAttribute('data-state', 'ready')
  const url = (await dialog(page).locator('iframe').getAttribute('src'))!
  await dialog(page).getByRole('button', { name: '关闭', exact: true }).click()
  await expect(dialog(page)).toHaveCount(0)
  await expect.poll(async () => (await request.get(url)).status()).toBe(404)
  await zoomTo(page, [id])
  await page
    .locator('.plein-node-head')
    .getByRole('button', { name: '编辑动态合成', exact: true })
    .click()
  await expect(dialog(page)).toBeVisible()
  await expect(dialog(page).locator('.motion-preview')).toHaveAttribute('data-state', 'ready')
  let release: (() => void) | undefined
  let lateUrl = ''
  await page.route('**/api/motion/preview', async (route) => {
    if (route.request().method() !== 'POST') return route.continue()
    const response = await route.fetch()
    lateUrl = ((await response.json()) as { url: string }).url
    await new Promise<void>((resolve) => {
      release = resolve
    })
    await route.fulfill({ response })
  })
  await edit(page, '标题文案', '迟到预览必须释放')
  await expect.poll(() => !!release).toBe(true)
  await dialog(page).getByRole('button', { name: '关闭', exact: true }).click()
  release!()
  await expect(dialog(page)).toHaveCount(0)
  await expect.poll(async () => (await request.get(lateUrl)).status()).toBe(404)
  await page.unroute('**/api/motion/preview')
})

test('动态合成：只读保留播放，禁用编辑、渲染和采用写入', async ({ page }) => {
  const id = await openMotion(page)
  await expect(dialog(page).locator('.motion-preview')).toHaveAttribute('data-state', 'ready')
  await dialog(page).getByRole('button', { name: '关闭', exact: true }).click()
  await expect(dialog(page)).toHaveCount(0)
  const before = await overrides(page, id)
  await page.evaluate(() => {
    ;(
      window.__plein.engine.doc as typeof window.__plein.engine.doc & { readOnly: boolean }
    ).readOnly = true
  })
  await zoomTo(page, [id])
  const at = await centerOf(page, id)
  await page.mouse.dblclick(at.x, at.y)
  await expect(dialog(page)).toContainText('当前画布为只读')
  await expect(dialog(page).getByRole('textbox', { name: '标题文案', exact: true })).toBeDisabled()
  await expect(dialog(page).getByRole('button', { name: '渲染为候选' })).toBeDisabled()
  await expect(dialog(page).locator('.motion-preview')).toHaveAttribute('data-state', 'ready')
  await expect(dialog(page).getByRole('button', { name: '播放预览' })).toBeEnabled()
  expect(await overrides(page, id)).toEqual(before)
  await page.evaluate((nodeId) => {
    const doc = window.__plein.engine.doc as typeof window.__plein.engine.doc & {
      readOnly: boolean
    }
    doc.readOnly = false
    ;(doc.mutable(nodeId)! as unknown as { set(key: string, value: unknown): void }).set(
      'name',
      '恢复可写检查',
    )
  }, id)
  const title = dialog(page).getByRole('textbox', { name: '标题文案', exact: true })
  await expect(title).toBeEnabled()
  const savedTitle = await title.inputValue()
  await title.fill('不应在恢复可写后复活的草稿')
  await page.evaluate((nodeId) => {
    const doc = window.__plein.engine.doc as typeof window.__plein.engine.doc & {
      readOnly: boolean
    }
    doc.readOnly = true
    ;(doc.mutable(nodeId)! as unknown as { set(key: string, value: unknown): void }).set(
      'name',
      '只读草稿检查',
    )
  }, id)
  await expect(title).toBeDisabled()
  await expect(title).toHaveValue(savedTitle)
  expect(await overrides(page, id)).toEqual(before)
  await page.evaluate(() => {
    ;(
      window.__plein.engine.doc as typeof window.__plein.engine.doc & { readOnly: boolean }
    ).readOnly = false
  })
})

test('动态合成：真实渲染候选、显式采用、旧源独立继续编辑与一次撤销', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (cause) => errors.push(cause.message))
  const id = await openMotion(page)
  const panel = dialog(page)
  await panel.getByRole('spinbutton', { name: '片段时长（秒）' }).fill('1')
  await panel.getByRole('spinbutton', { name: '片段时长（秒）' }).press('Tab')
  await panel.getByRole('combobox', { name: '分辨率', exact: true }).click()
  await page.getByRole('option', { name: '720p', exact: true }).click()
  await edit(page, '标题文案', '源版本一')
  await expect.poll(() => overrides(page, id)).toMatchObject({ 'hf-title.text': '源版本一' })
  await panel.getByRole('button', { name: '渲染为候选', exact: true }).click()
  await expect
    .poll(async () => (await elements(page)).find((el) => el.id === id)?.status, {
      timeout: 120_000,
    })
    .toBe('succeeded')
  await expect(panel.locator('.motion-candidate')).toHaveCount(1)
  const candidate = await page.evaluate((nodeId) => {
    const el = window.__plein.engine.doc.get(nodeId)!
    return { adopted: el.adopted, result: el.results![0]! }
  }, id)
  expect(candidate.adopted).toBeNull()
  expect(candidate.result.value).toHaveProperty('compositionSource')
  const bundle = panel.getByRole('link', { name: '下载源工程', exact: true })
  const bundleResponse = await page.request.get((await bundle.getAttribute('href'))!)
  expect(bundleResponse.status()).toBe(200)
  expect((await bundleResponse.body()).subarray(0, 2).toString()).toBe('PK')
  await panel.getByRole('button', { name: '采用', exact: true }).click()
  await expect
    .poll(() => page.evaluate((nodeId) => window.__plein.engine.doc.get(nodeId)?.adopted, id))
    .toBe(candidate.result.id)
  await edit(page, '标题文案', '当前正在修改的第二版')
  await expect
    .poll(() => overrides(page, id))
    .toMatchObject({ 'hf-title.text': '当前正在修改的第二版' })
  await panel.getByRole('button', { name: '查看源版本', exact: true }).click()
  await expect(panel).toContainText('正在查看候选源版本')
  await expect(panel.getByRole('textbox', { name: '标题文案', exact: true })).toHaveValue(
    '源版本一',
  )
  await expect(panel.getByRole('textbox', { name: '标题文案', exact: true })).toBeDisabled()
  await expect(panel.locator('.motion-preview')).toHaveAttribute('data-state', 'ready')
  const before = await page.evaluate(
    (nodeId) => JSON.stringify(window.__plein.engine.doc.get(nodeId)),
    id,
  )
  await panel.getByRole('button', { name: '从此版继续编辑', exact: true }).click()
  await expect
    .poll(async () => (await elements(page)).filter((el) => el.nodeType === 'plein/motion').length)
    .toBe(2)
  const restored = (await elements(page)).find(
    (el) => el.nodeType === 'plein/motion' && el.id !== id,
  )!
  await expect
    .poll(() => overrides(page, restored.id))
    .toMatchObject({ 'hf-title.text': '源版本一' })
  expect(
    await page.evaluate((nodeId) => JSON.stringify(window.__plein.engine.doc.get(nodeId)), id),
  ).toBe(before)
  await panel.getByRole('button', { name: '撤销动态合成编辑', exact: true }).click()
  await expect(dialog(page)).toHaveCount(0)
  await expect
    .poll(async () => (await elements(page)).filter((el) => el.nodeType === 'plein/motion').length)
    .toBe(1)
  expect(
    await page.evaluate((nodeId) => JSON.stringify(window.__plein.engine.doc.get(nodeId)), id),
  ).toBe(before)
  // 复用刚采用的真实HF候选，只渲染下游序列一次，避免再次生成动态合成。
  const sequenceId = await page.evaluate((motion) => {
    const sequence = window.__plein.addNode({
      type: 'plein/sequence',
      name: '动态合成成片',
      params: { subtitles: false, aspectRatio: '9:16', resolution: '720p' },
      x: 1400,
      y: 200,
    })
    if (!window.__plein.connect([motion, 'video'], [sequence, 'clips']))
      throw new Error('动态合成连入序列失败')
    return sequence
  }, id)
  await zoomTo(page, [sequenceId])
  const sequenceAt = await centerOf(page, sequenceId)
  await page.mouse.dblclick(sequenceAt.x, sequenceAt.y)
  const sequencePanel = page.getByRole('dialog', { name: '序列', exact: true })
  await sequencePanel.getByRole('button', { name: '导出 MP4', exact: true }).click()
  await waitNode(page, sequenceId)
  const output = await page.evaluate((nodeId) => {
    const node = window.__plein.engine.doc.get(nodeId)!
    const selected = node.results?.find((result) => result.id === node.adopted)
    return { status: node.run?.status, value: selected?.value }
  }, sequenceId)
  expect(output.status).toBe('succeeded')
  expect(output.value?.type).toBe('video')
  const rendered = await page.request.get(`/api/assets/${output.value!.assetId}`)
  expect(rendered.status()).toBe(200)
  const filmPath = test.info().outputPath('motion-through-sequence.mp4')
  writeFileSync(filmPath, await rendered.body())
  const probe = JSON.parse(
    execFileSync(
      process.env.PLEIN_FFPROBE_PATH ?? 'ffprobe',
      ['-v', 'error', '-count_frames', '-show_streams', '-show_format', '-of', 'json', filmPath],
      { encoding: 'utf8' },
    ),
  ) as {
    streams: {
      codec_type: string
      codec_name: string
      width?: number
      height?: number
      nb_read_frames?: string
    }[]
    format: { duration: string }
  }
  expect(probe.streams.find((stream) => stream.codec_type === 'video')).toMatchObject({
    codec_name: 'h264',
    width: 720,
    height: 1280,
    nb_read_frames: '30',
  })
  expect(Number(probe.format.duration)).toBeCloseTo(1, 1)
  expect(
    await page.evaluate((nodeId) => window.__plein.engine.doc.get(nodeId)?.results?.length, id),
  ).toBe(1)
  await test.info().attach('motion-through-sequence-ffprobe', {
    body: JSON.stringify(probe, null, 2),
    contentType: 'application/json',
  })
  expect(errors).toEqual([])
})

test('动态合成：上游图片采用变更重建预览，不创建渲染候选', async ({ page }) => {
  const { solidPng } = await import('../packages/providers/src/mock/media')
  const id = await openMotion(page)
  const assetIds: string[] = []
  for (const color of [
    [210, 80, 50],
    [50, 130, 210],
  ]) {
    const response = await page.request.post('/api/assets', {
      headers: { 'content-type': 'image/png' },
      data: Buffer.from(solidPng(200, 300, color as [number, number, number])),
    })
    expect(response.status()).toBe(201)
    assetIds.push(((await response.json()) as { id: string }).id)
  }
  const upstream = await page.evaluate(
    ({ id, assetId }) => {
      const image = window.__plein.addNode({
        type: 'plein/image',
        name: '动态图输入',
        params: {},
        x: 0,
        y: 0,
      })
      const node = window.__plein.engine.doc.mutable(image)! as unknown as {
        set(key: string, value: unknown): void
      }
      node.set('results', [
        {
          id: 'input-one',
          runId: 'existing-one',
          port: 'images',
          at: 1,
          value: { type: 'image', assetId },
        },
      ])
      node.set('adopted', 'input-one')
      window.__plein.connect([image, 'images'], [id, 'image'])
      return image
    },
    { id, assetId: assetIds[0] },
  )
  await dialog(page).getByRole('combobox', { name: '模板', exact: true }).click()
  await page.getByRole('option', { name: '角色介绍', exact: true }).click()
  await expect(dialog(page)).toContainText(`已连接图片 ${assetIds[0]!.slice(0, 12)}`)
  await expect(dialog(page).locator('.motion-preview')).toHaveAttribute('data-state', 'ready')
  const before = await dialog(page).locator('iframe').getAttribute('src')
  const request = page.waitForRequest(
    (request) =>
      request.url().endsWith('/api/motion/preview') &&
      request.postDataJSON()?.inputs?.image === assetIds[1],
  )
  await page.evaluate(
    ({ image, assetId }) => {
      const node = window.__plein.engine.doc.mutable(image)! as unknown as {
        set(key: string, value: unknown): void
      }
      node.set('results', [
        {
          id: 'input-two',
          runId: 'existing-two',
          port: 'images',
          at: 2,
          value: { type: 'image', assetId },
        },
      ])
      node.set('adopted', 'input-two')
    },
    { image: upstream, assetId: assetIds[1] },
  )
  await request
  await expect(dialog(page)).toContainText(`已连接图片 ${assetIds[1]!.slice(0, 12)}`)
  await expect(dialog(page).locator('.motion-preview')).toHaveAttribute('data-state', 'ready')
  expect(await dialog(page).locator('iframe').getAttribute('src')).not.toBe(before)
  expect((await elements(page)).find((el) => el.id === id)?.results).toBe(0)
})

test('动态合成：localhost 主界面使用不同 hostname 预览，Cookie 域不共享', async ({ page }) => {
  const id = await openMotion(page)
  await dialog(page).getByRole('button', { name: '关闭', exact: true }).click()
  await expect(dialog(page)).toHaveCount(0)
  await page.goto(page.url().replace('127.0.0.1', 'localhost'))
  await waitEngine(page)
  await expect.poll(async () => (await elements(page)).some((el) => el.id === id)).toBe(true)
  await zoomTo(page, [id])
  const at = await centerOf(page, id)
  await page.mouse.dblclick(at.x, at.y)
  await expect(dialog(page).locator('.motion-preview')).toHaveAttribute('data-state', 'ready')
  const preview = new URL((await dialog(page).locator('iframe').getAttribute('src'))!)
  expect(preview.hostname).toBe('127.0.0.1')
  expect(preview.hostname).not.toBe(new URL(page.url()).hostname)
})
