import { expect, type Page, test } from '@playwright/test'
import type { JobList, PreparedInput } from '../packages/protocol/src/runs'
import { solidPng } from '../packages/providers/src/mock/media'
import { clickElement, newProject, waitEngine, waitNode } from './canvas'
import { openLibraryPanel } from './library-ui'

async function fixture(page: Page) {
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
            voiceStates: [
              {
                id: 'sick',
                name: '生病',
                voice: { provider: 'plein/mock', voiceId: 'mock-uncle' },
              },
            ],
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
  const editProfile = async () => {
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
  }
  const syncProfile = async () => {
    await panel.getByRole('button', { name: '保存', exact: true }).click()
    await expect(panel.getByRole('button', { name: '已保存', exact: true })).toBeDisabled()
    const updates = panel.getByRole('region', { name: '跨画布资产更新', exact: true })
    const open = updates.getByRole('button', { name: '查看画布中的版本', exact: true })
    if ((await open.getAttribute('aria-expanded')) !== 'true') await open.click()
    await updates.getByRole('checkbox', { name: '角色档案', exact: true }).check()
    await updates.getByRole('button', { name: '同步选中的字段', exact: true }).click()
    await expect(updates.getByRole('status').filter({ hasText: '选中的卡片已同步' })).toBeVisible()
    await panel.getByRole('button', { name: '关闭', exact: true }).click()
  }
  return { canvas, name, assets, panel, card, nodes, preview, before, editProfile, syncProfile }
}

