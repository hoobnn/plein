import { openLibraryPanel } from './library-ui'
import { expect, type Page, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newProject } from './canvas'

let dir = ''
test.beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'plein-library-sources-'))
  for (const color of ['red', 'blue'])
    execFileSync('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      `color=c=${color}:s=64x48`,
      '-frames:v',
      '1',
      join(dir, `${color}.png`),
    ])
})
test.afterAll(() => rmSync(dir, { recursive: true, force: true }))

async function setup(page: Page) {
  await newProject(page)
  const canvas = await (
    await page.request.get(`/api/canvases/${page.url().split('/').at(-1)}`)
  ).json()
  expect(
    (
      await page.request.patch(`/api/projects/${canvas.projectId}`, { data: { title: '来源甲' } })
    ).ok(),
  ).toBe(true)
  const project = await (
    await page.request.post('/api/projects', { data: { title: '来源乙' } })
  ).json()
  const ids: string[] = []
  const assets: string[] = []
  for (const color of ['red', 'blue']) {
    const response = await page.request.post('/api/assets', {
      headers: { 'content-type': 'image/png', 'x-file-name': `${color}.png` },
      data: readFileSync(join(dir, `${color}.png`)),
    })
    expect(response.status()).toBe(201)
    assets.push((await response.json()).id)
  }
  const prefix = canvas.projectId.slice(-6)
  const name = `同名水杯 ${prefix}`
  for (const [projectId, description] of [
    [canvas.projectId, '透明玻璃'],
    [project.id, '金属杯身'],
    [null, '陶瓷杯身'],
  ] as const) {
    const response = await page.request.post('/api/library', {
      data: {
        kind: 'prop',
        name,
        description,
        projectId,
        images: ids.length < 2 ? [{ slot: 'main', assetId: assets[ids.length] }] : [],
      },
    })
    expect(response.status()).toBe(201)
    ids.push((await response.json()).id)
  }
  const open = async () => {
    await openLibraryPanel(page)
    const panel = page.getByRole('dialog', { name: '资产库', exact: true })
    await panel
      .getByRole('group', { name: '资产类别', exact: true })
      .getByRole('button', { name: '道具', exact: true })
      .click()
    await panel
      .getByRole('group', { name: '范围', exact: true })
      .getByRole('button', { name: '全部', exact: true })
      .click()
    await panel.getByRole('searchbox', { name: '搜索道具', exact: true }).fill(name)
    return panel
  }
  return { ids, assets, open, other: project.id, current: canvas.projectId, prefix, name }
}

test('跨项目同名资产显示来源，按来源选择后放入正确设定', async ({ page }) => {
  const f = await setup(page)
  const panel = await f.open()
  const cards = panel.getByRole('listitem')
  await expect(cards.filter({ hasText: '来源甲' })).toHaveCount(1)
  await expect(cards.filter({ hasText: '来源乙' })).toHaveCount(1)
  await expect(cards.filter({ hasText: '未归属项目' })).toHaveCount(1)
  let target = cards.filter({ hasText: '来源乙' })
  await target.getByRole('button').first().click()
  await expect(
    panel.getByRole('checkbox', { name: '保留在来源项目（不勾选则不归属任何项目）', exact: true }),
  ).toBeChecked()
  await panel.getByRole('textbox', { name: '名称', exact: true }).fill(`乙的水杯 ${f.prefix}`)
  await panel.getByRole('button', { name: '保存', exact: true }).click()
  await expect(panel.getByRole('button', { name: '已保存', exact: true })).toBeDisabled()
  expect((await (await page.request.get(`/api/library/${f.ids[1]}`)).json()).projectId).toBe(
    f.other,
  )
  await panel.getByRole('button', { name: '返回', exact: true }).click()
  await expect(target).toHaveCount(0)
  await panel.getByRole('searchbox', { name: '搜索道具', exact: true }).fill(f.prefix)
  await cards.filter({ hasText: '来源甲' }).getByRole('button').first().click()
  await panel.getByRole('button', { name: '删除', exact: true }).click()
  const confirm = page.getByRole('dialog', { name: `删除道具「${f.name}」？`, exact: true })
  await confirm.getByRole('button', { name: '删除', exact: true }).click()
  await expect(confirm).toHaveCount(0)
  await expect(cards.filter({ hasText: '来源甲' })).toHaveCount(0)
  await page.setViewportSize({ width: 390, height: 700 })
  target = cards.filter({ hasText: '来源乙' })
  await target.scrollIntoViewIfNeeded()
  await expect(target.locator('.lib-card-cover img')).toHaveAttribute(
    'src',
    new RegExp(f.assets[1]!),
  )
  await expect
    .poll(() =>
      target
        .locator('.lib-card-cover img')
        .evaluate(
          (img) => (img as HTMLImageElement).complete && (img as HTMLImageElement).naturalWidth > 0,
        ),
    )
    .toBe(true)
  await target.hover()
  await panel.screenshot({
    path: test.info().outputPath('library-sources-390.png'),
    animations: 'disabled',
  })
  await target.getByRole('button', { name: '添加到画布', exact: true }).click()
  await expect(panel).toBeHidden()
  await expect
    .poll(async () =>
      page.evaluate(() =>
        [...window.__plein.engine.doc.elements()]
          .filter((e) => e.nodeType === 'plein/prop')
          .map((e) => ({ id: e.params?.libraryId, description: e.params?.description })),
      ),
    )
    .toEqual([{ id: f.ids[1], description: '金属杯身' }])
  expect(
    await page.evaluate((id) => {
      const doc = window.__plein.engine.doc
      const node = [...doc.elements()].find((e) => e.params?.libraryId === id)!
      return [...doc.edges()]
        .filter((edge) => edge.to[0] === node.id)
        .map((edge) => doc.get(edge.from[0])?.assetId)
    }, f.ids[1]!),
  ).toEqual([f.assets[1]])
})

