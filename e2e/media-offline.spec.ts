import { execFileSync } from 'node:child_process'
import { expect, test } from '@playwright/test'
import { newProject } from './canvas'

const libraries: string[] = []
test.afterEach(async ({ request }) => {
  for (const id of libraries.splice(0)) await request.delete(`/api/library/${id}`)
})

test('已加载页面离线后素材与来源可原位恢复，服务不可达和检查点读取失败提示明确', async ({
  page,
}) => {
  await newProject(page)
  const prefix = '网络恢复'
  const assets: string[] = []
  for (const [index, color] of ['orange', 'pink'].entries()) {
    const data = execFileSync('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      `color=c=${color}:s=216x120`,
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
  for (let index = 0; index < 2; index++) {
    const response = await page.request.post('/api/library', {
      data: {
        kind: 'character',
        name: `网络来源-${index}`,
        images: [{ slot: 'full_body', assetId: assets[0] }],
      },
    })
    expect(response.status()).toBe(201)
    libraries.push(((await response.json()) as { id: string }).id)
  }
  let online = true,
    rejectList = false
  const network = async (value: boolean) => {
    online = value
    await page.context().setOffline(!value)
  }
  await page.route(/\/api\/assets(?:\?|\/[^/]+\/sources\?)/, async (route) => {
    if (!online) return route.continue()
    const url = new URL(route.request().url())
    if (url.pathname === '/api/assets' && rejectList) {
      rejectList = false
      return route.abort('connectionrefused')
    }
    url.searchParams.set('limit', '1')
    await route.fulfill({ response: await route.fetch({ url: url.toString() }) })
  })
  await page.getByRole('button', { name: '素材', exact: true }).click()
  const panel = page.getByRole('dialog', { name: '素材', exact: true })
  await panel.getByRole('combobox', { name: '关联项目' }).click()
  await page.getByRole('option', { name: '全部项目', exact: true }).click()
  await panel.getByRole('searchbox', { name: '搜索素材' }).fill(prefix)
  const cards = panel.getByRole('button', { name: /^查看素材 / })
  const main = panel.getByRole('button', { name: `查看素材 ${prefix}-0.png`, exact: true })
  const empty = panel.getByRole('button', { name: `查看素材 ${prefix}-1.png`, exact: true })
  await expect(cards).toHaveCount(1)
  await empty.click()
  const section = panel.getByRole('heading', { name: '来源', exact: true }).locator('..')
  await expect(section.getByText('未关联到现存项目，文件仍可复用。', { exact: true })).toBeVisible()
  try {
    await network(false)
    expect(await page.evaluate(() => navigator.onLine)).toBe(false)
    await panel.getByRole('button', { name: '加载更多素材', exact: true }).click()
    await expect(panel.getByRole('alert')).toContainText('当前离线')
    await expect(cards).toHaveCount(1)
    await expect(panel.getByRole('heading', { name: `${prefix}-1.png`, exact: true })).toBeVisible()
    await panel.screenshot({
      path: test.info().outputPath('offline-pagination.png'),
      animations: 'disabled',
    })
    await network(true)
    await panel.getByRole('button', { name: '重试', exact: true }).click()
    await expect(cards).toHaveCount(2)
    await expect(panel.getByRole('heading', { name: `${prefix}-1.png`, exact: true })).toBeVisible()
    await network(false)
    await panel.getByRole('button', { name: '刷新', exact: true }).click()
    await expect(panel.getByRole('alert')).toContainText('当前离线')
    await expect(panel.getByText('素材读取失败', { exact: true })).toBeVisible()
    await network(true)
    await panel.getByRole('button', { name: '重试', exact: true }).click()
    await expect(cards).toHaveCount(1)
    await panel.getByRole('button', { name: '加载更多素材', exact: true }).click()
    await expect(cards).toHaveCount(2)
    await main.click()
    const more = section.getByRole('button', { name: '更多来源', exact: true })
    await expect(more).toBeEnabled()
    const rows = section.getByRole('listitem')
    await expect(rows).toHaveCount(1)
    await network(false)
    await more.click()
    await expect(section.getByRole('alert')).toContainText('当前离线')
    await expect(rows).toHaveCount(1)
    await network(true)
    await section.getByRole('button', { name: '重试来源', exact: true }).click()
    await expect(rows).toHaveCount(2)
    expect(new Set(await rows.allTextContents()).size).toBe(2)
    await network(false)
    await empty.click()
    await expect(section.getByRole('alert')).toContainText('当前离线')
    await expect(
      section.getByText('未关联到现存项目，文件仍可复用。', { exact: true }),
    ).toHaveCount(0)
    await network(true)
    await section.getByRole('button', { name: '重试来源', exact: true }).click()
    await expect(
      section.getByText('未关联到现存项目，文件仍可复用。', { exact: true }),
    ).toBeVisible()
    rejectList = true
    await panel.getByRole('button', { name: '刷新', exact: true }).click()
    await expect(panel.getByRole('alert')).toContainText('无法连接服务')
    expect(await page.evaluate(() => navigator.onLine)).toBe(true)
    await panel.getByRole('button', { name: '重试', exact: true }).click()
    await expect(cards).toHaveCount(1)
    await expect(panel.getByRole('alert')).toHaveCount(0)
    await panel.getByRole('button', { name: '关闭', exact: true }).click()
    await expect(panel).toHaveCount(0)
    await page.getByRole('button', { name: '检查点', exact: true }).click()
    const checkpoints = page.getByRole('dialog', { name: '创作检查点', exact: true })
    await expect(checkpoints.getByRole('button', { name: '刷新', exact: true })).toBeEnabled()
    await network(false)
    await checkpoints.getByRole('button', { name: '刷新', exact: true }).click()
    await expect(checkpoints.getByRole('alert')).toContainText('当前离线')
    await expect(checkpoints.getByText('检查点读取失败', { exact: true })).toBeVisible()
    await checkpoints.screenshot({
      path: test.info().outputPath('offline-checkpoints.png'),
      animations: 'disabled',
    })
    await network(true)
    await checkpoints.getByRole('button', { name: '刷新', exact: true }).click()
    await expect(checkpoints.getByRole('alert')).toHaveCount(0)
    await expect(checkpoints.getByText('还没有命名检查点', { exact: true })).toBeVisible()
  } finally {
    await network(true)
  }
})
