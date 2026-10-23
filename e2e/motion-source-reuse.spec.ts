import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { expect, test, type Page } from '@playwright/test'
import { MotionParams, MOTION_TEMPLATE_VERSION } from '../packages/nodes/src/motion'
import type { CompositionSourceRef } from '../packages/plugin-sdk/src/ports'
import { MOCK_WEBM_BASE64 } from '../packages/providers/src/mock/video-fixture'
import { centerOf, newProject, waitEngine, zoomTo } from './canvas'
import { openLibraryPanel } from './library-ui'

const { strToU8, unzipSync, zipSync } = createRequire(
  new URL('../apps/server/package.json', import.meta.url),
)('fflate') as {
  strToU8(data: string): Uint8Array
  unzipSync(data: Uint8Array): Record<string, Uint8Array>
  zipSync(data: Record<string, Uint8Array>): Uint8Array
}

const projects: string[] = []
const libraryItems: string[] = []
test.afterEach(async ({ request }) => {
  for (const item of libraryItems.splice(0)) await request.delete(`/api/library/${item}`)
  for (const project of projects.splice(0)) await request.delete(`/api/projects/${project}`)
})

async function fixture(page: Page, count: number) {
  await newProject(page)
  const canvasId = decodeURIComponent(page.url().split('#/c/')[1]!)
  const canvas = (await (await page.request.get(`/api/canvases/${canvasId}`)).json()) as {
    projectId: string
  }
  projects.push(canvas.projectId)
  const upload = async (data: Uint8Array, mime: string, name: string) => {
    const response = await page.request.post('/api/assets', {
      headers: { 'content-type': mime, 'x-file-name': encodeURIComponent(name) },
      data: Buffer.from(data),
    })
    expect(response.status()).toBe(201)
    return ((await response.json()) as { id: string }).id
  }
  const assetId = await upload(
    Buffer.from(MOCK_WEBM_BASE64, 'base64'),
    'video/webm',
    '可复用合成.webm',
  )
  const sources: CompositionSourceRef[] = []
  const nodes: string[] = []
  for (let index = 0; index < count; index++) {
    const params = MotionParams.parse({
      title: `源工程 ${index + 1}`,
      duration: 1,
      resolution: '720p',
    })
    const manifest = {
      schema: 'plein.motion-source.v1',
      templateVersion: MOTION_TEMPLATE_VERSION,
      engine: { name: 'hyperframes', version: '0.8.186', fps: 30 },
      params,
      inputs: {},
      dependencyAssetIds: [],
      renderIdentity: `fixture-${index}`,
    }
    const bytes = strToU8(JSON.stringify(manifest))
    const manifestAssetId = await upload(bytes, 'application/json', `源工程${index + 1}.json`)
    const bundleAssetId = await upload(
      zipSync({
        'manifest.json': bytes,
        'index.html': strToU8(`<!doctype html><title>源工程 ${index + 1}</title>`),
      }),
      'application/zip',
      `源工程${index + 1}.zip`,
    )
    const source: CompositionSourceRef = {
      version: 1,
      bundleAssetId,
      manifestAssetId,
      dependencyAssetIds: [],
      rendererIdentity: `fixture-${index}`,
    }
    sources.push(source)
    nodes.push(
      await page.evaluate(
        ({ params, assetId, source, index }) => {
          const id = window.__plein.addNode({
            type: 'plein/motion',
            name: `来源 ${index + 1}`,
            params,
            x: 300 + index * 500,
            y: 200,
          })
          const node = window.__plein.engine.doc.mutable(id)! as unknown as {
            set(key: string, value: unknown): void
          }
          node.set('results', [
            {
              id: `fixture-${index}`,
              runId: `fixture-${index}`,
              port: 'video',
              at: index + 1,
              value: { type: 'video', assetId, mime: 'video/webm', compositionSource: source },
            },
          ])
          return id
        },
        { params, assetId, source, index },
      ),
    )
  }
  if (count === 0) {
    await page.evaluate((assetId) => {
      const id = window.__plein.addNode({
        type: 'plein/video',
        name: '普通生成视频',
        params: {},
        x: 300,
        y: 200,
      })
      const node = window.__plein.engine.doc.mutable(id)! as unknown as {
        set(key: string, value: unknown): void
      }
      node.set('results', [
        {
          id: 'ordinary',
          runId: 'ordinary',
          port: 'video',
          at: 1,
          value: { type: 'video', assetId, mime: 'video/webm' },
        },
      ])
    }, assetId)
  }
  // 等待真实文档同步后，宿主来源发现读取的是已经落到当前owner的事实。
  await expect
    .poll(
      async () =>
        (
          (await (await page.request.get(`/api/motion/asset/${assetId}/sources`)).json()) as {
            sources?: unknown[]
          }
        ).sources?.length,
    )
    .toBe(count)
  for (const source of sources) {
    expect((await page.request.get(`/api/motion/source/${source.manifestAssetId}`)).status()).toBe(
      200,
    )
  }
  return { assetId, sources, nodes, canvasId, projectId: canvas.projectId }
}
const mediaElements = (page: Page) =>
  page.evaluate(() => [...window.__plein.engine.doc.elements()].filter((el) => el.kind === 'video'))