test('资产库移动服饰并手动同步后，旧名引用生成使用新时期图片和音色', async ({ page }) => {
  const { canvas, assets, panel, card, nodes, preview, before } = await fixture(page)
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
  await expect(updates.getByRole('status').filter({ hasText: '选中的卡片已同步' })).toBeVisible()
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

test('服饰改名保留旧引用，删除后的必需引用明确阻断，修复与候选切换保留历史输入', async ({
  page,
}) => {
  const f = await fixture(page)
  const node = f.nodes.image
  const openInput = async () => {
    await clickElement(page, node)
    const generator = page.getByTestId('generator')
    const expand = generator.getByRole('button', { name: /^编辑/ })
    if (await expand.isVisible()) await expand.click()
    const input = page.getByTestId('input-preview')
    const toggle = input.getByRole('button', { name: /实际输入/ })
    if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click()
    return { generator, input }
  }
  let ui = await openInput()
  await ui.generator.getByRole('button', { name: '生成', exact: true }).click()
  await waitNode(page, node)
  const original = await page.evaluate(
    (id) => window.__plein.engine.doc.get(id)!.results![0]!,
    node,
  )
  const readJobs = async () =>
    (await (await page.request.get(`/api/canvases/${f.canvas}/jobs`)).json()) as JobList
  const oldJob = (await readJobs()).jobs.find((job) => job.nodeId === node)!
  expect(oldJob.input?.inputs.references?.map((v) => v.assetId)).toEqual([f.assets[0], f.assets[2]])

  await f.editProfile()
  await f.panel.getByRole('button', { name: '少年 · 校服', exact: true }).click()
  const outfitName = f.panel.getByRole('textbox', { name: '服饰名', exact: true })
  await outfitName.fill('便装')
  await outfitName.press('Enter')
  await f.syncProfile()
  const renamed = await f.preview(node)
  expect(renamed.status).toBe('ready')
  expect(renamed.prompt).toContain('少年·便装')
  expect(renamed.inputs.references).toEqual(f.before.inputs.references)
  expect(renamed.notices).toEqual([])
  ui = await openInput()
  await expect(ui.generator.locator('mark.plein-mention')).toHaveAttribute('data-state', 'resolved')
  await expect(ui.input).toContainText('少年·便装')

  await f.editProfile()
  await f.panel.getByRole('button', { name: '少年 · 便装', exact: true }).click()
  await f.panel.getByRole('button', { name: '删除服饰「便装」', exact: true }).click()
  await f.syncProfile()
  const deleted = await f.preview(node)
  expect(deleted.status).toBe('blocked')
  expect(deleted.notices).toContainEqual(expect.objectContaining({ code: 'profile_miss' }))
  expect(deleted.blocked).toContainEqual(expect.objectContaining({ code: 'required_no_image' }))
  ui = await openInput()
  await expect(ui.generator.locator('mark.plein-mention')).toHaveAttribute('data-state', 'warning')
  await expect(ui.input).toContainText('档案里没有「旧校服」')
  await expect(ui.generator.getByRole('button', { name: '重新生成', exact: true })).toBeDisabled()
  expect((await readJobs()).jobs).toHaveLength(1)

  await ui.generator
    .getByRole('textbox', { name: '提示词', exact: true })
    .fill(`@${f.name}/少年 走到窗边`)
  await expect(ui.input).not.toContainText('不会提交')
  await expect(ui.generator.getByRole('button', { name: '重新生成', exact: true })).toBeEnabled()
  const fixed = await f.preview(node)
  expect(fixed.inputs.references?.map((v) => v.assetId)).toEqual([f.assets[0]])
  await ui.generator.getByRole('button', { name: '重新生成', exact: true }).click()
  await expect
    .poll(() => page.evaluate((id) => window.__plein.engine.doc.get(id)!.results!.length, node))
    .toBe(2)
  await waitNode(page, node)
  const jobs = (await readJobs()).jobs
  expect(jobs.find((job) => job.id === oldJob.id)?.input).toEqual(oldJob.input)
  expect(
    jobs.find((job) => job.id !== oldJob.id)?.input?.inputs.references?.map((v) => v.assetId),
  ).toEqual([f.assets[0]])
  const adopted = () => page.evaluate((id) => window.__plein.engine.doc.get(id)!.adopted, node)
  const current = await adopted()
  // 编辑器固定在卡片下方，不再有收起模式；候选直接在卡片上翻，
  // 翻到的按钮要够得着。
  const next = page.locator('.plein-node').getByRole('button', { name: '下一个结果', exact: true })
  await expect(next).toBeInViewport({ ratio: 1 })
  await page.screenshot({ path: test.info().outputPath('collapsed-editor-candidate.png') })
  await next.click()
  const viewer = page.getByRole('dialog', { name: '查看「移动档案图片」', exact: true })
  await viewer.getByRole('button', { name: '采用此候选', exact: true }).click()
  await expect.poll(adopted).toBe(original.id)
  await viewer.getByRole('button', { name: '关闭', exact: true }).click()
  await page.getByRole('button', { name: '撤销', exact: true }).click()
  await expect.poll(adopted).toBe(current)
  await page.getByRole('button', { name: '重做', exact: true }).click()
  await expect.poll(adopted).toBe(original.id)
  await page.reload()
  await waitEngine(page)
  await expect.poll(adopted).toBe(original.id)
  expect((await f.preview(node)).inputHash).toBe(fixed.inputHash)
  expect((await readJobs()).jobs.find((job) => job.id === oldJob.id)?.input).toEqual(oldJob.input)
})

test('服饰与次音色同时跨时期冲突时逐项说明，实际图片与配音只用指定时期', async ({ page }) => {
  const f = await fixture(page)
  for (const node of [f.nodes.image, f.nodes.speech]) {
    await clickElement(page, node)
    const generator = page.getByTestId('generator')
    const expand = generator.getByRole('button', { name: /^编辑/ })
    if (await expand.isVisible()) await expand.click()
    await generator
      .getByRole('textbox', { name: '提示词', exact: true })
      .fill(`@${f.name}/成年/旧校服/生病 走到窗边。`)
    const input = page.getByTestId('input-preview')
    const toggle = input.getByRole('button', { name: /实际输入/ })
    if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click()
    await expect(input).toContainText('已忽略服饰「校服」')
    await expect(input).toContainText('已忽略次音色「生病」')
    await expect(input).toContainText('与「成年」时期不一致')
    const notice = input.locator('li').filter({ hasText: '已忽略服饰「校服」' })
    await notice.evaluate((el) => el.scrollIntoView({ block: 'center' }))
    await page.screenshot({
      path: test
        .info()
        .outputPath(`${node === f.nodes.image ? 'image' : 'speech'}-profile-conflicts.png`),
    })
    await expect(generator.locator('mark.plein-mention')).toHaveAttribute('data-state', 'warning')
    const prepared = await f.preview(node)
    expect(prepared.status).toBe('ready')
    expect(prepared.prompt).toContain('（成年）')
    expect(prepared.prompt).not.toContain('校服')
    expect(prepared.prompt).not.toContain('生病')
    expect(prepared.notices.filter((n) => n.code === 'profile_conflict')).toHaveLength(1)
    if (node === f.nodes.image)
      expect(prepared.inputs.references?.map((v) => v.assetId)).toEqual([f.assets[1]])
    else expect(prepared.voice?.voiceId).toBe('mock-male')
    await generator.getByRole('button', { name: '生成', exact: true }).click()
    await waitNode(page, node)
    const jobs = (await (
      await page.request.get(`/api/canvases/${f.canvas}/jobs`)
    ).json()) as JobList
    expect(jobs.jobs.find((job) => job.nodeId === node)?.input).toEqual({
      ...prepared,
      preparedAt: expect.any(Number),
    })
  }
})
