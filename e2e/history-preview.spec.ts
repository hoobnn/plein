import { expect, test } from './fixtures'
import { clickElement, newProject, waitEngine, waitNode } from './canvas'
import { solidPng } from '../packages/providers/src/mock/media'
import type { NodeResult } from '../packages/doc/src/types'
import { slowFile } from './slow-file'

for (const hasTail of [false, true]) {
  test(`同次两个视频切换采用后读取各自尾帧，撤销刷新保持一致（第二条有尾帧=${hasTail}）`, async ({
    page,
  }) => {
    await newProject(page)
    const source = await page.evaluate(() =>
      window.__plein.addNode({
        type: 'plein/video',
        name: '同次多候选视频',
        params: { model: 'plein/mock:video', prompt: '雨后水杯', mode: 'text', count: 2 },
        x: 400,
        y: 200,
      }),
    )
    const canvas = /#\/c\/([^/?]+)/.exec(page.url())![1]
    expect(
      (
        await page.request.post(`/api/canvases/${canvas}/nodes/${source}/run`, { data: {} })
      ).status(),
    ).toBe(202)
    await waitNode(page, source)
    const tails: string[] = []
    for (const color of [
      [210, 80, 40],
      [40, 120, 210],
    ] as [number, number, number][]) {
      const response = await page.request.post('/api/assets', {
        headers: { 'content-type': 'image/png' },
        data: Buffer.from(solidPng(64, 64, color)),
      })
      expect(response.status()).toBe(201)
      tails.push((await response.json()).id)
    }
    const target = await page.evaluate(
      ({ source, tails, hasTail }) => {
        const map = window.__plein.engine.doc.mutable(source)! as {
          get(key: string): unknown
          set(key: string, value: unknown): void
        }
        const videos = map.get('results') as NodeResult[]
        // 视频候选及关联键由真实 Mock 执行产生；受控补入不同颜色的尾帧，避免相同视频字节掩盖串用。
        map.set('results', [
          ...videos,
          ...videos.slice(0, hasTail ? 2 : 1).map((video, i) => ({
            id: `tail-${i}`,
            port: 'lastFrame',
            runId: video.runId,
            outputGroup: video.outputGroup,
            at: video.at,
            value: { type: 'image', assetId: tails[i] },
          })),
        ])
        const target = window.__plein.addNode({
          type: 'plein/image',
          name: '尾帧参考图片',
          params: { model: 'plein/mock:image', prompt: '沿用当前视频尾帧' },
          x: 1000,
          y: 200,
        })
        window.__plein.connect([source, 'lastFrame'], [target, 'references'])
        window.__plein.engine.zoomToFit()
        return target
      },
      { source, tails, hasTail },
    )
    const input = async () =>
      (await page.request.get(`/api/canvases/${canvas}/nodes/${target}/input`)).json()
    const asset = async () => (await input()).inputs.references?.[0]?.assetId
    await expect.poll(asset).toBe(tails[0])
    await clickElement(page, source)
    const generator = page.getByTestId('generator')
    await generator.getByRole('button', { name: '全屏查看', exact: true }).click()
    const viewer = page.getByRole('dialog', { name: '查看「同次多候选视频」', exact: true })
    await viewer.getByRole('button', { name: '预览下一个候选', exact: true }).click()
    await viewer.getByRole('button', { name: '采用此候选', exact: true }).click()
    await viewer.getByRole('button', { name: '关闭', exact: true }).click()
    await clickElement(page, target)
    await expect.poll(asset).toBe(hasTail ? tails[1] : undefined)
    if (hasTail) {
      await expect(
        generator
          .getByRole('group', { name: '参考 1：同次多候选视频', exact: true })
          .locator('img'),
      ).toHaveAttribute('src', new RegExp(tails[1]!))
    } else {
      await expect(generator).toContainText('当前候选没有可确认的「尾帧」输出')
      await expect(generator.getByRole('button', { name: '生成', exact: true })).toBeDisabled()
    }
    await generator.screenshot({ path: test.info().outputPath('paired-tail-input.png') })
    await page.getByRole('button', { name: '撤销', exact: true }).click()
    await expect.poll(asset).toBe(tails[0])
    await page.getByRole('button', { name: '重做', exact: true }).click()
    await expect.poll(asset).toBe(hasTail ? tails[1] : undefined)
    await page.reload()
    await waitEngine(page)
    await expect.poll(asset).toBe(hasTail ? tails[1] : undefined)
  })
}

