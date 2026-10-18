import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import { newProject } from './canvas'

let dir = ''
test.beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'plein-profile-structure-'))
  execFileSync('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'color=c=blue:s=64x64',
    '-frames:v',
    '1',
    join(dir, 'uniform.png'),
  ])
})
test.afterAll(() => rmSync(dir, { recursive: true, force: true }))
async function open(page: Page, name: string) {
  await page.getByRole('button', { name: '资产库', exact: true }).click()
  const panel = page.getByRole('dialog', { name: '资产库', exact: true })
  await panel
    .getByRole('group', { name: '范围' })
    .getByRole('button', { name: '全部', exact: true })
    .click()
  await panel.getByRole('listitem').filter({ hasText: name }).getByRole('button').first().click()
  await panel
    .getByRole('group', { name: '档案分页' })
    .getByRole('button', { name: /^时期与服饰/ })
    .click()
  return panel
}

test('服饰不能移入已满时期，键盘跳过已满选项，往返移动与保存保留完整素材和旧名', async ({
  page,
}) => {
  await newProject(page)
  const asset = await page.request.post('/api/assets', {
    headers: { 'content-type': 'image/png', 'x-file-name': 'uniform.png' },
    data: readFileSync(join(dir, 'uniform.png')),
  })
  const image = (await asset.json()).id
  const outfit = {
    id: 'uniform',
    name: '校服',
    aliases: ['旧校服'],
    description: '蓝白校服',
    images: [image],
  }
  const created = await page.request.post('/api/library', {
    data: {
      kind: 'character',
      name: '服饰移动容量回归',
      profile: {
        periods: [
          { id: 'teen', name: '少年', outfits: [outfit] },
          {
            id: 'youth',
            name: '青年',
            outfits: Array.from({ length: 12 }, (_, i) => ({
              id: `look-${i}`,
              name: `服饰${i + 1}`,
            })),
          },
          { id: 'adult', name: '成年' },
        ],
      },
    },
  })
  expect(created.status()).toBe(201)
  const item = await created.json()
  const panel = await open(page, '服饰移动容量回归')
  await panel.getByRole('button', { name: '少年 · 校服', exact: true }).click()
  const belongs = panel.getByRole('combobox', { name: '属于时期', exact: true })
  await belongs.click()
  const full = page.getByRole('option', { name: /青年/ })
  await expect(full).toHaveAttribute('aria-disabled', 'true')
  await expect(full).toContainText('已满')
  await page.screenshot({
    path: test.info().outputPath('full-period-option.png'),
    animations: 'disabled',
  })
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await expect(belongs).toHaveText('成年')
  await expect(panel.getByRole('button', { name: '成年 · 校服', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(panel.locator('.lib-look-editor .lib-strip-tile img')).toHaveAttribute(
    'src',
    new RegExp(image),
  )
  await panel.getByRole('button', { name: '保存', exact: true }).click()
  await expect(panel.getByRole('button', { name: '已保存', exact: true })).toBeDisabled()
  const first = (await (await page.request.get(`/api/library/${item.id}`)).json()).profile.periods
  expect(first[0].outfits).toEqual([])
  expect(first[1].outfits).toHaveLength(12)
  expect(first[2].outfits).toEqual([outfit])
  await belongs.click()
  await page.getByRole('option', { name: '少年', exact: true }).click()
  await expect(belongs).toHaveText('少年')
  await panel.getByRole('button', { name: '保存', exact: true }).click()
  await expect(panel.getByRole('button', { name: '已保存', exact: true })).toBeDisabled()
  const restored = (await (await page.request.get(`/api/library/${item.id}`)).json()).profile
    .periods
  expect(restored[0].outfits).toEqual([outfit])
  expect(restored[1].outfits).toHaveLength(12)
  expect(restored[2].outfits).toEqual([])
})

test('旧名已满时改名保留最近旧名，保存重开及改回旧名保持引用状态', async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 560 })
  await newProject(page)
  const aliases = Array.from({ length: 8 }, (_, i) => `旧名${7 - i}`)
  const created = await page.request.post('/api/library', {
    data: {
      kind: 'character',
      name: '角色旧名容量回归',
      profile: { periods: [{ id: 'teen', name: '少年', aliases }] },
    },
  })
  const item = await created.json()
  const panel = await open(page, '角色旧名容量回归')
  const name = panel.getByRole('textbox', { name: '时期名', exact: true })
  await name.fill('青年')
  await name.blur()
  await expect(panel.getByText(/旧名 少年、/)).toBeVisible()
  await panel.getByText(/旧名 少年、/).scrollIntoViewIfNeeded()
  await panel.screenshot({
    path: test.info().outputPath('recent-aliases.png'),
    animations: 'disabled',
  })
  await panel.getByRole('button', { name: '保存', exact: true }).click()
  await expect(panel.getByRole('button', { name: '已保存', exact: true })).toBeDisabled()
  const read = async () =>
    (await (await page.request.get(`/api/library/${item.id}`)).json()).profile.periods[0]
  expect((await read()).aliases).toEqual(['少年', ...aliases.slice(0, 7)])
  await panel.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(panel).toBeHidden()
  await open(page, '角色旧名容量回归')
  await expect(name).toHaveValue('青年')
  await expect(panel.getByText(/旧名 少年、/)).toBeVisible()
  await name.fill('少年')
  await name.blur()
  await panel.getByRole('button', { name: '保存', exact: true }).click()
  await expect(panel.getByRole('button', { name: '已保存', exact: true })).toBeDisabled()
  expect(await read()).toMatchObject({ name: '少年', aliases: ['青年', ...aliases.slice(0, 7)] })
})