test('项目重名时来源标记保持可区分，项目改名后重新打开可刷新', async ({ page }) => {
  const f = await setup(page)
  expect(
    (await page.request.patch(`/api/projects/${f.other}`, { data: { title: '来源甲' } })).ok(),
  ).toBe(true)
  let panel = await f.open()
  const a = panel.locator(`[data-library-id="${f.ids[0]}"] .text-ink-subtle`).last()
  const b = panel.locator(`[data-library-id="${f.ids[1]}"] .text-ink-subtle`).last()
  await expect(a).toContainText('来源甲 · ')
  await expect(b).toContainText('来源甲 · ')
  expect(await a.textContent()).not.toBe(await b.textContent())
  await panel.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(panel).toHaveCount(0)
  expect(
    (await page.request.patch(`/api/projects/${f.other}`, { data: { title: '来源改名' } })).ok(),
  ).toBe(true)
  panel = await f.open()
  await expect(panel.getByRole('listitem').filter({ hasText: '来源改名' })).toHaveCount(1)
})

test('项目来源读取失败可重试，资产仍可浏览且恢复后显示真实项目名', async ({ page }) => {
  const f = await setup(page)
  await page.route('**/api/projects', (route) =>
    route.fulfill({ status: 503, json: { message: '项目列表暂不可用' } }),
  )
  const panel = await f.open()
  await expect(panel.getByText('来源项目读取失败，可重试更新名称。', { exact: true })).toBeVisible()
  await expect(panel.locator(`[data-library-id="${f.ids[1]}"]`)).toBeVisible()
  await page.unroute('**/api/projects')
  await panel.getByRole('button', { name: '重试来源项目', exact: true }).click()
  await expect(panel.getByRole('listitem').filter({ hasText: '来源乙' })).toHaveCount(1)
  await expect(panel.getByText('来源项目读取失败，可重试更新名称。', { exact: true })).toHaveCount(
    0,
  )
})

test('解除来源归属再归到当前项目，列表和实际记录保持一致', async ({ page }) => {
  const f = await setup(page)
  const panel = await f.open()
  const card = panel.locator(`[data-library-id="${f.ids[1]}"]`)
  await card.getByRole('button').first().click()
  await panel
    .getByRole('checkbox', { name: '保留在来源项目（不勾选则不归属任何项目）', exact: true })
    .uncheck()
  await panel.getByRole('button', { name: '保存', exact: true }).click()
  await expect(panel.getByRole('button', { name: '已保存', exact: true })).toBeDisabled()
  expect((await (await page.request.get(`/api/library/${f.ids[1]}`)).json()).projectId).toBeNull()
  const current = panel.getByRole('checkbox', { name: /^归到当前项目/ })
  await expect(current).not.toBeChecked()
  await current.check()
  await panel.getByRole('button', { name: '保存', exact: true }).click()
  await expect(panel.getByRole('button', { name: '已保存', exact: true })).toBeDisabled()
  expect((await (await page.request.get(`/api/library/${f.ids[1]}`)).json()).projectId).toBe(
    f.current,
  )
  await panel.getByRole('button', { name: '返回', exact: true }).click()
  await expect(card).toContainText('来源甲')
})

for (const action of ['保存', '保存并添加到画布'] as const) {
  test(`解除归属 ${action} 期间重新勾选来源，不能静默改成当前项目`, async ({ page }) => {
    const f = await setup(page)
    const panel = await f.open()
    await panel.locator(`[data-library-id="${f.ids[1]}"]`).getByRole('button').first().click()
    if (action !== '保存') await page.setViewportSize({ width: 390, height: 700 })
    let release!: () => void, arrived!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const stored = new Promise<void>((resolve) => {
      arrived = resolve
    })
    let writes = 0
    await page.route(`**/api/library/${f.ids[1]}`, async (route) => {
      if (route.request().method() !== 'PATCH' || writes++ > 0) return route.continue()
      const response = await route.fetch()
      arrived()
      await gate
      await route.fulfill({ response })
    })
    try {
      const association = panel.getByRole('checkbox')
      await association.uncheck()
      await panel.getByRole('button', { name: action, exact: true }).click()
      await stored
      await association.check()
      release()
      const save = panel.getByRole('button', { name: '保存', exact: true })
      await expect(save).toBeEnabled()
      const retained = panel.getByRole('checkbox', {
        name: '保留在来源项目（不勾选则不归属任何项目）',
        exact: true,
      })
      await expect(retained).toBeChecked()
      if (action !== '保存') {
        await expect(
          panel.getByText('已保存提交时的内容，仍有新修改，请再次保存后添加到画布。', {
            exact: true,
          }),
        ).toBeVisible()
        await expect(retained).toBeInViewport({ ratio: 1 })
        expect(await page.evaluate(() => [...window.__plein.engine.doc.elements()].length)).toBe(0)
        await panel.screenshot({ path: test.info().outputPath('ownership-pending-390.png') })
      }
      await panel.getByRole('button', { name: action, exact: true }).click()
      if (action === '保存')
        await expect(panel.getByRole('button', { name: '已保存', exact: true })).toBeDisabled()
      else await expect(panel).toBeHidden()
      expect((await (await page.request.get(`/api/library/${f.ids[1]}`)).json()).projectId).toBe(
        f.other,
      )
    } finally {
      release()
    }
  })
}
