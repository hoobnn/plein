import { execFileSync } from 'node:child_process'
import { expect, test } from '@playwright/test'
import { newProject } from './canvas'

test('素材分页失败重试保留列表与详情，换搜索取消旧页，首页失败明确提示', async ({ page }) => {
  await newProject(page)
  const prefix = '素材分页恢复'
  for (const [index, color] of ['red', 'green', 'blue'].entries()) {
    const data = execFileSync('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      `color=c=${color}:s=96x64`,
      '-frames:v',
      '1',
      '-f',
      'image2pipe',
      '-vcodec',
      'png',
      'pipe:1',
    ])
    const response = await page.request.post('/api/assets', {
      headers: {
        'content-type': 'image/png',
        'x-file-name': encodeURIComponent(`${prefix}-${index}.png`),
      },
      data,
    })
    expect(response.status()).toBe(201)
  }
  let failMore = true,
    failFirst = false,
    delayMore = false
  let started!: () => void, release!: () => void, delivered!: () => void
  const pending = new Promise<void>((resolve) => {
    started = resolve
  })
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const finished = new Promise<void>((resolve) => {
    delivered = resolve
  })
  const cursors: string[] = []
  await page.route(/\/api\/assets\?/, async (route) => {
    const url = new URL(route.request().url())
    if (url.searchParams.get('q') !== prefix) return route.continue()
    url.searchParams.set('limit', '1')
    const cursor = url.searchParams.get('cursor') ?? ''
    cursors.push(cursor)
    if (cursor && failMore) {
      failMore = false
      return route.fulfill({ status: 503, json: { message: '分页暂不可用' } })
    }
    if (!cursor && failFirst) {
      failFirst = false
      return route.fulfill({ status: 503, json: { message: '首页暂不可用' } })
    }
    const response = await route.fetch({ url: url.toString() })
    if (cursor && delayMore) {
      started()
      await gate
    }
    await route.fulfill({ response })
    if (cursor && delayMore) delivered()
  })
  await page.getByRole('button', { name: '素材', exact: true }).click()
  const panel = page.getByRole('dialog', { name: '素材', exact: true })
  await panel.getByRole('combobox', { name: '关联项目' }).click()
  await page.getByRole('option', { name: '全部项目', exact: true }).click()
  const search = panel.getByRole('searchbox', { name: '搜索素材' })
  await search.fill(prefix)
  const cards = panel.getByRole('button', { name: /^查看素材 / })
  await expect(cards).toHaveCount(1)
  await cards.first().click()
  const detail = panel.getByRole('heading', { name: `${prefix}-2.png`, exact: true })
  await expect(detail).toBeVisible()
  await panel.getByRole('button', { name: '加载更多素材', exact: true }).click()
  await expect(panel.getByRole('alert')).toContainText('分页暂不可用')
  const failedCursor = cursors.at(-1)!
  expect(failedCursor).not.toBe('')
  await panel.getByRole('button', { name: '重试', exact: true }).click()
  await expect(cards).toHaveCount(2)
  expect(cursors.at(-1)).toBe(failedCursor)
  await expect(detail).toBeVisible()
  await expect(panel.getByRole('alert')).toHaveCount(0)
  delayMore = true
  await panel.getByRole('button', { name: '加载更多素材', exact: true }).click()
  try {
    await pending
    await expect(panel.getByRole('button', { name: '刷新', exact: true })).toBeDisabled()
    const delayedCursor = cursors.at(-1)!
    const canceled = page.waitForEvent('requestfailed', {
      predicate: (request) => new URL(request.url()).searchParams.get('cursor') === delayedCursor,
    })
    await search.fill('不存在的分页搜索结果')
    await expect(panel.getByText('没有找到素材', { exact: true })).toBeVisible()
    await canceled
    release()
    await finished
    await expect(cards).toHaveCount(0)
    await expect(panel.getByRole('button', { name: '放入当前画布', exact: true })).toHaveCount(0)
    failFirst = true
    await search.fill(prefix)
    await expect(panel.getByRole('alert')).toContainText('首页暂不可用')
    await expect(panel.getByText('素材读取失败', { exact: true })).toBeVisible()
    await panel.screenshot({
      path: test.info().outputPath('media-first-page-failed.png'),
      animations: 'disabled',
    })
    await panel.getByRole('button', { name: '重试', exact: true }).click()
    await expect(cards).toHaveCount(1)
    expect(cursors.at(-1)).toBe('')
    await expect(panel.getByRole('alert')).toHaveCount(0)
  } finally {
    release()
  }
})
