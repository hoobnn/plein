import { expect, test } from '@playwright/test'
import type { JobList, PreparedInput } from '../packages/protocol/src/runs'
import { solidPng } from '../packages/providers/src/mock/media'
import { clickElement, newProject, waitNode } from './canvas'
import { openLibraryPanel } from './library-ui'

test('资产库移动服饰并手动同步后，旧名引用生成使用新时期图片和音色', async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 650 })
  await newProject(page)
  const canvas = /#\/c\/([^/?]+)/.exec(page.url())![1]!
  const name = `同步角色 ${canvas}`
  const assets: string[] = []
  for (let i = 0; i < 3; i++) {
    const res = await page.request.post('/api/assets', {
      headers: { 'Content-Type': 'image/png' },
      data: Buffer.from(solidPng(64, 48, [i * 80, 110, 180])),
    })
    expect(res.status()).toBe(201)
    assets.push((await res.json()).id)
  }
  const created = await page.request.post('/api/library', {
    data: {
      kind: 'character',
      name,
      profile: {
        periods: [
          {
            id: 'teen',
            name: '少年',
            images: [assets[0]],
            voice: { provider: 'plein/mock', voiceId: 'mock-female' },
            outfits: [{ id: 'uniform', name: '校服', aliases: ['旧校服'], images: [assets[2]] }],
          },
          {
            id: 'adult',
            name: '成年',
            images: [assets[1]],
            voice: { provider: 'plein/mock', voiceId: 'mock-male' },
          },
        ],
      },
    },
  })
  expect(created.status()).toBe(201)
  const item = await created.json()
  const panel = await openLibraryPanel(page)
  await panel
    .getByRole('group', { name: '范围', exact: true })
    .getByRole('button', { name: '全部', exact: true })
    .click()
  const card = panel.getByRole('listitem').filter({ hasText: name })
  await card.hover()
  await card.getByRole('button', { name: '添加到画布', exact: true }).click()
  await expect(panel).toBeHidden()
  const hero = await page.evaluate(
    (id) => [...window.__plein.engine.doc.elements()].find((el) => el.params?.libraryId === id)!.id,
    item.id,
  )
  const nodes = await page.evaluate(
    ({ hero, name }) => {
      const image = window.__plein.addNode({
        type: 'plein/image',
        name: '移动档案图片',
        x: 900,
        y: 0,
        params: {
          model: 'plein/mock:image',
          prompt: `@${name}/旧校服 走到窗边`,
          requiredRefs: [hero],
        },
      })
      const speech = window.__plein.addNode({
        type: 'plein/speech',
        name: '移动档案配音',
        x: 900,
        y: 500,
        params: { model: 'plein/mock:audio', text: `@${name}/旧校服 你好。` },
      })
      return { image, speech }
    },
    { hero, name },
  )
  const preview = async (node: string) => {
    const res = await page.request.get(`/api/canvases/${canvas}/nodes/${node}/input`)
    expect(res.status()).toBe(200)
    return (await res.json()) as PreparedInput
  }
  const before = await preview(nodes.image)
  expect(before.inputs.references?.map((v) => v.assetId)).toEqual([assets[0], assets[2]])
  expect((await preview(nodes.speech)).voice?.voiceId).toBe('mock-female')
  await openLibraryPanel(page)
  await panel
    .getByRole('group', { name: '范围', exact: true })
    .getByRole('button', { name: '全部', exact: true })
    .click()
  await card.getByRole('button').first().click()
  await panel
    .getByRole('group', { name: '档案分页', exact: true })
    .getByRole('button', { name: /^时期与服饰/ })
    .click()
  await panel.getByRole('button', { name: '少年 · 校服', exact: true }).click()
  await panel.getByRole('combobox', { name: '属于时期', exact: true }).click()
  await page.getByRole('option', { name: '成年', exact: true }).click()
  await expect(panel.getByRole('textbox', { name: '服饰名', exact: true })).toBeFocused()
  await panel.getByRole('button', { name: '保存', exact: true }).click()
  await expect(panel.getByRole('button', { name: '已保存', exact: true })).toBeDisabled()
  // 保存资产库不会擅自改画布，仍需用户选择同步字段。
  expect((await preview(nodes.speech)).voice?.voiceId).toBe('mock-female')
  const updates = panel.getByRole('region', { name: '跨画布资产更新', exact: true })
  await updates.getByRole('button', { name: '查看画布中的版本', exact: true }).click()
  await updates.getByRole('checkbox', { name: '角色档案', exact: true }).check()
  await updates.getByRole('button', { name: '同步选中的字段', exact: true }).click()
  await expect(updates.getByRole('status')).toContainText('选中的卡片已同步')
  await panel.getByRole('button', { name: '关闭', exact: true }).click()
  await expect.poll(async () => (await preview(nodes.speech)).voice?.voiceId).toBe('mock-male')
  const stale = await page.request.post(`/api/canvases/${canvas}/nodes/${nodes.image}/run`, {
    data: { expect: before.inputHash },
  })
  expect(stale.status()).toBe(409)
  for (const node of [nodes.image, nodes.speech]) {
    const input = await preview(node)
    expect(input.status).toBe('ready')
    expect(input.prompt).toContain('成年·校服')
    expect(input.prompt).not.toContain('少年')
    if (node === nodes.image)
      expect(input.inputs.references?.map((v) => v.assetId)).toEqual([assets[1], assets[2]])
    else expect(input.voice?.voiceId).toBe('mock-male')
    await clickElement(page, node)
    const generator = page.getByRole('region', { name: /生成器$/ })
    const edit = generator.getByRole('button', { name: /^编辑/ })
    if (await edit.isVisible()) await edit.click()
    const ui = page.getByTestId('input-preview')
    await expect(ui).toHaveAttribute('aria-busy', 'false')
    await ui.getByRole('button', { name: /实际输入/ }).click()
    await expect(ui).toContainText('成年·校服')
    if (node === nodes.image)
      await expect(ui.locator(`img[src*="${assets[1]}"]`).first()).toBeVisible()
    else await expect(ui).toContainText('mock-male')
    await page.getByRole('button', { name: '生成', exact: true }).click()
    await waitNode(page, node)
    const jobs = (await (await page.request.get(`/api/canvases/${canvas}/jobs`)).json()) as JobList
    expect(
      jobs.jobs.find((job) => job.nodeId === node && job.status === 'succeeded')?.input,
    ).toEqual({ ...input, preparedAt: expect.any(Number) })
    const results = await page.evaluate((id) => window.__plein.engine.doc.get(id)!.results!, node)
    expect(results[0]!.value.type).toBe(node === nodes.image ? 'image' : 'audio')
    await expect(ui).toHaveAttribute('aria-busy', 'false')
    await expect(ui).not.toContainText('正在更新实际输入')
    if (node === nodes.speech) await expect(ui).toContainText('mock-male')
  }
  await page.screenshot({ path: test.info().outputPath('profile-sync-generation.png') })
})
