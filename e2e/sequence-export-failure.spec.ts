import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from './fixtures'
import { centerOf, clickElement, newProject, waitNode } from './canvas'
import { slowFile } from './slow-file'

let dir = ''
test.beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'plein-export-failure-'))
  for (const color of ['blue', 'orange'])
    execFileSync('ffmpeg', [
      '-hide_banner',
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      `color=c=${color}:s=160x90`,
      '-frames:v',
      '1',
      join(dir, `${color}.png`),
    ])
})
test.afterAll(() => rmSync(dir, { recursive: true, force: true }))

for (const mode of ['corrupt', 'missing'] as const)
  test(`真实导出 ${mode} 失败可读可定位，保留旧成片，切换有效素材后重新导出`, async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 560 })
    await newProject(page)
    const assets: string[] = []
    for (const color of ['blue', 'orange']) {
      const response = await page.request.post('/api/assets', {
        headers: { 'content-type': 'image/png', 'x-file-name': `${color}.png` },
        data: readFileSync(join(dir, `${color}.png`)),
      })
      expect(response.status()).toBe(201)
      assets.push((await response.json()).id)
    }
    const ids = await page.evaluate(
      ({ blue, orange }) => {
        const board = window.__plein.addNode({
          type: 'plein/storyboard',
          name: '失败恢复分镜',
          x: 0,
          y: 200,
          params: { shots: [{ id: 'one', no: 1, duration: 1 }] },
        })
        const image = window.__plein.addNode({
          type: 'plein/image',
          name: '可切换分镜图',
          x: 800,
          y: 200,
          params: { source: { storyboard: board, shot: 'one', role: 'image' } },
        })
        const node = window.__plein.engine.doc.mutable(image)! as unknown as {
          set(k: string, v: unknown): void
        }
        node.set(
          'results',
          [blue, orange].map((assetId, i) => ({
            id: `candidate-${i}`,
            runId: `fixture-${i}`,
            port: 'images',
            at: i,
            value: { type: 'image', assetId },
          })),
        )
        node.set('adopted', 'candidate-0')
        return { board, image }
      },
      { blue: assets[0]!, orange: assets[1]! },
    )
    const open = async (id: string) => {
      await clickElement(page, id)
      const at = await centerOf(page, id)
      await page.mouse.dblclick(at.x, at.y)
    }
    await open(ids.board)
    await page.getByRole('button', { name: '节奏样片', exact: true }).click()
    const editor = page.getByRole('dialog', { name: '序列', exact: true })
    const id = await page.evaluate(
      () =>
        [...window.__plein.engine.doc.elements()].find((el) => el.nodeType === 'plein/animatic')!
          .id,
    )
    const duration = editor.getByRole('spinbutton', { name: '样片镜头时长（秒）', exact: true })
    await duration.fill('0.5')
    await duration.blur()
    await editor.getByRole('button', { name: '导出样片 MP4', exact: true }).click()
    await waitNode(page, id)
    const read = () =>
      page.evaluate((id) => {
        const el = window.__plein.engine.doc.get(id)!
        return { adopted: el.adopted, results: el.results, deliveries: el.deliveries }
      }, id)
    const previous = await read()
    await editor.getByRole('button', { name: '样片编辑预览', exact: true }).click()
    await duration.fill('0.7')
    await duration.blur()
    const file = join(process.env.PLEIN_E2E_DATA!, 'assets', assets[0]!.slice(0, 2), assets[0]!)
    const original = readFileSync(file)
    try {
      // 只破坏隔离测试资产，模拟本地原文件损坏；finally 恢复，避免影响其他用例。
      if (mode === 'missing') unlinkSync(file)
      else writeFileSync(file, 'damaged image for export recovery')
      await editor.getByRole('button', { name: '重新导出', exact: true }).click()
      const canvas = /#\/c\/([^/?]+)/.exec(page.url())![1]
      const jobs = async () =>
        (await (await page.request.get(`/api/canvases/${canvas}/jobs`)).json()).jobs
      await expect.poll(async () => (await jobs()).length).toBe(2)
      await expect.poll(async () => (await jobs())[0].status).toBe('failed')
      const error = (await jobs())[0].error as string
      if (mode === 'corrupt') expect(error).toMatch(/unsupported image format/i)
      else expect(error).toContain(assets[0])
      expect(await read()).toEqual(previous)
      const oldAsset = previous.results!.find((r) => r.id === previous.adopted)!
      const oldFile = await page.request.get(`/api/assets/${oldAsset.value.assetId}`)
      expect(oldFile.ok()).toBe(true)
      const oldPath = join(dir, 'retained.mp4')
      writeFileSync(oldPath, await oldFile.body())
      const oldProbe = JSON.parse(
        execFileSync(
          'ffprobe',
          ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', oldPath],
          { encoding: 'utf8' },
        ),
      )
      expect(Number(oldProbe.format.duration)).toBeCloseTo(0.5, 1)
      const failure = editor.getByRole('alert', { name: '成片导出失败', exact: true })
      await expect(failure).toContainText('已有成片与交付记录已保留')
      await failure.getByText('查看错误详情', { exact: true }).focus()
      await page.keyboard.press('Enter')
      await expect(failure.locator('pre')).toHaveText(error)
      await expect(failure.locator('pre')).toHaveCSS('user-select', 'text')
      expect(await failure.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
      await page.setViewportSize({ width: 390, height: 700 })
      await expect(editor.getByRole('button', { name: '关闭', exact: true })).toBeInViewport()
      expect(await failure.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
      await editor.screenshot({
        path: test.info().outputPath('export-failure-390.png'),
        animations: 'disabled',
      })
      await editor.getByRole('button', { name: '关闭', exact: true }).click()
      await expect(editor).not.toBeVisible()
      await page.getByRole('button', { name: '故事板', exact: true }).click()
      await page.getByRole('button', { name: '查看可切换分镜图', exact: true }).click()
      const viewer = page.getByRole('dialog', { name: '查看「可切换分镜图」', exact: true })
      await viewer.getByRole('button', { name: '预览下一个候选', exact: true }).click()
      await viewer.getByRole('button', { name: '采用此候选', exact: true }).click()
      await page.keyboard.press('Escape')
      await expect(viewer).not.toBeVisible()
      await page.getByRole('button', { name: '工作流', exact: true }).click()
      await open(id)
      await editor.getByRole('button', { name: '更新已有素材', exact: true }).click()
      expect(
        await page.evaluate(
          (id) =>
            (
              window.__plein.engine.doc.get(id)!.params!.shots as Array<{ imageAssetId: string }>
            )[0]!.imageAssetId,
          id,
        ),
      ).toBe(assets[1])
      await editor.getByRole('button', { name: '重新导出', exact: true }).click()
      await expect(failure).toHaveCount(0)
      await expect.poll(async () => (await jobs()).length).toBe(3)
      await expect.poll(async () => (await jobs())[0].status).toBe('succeeded')
      await waitNode(page, id)
      const after = await read()
      expect(after.results).toHaveLength(2)
      expect(after.deliveries).toHaveLength(2)
      expect(after.results!.some((r) => r.id === previous.results![0]!.id)).toBe(true)
      const result = after.results!.find((r) => r.id === after.adopted)!
      const response = await page.request.get(`/api/assets/${result.value.assetId}`)
      expect(response.ok()).toBe(true)
      const output = join(dir, 'recovered.mp4')
      writeFileSync(output, await response.body())
      const rgb = execFileSync('ffmpeg', [
        '-v',
        'error',
        '-i',
        output,
        '-vf',
        'scale=1:1,format=rgb24',
        '-frames:v',
        '1',
        '-f',
        'rawvideo',
        'pipe:1',
      ])
      expect(rgb[0]).toBeGreaterThan(200)
      expect(rgb[1]).toBeGreaterThan(80)
      expect(rgb[2]).toBeLessThan(60)
    } finally {
      writeFileSync(file, original)
    }
  })

// 这批用例要跑真实渲染、编码或很大的工程，单条本来就慢
slowFile(test)