test('采用旧视频的尾帧后，主视频预览、撤销重做和刷新保持对应运行', async ({ page }) => {
  await newProject(page)
  const id = await page.evaluate(() =>
    window.__plein.addNode({
      type: 'plein/video',
      name: '视频与尾帧',
      params: { model: 'plein/mock:video', prompt: '雨后水杯', mode: 'text' },
      x: 400,
      y: 200,
    }),
  )
  const canvas = /#\/c\/([^/?]+)/.exec(page.url())![1]
  expect(
    (await page.request.post(`/api/canvases/${canvas}/nodes/${id}/run`, { data: {} })).status(),
  ).toBe(202)
  await waitNode(page, id)
  const upload = await page.request.post('/api/assets', {
    headers: { 'content-type': 'image/png' },
    data: Buffer.from(solidPng(64, 64, [80, 150, 210])),
  })
  expect(upload.status()).toBe(201)
  const { id: tailAsset } = await upload.json()
  // Mock 默认只返回主视频；补入受控的副输出与较新候选，验证真实媒体加载和用户采用链。
  const videoAsset = await page.evaluate(
    ({ id, tailAsset }) => {
      const map = window.__plein.engine.doc.mutable(id)! as {
        get(key: string): unknown
        set(key: string, value: unknown): void
      }
      const old = (map.get('results') as NodeResult[])[0]!
      map.set('results', [
        { ...old, id: 'video-new', runId: 'new-run', at: old.at + 1 },
        old,
        {
          id: 'tail-old',
          port: 'lastFrame',
          runId: old.runId,
          outputGroup: old.outputGroup,
          at: old.at,
          value: { type: 'image', assetId: tailAsset },
        },
      ])
      map.set('adopted', 'video-new')
      return old.value.type === 'video' ? old.value.assetId : ''
    },
    { id, tailAsset },
  )
  await page.getByRole('button', { name: '生成历史', exact: true }).click()
  const history = page.getByRole('dialog', { name: '生成历史', exact: true })
  await history.getByRole('button', { name: /^图片/ }).click()
  await history.getByRole('button', { name: '预览「视频与尾帧」', exact: true }).click()
  const viewer = page.getByRole('dialog', { name: '查看「视频与尾帧」', exact: true })
  await expect(viewer.getByRole('img', { name: '视频与尾帧', exact: true })).toBeVisible()
  await viewer.getByRole('button', { name: '采用此候选', exact: true }).click()
  await viewer.getByRole('button', { name: '定位来源', exact: true }).click()
  const generator = page.getByTestId('generator')
  await expect(generator.getByRole('button', { name: '生成视频', exact: true })).toHaveCount(0)
  const check = async (candidate: number) => {
    await generator.getByRole('button', { name: '全屏查看', exact: true }).click()
    await expect(viewer).toContainText(`候选 ${candidate} · 已采用 / 2`)
    await expect(viewer.locator('video')).toBeVisible()
    await expect
      .poll(() => viewer.locator('video').evaluate((el) => (el as HTMLVideoElement).readyState))
      .toBeGreaterThanOrEqual(2)
    await viewer.getByRole('button', { name: '关闭', exact: true }).click()
  }
  await check(2)
  await page.getByRole('button', { name: '撤销', exact: true }).click()
  await check(1)
  await page.getByRole('button', { name: '重做', exact: true }).click()
  await check(2)
  await page.reload()
  await waitEngine(page)
  await clickElement(page, id)
  await check(2)
  await expect
    .poll(async () => {
      const list = (await (await page.request.get('/api/canvases')).json()) as Array<{
        id: string
        covers?: string[]
      }>
      return list.find((item) => item.id === canvas)?.covers?.join(' ')
    })
    .toContain(videoAsset)
  await page.screenshot({ path: test.info().outputPath('video-after-tail-adoption.png') })

  // 主视频与尾帧均生效；历史、跨画布素材来源和验收表单须认同一份状态。
  for (const asset of [videoAsset, tailAsset]) {
    await expect
      .poll(async () => {
        const response = await page.request.get(`/api/assets/${asset}/sources`)
        if (!response.ok()) return []
        const sources = (await response.json()) as {
          items: Array<{ nodeId: string; adopted: boolean; resultId: string }>
        }
        return sources.items
          .filter((item) => item.nodeId === id && item.adopted)
          .map((item) => item.resultId)
      })
      .toHaveLength(1)
  }
  await page.getByRole('button', { name: '生成历史', exact: true }).click()
  await history.getByRole('button', { name: /^图片/ }).click()
  const adoptedCard = () => history.getByRole('listitem').filter({ hasText: '采用中' })
  await expect(adoptedCard()).toHaveCount(1)
  await adoptedCard().getByRole('button').first().click()
  const review = viewer.locator('[data-review-node]')
  await review.locator('summary').first().click()
  const note = review.getByRole('textbox', { name: '创作验收备注 · 视频与尾帧', exact: true })
  await note.fill('尾帧需要调整水杯边缘')
  await review.getByRole('button', { name: '保存为需修改', exact: true }).click()
  await expect(review).toContainText('创作验收：需修改')
  await viewer.getByRole('button', { name: '关闭', exact: true }).click()
  await history.getByRole('button', { name: /^视频/ }).click()
  await expect(adoptedCard()).toHaveCount(1)
  await adoptedCard().getByRole('button').first().click()
  await review.locator('summary').first().click()
  await expect(note).toHaveValue('')
  await note.fill('主视频运动可用')
  await review.getByRole('button', { name: '保存为可用', exact: true }).click()
  await expect(review).toContainText('创作验收：可用')
  await expect(note).toBeVisible()
  await expect(note).toHaveValue('主视频运动可用')
  await viewer.screenshot({ path: test.info().outputPath('port-review-video.png') })
  await viewer.getByRole('button', { name: '关闭', exact: true }).click()
  await history.getByRole('button', { name: /^图片/ }).click()
  await adoptedCard().getByRole('button').first().click()
  await review.locator('summary').first().click()
  await expect(note).toHaveValue('尾帧需要调整水杯边缘')
  await viewer.screenshot({ path: test.info().outputPath('port-review-tail.png') })
  await page.reload()
  await waitEngine(page)
  await clickElement(page, id)
  await generator.getByRole('button', { name: '全屏查看', exact: true }).click()
  await review.locator('summary').first().click()
  await expect(note).toHaveValue('主视频运动可用')
})

