import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, type Locator, type Page, test } from '@playwright/test'
import { newProject } from './canvas'

let dir = ''
const file = (i: number) => join(dir, `batch-${i}.png`)
test.beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'plein-upload-batches-'))
  for (let i = 0; i < 25; i++)
    execFileSync('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      `color=c=teal:s=${64 + i * 2}x64`,
      '-frames:v',
      '1',
      file(i),
    ])
})
test.afterAll(() => rmSync(dir, { recursive: true, force: true }))

async function openItem(page: Page, kind: string, name: string) {
  await page.getByRole('button', { name: '资产库', exact: true }).click()
  const panel = page.getByRole('dialog', { name: '资产库', exact: true })
  await panel
    .getByRole('group', { name: '资产类别' })
    .getByRole('button', { name: kind, exact: true })
    .click()
  await panel
    .getByRole('group', { name: '范围' })
    .getByRole('button', { name: '全部', exact: true })
    .click()
  await panel.getByRole('listitem').filter({ hasText: name }).getByRole('button').first().click()
  return panel
}
async function upload(page: Page, field: Locator, indices: number[]) {
  const chooser = page.waitForEvent('filechooser')
  await field.getByRole('button', { name: '上传', exact: true }).click()
  await (await chooser).setFiles(indices.map(file))
}
async function save(panel: Locator) {
  await panel.getByRole('button', { name: '保存', exact: true }).click()
  await expect(panel.getByRole('button', { name: '已保存', exact: true })).toBeDisabled()
}

test('场景批量上传中途失败保留其他成功图片，整批重试不产生重复引用', async ({ page }) => {
  await newProject(page)
  const created = await page.request.post('/api/library', {
    data: { kind: 'scene', name: '场景批量失败恢复' },
  })
  const item = await created.json()
  const panel = await openItem(page, '场景', '场景批量失败恢复')
  const field = panel
    .locator('.ui-field')
    .filter({ has: page.locator('.ui-label').filter({ hasText: '多角度' }) })
    .last()
  let fail = true
  await page.route('**/api/assets', (route) => {
    if (fail && route.request().headers()['x-file-name'] === 'batch-1.png')
      return route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ message: '第二张暂不可用' }),
      })
    return route.continue()
  })
  await upload(page, field, [0, 1, 2])
  await expect(field.getByRole('alert')).toContainText('batch-1.png')
  await expect(field.locator('img')).toHaveCount(2)
  await save(panel)
  const first = await (await page.request.get(`/api/library/${item.id}`)).json()
  expect(first.images).toHaveLength(2)
  fail = false
  await upload(page, field, [0, 1, 2])
  await expect(field.locator('img')).toHaveCount(3)
  await save(panel)
  const final = await (await page.request.get(`/api/library/${item.id}`)).json()
  expect(final.images).toHaveLength(3)
  expect(new Set(final.images.map((image: { assetId: string }) => image.assetId)).size).toBe(3)
  expect(final.images.slice(0, 2)).toEqual(first.images)
  await upload(page, field, [0, 1, 2])
  await expect(field.getByRole('status')).toContainText('重复')
  await expect(field.locator('img')).toHaveCount(3)
  await expect(panel.getByRole('button', { name: '已保存', exact: true })).toBeDisabled()
})

test('跨槽位数量上限在上传前检查，缩减选择后可保存完整素材', async ({ page }) => {
  await newProject(page)
  const uploaded = await page.request.post('/api/assets', {
    headers: { 'content-type': 'image/png', 'x-file-name': 'batch-0.png' },
    data: readFileSync(file(0)),
  })
  const main = (await uploaded.json()).id
  const created = await page.request.post('/api/library', {
    data: { kind: 'scene', name: '场景批量上限', images: [{ slot: 'main', assetId: main }] },
  })
  const item = await created.json()
  const panel = await openItem(page, '场景', '场景批量上限')
  const field = panel
    .locator('.ui-field')
    .filter({ has: page.locator('.ui-label').filter({ hasText: '多角度' }) })
    .last()
  let posts = 0
  await page.route('**/api/assets', (route) => {
    posts++
    return route.continue()
  })
  await upload(
    page,
    field,
    Array.from({ length: 24 }, (_, i) => i + 1),
  )
  await expect(field.getByRole('alert')).toContainText('最多还能添加 23 张')
  expect(posts).toBe(0)
  await expect(field.locator('img')).toHaveCount(0)
  await expect(panel.getByRole('button', { name: '已保存', exact: true })).toBeDisabled()
  await upload(page, field, [1, 2])
  await expect(field.locator('img')).toHaveCount(2)
  await save(panel)
  const final = await (await page.request.get(`/api/library/${item.id}`)).json()
  expect(final.images).toHaveLength(3)
  expect(final.images[0]).toEqual({ slot: 'main', assetId: main })
})

test('单张角色图拒绝多图拖入，混选非图片时只上传有效图片并提示', async ({ page }) => {
  await newProject(page)
  const created = await page.request.post('/api/library', {
    data: { kind: 'character', name: '单槽拖入保护' },
  })
  const item = await created.json()
  const panel = await openItem(page, '角色', '单槽拖入保护')
  const tile = panel.locator('[data-character-slot="full_body"]')
  let posts = 0
  await page.route('**/api/assets', (route) => {
    posts++
    return route.continue()
  })
  const drop = async (mixed: boolean) => {
    const transfer = await page.evaluateHandle(
      (files) => {
        const data = new DataTransfer()
        for (const file of files)
          data.items.add(
            new File([Uint8Array.from(atob(file.body), (c) => c.charCodeAt(0))], file.name, {
              type: file.type,
            }),
          )
        return data
      },
      [0, 1].map((i) => ({
        body: readFileSync(file(i)).toString('base64'),
        name: mixed && !i ? 'note.txt' : `batch-${i}.png`,
        type: mixed && !i ? 'text/plain' : 'image/png',
      })),
    )
    try {
      await tile
        .getByRole('button', { name: '添加全身定妆图', exact: true })
        .dispatchEvent('drop', { dataTransfer: transfer })
    } finally {
      await transfer.dispose()
    }
  }
  await drop(false)
  await expect(tile.getByRole('alert')).toContainText('最多还能添加 1 张')
  expect(posts).toBe(0)
  await expect(tile.locator('img')).toHaveCount(0)
  await drop(true)
  await expect(tile.getByRole('status')).toContainText('已跳过 1 个非图片文件')
  await expect(tile.locator('img')).toBeVisible()
  expect(posts).toBe(1)
  await save(panel)
  const saved = await (await page.request.get(`/api/library/${item.id}`)).json()
  expect(saved.images).toHaveLength(1)
  expect(saved.images[0].slot).toBe('full_body')
})
