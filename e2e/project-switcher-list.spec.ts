import { expect, type Page, test } from '@playwright/test'
import { newProject } from './canvas'

const duplicateTitle = `同名画布 · ${'雨后玻璃水杯分镜与拍摄计划'.repeat(8)}`

async function fixture(page: Page, sameNames = false) {
  await newProject(page)
  const id = decodeURIComponent(page.url().split('#/c/')[1]!)
  const canvas = await (await page.request.get(`/api/canvases/${id}`)).json()
  if (sameNames)
    await page.request.patch(`/api/canvases/${id}`, { data: { title: duplicateTitle } })
  const other = await (
    await page.request.post('/api/canvases', {
      data: { projectId: canvas.projectId, title: sameNames ? duplicateTitle : '另一张画布' },
    })
  ).json()
  return { id, other, projectId: canvas.projectId as string }
}
const menu = (page: Page) => page.getByRole('dialog', { name: '画布', exact: true })
const open = (page: Page) => page.getByRole('button', { name: '切换画布', exact: true }).click()

test('画布清单首次加载等待有明确反馈，完成后可切换', async ({ page }) => {
  const f = await fixture(page)
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route(`**/api/projects/${f.projectId}/canvases`, async (route) => {
    await pending
    await route.continue()
  })
  try {
    await page.reload()
    await open(page)
    await expect(menu(page).getByRole('status')).toContainText('正在加载画布')
    release()
    await expect(menu(page).getByRole('button', { name: f.other.title, exact: true })).toBeVisible()
    await expect(menu(page).getByRole('status')).toHaveCount(0)
    await menu(page).getByRole('button', { name: f.other.title, exact: true }).click()
    await expect(page).toHaveURL(new RegExp(`#/c/${f.other.id}$`))
  } finally {
    release()
  }
})

test('画布清单首次失败可直接重试，等待时不会让错误和按钮消失', async ({ page }) => {
  const f = await fixture(page)
  let fail = true,
    reads = 0
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route(`**/api/projects/${f.projectId}/canvases`, async (route) => {
    if (fail) return route.fulfill({ status: 503, json: { message: '画布清单暂时不可用' } })
    reads++
    await pending
    await route.continue()
  })
  try {
    await page.reload()
    await open(page)
    const error = menu(page).getByRole('alert')
    await expect(error).toContainText('画布清单暂时不可用')
    fail = false
    const retry = error.getByRole('button', { name: '重新加载画布', exact: true })
    await retry.click()
    await expect.poll(() => reads).toBe(1)
    await expect(retry).toBeDisabled()
    release()
    await expect(error).toHaveCount(0)
    await expect(menu(page).getByRole('button', { name: f.other.title, exact: true })).toBeVisible()
  } finally {
    release()
  }
})

test('画布清单刷新失败保留已有选项，重试不改选也不修改文档', async ({ page }) => {
  const f = await fixture(page)
  await open(page)
  await expect(menu(page).getByRole('button', { name: f.other.title, exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(menu(page)).toHaveCount(0)
  const before = await page.evaluate(() => [...window.__plein.engine.doc.elements()])
  let fail = true
  await page.route(`**/api/projects/${f.projectId}/canvases`, (route) =>
    fail ? route.fulfill({ status: 503, json: { message: '刷新画布失败' } }) : route.continue(),
  )
  await open(page)
  const error = menu(page).getByRole('alert')
  await expect(error).toContainText('刷新画布失败')
  await menu(page).screenshot({
    path: test.info().outputPath('canvas-menu-refresh-error.png'),
    animations: 'disabled',
  })
  await expect(menu(page).getByRole('button', { name: f.other.title, exact: true })).toBeVisible()
  fail = false
  await error.getByRole('button', { name: '重新加载画布', exact: true }).click()
  await expect(error).toHaveCount(0)
  expect(page.url()).toContain(`#/c/${f.id}`)
  expect(await page.evaluate(() => [...window.__plein.engine.doc.elements()])).toEqual(before)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: '切换画布', exact: true })).toBeFocused()
})

test('同名画布显示唯一短 ID，选择与当前标记按真实身份区分', async ({ page }) => {
  const f = await fixture(page, true)
  await page.reload()
  await open(page)
  const current = menu(page).getByRole('button', {
    name: `${duplicateTitle} · ${f.id.slice(-6)}`,
    exact: true,
  })
  const other = menu(page).getByRole('button', {
    name: `${duplicateTitle} · ${f.other.id.slice(-6)}`,
    exact: true,
  })
  await expect(current).toHaveAttribute('aria-current', 'true')
  await expect(other).not.toHaveAttribute('aria-current', 'true')
  for (const id of [f.id, f.other.id]) {
    const suffix = menu(page).getByText(id.slice(-6), { exact: true })
    await expect(suffix).toBeInViewport()
    expect(
      await suffix.evaluate((el) => {
        const r = el.getBoundingClientRect()
        return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))
      }),
    ).toBe(true)
  }
  await menu(page).screenshot({
    path: test.info().outputPath('canvas-menu-duplicate-names.png'),
    animations: 'disabled',
  })
  await other.click()
  await expect(page).toHaveURL(new RegExp(`#/c/${f.other.id}$`))
  await open(page)
  await expect(other).toHaveAttribute('aria-current', 'true')
  await expect(current).not.toHaveAttribute('aria-current', 'true')
})

test('空画布清单有说明，仍可明确新建画布继续', async ({ page }) => {
  const f = await fixture(page)
  await page.route(`**/api/projects/${f.projectId}/canvases`, (route) =>
    route.fulfill({ json: [] }),
  )
  await page.reload()
  await open(page)
  await expect(menu(page)).toContainText('暂无可切换的画布')
  await expect(menu(page).getByRole('alert')).toHaveCount(0)
  await menu(page).getByRole('button', { name: '新建画布', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '新建画布', exact: true })
  await dialog.getByRole('textbox').fill('空清单后新建')
  await dialog.getByRole('button', { name: '新建', exact: true }).click()
  await expect(page.getByRole('button', { name: '切换画布', exact: true })).toHaveText(
    '空清单后新建',
  )
  expect(page.url()).not.toContain(`#/c/${f.id}`)
})
