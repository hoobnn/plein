import { expect, test } from '@playwright/test'
import { newProject, waitEngine } from './canvas'

test('会话接口自身返回 401 时停止自动读取，可手动重试恢复', async ({ page }) => {
  let reads = 0
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route('**/api/session', async (route) => {
    reads++
    if (reads === 1) return route.fulfill({ status: 401, json: { message: '会话服务拒绝读取' } })
    await held
    await route.continue()
  })
  try {
    await page.goto('/')
    await expect(page.getByRole('alert')).toContainText('会话服务拒绝读取')
    expect(reads).toBe(1)
    await page.getByRole('button', { name: '重试', exact: true }).click()
    await expect(page.getByRole('button', { name: '正在重试…', exact: true })).toBeDisabled()
    await expect.poll(() => reads).toBe(2)
    release()
    await expect(page.getByRole('heading', { name: '我的项目' })).toBeVisible()
    expect(reads).toBe(2)
  } finally {
    release()
  }
})

test('首次连接等待显示状态，恢复后正常显示项目列表', async ({ page }) => {
  let reads = 0
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route('**/api/session', async (route) => {
    reads++
    await held
    await route.continue()
  })
  try {
    await page.goto('/')
    await expect(page.getByRole('status').filter({ hasText: '正在连接 Plein' })).toBeVisible()
    expect(reads).toBe(1)
    release()
    await expect(page.getByRole('heading', { name: '我的项目' })).toBeVisible()
    expect(reads).toBe(1)
  } finally {
    release()
  }
})

test('连接失败保留具体原因，重试有等待和防重，恢复仍进入原画布', async ({ page }) => {
  await newProject(page)
  const original = new URL(page.url()).hash
  let mode: 'fail' | 'retry-fail' | 'success' = 'fail'
  let release!: () => void
  let held = new Promise<void>((resolve) => {
    release = resolve
  })
  let retries = 0
  await page.route('**/api/session', async (route) => {
    const attempt = mode
    if (attempt === 'fail') return route.fulfill({ status: 503, json: { message: '连接暂不可用' } })
    retries++
    await held
    if (attempt === 'retry-fail')
      await route.fulfill({ status: 503, json: { message: '服务仍在恢复' } })
    else await route.continue()
  })
  try {
    await page.reload()
    await expect(page.getByRole('alert')).toContainText('连接暂不可用')
    await expect(page.locator('body')).not.toContainText('pnpm dev:server')
    mode = 'retry-fail'
    await page.getByRole('button', { name: '重试', exact: true }).evaluate((el) => {
      ;(el as HTMLButtonElement).click()
      ;(el as HTMLButtonElement).click()
    })
    await expect(page.getByRole('button', { name: '正在重试…', exact: true })).toBeDisabled()
    await expect(page.getByRole('alert')).toContainText('连接暂不可用')
    await expect.poll(() => retries).toBe(1)
    release()
    await expect(page.getByRole('alert')).toContainText('服务仍在恢复')
    mode = 'success'
    held = new Promise<void>((resolve) => {
      release = resolve
    })
    await page.getByRole('button', { name: '重试', exact: true }).click()
    await expect(page.getByRole('button', { name: '正在重试…', exact: true })).toBeDisabled()
    await expect.poll(() => retries).toBe(2)
    await page.screenshot({ path: test.info().outputPath('connection-retrying.png') })
    release()
    await waitEngine(page)
    expect(new URL(page.url()).hash).toBe(original)
    expect(retries).toBe(2)
  } finally {
    release()
  }
})
