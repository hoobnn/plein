import { execFileSync } from 'node:child_process'
import { expect, test } from '@playwright/test'
import { newProject } from './canvas'

const libraries: string[] = []
test.afterEach(async ({ request }) => {
  for (const id of libraries.splice(0)) await request.delete(`/api/library/${id}`)
})

test('素材来源分页防重复、失败可重试，换素材取消旧来源请求', async ({ page }) => {
  await newProject(page)
  const prefix = '来源分页恢复'
  const assets: string[] = []
  for (const [index, color] of ['orange', 'purple'].entries()) {
    const data = execFileSync('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      `color=c=${color}:s=128x80`,
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
    assets.push(((await response.json()) as { id: string }).id)
  }
  for (let index = 0; index < 3; index++) {
    const response = await page.request.post('/api/library', {
      data: {
        kind: 'character',
        name: `来源记录-${index}`,
        images: [{ slot: 'full_body', assetId: assets[0] }],
      },
    })
    expect(response.status()).toBe(201)
    libraries.push(((await response.json()) as { id: string }).id)
  }
  const holds = [0, 1, 2].map(() => {
    let started!: () => void, release!: () => void, delivered!: () => void
    const pending = new Promise<void>((resolve) => {
      started = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const done = new Promise<void>((resolve) => {
      delivered = resolve
    })
    return { started, release, delivered, pending, gate, done }
  })
  let hold = 0,
    failMore = false,
    failEmpty = true,
    moreCalls = 0
  await page.route(/\/api\/assets\/[^/]+\/sources\?/, async (route) => {
    const url = new URL(route.request().url())
    url.searchParams.set('limit', '1')
    const cursor = url.searchParams.get('cursor')
    if (url.pathname.includes(assets[1]!) && failEmpty) {
      return route.fulfill({ status: 503, json: { message: '来源首页失败' } })
    }
    if (cursor) {
      moreCalls++
      if (failMore) {
        failMore = false
        return route.fulfill({ status: 503, json: { message: '来源分页失败' } })
      }
    }
    const response = await route.fetch({ url: url.toString() })
    const delayed = cursor && hold >= 0 ? holds[hold]! : null
    if (delayed) {
      delayed.started()
      await delayed.gate
    }
    await route.fulfill({ response })
    delayed?.delivered()
  })
  await page.getByRole('button', { name: '素材', exact: true }).click()
  const panel = page.getByRole('dialog', { name: '素材', exact: true })
  await panel.getByRole('combobox', { name: '关联项目' }).click()
  await page.getByRole('option', { name: '全部项目', exact: true }).click()
  await panel.getByRole('searchbox', { name: '搜索素材' }).fill(prefix)
  const main = panel.getByRole('button', { name: `查看素材 ${prefix}-0.png`, exact: true })
  const empty = panel.getByRole('button', { name: `查看素材 ${prefix}-1.png`, exact: true })
  await main.click()
  const section = panel.getByRole('heading', { name: '来源', exact: true }).locator('..')
  const more = section.getByRole('button', { name: '更多来源', exact: true })
  try {
    await expect(more).toBeVisible()
    await more.dblclick()
    await holds[0]!.pending
    await expect(more).toBeDisabled()
    await section.screenshot({
      path: test.info().outputPath('sources-loading.png'),
      animations: 'disabled',
    })
    holds[0]!.release()
    await holds[0]!.done
    const rows = section.getByRole('list', { name: '素材来源', exact: true }).getByRole('listitem')
    await expect(rows).toHaveCount(2)
    expect(moreCalls).toBe(1)
    hold = -1
    failMore = true
    await more.click()
    await expect(section.getByRole('alert')).toContainText('来源分页失败')
    await expect(rows).toHaveCount(2)
    await section.getByRole('button', { name: '重试来源', exact: true }).click()
    await expect(rows).toHaveCount(3)
    await expect(section.getByRole('alert')).toHaveCount(0)
    await expect(more).toHaveCount(0)
    expect(new Set(await rows.allTextContents()).size).toBe(3)
    await section.screenshot({
      path: test.info().outputPath('sources-recovered.png'),
      animations: 'disabled',
    })
    await empty.click()
    await expect(section.getByRole('alert')).toContainText('来源首页失败')
    await expect(
      section.getByText('未关联到现存项目，文件仍可复用。', { exact: true }),
    ).toHaveCount(0)
    await section.screenshot({
      path: test.info().outputPath('sources-failed.png'),
      animations: 'disabled',
    })
    failEmpty = false
    await section.getByRole('button', { name: '重试来源', exact: true }).click()
    await expect(
      section.getByText('未关联到现存项目，文件仍可复用。', { exact: true }),
    ).toBeVisible()
    await main.click()
    await expect(more).toBeEnabled()
    hold = 1
    await more.click()
    await holds[1]!.pending
    const canceled = page.waitForEvent('requestfailed', {
      predicate: (request) =>
        request.url().includes(`/api/assets/${assets[0]}/sources?`) &&
        new URL(request.url()).searchParams.has('cursor'),
    })
    await empty.click()
    await canceled
    holds[1]!.release()
    await holds[1]!.done
    await expect(panel.getByRole('heading', { name: `${prefix}-1.png`, exact: true })).toBeVisible()
    await expect(section.getByRole('listitem')).toHaveCount(0)
    await expect(section.getByRole('alert')).toHaveCount(0)
    await main.click()
    await expect(more).toBeEnabled()
    hold = 2
    await more.click()
    await holds[2]!.pending
    const closedRequest = page.waitForEvent('requestfailed', {
      predicate: (request) =>
        request.url().includes(`/api/assets/${assets[0]}/sources?`) &&
        new URL(request.url()).searchParams.has('cursor'),
    })
    await panel.getByRole('button', { name: '关闭', exact: true }).click()
    await closedRequest
    holds[2]!.release()
    await holds[2]!.done
    await expect(panel).toHaveCount(0)
    await page.getByRole('button', { name: '素材', exact: true }).click()
    await panel.getByRole('combobox', { name: '关联项目' }).click()
    await page.getByRole('option', { name: '全部项目', exact: true }).click()
    await panel.getByRole('searchbox', { name: '搜索素材' }).fill(prefix)
    await main.click()
    await expect(rows).toHaveCount(1)
    await expect(section.getByRole('alert')).toHaveCount(0)
  } finally {
    for (const delayed of holds) delayed.release()
  }
})

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