async function anotherCanvas(page: Page, projectId: string) {
  const response = await page.request.post('/api/canvases', {
    data: { projectId, title: '复用目标画布' },
  })
  expect(response.status()).toBe(201)
  const target = (await response.json()) as { id: string }
  await page.goto(`/#/c/${target.id}`)
  await waitEngine(page)
  await expect.poll(() => mediaElements(page).then((items) => items.length)).toBe(0)
}

async function openAsset(page: Page, name: string) {
  await page.getByRole('button', { name: '素材', exact: true }).click()
  const panel = page.getByRole('dialog', { name: '素材', exact: true })
  await panel.getByRole('button', { name: `查看素材 ${name}`, exact: true }).click()
  return panel
}

test('历史放到画布：普通video接入序列后，工程ZIP仍附对应源工程', async ({ page }) => {
  const f = await fixture(page, 1)
  await page.getByRole('button', { name: '生成历史', exact: true }).click()
  const history = page.getByRole('dialog', { name: '生成历史', exact: true })
  await history.getByRole('checkbox', { name: '选择「来源 1」', exact: true }).check()
  await history.getByRole('button', { name: '放到画布上', exact: true }).click()
  await expect(history).toHaveCount(0)
  await expect.poll(async () => (await mediaElements(page)).length).toBe(1)
  const media = (await mediaElements(page))[0]!
  expect(media.params?.compositionSource).toEqual(f.sources[0])
  const sequence = await page.evaluate((video) => {
    const id = window.__plein.addNode({
      type: 'plein/sequence',
      name: '普通视频来源工程',
      params: { subtitles: false, aspectRatio: '16:9', resolution: '720p' },
      x: 1200,
      y: 200,
    })
    window.__plein.connect([video, 'video'], [id, 'clips'])
    return id
  }, media.id)
  await zoomTo(page, [sequence])
  const at = await centerOf(page, sequence)
  await page.mouse.dblclick(at.x, at.y)
  const editor = page.getByRole('dialog', { name: '序列', exact: true })
  const posted = page.waitForRequest(
    (request) =>
      request.method() === 'POST' && request.url().endsWith('/api/media/sequence-export'),
  )
  const downloaded = page.waitForEvent('download')
  await editor.getByRole('button', { name: '导出工程', exact: true }).click()
  const spec = (await posted).postDataJSON() as {
    spec: { clips: { asset: { compositionSource?: CompositionSourceRef } }[] }
  }
  expect(spec.spec.clips[0]!.asset.compositionSource).toEqual(f.sources[0])
  const file = await downloaded
  const entries = unzipSync(readFileSync((await file.path())!))
  expect(Object.keys(entries).some((name) => name.endsWith('/sources/1/source.zip'))).toBe(true)
  const manifest = Object.entries(entries).find(([name]) =>
    name.endsWith('/sources/1/manifest.json'),
  )!
  expect(JSON.parse(new TextDecoder().decode(manifest[1])).params.title).toBe('源工程 1')
})

for (const count of [0, 1, 2]) {
  test(`跨画布素材放入：${count} 个源版本保留明确身份`, async ({ page }) => {
    const f = await fixture(page, count)
    await anotherCanvas(page, f.projectId)
    const panel = await openAsset(page, '可复用合成.webm')
    await panel.getByRole('button', { name: '放入当前画布', exact: true }).click()
    let expected = f.sources[0]
    if (count === 2) {
      const picker = page.getByRole('dialog', { name: '选择素材源版本', exact: true })
      await expect(picker).toBeVisible()
      expect(await mediaElements(page)).toHaveLength(0)
      await picker.getByRole('combobox', { name: '可编辑源版本', exact: true }).click()
      await page.getByRole('option', { name: /源工程 2/ }).click()
      await picker.getByRole('button', { name: '放入此源版本', exact: true }).click()
      expected = f.sources[1]
    }
    await expect(panel).toHaveCount(0)
    await expect.poll(async () => (await mediaElements(page)).length).toBe(1)
    expect((await mediaElements(page))[0]!.params?.compositionSource).toEqual(expected)
  })
}

test('素材源工程读取失败保留面板与零新增，重试后保存来源', async ({ page }) => {
  const f = await fixture(page, 1)
  await anotherCanvas(page, f.projectId)
  const panel = await openAsset(page, '可复用合成.webm')
  await page.route(`**/api/motion/asset/${f.assetId}/sources`, (route) =>
    route.fulfill({ status: 503, json: { message: '源工程暂时不可读' } }),
  )
  await panel.getByRole('button', { name: '放入当前画布', exact: true }).click()
  await expect(panel.getByRole('alert')).toContainText('源工程暂时不可读')
  expect(await mediaElements(page)).toHaveLength(0)
  await page.unroute(`**/api/motion/asset/${f.assetId}/sources`)
  await panel.getByRole('button', { name: '放入当前画布', exact: true }).click()
  await expect(panel).toHaveCount(0)
  await expect.poll(async () => (await mediaElements(page)).length).toBe(1)
  expect((await mediaElements(page))[0]!.params?.compositionSource).toEqual(f.sources[0])
})

