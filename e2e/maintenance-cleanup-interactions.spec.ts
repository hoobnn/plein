import { randomUUID } from 'node:crypto'
import { utimes } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import { openDb } from '../apps/server/src/storage/db'
import { newProject } from './canvas'

async function openData(page: Page) {
  await newProject(page)
  await page.getByRole('button', { name: '设置', exact: true }).click()
  const settings = page.getByRole('dialog', { name: '设置', exact: true })
  await settings.getByRole('button', { name: '数据', exact: true }).click()
  return settings
}

let assetId = ''
test.beforeEach(async ({ request }) => {
  const root = process.env.PLEIN_E2E_DATA
  if (!root) throw new Error('清理回归只能在隔离测试数据目录运行')
  const status = await (await request.get('/api/maintenance/status')).json()
  expect(
    (
      await request.put('/api/maintenance/settings', {
        data: { ...status.settings, autoBackup: false, unusedDays: 30 },
      })
    ).ok(),
  ).toBe(true)
  const response = await request.post('/api/assets', {
    multipart: {
      file: { name: 'cleanup-test.txt', mimeType: 'text/plain', buffer: Buffer.from(randomUUID()) },
    },
  })
  expect(response.status()).toBe(201)
  assetId = (await response.json()).id
  const old = new Date(Date.now() - 60 * 86_400_000)
  const db = openDb(root)
  try {
    db.$client.prepare('UPDATE assets SET created_at=? WHERE id=?').run(old.getTime(), assetId)
  } finally {
    db.$client.close()
  }
  await utimes(join(root, 'assets', assetId.slice(0, 2), assetId), old, old)
})

test('预览取消不执行清理，执行后不再允许取消，真实回收与恢复素材可用', async ({
  page,
  request,
}) => {
  const settings = await openData(page)
  const inspect = settings.getByRole('button', { name: '检查可清理素材', exact: true })
  const confirm = settings.getByRole('button', { name: '确认移入回收站', exact: true })
  const cancel = settings.getByRole('button', { name: '取消', exact: true })
  let cleanupRequests = 0
  page.on('request', (req) => {
    if (req.method() === 'POST' && req.url().endsWith('/api/maintenance/cleanup')) cleanupRequests++
  })
  await inspect.click()
  await expect(confirm).toBeEnabled()
  await cancel.click()
  await expect(confirm).toHaveCount(0)
  expect(cleanupRequests).toBe(0)
  expect((await request.get(`/api/assets/${assetId}/meta`)).status()).toBe(200)
  await inspect.click()
  await expect(confirm).toBeEnabled()
  let release!: () => void
  let done!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const completed = new Promise<void>((resolve) => {
    done = resolve
  })
  await page.route('**/api/maintenance/cleanup', async (route) => {
    const response = await route.fetch()
    expect(response.ok()).toBe(true)
    done()
    await gate
    await route.fulfill({ response })
  })
  try {
    await confirm.click()
    await completed
    expect((await request.get(`/api/assets/${assetId}/meta`)).status()).toBe(404)
    await expect(cancel).toBeDisabled()
    await expect(confirm).toBeDisabled()
    await expect(inspect).toBeDisabled()
    release()
    await expect(settings.getByRole('status').filter({ hasText: '已将' })).toContainText(
      '移入回收站',
    )
    await expect(inspect).toBeEnabled()
    expect(cleanupRequests).toBe(1)
    const trash = await (await request.get('/api/maintenance/status')).json()
    expect(trash.trash.length).toBeGreaterThan(0)
    await settings.getByRole('button', { name: '恢复素材', exact: true }).first().click()
    await expect(settings.getByRole('status').filter({ hasText: '已恢复' })).toBeVisible()
    expect((await request.get(`/api/assets/${assetId}/meta`)).status()).toBe(200)
  } finally {
    release()
  }
})

test('预览失败可重试，窄窗口能直接看到检查结果与确认操作', async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 560 })
  const settings = await openData(page)
  let failing = true
  await page.route('**/api/maintenance/cleanup/preview', async (route) => {
    if (failing)
      await route.fulfill({ status: 503, json: { error: 'test_failure', message: '检查暂不可用' } })
    else await route.continue()
  })
  const inspect = settings.getByRole('button', { name: '检查可清理素材', exact: true })
  await inspect.click()
  await expect(settings.getByRole('alert')).toContainText('检查暂不可用')
  await expect(inspect).toBeEnabled()
  failing = false
  await inspect.click()
  const confirm = settings.getByRole('button', { name: '确认移入回收站', exact: true })
  await expect(confirm).toBeEnabled()
  await expect(confirm).toBeInViewport()
  await expect(settings.getByText(/个登记和修改时间都超过/)).toBeInViewport()
  await settings.screenshot({
    path: test.info().outputPath('cleanup-preview.png'),
    animations: 'disabled',
  })
})

test('预检后数据变化会保留素材并提示重新检查，重新预检后可执行', async ({ page, request }) => {
  const settings = await openData(page)
  const inspect = settings.getByRole('button', { name: '检查可清理素材', exact: true })
  const confirm = settings.getByRole('button', { name: '确认移入回收站', exact: true })
  await inspect.click()
  await expect(confirm).toBeEnabled()
  expect((await request.post('/api/projects', { data: { title: '预检后的外部写入' } })).ok()).toBe(
    true,
  )
  const rejected = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' && response.url().endsWith('/api/maintenance/cleanup'),
  )
  await confirm.click()
  expect((await rejected).status()).toBe(409)
  await expect(settings.getByRole('alert')).toContainText('数据已变化')
  await expect(confirm).toHaveCount(0)
  await expect(inspect).toBeEnabled()
  expect((await request.get(`/api/assets/${assetId}/meta`)).status()).toBe(200)
  await inspect.click()
  await expect(settings.getByRole('alert')).toHaveCount(0)
  await expect(confirm).toBeEnabled()
  await confirm.click()
  await expect(settings.getByRole('status').filter({ hasText: '已将' })).toContainText('移入回收站')
  await expect(inspect).toBeEnabled()
  expect((await request.get(`/api/assets/${assetId}/meta`)).status()).toBe(404)
  await settings.getByRole('button', { name: '恢复素材', exact: true }).first().click()
  await expect(settings.getByRole('status').filter({ hasText: '已恢复' })).toBeVisible()
  expect((await request.get(`/api/assets/${assetId}/meta`)).status()).toBe(200)
})
