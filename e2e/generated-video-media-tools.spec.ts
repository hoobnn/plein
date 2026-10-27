import { execFileSync } from 'node:child_process'
import type { PleinDoc } from '../packages/doc/src/doc'
import { expect, type Page, test } from './fixtures'
import { addNode, clickElement, elements, newProject, revealGenerator, waitNode } from './canvas'

async function fixture(page: Page) {
  await newProject(page)
  await addNode(page, '生成视频')
  const generator = page.getByTestId('generator')
  await expect(generator.getByRole('button', { name: '媒体工具', exact: true })).toHaveCount(0)
  // 编辑器固定在卡片下方，先把它移进窗口再点里面的控件
  await revealGenerator(page)
  await generator.locator('textarea').first().fill('用于裁剪验收的视频')
  await generator.getByRole('button', { name: '生成', exact: true }).click()
  const node = (await elements(page)).find((e) => e.kind === 'node')!
  await waitNode(page, node.id)
  const original = await page.evaluate(
    (id) => (window.__plein.engine.doc as unknown as PleinDoc).get(id)!,
    node.id,
  )
  const first = original.results!.find((r) => r.id === original.adopted)!
  const clip = execFileSync('ffmpeg', [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=s=160x90:r=10:d=1',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    'frag_keyframe+empty_moov',
    '-f',
    'mp4',
    'pipe:1',
  ])
  const upload = await page.request.post('/api/assets', {
    headers: { 'Content-Type': 'video/mp4' },
    data: clip,
  })
  expect(upload.status()).toBe(201)
  const { id: assetId } = await upload.json()
  await page.evaluate(
    ({ id, first, assetId }) => {
      const doc = window.__plein.engine.doc as unknown as PleinDoc
      doc.ydoc.transact(() => {
        const m = doc.mutable(id)!
        m.set('results', [
          first,
          { ...first, id: 'candidate-two', value: { type: 'video', assetId, mime: 'video/mp4' } },
        ])
        m.set('adopted', 'candidate-two')
      })
      doc.undo.clear()
    },
    { id: node.id, first, assetId },
  )
  const source = () =>
    page.evaluate((id) => (window.__plein.engine.doc as unknown as PleinDoc).get(id)!, node.id)
  const outputs = () =>
    page.evaluate(() =>
      [...(window.__plein.engine.doc as unknown as PleinDoc).elements()].filter(
        (e) => e.kind === 'video',
      ),
    )
  return { id: node.id, assetId: assetId as string, first, generator, source, outputs }
}

async function open(page: Page) {
  await page.getByTestId('generator').getByRole('button', { name: '媒体工具', exact: true }).click()
  const tools = page.getByRole('dialog', { name: '媒体工具', exact: true })
  await tools.getByRole('button', { name: '裁剪', exact: true }).click()
  return tools
}

test('已采用生成视频从生成器进入裁剪，精确绑定第二候选且不改原节点，可单步撤销', async ({
  page,
}) => {
  const f = await fixture(page)
  const before = await f.source()
  const tools = await open(page)
  await expect(tools).toContainText('视频 160 × 90 像素')
  await tools.getByLabel('左', { exact: true }).fill('11')
  await tools.getByLabel('上', { exact: true }).fill('7')
  await tools.getByLabel('宽', { exact: true }).fill('100')
  await tools.getByLabel('高', { exact: true }).fill('56')
  await page.screenshot({ path: test.info().outputPath('generated-video-crop.png') })
  const request = page.waitForRequest((r) => r.url().endsWith('/api/media/derive'))
  await tools.getByRole('button', { name: '开始加工', exact: true }).click()
  expect((await request).postDataJSON()).toEqual({
    op: 'crop',
    assetId: f.assetId,
    left: 11,
    top: 7,
    width: 100,
    height: 56,
  })
  await expect.poll(async () => (await f.outputs()).length).toBe(1)
  const result = (await f.outputs())[0]!
  expect(result.assetId).not.toBe(f.assetId)
  expect(await (await page.request.get(`/api/assets/${result.assetId}/meta`)).json()).toMatchObject(
    { kind: 'video', width: 100, height: 56 },
  )
  expect(await f.source()).toEqual(before)
  await page.getByRole('button', { name: '撤销', exact: true }).click()
  await expect.poll(async () => (await f.outputs()).length).toBe(0)
  expect(await f.source()).toEqual(before)
})

test('加工等待中切换采用结果，迟到产物不落画布，新入口清空旧表单并跟随新素材', async ({ page }) => {
  const f = await fixture(page)
  let release!: () => void
  let ready!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const captured = new Promise<void>((resolve) => {
    ready = resolve
  })
  await page.route('**/api/media/derive', async (route) => {
    const response = await route.fetch()
    ready()
    await gate
    await route.fulfill({ response })
  })
  try {
    const tools = await open(page)
    await tools.getByLabel('宽', { exact: true }).fill('100')
    await tools.getByLabel('高', { exact: true }).fill('56')
    await tools.getByRole('button', { name: '开始加工', exact: true }).click()
    await captured
    await page.evaluate(
      ({ id, adopted }) =>
        (window.__plein.engine.doc as unknown as PleinDoc).mutable(id)!.set('adopted', adopted),
      { id: f.id, adopted: f.first.id },
    )
    const before = await f.source()
    release()
    await expect(page.locator('.ui-toast')).toContainText('素材已变化')
    expect(await f.outputs()).toHaveLength(0)
    expect(await f.source()).toEqual(before)
    const next = await open(page)
    const assetId = f.first.value.type === 'video' ? f.first.value.assetId : ''
    const meta = await (await page.request.get(`/api/assets/${assetId}/meta`)).json()
    await expect(next).toContainText(`视频 ${meta.width} × ${meta.height} 像素`)
    await expect(next.getByLabel('宽', { exact: true })).toHaveValue(String(meta.width))
    await expect(next.getByLabel('高', { exact: true })).toHaveValue(String(meta.height))
  } finally {
    release()
  }
})

test('无采用结果时隐藏入口，锁定生成视频沿用唯一浮动媒体工具', async ({ page }) => {
  const f = await fixture(page)
  await page.evaluate(
    (id) => (window.__plein.engine.doc as unknown as PleinDoc).mutable(id)!.set('adopted', null),
    f.id,
  )
  await expect(f.generator.getByRole('button', { name: '媒体工具', exact: true })).toHaveCount(0)
  await page.evaluate((id) => {
    const m = (window.__plein.engine.doc as unknown as PleinDoc).mutable(id)!
    m.set('adopted', 'candidate-two')
    m.set('locked', true)
  }, f.id)
  await expect(f.generator).toHaveCount(0)
  await expect(page.getByRole('button', { name: '媒体工具', exact: true })).toHaveCount(1)
  await expect(
    page
      .getByRole('toolbar', { name: '结果操作', exact: true })
      .getByRole('button', { name: '媒体工具', exact: true }),
  ).toBeVisible()
  await page.evaluate(
    (id) => (window.__plein.engine.doc as unknown as PleinDoc).mutable(id)!.set('locked', false),
    f.id,
  )
  await clickElement(page, f.id)
  await expect(f.generator.getByRole('button', { name: '媒体工具', exact: true })).toBeVisible()
})
