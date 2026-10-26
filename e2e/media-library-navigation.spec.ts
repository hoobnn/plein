import { execFileSync } from 'node:child_process'
import { expect, type Page, test } from '@playwright/test'
import type { MediaSourcesPage } from '../packages/protocol/src/media-library'
import { newProject } from './canvas'

async function navigate(page: Page, canvas: { id: string; title: string }) {
  const previous = await page.evaluateHandle(() => window.__plein?.engine)
  await page.evaluate((id) => {
    location.hash = `#/c/${id}`
  }, canvas.id)
  await expect(page).toHaveURL(new RegExp(`#/c/${canvas.id}$`))
  await page.waitForFunction(
    (previous) => window.__plein && window.__plein.engine !== previous,
    previous,
  )
  await previous.dispose()
  await expect(
    page.getByRole('button', { name: '切换画布', exact: true, includeHidden: true }),
  ).toHaveText(canvas.title)
  await expect(page.getByTestId('sync-status')).toHaveAttribute('data-sync', 'connected')
}

for (const mode of ['switch', 'return', 'home-return', 'duplicate-node'] as const) {
  test(`素材面板打开时 ${mode} 放入当前访问，来源定位命中正确画布和节点`, async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await newProject(page)
    const originId = decodeURIComponent(page.url().split('#/c/')[1]!)
    const origin = (await (await page.request.get(`/api/canvases/${originId}`)).json()) as {
      id: string
      title: string
      projectId: string
    }
    const response = await page.request.post('/api/canvases', {
      data: { projectId: origin.projectId, title: `目标画布-${mode}` },
    })
    expect(response.status()).toBe(201)
    const other = (await response.json()) as { id: string; title: string }
    const bytes = execFileSync('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=cyan:s=160x96',
      '-frames:v',
      '1',
      '-f',
      'image2pipe',
      '-vcodec',
      'png',
      'pipe:1',
    ])
    const name = '归属验证-canvas.png'
    const upload = await page.request.post('/api/assets', {
      headers: { 'content-type': 'image/png', 'x-file-name': encodeURIComponent(name) },
      data: bytes,
    })
    expect(upload.status()).toBe(201)
    const asset = (await upload.json()) as { id: string }
    const panel = page.getByRole('dialog', { name: '素材', exact: true })
    const open = async () => {
      await page.getByRole('button', { name: '素材', exact: true }).click()
      await panel.getByRole('combobox', { name: '关联项目' }).click()
      await page.getByRole('option', { name: '全部项目', exact: true }).click()
      await panel.getByRole('searchbox', { name: '搜索素材', exact: true }).fill(name)
      await panel.getByRole('button', { name: `查看素材 ${name}`, exact: true }).click()
    }
    await open()
    if (mode === 'home-return') {
      await page.evaluate(() => {
        location.hash = '#/'
      })
      await expect(page).toHaveURL(/#\/$/)
      const place = panel.getByRole('button', { name: '放入当前画布', exact: true })
      await expect(place).toBeDisabled()
      await expect(place).toHaveAccessibleDescription('打开一张画布后可以放入')
      await navigate(page, origin)
    } else {
      await navigate(page, other)
      if (mode !== 'switch') await navigate(page, origin)
    }
    const target = mode === 'switch' ? other : origin
    const untouched = mode === 'switch' ? origin : other
    await expect(panel).toBeVisible()
    await expect(panel.getByRole('heading', { name, exact: true })).toBeVisible()
    await panel.getByRole('button', { name: '放入当前画布', exact: true }).click()
    await expect(panel).toHaveCount(0)
    const placed = await page.evaluate(() => {
      const engine = window.__plein.engine
      const el = engine.doc.get(engine.selection.values()[0]!)!
      return { id: el.id, kind: el.kind, assetId: el.assetId }
    })
    expect(placed).toMatchObject({ kind: 'image', assetId: asset.id })
    const expected = [{ canvasId: target.id, nodeId: placed.id }]
    if (mode === 'duplicate-node') {
      await open()
      await panel.getByRole('button', { name: '放入当前画布', exact: true }).click()
      await expect(panel).toHaveCount(0)
      const second = await page.evaluate(() => window.__plein.engine.selection.values()[0]!)
      expected.push({ canvasId: target.id, nodeId: second })
    }
    // 素材索引刚起来时还在建，接口会先回 503；这时候当作还没有来源，继续等。
    const sources = async () => {
      const response = await page.request.get(`/api/assets/${asset.id}/sources`)
      if (!response.ok()) return { items: [], nextCursor: null } as MediaSourcesPage
      return (await response.json()) as MediaSourcesPage
    }
    await expect
      .poll(async () =>
        (await sources()).items
          .filter((s) => s.type === 'canvas' && [origin.id, other.id].includes(s.canvasId ?? ''))
          .map((s) => ({ canvasId: s.canvasId, nodeId: s.nodeId }))
          .sort((a, b) => a.nodeId!.localeCompare(b.nodeId!)),
      )
      .toEqual(expected.sort((a, b) => a.nodeId.localeCompare(b.nodeId)))
    await navigate(page, untouched)
    expect(await page.evaluate(() => [...window.__plein.engine.doc.elements()])).toEqual([])
    await open()
    const matches = panel.getByRole('listitem').filter({ hasText: `${target.title} / ${name}` })
    await expect(matches.first()).toBeVisible()
    const ambiguous = mode === 'home-return' || mode === 'duplicate-node'
    if (ambiguous) {
      await expect.poll(() => matches.count()).toBeGreaterThan(1)
      const labels = await matches.allTextContents()
      expect(new Set(labels).size).toBe(labels.length)
    }
    const source = ambiguous
      ? matches
          .filter({ hasText: `画布 ${target.id.slice(-6)}` })
          .filter({ hasText: `元素 ${placed.id.slice(-6)}` })
      : matches
    await expect(source).toHaveCount(1)
    await source.scrollIntoViewIfNeeded()
    await panel.screenshot({ path: test.info().outputPath('media-sources.png') })
    await source.getByRole('button', { name: '定位来源', exact: true }).click()
    await expect(panel).toHaveCount(0)
    await expect(page).toHaveURL(new RegExp(`#/c/${target.id}$`))
    await expect
      .poll(() => page.evaluate(() => window.__plein.engine.selection.values()))
      .toEqual([placed.id])
    expect(await page.evaluate((id) => window.__plein.engine.doc.get(id)?.assetId, placed.id)).toBe(
      asset.id,
    )
    expect(errors).toEqual([])
    await page.screenshot({ path: test.info().outputPath('media-source-located.png') })
  })
}