async function effectLibrary(page: Page) {
  const panel = await openLibraryPanel(page)
  await panel
    .getByRole('group', { name: '资产类别', exact: true })
    .getByRole('button', { name: '特效', exact: true })
    .click()
  await panel
    .getByRole('group', { name: '范围', exact: true })
    .getByRole('button', { name: '我的', exact: true })
    .click()
  return panel
}

test('资产卡从画布选择保留精确来源，删除原画布后再展开仍恢复该版本', async ({ page }) => {
  const f = await fixture(page, 2)
  await page.getByRole('button', { name: '生成历史', exact: true }).click()
  const history = page.getByRole('dialog', { name: '生成历史', exact: true })
  await history.getByRole('checkbox', { name: '选择「来源 2」', exact: true }).check()
  await history.getByRole('button', { name: '放到画布上', exact: true }).click()
  await expect(history).toHaveCount(0)
  const panel = await effectLibrary(page)
  await panel.getByRole('button', { name: '新建特效', exact: true }).first().click()
  const name = '带源版本的资产卡'
  await panel.getByRole('textbox', { name: '名称', exact: true }).fill(name)
  const videoField = panel.getByRole('group', { name: '参考视频', exact: true })
  await videoField.getByRole('button', { name: '从画布选', exact: true }).click()
  await page
    .getByRole('dialog', { name: '从画布选', exact: true })
    .getByRole('button', { name: '选择视频「来源 2」', exact: true })
    .click()
  const savedRequest = page.waitForRequest(
    (request) => request.method() === 'POST' && request.url().endsWith('/api/library'),
  )
  await panel.getByRole('button', { name: '保存', exact: true }).click()
  expect((await savedRequest).postDataJSON().videoCompositionSource).toEqual(f.sources[1])
  let saved: { id: string; videoCompositionSource: CompositionSourceRef } | undefined
  await expect
    .poll(async () => {
      const items = (await (await page.request.get('/api/library')).json()) as {
        id: string
        name: string
        videoCompositionSource: CompositionSourceRef
      }[]
      saved = items.find((item) => item.name === name)
      return saved?.videoCompositionSource
    })
    .toEqual(f.sources[1])
  libraryItems.push(saved!.id)
  await panel.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(panel).toHaveCount(0)
  await anotherCanvas(page, f.projectId)
  expect((await page.request.delete(`/api/canvases/${f.canvasId}`)).ok()).toBe(true)
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`/api/motion/asset/${f.assetId}/sources`)).json()).sources
          .length,
    )
    .toBe(1)
  const reopened = await effectLibrary(page)
  const card = reopened.getByRole('listitem').filter({ hasText: name })
  await card.hover()
  await card.getByRole('button', { name: '添加到画布', exact: true }).click()
  await expect.poll(async () => (await mediaElements(page)).length).toBe(1)
  expect((await mediaElements(page))[0]!.params?.compositionSource).toEqual(f.sources[1])
})

test('旧资产卡多来源展开先选择，取消零新增，再选后带所选版本', async ({ page }) => {
  const f = await fixture(page, 2)
  const response = await page.request.post('/api/library', {
    data: { kind: 'effect', name: '旧资产卡多来源', video: f.assetId },
  })
  expect(response.status()).toBe(201)
  libraryItems.push(((await response.json()) as { id: string }).id)
  await anotherCanvas(page, f.projectId)
  const panel = await effectLibrary(page)
  const card = panel.getByRole('listitem').filter({ hasText: '旧资产卡多来源' })
  await card.hover()
  await card.getByRole('button', { name: '添加到画布', exact: true }).click()
  const picker = page.getByRole('dialog', { name: '选择素材源版本', exact: true })
  await expect(picker).toBeVisible()
  expect(await mediaElements(page)).toHaveLength(0)
  await picker.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(picker).toHaveCount(0)
  expect(await mediaElements(page)).toHaveLength(0)
  await card.hover()
  await card.getByRole('button', { name: '添加到画布', exact: true }).click()
  await picker.getByRole('combobox', { name: '可编辑源版本', exact: true }).click()
  await page.getByRole('option', { name: /源工程 2/ }).click()
  await picker.getByRole('button', { name: '放入此源版本', exact: true }).click()
  await expect.poll(async () => (await mediaElements(page)).length).toBe(1)
  expect((await mediaElements(page))[0]!.params?.compositionSource).toEqual(f.sources[1])
})
