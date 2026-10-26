import { expect, test } from '@playwright/test'
import { MOCK_WEBM_BASE64 } from '../packages/providers/src/mock/video-fixture'
import { API } from '../packages/protocol/src/api'
import { centerOf, newProject, zoomTo } from './canvas'

test('剪辑内修改输入并生成候选，明确替换一实例，保留原采用和剪辑设置', async ({ page }) => {
  await newProject(page)
  const uploaded = await page.request.post(API.assets, {
    headers: { 'content-type': 'video/webm', 'x-file-name': 'original.webm' },
    data: Buffer.from(MOCK_WEBM_BASE64, 'base64'),
  })
  expect(uploaded.ok()).toBe(true)
  const asset = await uploaded.json()
  const ids = await page.evaluate((assetId) => {
    const source = window.__plein.addNode({
      type: 'plein/video',
      name: '返工来源',
      x: 0,
      y: 0,
      params: { model: 'plein/mock:video', mode: 'text', prompt: '原视频', duration: 2 },
    })
    const sourceMap = window.__plein.engine.doc.mutable(source)! as unknown as {
      set(k: string, v: unknown): void
    }
    sourceMap.set('results', [
      {
        id: 'original-candidate',
        runId: 'fixture-run',
        port: 'video',
        at: 1,
        value: { type: 'video', assetId },
      },
    ])
    sourceMap.set('adopted', 'original-candidate')
    const sequence = window.__plein.addNode({
      type: 'plein/sequence',
      name: '返工序列',
      x: 600,
      y: 0,
      params: { instanceVersion: 2, clips: [], subtitles: false },
    })
    window.__plein.connect([source, 'video'], [sequence, 'clips'])
    const params = window.__plein.engine.doc.mutable(sequence)!.get('params') as {
      get(k: string): unknown
      set(k: string, v: unknown): void
    }
    const raw = (params.get('clips') as Array<Record<string, unknown>>)[0]!
    const first = { ...raw, in: 0.1, out: 0.5, speed: 1.5, sound: 'native', subtitle: '保留字幕' }
    params.set('clips', [first, { ...first, clipInstanceId: 'other-use' }])
    return { source, sequence, first }
  }, asset.id)
  await zoomTo(page, [ids.sequence])
  const p = await centerOf(page, ids.sequence)
  await page.mouse.dblclick(p.x, p.y)
  const editor = page.getByRole('dialog', { name: '序列', exact: true })
  await editor.getByRole('button', { name: '修改并生成候选', exact: true }).click()
  const modal = page.getByRole('dialog', { name: '剪辑片段返工', exact: true })
  await expect(modal).toBeVisible()
  await expect(modal.getByRole('button', { name: '仅替换此剪辑实例', exact: true })).toBeDisabled()
  const generator = modal.getByTestId('generator')
  await generator.getByRole('textbox', { name: '提示词', exact: true }).fill('返工后沿着走廊向前走')
  await generator.getByRole('button', { name: '生成', exact: true }).click()
  const select = modal.getByRole('combobox', { name: '返工视频候选', exact: true })
  await expect(select.locator('option')).toHaveCount(2)
  await generator.getByRole('button', { name: '全屏查看', exact: true }).click()
  const viewer = page.getByRole('dialog', { name: /查看「.*返工草稿/ })
  await expect(viewer).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(viewer).toBeHidden()
  await expect(modal).toBeVisible()
  await select.selectOption({ index: 1 })
  await expect(modal.locator('video')).toHaveCount(2)
  await page.screenshot({ path: test.info().outputPath('sequence-rework-candidates.png') })
  const draftId = await page.evaluate(
    () =>
      [...window.__plein.engine.doc.elements()].find((el) => el.name === '返工来源 · 返工草稿')!.id,
  )
  await page.evaluate(
    (id) =>
      (
        window.__plein.engine.doc.mutable(id)! as unknown as { set(k: string, v: unknown): void }
      ).set('locked', true),
    draftId,
  )
  await expect(modal.getByRole('button', { name: '仅替换此剪辑实例', exact: true })).toBeDisabled()
  await expect(modal.getByTestId('generator')).toHaveCount(0)
  await page.evaluate(
    (id) =>
      (
        window.__plein.engine.doc.mutable(id)! as unknown as { set(k: string, v: unknown): void }
      ).set('locked', false),
    draftId,
  )
  await expect(modal.getByRole('button', { name: '仅替换此剪辑实例', exact: true })).toBeEnabled()
  await modal.getByRole('button', { name: '仅替换此剪辑实例', exact: true }).click()
  await expect(modal).toBeHidden()
  const result = await page.evaluate(({ source, sequence }) => {
    const original = window.__plein.engine.doc.get(source)!
    return {
      adopted: original.adopted,
      prompt: original.params!.prompt,
      clips: window.__plein.engine.doc.get(sequence)!.params!.clips,
    }
  }, ids)
  expect(result.adopted).toBe('original-candidate')
  expect(result.prompt).toBe('原视频')
  const clips = result.clips as Array<Record<string, unknown>>
  expect(clips[0]).toMatchObject({
    in: 0.1,
    out: 0.5,
    speed: 1.5,
    sound: 'native',
    subtitle: '保留字幕',
    segment: { version: 1 },
  })
  expect(clips[1]).toEqual({ ...ids.first, clipInstanceId: 'other-use' })
  await expect(editor).toBeVisible()
})
