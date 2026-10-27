import { execFileSync } from 'node:child_process'
import { expect, test, type Page } from './fixtures'
import { centerOf, newProject, zoomTo } from './canvas'

async function localReport(page: Page) {
  await newProject(page)
  const bytes = execFileSync('ffmpeg', [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=blue:s=96x64:r=10:d=3',
    '-c:v',
    'libx264',
    '-movflags',
    'frag_keyframe+empty_moov',
    '-f',
    'mp4',
    'pipe:1',
  ])
  const upload = await page.request.post('/api/assets', {
    headers: { 'Content-Type': 'video/mp4' },
    data: bytes,
  })
  expect(upload.status()).toBe(201)
  const assetId = (await upload.json()).id as string
  const node = await page.evaluate((assetId) => {
    const engine = window.__plein.engine as typeof window.__plein.engine & {
      paste(value: unknown): void
    }
    engine.paste({
      plein: 1,
      edges: [],
      elements: [
        { id: 'source', kind: 'video', assetId, x: 100, y: 200, w: 260, h: 180, parentId: null },
      ],
    })
    const source = [...engine.doc.elements()].find((item) => item.assetId === assetId)!.id
    const node = window.__plein.addNode({
      type: 'plein/shot-analysis',
      name: 'P09本地依据',
      params: { cutPlan: { sourceAssetId: assetId, points: [1, 2] } },
      x: 500,
      y: 200,
    })
    window.__plein.connect([source, 'video'], [node, 'video'])
    return node
  }, assetId)
  const canvasId = new URL(page.url()).hash.split('/').at(-1)!
  await expect
    .poll(async () =>
      (await page.request.get(`/api/canvases/${canvasId}/nodes/${node}/input`)).status(),
    )
    .toBe(200)
  expect((await page.request.post(`/api/canvases/${canvasId}/nodes/${node}/run`)).status()).toBe(
    202,
  )
  await expect
    .poll(() =>
      page.evaluate((node) => window.__plein.engine.doc.get(node)?.results?.length ?? 0, node),
    )
    .toBe(1)
  await zoomTo(page, [node])
  const at = await centerOf(page, node)
  await page.mouse.click(at.x, at.y)
  await page.getByRole('button', { name: '打开拉片清单', exact: true }).click()
  const report = page.getByRole('dialog', { name: '本地拉片', exact: true })
  await report
    .getByRole('button', { name: '可选 AI 分析与分镜草稿（默认关闭）', exact: true })
    .click()
  const panel = page.getByRole('dialog', { name: 'AI 拉片草稿', exact: true })
  await expect(panel).toBeVisible()
  await expect(panel.getByRole('img')).toHaveCount(3)
  return {
    node,
    canvasId,
    report,
    panel,
  }
}

