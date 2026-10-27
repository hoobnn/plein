import { execFileSync } from 'node:child_process'
import { expect, test } from './fixtures'
import { centerOf, newProject, zoomTo } from './canvas'
import { slowFile } from './slow-file'

test('本地拉片入口、人工切点、历史预览、素材入画布、刷新与锁定只读', async ({ page }) => {
  await newProject(page)
  // File-only fixture: no player or audio device is started by this test.
  const bytes = execFileSync('ffmpeg', [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=green:s=96x64:r=1:d=2',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=2',
    '-c:v',
    'libx264',
    '-c:a',
    'aac',
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
    data: bytes,
  })
  expect(upload.status()).toBe(201)
  const assetId = (await upload.json()).id as string
  const source = await page.evaluate((assetId) => {
    const engine = window.__plein.engine as typeof window.__plein.engine & {
      paste(value: unknown): void
    }
    engine.paste({
      plein: 1,
      edges: [],
      elements: [
        {
          id: 'source',
          kind: 'video',
          name: '本地拉片原视频',
          assetId,
          x: 300,
          y: 200,
          w: 300,
          h: 200,
          parentId: null,
        },
      ],
    })
    return [...engine.doc.elements()][0]!.id
  }, assetId)
  await zoomTo(page, [source])
  const at = await centerOf(page, source)
  await page.mouse.click(at.x, at.y)
  await page
    .getByRole('toolbar', { name: '结果操作', exact: true })
    .getByRole('button', { name: '媒体工具', exact: true })
    .click()
  await page
    .getByRole('dialog', { name: '媒体工具', exact: true })
    .getByRole('button', { name: '本地拉片', exact: true })
    .click()
  const editor = page.getByRole('dialog', { name: '本地拉片', exact: true })
  await editor.getByRole('button', { name: '检测切点', exact: true }).click()
  await expect(editor.getByLabel('选择镜头 1', { exact: true })).toBeVisible()
  const nodeId = await page.evaluate(
    () =>
      [...window.__plein.engine.doc.elements()].find((el) => el.nodeType === 'plein/shot-analysis')!
        .id,
  )
  await editor.getByLabel('切点（秒数或时间码，逗号分隔；留空表示整段）').fill('0.01')
  await editor.getByLabel('提取视频片段', { exact: true }).check()
  await editor.getByRole('button', { name: '按这些切点处理', exact: true }).click()
  await expect(editor.getByRole('alert')).toContainText('1/30')
  await editor.getByLabel('切点（秒数或时间码，逗号分隔；留空表示整段）').fill('0.2, 0.4')
  await editor.getByLabel('提取原音轨', { exact: true }).check()
  await editor.getByRole('button', { name: '按这些切点处理', exact: true }).click()
  await expect(editor.getByLabel('选择镜头 3', { exact: true })).toBeVisible()
  await expect(editor.getByRole('button', { name: '放入原音轨', exact: true })).toBeVisible()
  await expect(editor.locator('video')).toHaveCount(3)
  expect(
    await editor
      .locator('video')
      .evaluateAll((nodes) =>
        nodes.every(
          (node) => (node as HTMLVideoElement).muted && (node as HTMLVideoElement).paused,
        ),
      ),
  ).toBe(true)
  await page.screenshot({ path: test.info().outputPath('shot-analysis-report.png') })
  await editor.getByRole('button', { name: '全选镜头', exact: true }).click()
  await editor.getByRole('button', { name: '放入关键帧', exact: true }).click()
  await editor.getByRole('button', { name: '放入视频片段', exact: true }).click()
  await editor.getByRole('button', { name: '放入原音轨', exact: true }).click()
  const placed = await page.evaluate((nodeId) => {
    const doc = window.__plein.engine.doc
    return {
      media: [...doc.elements()].filter((el) => el.params?.shotAnalysisOrigin).map((el) => el.kind),
      params: doc.get(nodeId)!.params,
      adopted: doc.get(nodeId)!.adopted,
    }
  }, nodeId)
  expect(placed.media.sort()).toEqual([
    'audio',
    'image',
    'image',
    'image',
    'video',
    'video',
    'video',
  ])
  expect(placed.params).not.toHaveProperty('manifest')
  expect(placed.params).not.toHaveProperty('scenes')
  await editor.getByRole('combobox', { name: '拉片清单版本', exact: true }).click()
  await page.getByRole('option', { name: /^清单 2 ·/ }).click()
  await expect(editor.getByLabel('选择镜头 2', { exact: true })).toHaveCount(0)
  expect(
    await page.evaluate((nodeId) => window.__plein.engine.doc.get(nodeId)!.adopted, nodeId),
  ).toBe(placed.adopted)
  await editor.getByRole('button', { name: '关闭', exact: true }).click()
  await page.reload()
  await expect
    .poll(() =>
      page.evaluate((nodeId) => window.__plein?.engine?.doc.get(nodeId)?.results?.length, nodeId),
    )
    .toBe(2)
  await zoomTo(page, [nodeId])
  const nodeAt = await centerOf(page, nodeId)
  await page.mouse.click(nodeAt.x, nodeAt.y)
  await page.getByRole('button', { name: '打开拉片清单', exact: true }).click()
  await expect(editor.getByLabel('选择镜头 3', { exact: true })).toBeVisible()

  // A late start response must not reset a report the user has since chosen to inspect.
  let release!: () => void
  const responseGate = new Promise<void>((resolve) => {
    release = resolve
  })
  let entered!: () => void
  const accepted = new Promise<void>((resolve) => {
    entered = resolve
  })
  await page.route(`**/nodes/${nodeId}/run`, async (route) => {
    const response = await route.fetch()
    entered()
    await responseGate
    await route.fulfill({ response })
  })
  try {
    await editor.getByRole('button', { name: '按这些切点处理', exact: true }).click()
    await accepted
    await expect
      .poll(() =>
        page.evaluate((nodeId) => window.__plein.engine.doc.get(nodeId)?.results?.length, nodeId),
      )
      .toBe(3)
    await editor.getByRole('combobox', { name: '拉片清单版本', exact: true }).click()
    await page.getByRole('option', { name: /^清单 2 ·/ }).click()
    await expect(editor.locator('video')).toHaveCount(3)
    release()
    await expect(editor.getByRole('button', { name: '按这些切点处理', exact: true })).toBeEnabled()
    await expect(editor.getByRole('combobox', { name: '拉片清单版本', exact: true })).toContainText(
      '清单 2',
    )
    await editor.evaluate((element) => {
      ;(window as unknown as { p08Videos: HTMLVideoElement[] }).p08Videos = [
        ...element.querySelectorAll('video'),
      ]
    })
    await editor.getByRole('button', { name: '关闭', exact: true }).click()
    await expect
      .poll(() =>
        page.evaluate(() =>
          (window as unknown as { p08Videos: HTMLVideoElement[] }).p08Videos.every(
            (video) => video.paused && !video.hasAttribute('src'),
          ),
        ),
      )
      .toBe(true)
  } finally {
    release()
    await page.unroute(`**/nodes/${nodeId}/run`)
  }

  await page.evaluate((nodeId) => {
    const engine = window.__plein.engine
    const map = engine.doc.mutable(nodeId) as unknown as { set(key: string, value: unknown): void }
    map.set('locked', true)
    engine.selection.set([nodeId])
  }, nodeId)
  await page.getByRole('button', { name: '查看拉片清单', exact: true }).click()
  await expect(editor.getByText('当前只读：', { exact: false })).toBeVisible()
  await expect(editor.getByRole('button', { name: '按这些切点处理', exact: true })).toBeDisabled()
  await expect(editor.getByRole('button', { name: '采用此清单', exact: true })).toBeDisabled()
  await expect(editor).toHaveCSS('opacity', '1')
  await page.screenshot({ path: test.info().outputPath('shot-analysis-readonly.png') })
})

// 这批用例要跑真实渲染、编码或很大的工程，单条本来就慢
slowFile(test)