for (const action of ['escape', 'locate'] as const) {
  test(`历史审片 ${action} 按浮层层级退出并保留明确采用`, async ({ page }) => {
    await newProject(page)
    const id = await page.evaluate(() =>
      window.__plein.addNode({
        type: 'plein/image',
        name: '历史候选审片',
        params: { model: 'plein/mock:image', prompt: '两个水杯', count: 2 },
        x: 400,
        y: 300,
      }),
    )
    const canvas = decodeURIComponent(page.url().split('#/c/')[1]!)
    await expect
      .poll(async () =>
        (await page.request.get(`/api/canvases/${canvas}/nodes/${id}/input`)).status(),
      )
      .toBe(200)
    expect(
      (await page.request.post(`/api/canvases/${canvas}/nodes/${id}/run`, { data: {} })).status(),
    ).toBe(202)
    await waitNode(page, id)
    const before = await page.evaluate(
      (id) => ({
        adopted: window.__plein.engine.doc.mutable(id)?.get('adopted'),
        results: window.__plein.engine.doc.get(id)!.results!,
      }),
      id,
    )
    expect(before.results).toHaveLength(2)
    await page.getByRole('button', { name: '生成历史', exact: true }).click()
    const history = page.getByRole('dialog', { name: '生成历史', exact: true })
    await history.getByRole('listitem').last().getByRole('button').first().click()
    const viewer = page.getByRole('dialog', { name: '查看「历史候选审片」', exact: true })
    await expect(viewer).toBeVisible()
    expect(
      await page.evaluate((id) => window.__plein.engine.doc.mutable(id)?.get('adopted'), id),
    ).toEqual(before.adopted)
    await expect(viewer.getByRole('button', { name: '采用此候选', exact: true })).toBeEnabled()
    if (action === 'escape') {
      await page.keyboard.press('Escape')
      await expect(viewer).toHaveCount(0)
      await expect(history).toBeVisible({ timeout: 1500 })
      await expect(history.getByRole('checkbox', { checked: true })).toHaveCount(0)
      await history.getByRole('listitem').last().getByRole('button').first().click()
      await viewer.getByRole('button', { name: '采用此候选', exact: true }).click()
      expect(
        await page.evaluate((id) => window.__plein.engine.doc.mutable(id)?.get('adopted'), id),
      ).toBe(before.results[1]!.id)
      await viewer.getByRole('button', { name: '关闭', exact: true }).click()
      await expect(history).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(history).toHaveCount(0)
    } else {
      await viewer.getByRole('button', { name: '定位来源', exact: true }).click()
      await expect(viewer).toHaveCount(0)
      await expect(history).toHaveCount(0, { timeout: 1500 })
      expect(await page.evaluate(() => window.__plein.engine.selection.values())).toEqual([id])
    }
    await page.screenshot({
      path: test.info().outputPath('history-preview-exit.png'),
      animations: 'disabled',
    })
  })
}

// 这批用例要跑真实渲染、编码或很大的工程，单条本来就慢
slowFile(test)