test('P09默认零调用、明确预检逐镜和独立归纳、独立可编辑草稿及锁定查看', async ({ page }) => {
  const { node, report, panel } = await localReport(page)
  let runPosts = 0
  page.on('request', (request) => {
    if (request.method() === 'POST' && /\/nodes\/[^/]+\/run$/.test(request.url())) runPosts++
  })
  await expect(panel.getByLabel('逐镜视觉模型', { exact: true })).toHaveValue('')
  await expect(
    panel.getByRole('button', { name: '建立所选逐镜计划（零调用）', exact: true }),
  ).toBeDisabled()
  await expect(panel.getByRole('img')).toHaveCount(3)
  for (const checkbox of await panel.getByRole('checkbox').all()) await checkbox.check()
  await panel.getByLabel('逐镜视觉模型', { exact: true }).selectOption('plein/mock:agent-vision')
  await panel.getByLabel('分析重点', { exact: true }).fill('仅描述光影，声音与完整运动未知')
  await panel.getByRole('button', { name: '建立所选逐镜计划（零调用）', exact: true }).click()
  await expect(panel.getByRole('region', { name: '待确认分析计划', exact: true })).toContainText(
    '本计划 3 个作业',
  )
  expect(runPosts).toBe(0)
  await expect(
    panel.getByRole('button', { name: '确认运行本计划（可能计费）', exact: true }),
  ).toBeDisabled()
  await panel.getByRole('button', { name: '预检实际输入与费用', exact: true }).click()
  await expect(
    panel.getByRole('button', { name: '确认运行本计划（可能计费）', exact: true }),
  ).toBeEnabled()
  await expect(panel.getByText('输入/输出 token、图片费用与恢复提交费用未知。')).toHaveCount(3)
  await panel.getByText('完整固定请求、具体采样与重点', { exact: true }).first().click()
  await expect(panel.getByRole('region', { name: '待确认分析计划', exact: true })).toContainText(
    '仅描述光影',
  )
  expect(runPosts).toBe(0)
  await page.screenshot({ path: test.info().outputPath('P09-reviewed-plan.png') })
  await panel.getByRole('button', { name: '确认运行本计划（可能计费）', exact: true }).click()
  const drafts = panel.getByRole('region', { name: '逐镜模型草稿', exact: true })
  await expect(drafts.getByRole('checkbox')).toHaveCount(3)
  for (const checkbox of await drafts.getByRole('checkbox').all()) await checkbox.check()
  await drafts.getByLabel('独立归纳模型', { exact: true }).selectOption('plein/mock:chat')
  await expect(
    drafts.getByRole('button', { name: '建立独立归纳计划（零调用）', exact: true }),
  ).toBeEnabled()
  expect(runPosts).toBe(3)
  await drafts.getByRole('button', { name: '建立独立归纳计划（零调用）', exact: true }).click()
  expect(runPosts).toBe(3)
  await panel.getByRole('button', { name: '预检实际输入与费用', exact: true }).click()
  await expect(
    panel.getByRole('button', { name: '确认运行本计划（可能计费）', exact: true }),
  ).toBeEnabled()
  await panel.getByRole('button', { name: '确认运行本计划（可能计费）', exact: true }).click()
  await expect(panel.getByRole('region', { name: '独立归纳结果', exact: true })).toContainText(
    '采样归纳草稿',
  )
  await expect(
    drafts.getByRole('button', { name: '转为独立可编辑分镜草稿', exact: true }),
  ).toBeEnabled()
  expect(runPosts).toBe(4)
  await drafts.getByRole('button', { name: '转为独立可编辑分镜草稿', exact: true }).click()
  const result = await page.evaluate((node) => {
    const elements = [...window.__plein.engine.doc.elements()]
    const board = elements.find((item) => item.nodeType === 'plein/storyboard')!
    const source = elements.find((item) => item.kind === 'markdown')!
    return {
      board,
      source,
      localResults: window.__plein.engine.doc.get(node)!.results?.length,
      nodes: elements
        .filter((item) => item.nodeType === 'plein/shot-scene-draft')
        .map((item) => item.id),
    }
  }, node)
  expect(result.board.params?.shots).toHaveLength(3)
  expect(result.board.adopted).toBeFalsy()
  expect(result.source.text).toContain('模型分析草稿 · 非原剧情事实')
  expect(result.source.params?.aiDraftOrigin).toHaveProperty('kind', 'ai-shot-draft-origin')
  expect(result.localResults).toBe(1)
  expect(runPosts).toBe(4)
  await page.screenshot({ path: test.info().outputPath('P09-result-and-conversion.png') })
  await panel.getByRole('button', { name: '关闭', exact: true }).click()
  await report.getByRole('button', { name: '关闭', exact: true }).click()
  const locked = result.nodes[0]!
  await page.evaluate(
    (id) =>
      (
        window.__plein.engine.doc.mutable(id) as unknown as {
          set(key: string, value: unknown): void
        }
      ).set('locked', true),
    locked,
  )
  await zoomTo(page, [locked])
  // The previous storyboard generator covers the canvas center; use the real layer tree.
  await page
    .getByRole('tree', { name: '画布元素', exact: true })
    .locator(`[data-id="${locked}"]`)
    .click()
  await expect
    .poll(() => page.evaluate(() => window.__plein.engine.selection.values()))
    .toEqual([locked])
  await page.getByRole('button', { name: '查看 AI 分析与预检', exact: true }).click()
  await expect(panel).toContainText('当前只读')
  await expect(
    panel.getByRole('button', { name: '预检实际输入与费用', exact: true }),
  ).toBeDisabled()
  await expect(panel).toHaveCSS('opacity', '1')
  await page.screenshot({ path: test.info().outputPath('P09-locked-readonly.png') })
  expect(runPosts).toBe(4)
})

test('P09关闭旧预检再换分析节点，晚回不能授权新目标或发起模型', async ({ page }) => {
  const { report, panel } = await localReport(page)
  await panel.getByRole('checkbox').first().check()
  await panel.getByLabel('逐镜视觉模型', { exact: true }).selectOption('plein/mock:agent-vision')
  await panel.getByRole('button', { name: '建立所选逐镜计划（零调用）', exact: true }).click()
  const node = await page.evaluate(
    () =>
      [...window.__plein.engine.doc.elements()].find(
        (item) => item.nodeType === 'plein/shot-scene-draft',
      )!.id,
  )
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let accepted!: () => void
  const entered = new Promise<void>((resolve) => {
    accepted = resolve
  })
  await page.route(`**/nodes/${node}/input`, async (route) => {
    const response = await route.fetch()
    accepted()
    await gate
    await route.fulfill({ response })
  })
  try {
    await panel.getByRole('button', { name: '预检实际输入与费用', exact: true }).click()
    await entered
    await panel.getByRole('button', { name: '关闭', exact: true }).click()
    await report.getByRole('button', { name: '关闭', exact: true }).click()
    await zoomTo(page, [node])
    const at = await centerOf(page, node)
    await page.mouse.click(at.x, at.y)
    await page.getByRole('button', { name: '查看 AI 分析与预检', exact: true }).click()
    release()
    await expect(
      panel.getByRole('button', { name: '确认运行本计划（可能计费）', exact: true }),
    ).toBeDisabled()
    expect(
      await page.evaluate(
        (node) => window.__plein.engine.doc.get(node)?.results?.length ?? 0,
        node,
      ),
    ).toBe(0)
    await page.screenshot({ path: test.info().outputPath('P09-late-preview-guard.png') })
  } finally {
    release()
    await page.unroute(`**/nodes/${node}/input`)
  }
})

