import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { newProject } from './canvas'
import { openLibraryPanel } from './library-ui'

let dir = ''
const file = (i: number) => join(dir, `profile-batch-${i}.png`)
test.beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'plein-profile-batches-'))
  for (let i = 0; i < 5; i++)
    execFileSync('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      `color=c=orange:s=${64 + i * 2}x64`,
      '-frames:v',
      '1',
      file(i),
    ])
})
test.afterAll(() => rmSync(dir, { recursive: true, force: true }))

test('档案选图弹层打开时拖入上传，候选在上传期间禁用且恢复后不丢图', async ({ page }) => {
  await newProject(page)
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: '上传', exact: true }).click()
  await (await chooser).setFiles(file(4))
  await expect
    .poll(() =>
      page.evaluate(
        () => [...window.__plein.engine.doc.elements()].filter((el) => el.kind === 'image').length,
      ),
    )
    .toBe(1)
  await page.keyboard.press('Escape')
  const created = await page.request.post('/api/library', {
    data: {
      kind: 'character',
      name: '档案弹层上传保护',
      profile: { periods: [{ id: 'teen', name: '少年' }] },
    },
  })
  const item = await created.json()
  const panel = await openLibraryPanel(page)
  await panel
    .getByRole('group', { name: '范围' })
    .getByRole('button', { name: '全部', exact: true })
    .click()
  await panel
    .getByRole('listitem')
    .filter({ hasText: '档案弹层上传保护' })
    .getByRole('button')
    .first()
    .click()
  await panel
    .getByRole('group', { name: '档案分页' })
    .getByRole('button', { name: /^时期与服饰/ })
    .click()
  const field = panel
    .locator('.lib-look-editor .ui-field')
    .filter({ has: page.locator('.ui-label').filter({ hasText: '参考图' }) })
    .last()
  await field.getByRole('button', { name: '从画布选', exact: true }).click()
  const picker = page.locator('.ui-menu[aria-label="从画布选"]')
  const select = picker.getByRole('button', { name: /^选择图片/ })
  await expect(select).toBeEnabled()
  let finish!: () => void
  let started!: () => void
  const gate = new Promise<void>((resolve) => {
    finish = resolve
  })
  const uploading = new Promise<void>((resolve) => {
    started = resolve
  })
  await page.route('**/api/assets', async (route) => {
    const response = await route.fetch()
    started()
    await gate
    await route.fulfill({ response })
  })
  const transfer = await page.evaluateHandle(
    (body) => {
      const data = new DataTransfer()
      data.items.add(
        new File([Uint8Array.from(atob(body), (c) => c.charCodeAt(0))], 'profile-batch-0.png', {
          type: 'image/png',
        }),
      )
      return data
    },
    readFileSync(file(0)).toString('base64'),
  )
  try {
    await field
      .getByRole('button', { name: '上传', exact: true })
      .dispatchEvent('drop', { dataTransfer: transfer })
    await uploading
    await expect(picker).toBeVisible()
    await expect(select).toBeDisabled()
  } finally {
    finish()
    await transfer.dispose()
  }
  await expect(field.locator('.lib-strip-tile img')).toHaveCount(1)
  await expect(select).toBeEnabled()
  await select.click()
  await expect(field.locator('.lib-strip-tile img')).toHaveCount(2)
  await expect(picker).toHaveCount(0)
  await expect(field.getByRole('button', { name: '从画布选', exact: true })).toBeFocused()
  await expect(panel).toBeVisible()
  await panel.getByRole('button', { name: '保存', exact: true }).click()
  await expect(panel.getByRole('button', { name: '已保存', exact: true })).toBeDisabled()
  const saved = await (await page.request.get(`/api/library/${item.id}`)).json()
  expect(saved.profile.periods[0].images).toHaveLength(2)
  expect(new Set(saved.profile.periods[0].images).size).toBe(2)
  await page.keyboard.press('Escape')
  await expect(panel).toBeVisible()
  await expect(panel.getByRole('textbox', { name: '名称', exact: true })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(panel).toBeHidden()
})

for (const role of ['时期'] as const) {
  test(`档案${role}批量失败保留成功项，重复不占位且超限不上传`, async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 560 })
    await newProject(page)
    const name = `档案${role}批量恢复`
    const response = await page.request.post('/api/library', {
      data: {
        kind: 'character',
        name,
        profile: {
          periods: [{ id: 'teen', name: '少年', outfits: [{ id: 'uniform', name: '校服' }] }],
          expressions: [{ id: 'happy', name: '开心' }],
        },
      },
    })
    const item = await response.json()
    const panel = await openLibraryPanel(page)
    await panel
      .getByRole('group', { name: '范围' })
      .getByRole('button', { name: '全部', exact: true })
      .click()
    await panel.getByRole('listitem').filter({ hasText: name }).getByRole('button').first().click()
    await panel
      .getByRole('group', { name: '档案分页' })
      .getByRole('button', { name: /^时期与服饰/ })
      .click()
    const field = panel
      .locator('.lib-look-editor .ui-field')
      .filter({ has: page.locator('.ui-label').filter({ hasText: '参考图' }) })
      .last()
    const imagesOf = (profile: typeof item.profile): string[] => profile.periods[0].images
    let posts = 0
    let fail = true
    await page.route('**/api/assets', (route) => {
      posts++
      if (fail && route.request().headers()['x-file-name'] === 'profile-batch-1.png')
        return route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ message: '档案第二张暂不可用' }),
        })
      return route.continue()
    })
    const upload = async (indices: number[]) => {
      const chooser = page.waitForEvent('filechooser')
      await field.getByRole('button', { name: '上传', exact: true }).click()
      await (await chooser).setFiles(indices.map(file))
    }
    const save = async () => {
      await panel.getByRole('button', { name: '保存', exact: true }).click()
      await expect(panel.getByRole('button', { name: '已保存', exact: true })).toBeDisabled()
      return (await (await page.request.get(`/api/library/${item.id}`)).json()).profile
    }
    await upload([0, 1, 2])
    await expect(field.getByRole('alert')).toContainText('profile-batch-1.png')
    await expect(field.locator('img')).toHaveCount(2)
    await field.getByRole('alert').scrollIntoViewIfNeeded()
    await panel.screenshot({
      path: test.info().outputPath('profile-batch-partial.png'),
      animations: 'disabled',
    })
    const first = imagesOf(await save())
    expect(first).toHaveLength(2)
    fail = false
    await upload([1])
    await expect(field.locator('img')).toHaveCount(3)
    await upload([0])
    await expect(field.getByRole('status')).toContainText('重复')
    await expect(field.locator('img')).toHaveCount(3)
    const before = posts
    await upload([3, 4])
    await expect(field.getByRole('alert')).toContainText('最多还能添加 1 张')
    expect(posts).toBe(before)
    await expect(field.locator('img')).toHaveCount(3)
    await upload([3])
    await expect(field.locator('img')).toHaveCount(4)
    await expect(field.getByRole('button', { name: '上传', exact: true })).toHaveCount(0)
    const final = imagesOf(await save())
    expect(final).toHaveLength(4)
    expect(new Set(final).size).toBe(4)
    expect(final.slice(0, 2)).toEqual(first)
  })
}
