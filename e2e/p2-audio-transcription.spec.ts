import { expect, test, type Page } from './fixtures'
import { sineWav } from '../packages/providers/src/mock/media'
import { centerOf, newProject, waitNode, zoomTo } from './canvas'

async function fixture(page: Page) {
  await newProject(page)
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: '上传', exact: true }).click()
  await (
    await chooser
  ).setFiles(
    [2, 3].map((seconds, index) => ({
      name: `识别音频${index + 1}.wav`,
      mimeType: 'audio/wav',
      buffer: Buffer.from(sineWav(seconds)),
    })),
  )
  await expect
    .poll(() =>
      page.evaluate(
        () => [...window.__plein.engine.doc.elements()].filter((el) => el.kind === 'audio').length,
      ),
    )
    .toBe(2)
  const sources = await page.evaluate(() =>
    [...window.__plein.engine.doc.elements()]
      .filter((el) => el.kind === 'audio')
      .sort((a, b) => a.name!.localeCompare(b.name!)),
  )
  const asr = await page.evaluate((source) => {
    const node = window.__plein.addNode({
      type: 'plein/transcribe',
      name: '第一段的识别',
      params: { model: 'plein/mock:audio' },
      x: 700,
      y: 500,
    })
    window.__plein.connect([source, 'audio'], [node, 'audio'])
    return node
  }, sources[0]!.id)
  const canvas = page.url().split('/').at(-1)!
  const response = await page.request.post(`/api/canvases/${canvas}/nodes/${asr}/run`, { data: {} })
  expect(response.ok(), await response.text()).toBe(true)
  await waitNode(page, asr)
  const result = await page.evaluate(
    (id) =>
      window.__plein.engine.doc
        .get(id)!
        .results!.find((result) => (result as unknown as { port: string }).port === 'segments')!,
    asr,
  )
  return { sources, asr, canvas, result }
}
async function openSplit(page: Page, source: string) {
  await page.keyboard.press('Escape')
  await zoomTo(page, [source])
  const point = await centerOf(page, source)
  await page.mouse.click(point.x, point.y)
  await page
    .getByRole('toolbar', { name: '结果操作' })
    .getByRole('button', { name: '媒体工具', exact: true })
    .click()
  const menu = page.getByRole('dialog', { name: '媒体工具', exact: true })
  await menu.getByRole('button', { name: '手动切分', exact: true }).click()
  return menu
}
function submissions(page: Page) {
  const result: string[] = []
  page.on('request', (request) => {
    if (
      request.method() === 'POST' &&
      /\/(run|run-flow|run-batch|commit)$/.test(new URL(request.url()).pathname)
    )
      result.push(request.url())
  })
  return result
}

test('识别时间戳经冻结源音频核验后导入可编辑区间，再明确执行本地切分', async ({ page }) => {
  const { sources } = await fixture(page)
  const sent = submissions(page)
  const menu = await openSplit(page, sources[0]!.id)
  await menu.getByRole('button', { name: '使用识别区间', exact: true }).click()
  const intervals = menu.getByRole('textbox', { name: '音频区间', exact: true })
  await expect(intervals).toHaveValue('0.1 - 0.5\n0.5 - 0.9')
  await intervals.fill('0.1 - 0.4\n0.6 - 0.9')
  await expect(menu.getByLabel('切分区间预览')).toContainText('将生成 2 段')
  expect(
    await page.evaluate(
      () => [...window.__plein.engine.doc.elements()].filter((el) => el.kind === 'audio').length,
    ),
  ).toBe(2)
  expect(sent).toEqual([])
  await menu.screenshot({ path: test.info().outputPath('asr-split-plan.png') })
  await menu.getByRole('button', { name: '开始加工', exact: true }).click()
  await expect
    .poll(() =>
      page.evaluate(
        () => [...window.__plein.engine.doc.elements()].filter((el) => el.kind === 'audio').length,
      ),
    )
    .toBe(4)
  expect(
    await page.evaluate((id) => window.__plein.engine.doc.get(id)!.assetId, sources[0]!.id),
  ).toBe(sources[0]!.assetId)
  expect(sent).toEqual([])
})