test('P09真实mock部分失败后只重新预检和运行失败镜，成功镜与本地依据不重跑', async ({ page }) => {
  const { node: local, canvasId, panel } = await localReport(page)
  for (const checkbox of await panel.getByRole('checkbox').all()) await checkbox.check()
  await expect(panel.getByRole('checkbox', { checked: true })).toHaveCount(3)
  await panel.getByLabel('逐镜视觉模型', { exact: true }).selectOption('plein/mock:agent-vision')
  await panel.getByRole('button', { name: '建立所选逐镜计划（零调用）', exact: true }).click()
  const nodes = await page.evaluate(() =>
    [...window.__plein.engine.doc.elements()]
      .filter((item) => item.nodeType === 'plein/shot-scene-draft')
      .sort((a, b) => a.name!.localeCompare(b.name!))
      .map((item) => item.id),
  )
  const failedNode = nodes[1]!
  let injected = false
  const config = '/api/providers/plein/mock/config'
  await page.route(`**/nodes/${failedNode}/run`, async (route) => {
    if (injected) {
      await route.continue()
      return
    }
    injected = true
    expect(
      (await page.request.put(config, { data: { settings: { failWith: 'rate_limit' } } })).ok(),
    ).toBe(true)
    try {
      const response = await route.fetch()
      await expect
        .poll(async () => {
          const jobs = await (
            await page.request.post(`/api/canvases/${canvasId}/jobs/latest`, {
              data: { nodes: [failedNode] },
            })
          ).json()
          return jobs.jobs[0]?.status
        })
        .toBe('failed')
      expect(
        (await page.request.put(config, { data: { settings: { failWith: 'none' } } })).ok(),
      ).toBe(true)
      await route.fulfill({ response })
    } finally {
      await page.request.put(config, { data: { settings: { failWith: 'none' } } })
    }
  })
  try {
    await panel.getByRole('button', { name: '预检实际输入与费用', exact: true }).click()
    await expect(
      panel.getByRole('button', { name: '确认运行本计划（可能计费）', exact: true }),
    ).toBeEnabled()
    await panel.getByRole('button', { name: '确认运行本计划（可能计费）', exact: true }).click()
    const plan = panel.getByRole('region', { name: '待确认分析计划', exact: true })
    await expect(plan).toContainText('本计划 1 个作业')
    await expect(
      panel.getByRole('region', { name: '逐镜模型草稿', exact: true }).getByRole('checkbox'),
    ).toHaveCount(2)
    await expect(
      plan.getByRole('button', { name: '预检实际输入与费用', exact: true }),
    ).toBeEnabled()
    await plan.getByRole('button', { name: '预检实际输入与费用', exact: true }).click()
    await expect(plan.getByText('输入/输出 token、图片费用与恢复提交费用未知。')).toHaveCount(1)
    await plan.getByRole('button', { name: '确认运行本计划（可能计费）', exact: true }).click()
    await expect(
      panel.getByRole('region', { name: '逐镜模型草稿', exact: true }).getByRole('checkbox'),
    ).toHaveCount(3)
    await expect(plan).toHaveCount(0)
    const history = (await (await page.request.get(`/api/canvases/${canvasId}/jobs`)).json()) as {
      jobs: Array<{ nodeId: string; nodeType: string; submissionHistory: Array<{ kind: string }> }>
    }
    const analysis = history.jobs.filter((job) => job.nodeType === 'plein/shot-scene-draft')
    expect(analysis).toHaveLength(4)
    expect(analysis.filter((job) => job.nodeId === failedNode)).toHaveLength(2)
    for (const id of [nodes[0], nodes[2]])
      expect(analysis.filter((job) => job.nodeId === id)).toHaveLength(1)
    expect(
      analysis
        .flatMap((job) => job.submissionHistory)
        .filter((event) => event.kind === 'submit_started'),
    ).toHaveLength(4)
    expect(history.jobs.filter((job) => job.nodeId === local)).toHaveLength(1)
    await page.screenshot({
      path: test.info().outputPath('P09-independent-failed-scene-retry.png'),
    })
  } finally {
    await page.unroute(`**/nodes/${failedNode}/run`)
    await page.request.put(config, { data: { settings: { failWith: 'none' } } })
  }
})
