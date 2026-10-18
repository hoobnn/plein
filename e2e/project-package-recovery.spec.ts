import { expect, type Route, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import type { ProjectPackageManifest } from '../packages/protocol/src/project-package'
import { newProject, waitEngine, waitNode } from './canvas'

const { strFromU8, unzipSync } = createRequire(
  new URL('../apps/server/package.json', import.meta.url),
)('fflate') as {
  strFromU8(data: Uint8Array): string
  unzipSync(data: Uint8Array): Record<string, Uint8Array>
}

test('导出统计失败可重试，默认仅打包采用项，历史开关实际增加候选，导入保留选中项', async ({
  page,
}) => {
  await newProject(page)
  const name = `项目包恢复 ${Date.now()}`
  await page.getByTitle('重命名项目').click()
  await page.getByRole('textbox').fill(name)
  await page.keyboard.press('Enter')
  await expect(page.getByRole('button', { name, exact: true })).toBeVisible()
  const id = await page.evaluate(() =>
    window.__plein.addNode({
      type: 'plein/image',
      name: '双候选水杯',
      params: { model: 'plein/mock:image', prompt: '两个水杯', count: 2 },
      x: 400,
      y: 200,
    }),
  )
  const canvas = /#\/c\/([^/?]+)/.exec(page.url())![1]
  expect(
    (await page.request.post(`/api/canvases/${canvas}/nodes/${id}/run`, { data: {} })).status(),
  ).toBe(202)
  await waitNode(page, id)
  const adopted = await page.evaluate((id) => window.__plein.engine.doc.get(id)?.adopted, id)
  await page.goto('/')
  let failing = true
  let pending: Route | undefined
  let holding = false
  let exports = 0
  page.on('request', (request) => {
    if (/\/projects\/[^/]+\/package(?:\?|$)/.test(request.url())) exports++
  })
  await page.route('**/api/projects/*/package/summary*', (route) =>
    failing
      ? route.fulfill({ status: 503, json: { message: '项目统计暂不可用' } })
      : holding
        ? void (pending = route)
        : route.continue(),
  )
  const card = page
    .getByRole('listitem')
    .filter({ has: page.getByRole('link', { name, exact: true }) })
  await card.hover()
  await card.getByRole('button', { name: '导出项目包', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '导出项目包', exact: true })
  await expect(dialog).toContainText('读取失败：项目统计暂不可用')
  await expect(dialog.getByRole('button', { name: '导出', exact: true })).toBeDisabled()
  failing = false
  holding = true
  await dialog.getByRole('button', { name: '重新统计', exact: true }).click()
  await expect.poll(() => !!pending).toBe(true)
  await expect(dialog).toContainText('正在统计…')
  await expect(dialog.getByRole('button', { name: '导出', exact: true })).toBeDisabled()
  expect(exports).toBe(0)
  holding = false
  await pending!.continue()
  await expect(dialog).toContainText('1 个素材')
  await expect(dialog).not.toContainText('读取失败')
  expect(exports).toBe(0)
  await dialog.screenshot({ path: test.info().outputPath('export-summary-recovered.png') })
  const downloaded = page.waitForEvent('download')
  await dialog.getByRole('button', { name: '导出', exact: true }).click()
  const download = await downloaded
  expect(await download.failure()).toBeNull()
  const file = (await download.path())!
  const manifest = (path: string) =>
    JSON.parse(strFromU8(unzipSync(readFileSync(path))['manifest.json']!)) as ProjectPackageManifest
  expect(manifest(file).candidates).toBe('current')
  expect(manifest(file).assets).toHaveLength(1)
  await page.getByTestId('project-import-input').setInputFiles(file)
  const preview = page.getByRole('dialog', { name: `导入「${name}」`, exact: true })
  await expect(preview).toContainText('1 个素材')
  await preview.getByRole('button', { name: '作为副本导入', exact: true }).click()
  await waitEngine(page)
  await expect(page.getByRole('button', { name: `${name}（副本）`, exact: true })).toBeVisible()
  await expect
    .poll(() => page.evaluate((id) => window.__plein.engine.doc.get(id)?.results?.length, id))
    .toBe(1)
  expect(await page.evaluate((id) => window.__plein.engine.doc.get(id)?.adopted, id)).toBe(adopted)
  await page.goto('/')
  await card.hover()
  await card.getByRole('button', { name: '导出项目包', exact: true }).click()
  await dialog.getByRole('switch', { name: '包含历史候选', exact: true }).click()
  await expect(dialog).toContainText('2 个素材')
  const allDownload = page.waitForEvent('download')
  await dialog.getByRole('button', { name: '导出', exact: true }).click()
  const all = await allDownload
  expect(await all.failure()).toBeNull()
  expect(manifest((await all.path())!).candidates).toBe('all')
  expect(manifest((await all.path())!).assets).toHaveLength(2)
})