test('重连识别节点不能把旧结果归到新音频，仍可凭历史找到原音频结果', async ({ page }) => {
  const { sources, asr } = await fixture(page)
  await page.evaluate(
    ({ asr, other }) => {
      const doc = window.__plein.engine.doc as unknown as {
        edges(): Iterable<{ id: string; to: [string, string] }>
        edgeMap: { delete(id: string): void }
      }
      for (const edge of [...doc.edges()]) if (edge.to[0] === asr) doc.edgeMap.delete(edge.id)
      window.__plein.connect([other, 'audio'], [asr, 'audio'])
    },
    { asr, other: sources[1]!.id },
  )
  let menu = await openSplit(page, sources[1]!.id)
  await expect(
    menu.getByText('没有可核验为当前音频的已采用识别结果。', { exact: false }),
  ).toBeVisible()
  await expect(menu.getByRole('button', { name: '使用识别区间', exact: true })).toHaveCount(0)
  await page.keyboard.press('Escape')
  menu = await openSplit(page, sources[0]!.id)
  await expect(menu.getByRole('button', { name: '使用识别区间', exact: true })).toBeVisible()
})

test('读取期间取消采用时丢弃迟到历史；创建新识别草稿不自动运行', async ({ page }) => {
  const { sources, asr, canvas, result } = await fixture(page)
  const sent = submissions(page)
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  let requests = 0
  await page.route(`**/api/canvases/${canvas}/jobs/${result.runId}`, async (route) => {
    requests++
    await held
    await route.continue()
  })
  const menu = await openSplit(page, sources[0]!.id)
  await expect.poll(() => requests).toBe(1)
  await page.evaluate(
    (id) =>
      (
        window.__plein.engine.doc.mutable(id)! as unknown as {
          set(key: string, value: unknown): void
        }
      ).set('adopted', null),
    asr,
  )
  release()
  await expect(
    menu.getByText('没有可核验为当前音频的已采用识别结果。', { exact: false }),
  ).toBeVisible()
  await expect(menu.getByRole('button', { name: '使用识别区间', exact: true })).toHaveCount(0)
  await menu.getByRole('button', { name: '创建语音识别草稿', exact: true }).click()
  await expect(menu).toBeHidden()
  const draft = await page.evaluate(
    (original) =>
      [...window.__plein.engine.doc.elements()].find(
        (el) => el.nodeType === 'plein/transcribe' && el.id !== original,
      )!,
    asr,
  )
  expect(draft.results ?? []).toHaveLength(0)
  expect(
    await page.evaluate(
      ({ source, id }) =>
        [...window.__plein.engine.doc.edges()].some(
          (edge) => edge.from[0] === source && edge.to[0] === id && edge.to[1] === 'audio',
        ),
      { source: sources[0]!.id, id: draft.id },
    ),
  ).toBe(true)
  expect(sent).toEqual([])
})

test('读取识别历史期间替换源文件，旧弹层与迟到结果不会用于新音频', async ({ page }) => {
  const { sources, canvas, result } = await fixture(page)
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  let requests = 0
  await page.route(`**/api/canvases/${canvas}/jobs/${result.runId}`, async (route) => {
    requests++
    await held
    await route.continue()
  })
  const menu = await openSplit(page, sources[0]!.id)
  await expect.poll(() => requests).toBe(1)
  await page.evaluate(
    ({ id, assetId }) => {
      const node = window.__plein.engine.doc.mutable(id)! as unknown as {
        set(key: string, value: unknown): void
      }
      node.set('assetId', assetId)
    },
    { id: sources[0]!.id, assetId: sources[1]!.assetId! },
  )
  release()
  await expect(menu).toBeHidden()
  const next = await openSplit(page, sources[0]!.id)
  await expect(
    next.getByText('没有可核验为当前音频的已采用识别结果。', { exact: false }),
  ).toBeVisible()
  await expect(next.getByRole('button', { name: '使用识别区间', exact: true })).toHaveCount(0)
})
