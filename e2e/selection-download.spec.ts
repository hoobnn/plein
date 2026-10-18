import { readFileSync } from 'node:fs'
import { expect, test, type Download } from '@playwright/test'
import { sineWav, solidPng } from '../packages/providers/src/mock/media'
import { newProject } from './canvas'

test('多选含分组、重复图片和音频时逐个下载原文件，显式选中后代不重复下载', async ({ page }) => {
  await newProject(page)
  const files = [
    { name: '下载红杯', mime: 'image/png', bytes: Buffer.from(solidPng(64, 48, [200, 20, 20])) },
    { name: '下载蓝杯', mime: 'image/png', bytes: Buffer.from(solidPng(64, 48, [20, 20, 200])) },
    { name: '下载提示音', mime: 'audio/wav', bytes: Buffer.from(sineWav(0.2)) },
  ]
  const assets: string[] = []
  for (const file of files) {
    const response = await page.request.post('/api/assets', {
      headers: { 'Content-Type': file.mime },
      data: file.bytes,
    })
    expect(response.status()).toBe(201)
    assets.push(((await response.json()) as { id: string }).id)
  }
  await page.evaluate((assets) => {
    const engine = window.__plein.engine as typeof window.__plein.engine & {
      paste(data: unknown): void
    }
    const base = { rotation: 0, locked: false, x: 0, y: 0, w: 200, h: 150, parentId: null }
    engine.paste({
      plein: 1,
      edges: [],
      elements: [
        { ...base, id: 'frame', kind: 'frame', name: '下载分组', w: 500, h: 250 },
        {
          ...base,
          id: 'red',
          kind: 'image',
          name: '下载红杯',
          assetId: assets[0],
          parentId: 'frame',
        },
        {
          ...base,
          id: 'blue',
          kind: 'image',
          name: '下载蓝杯',
          assetId: assets[1],
          parentId: 'frame',
          x: 240,
        },
        { ...base, id: 'duplicate', kind: 'image', name: '红杯副本', assetId: assets[0], x: 600 },
        { ...base, id: 'audio', kind: 'audio', name: '下载提示音', assetId: assets[2], x: 850 },
      ],
    })
    const all = [...engine.doc.elements()]
    const ids = ['下载分组', '下载红杯', '红杯副本', '下载提示音'].map(
      (name) => all.find((el) => el.name === name)!.id,
    )
    engine.selection.set(ids)
    engine.zoomToFit(ids)
  }, assets)
  const downloads: Download[] = []
  page.on('download', (download) => downloads.push(download))
  const bar = page.getByRole('toolbar', { name: '多选操作', exact: true })
  await bar.getByRole('button', { name: '下载（4）', exact: true }).click()
  await expect.poll(() => downloads.length).toBe(4)
  const expected = new Map([
    ...files.map((file) => [file.name, file.bytes] as const),
    ['红杯副本', files[0]!.bytes] as const,
  ])
  const names: string[] = []
  for (const download of downloads) {
    expect(await download.failure()).toBeNull()
    const name = [...expected.keys()].find((name) => download.suggestedFilename().startsWith(name))!
    expect(name).toBeTruthy()
    names.push(name)
    expect(readFileSync((await download.path())!)).toEqual(expected.get(name))
  }
  expect(names.sort()).toEqual([...expected.keys()].sort())
  await expect(page.locator('.ui-toast')).toContainText('已交给浏览器下载 4 个文件')
})
