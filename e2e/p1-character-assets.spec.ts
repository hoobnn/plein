import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, type Locator, type Page, test } from './fixtures'
import { elements, newProject, revealGenerator, waitNode } from './canvas'
import { openLibraryPanel } from './library-ui'

interface Item {
  id: string
  name: string
  projectId: string | null
  description: string
  tags: Record<string, string>
  profile: unknown
  images: Array<{ slot: string; assetId: string }>
  coverAssetId?: string | null
}

let dir = ''
const files = ['red', 'blue', 'green'].map((color) => join(dir, `${color}.png`))
const created: string[] = []
const readItem = async (page: Page, id: string) =>
  (await (await page.request.get(`/api/library/${id}`)).json()) as Item
const openItem = async (panel: Locator, name: string) => {
  await panel.getByRole('listitem').filter({ hasText: name }).getByRole('button').first().click()
}
const slot = (panel: Locator, id: string) => panel.locator(`[data-character-slot="${id}"]`)

// 文件路径在 beforeAll 中重建；避免模块加载时创建空目录。
const paths = ['red', 'blue', 'green'].map((color) => `${color}.png`)

test.beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'plein-p1-character-e2e-'))
  for (const [index, color] of ['red', 'blue', 'green'].entries()) {
    files[index] = join(dir, paths[index]!)
    execFileSync('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      `color=c=${color}:s=96x128`,
      '-frames:v',
      '1',
      files[index]!,
    ])
  }
})
test.afterEach(async ({ request }) => {
  for (const id of created.splice(0)) await request.delete(`/api/library/${id}`)
})
test.afterAll(() => rmSync(dir, { recursive: true, force: true }))

async function upload(page: Page, index: number) {
  const response = await page.request.post('/api/assets', {
    headers: { 'content-type': 'image/png', 'x-file-name': `original-${index}.png` },
    data: readFileSync(files[index]!),
  })
  expect(response.status(), await response.text()).toBe(201)
  return ((await response.json()) as { id: string }).id
}

test('角色槽位保存后制作草稿，手动 mock 生成并采用后归档原角色、封面与重开', async ({ page }) => {
  await newProject(page)
  const canvasId = /#\/c\/([^/?]+)/.exec(page.url())![1]!
  const canvas = await (await page.request.get(`/api/canvases/${canvasId}`)).json()
  const originals = await Promise.all([upload(page, 0), upload(page, 1), upload(page, 2)])
  const description = 'P1 角色的原始设定，制作前补充。'
  const response = await page.request.post('/api/library', {
    data: {
      kind: 'character',
      name: 'P1 归档角色',
      projectId: canvas.projectId,
      description: '初始设定',
      tags: { gender: '女' },
      images: [
        { slot: 'full_body', assetId: originals[0] },
        { slot: 'portrait', assetId: originals[1] },
        { slot: 'face_grid', assetId: originals[2] },
      ],
      profile: {
        periods: [],
        expressions: [{ id: 'calm', name: '平静', aliases: [], description: '放松', images: [] }],
      },
    },
  })
  expect(response.status(), await response.text()).toBe(201)
  const original = (await response.json()) as Item
  created.push(original.id)

  const panel = await openLibraryPanel(page)
  await openItem(panel, original.name)
  const tabs = panel.getByRole('group', { name: '档案分页', exact: true })
  await tabs.getByRole('button', { name: '基础设定', exact: true }).click()
  await panel.getByRole('textbox', { name: /^基础设定/ }).fill(description)
  await tabs.getByRole('button', { name: '角色资产', exact: true }).click()

  const runs: string[] = []
  page.on('request', (request) => {
    if (request.method() === 'POST' && /\/nodes\/[^/]+\/run$/.test(new URL(request.url()).pathname))
      runs.push(request.url())
  })
  await slot(panel, 'portrait').getByRole('button', { name: '制作这类图片', exact: true }).click()
  await expect(panel).toBeHidden()
  expect(runs).toHaveLength(0)
  expect((await readItem(page, original.id)).description).toBe(description)

  const draftName = 'P1 归档角色 · 肖像／半身图'
  const draft = (await elements(page)).find((element) => element.name === draftName)
  expect(draft?.nodeType).toBe('plein/image')
  const draftId = draft!.id
  const initialDraft = await page.evaluate((id) => window.__plein.engine.doc.get(id), draftId)
  expect(initialDraft?.params?.characterAssetTarget).toEqual({
    libraryId: original.id,
    slot: 'portrait',
  })
  expect(initialDraft?.run).toBeUndefined()
  expect(initialDraft?.results).toBeUndefined()
  expect(String(initialDraft?.params?.prompt)).toContain('肖像／半身图')

  const generator = page.getByTestId('generator')
  await revealGenerator(page)
  const generate = generator.getByRole('button', { name: '生成', exact: true })
  await expect(generate).toBeEnabled()
  await generate.click()
  await waitNode(page, draftId)
  expect(runs).toHaveLength(1)
  await generator.getByRole('button', { name: '重新生成', exact: true }).click()
  await expect
    .poll(() =>
      page.evaluate((id) => {
        const node = window.__plein.engine.doc.get(id)
        return { status: node?.run?.status, results: node?.results?.length }
      }, draftId),
    )
    .toEqual({ status: 'succeeded', results: 2 })

  await generator.getByRole('button', { name: '全屏查看', exact: true }).click()
  const viewer = page.getByRole('dialog', { name: `查看「${draftName}」`, exact: true })
  // 第一个候选已经是采用状态，先翻到第二个再采用，才能验证“换候选后重新归档”。
  await viewer.getByRole('button', { name: '预览下一个候选', exact: true }).click()
  await viewer.getByRole('button', { name: '采用此候选', exact: true }).click()
  const adopted = await page.evaluate((id) => window.__plein.engine.doc.get(id)?.adopted, draftId)
  expect(typeof adopted).toBe('string')
  await viewer.getByRole('button', { name: '关闭', exact: true }).click()
  const candidate = await page.evaluate(
    ({ id, resultId }) => {
      const result = window.__plein.engine.doc
        .get(id)
        ?.results?.find((entry) => entry.id === resultId)
      return result?.value.assetId as string
    },
    { id: draftId, resultId: adopted! },
  )

  await generator.getByRole('button', { name: '归档到角色', exact: true }).click()
  const archive = page.getByRole('dialog', { name: '归档到角色', exact: true })
  await expect(archive.locator(`[data-library-id="${original.id}"]`)).toHaveText(original.name)
  await expect(archive).toContainText('制作意图')
  await expect(archive).toContainText('肖像／半身图')
  await expect(archive.getByRole('img', { name: `${original.name}的当前候选图` })).toHaveAttribute(
    'src',
    new RegExp(candidate),
  )
  await archive.getByRole('combobox', { name: '目标槽位', exact: true }).click()
  await page.getByRole('option', { name: '情绪九宫格', exact: true }).click()
  await archive.getByRole('checkbox', { name: /设为独立封面/ }).check()
  const requestPromise = page.waitForRequest(
    (request) =>
      request.method() === 'POST' &&
      new URL(request.url()).pathname === `/api/library/${original.id}/character-image`,
  )
  const responsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === `/api/library/${original.id}/character-image`,
  )
  const canvasUrl = page.url()
  await archive.getByRole('button', { name: '确认归档', exact: true }).click()
  const archiveRequest = await requestPromise
  expect((await responsePromise).ok()).toBe(true)
  expect(archiveRequest.postDataJSON()).toMatchObject({
    canvasId,
    nodeId: draftId,
    resultId: adopted,
    assetId: candidate,
    sourceSlot: 'portrait',
    slot: 'face_grid',
    cover: true,
  })
  expect(archiveRequest.postDataJSON().expected).toEqual(expect.any(String))
  await expect(archive).toBeHidden()
  expect(page.url()).toBe(canvasUrl)

  const saved = await readItem(page, original.id)
  expect(saved.projectId).toBe(canvas.projectId)
  expect(saved.description).toBe(description)
  expect(saved.tags).toEqual(original.tags)
  expect(saved.profile).toEqual(original.profile)
  expect(saved.coverAssetId).toBe(candidate)
  expect(saved.images).toHaveLength(4)
  expect(saved.images).toContainEqual({ slot: 'full_body', assetId: originals[0] })
  expect(saved.images).toContainEqual({ slot: 'portrait', assetId: originals[1] })
  expect(saved.images).toContainEqual({ slot: 'face_grid', assetId: candidate })
  expect(saved.images).toContainEqual({ slot: 'extra', assetId: originals[2] })

  const reopened = await openLibraryPanel(page)
  await expect(reopened.locator(`[data-lib-cover="${original.id}"] img`)).toHaveAttribute(
    'src',
    new RegExp(candidate),
  )
  await openItem(reopened, original.name)
  await expect(reopened.locator('.lib-hero > img').last()).toHaveAttribute(
    'src',
    new RegExp(candidate),
  )
  await expect(slot(reopened, 'full_body').locator('img')).toHaveAttribute(
    'src',
    new RegExp(originals[0]!),
  )
  await expect(slot(reopened, 'portrait').locator('img')).toHaveAttribute(
    'src',
    new RegExp(originals[1]!),
  )
  await expect(slot(reopened, 'face_grid').locator('img')).toHaveAttribute(
    'src',
    new RegExp(candidate),
  )
  await expect(reopened.locator('.lib-character-extras img')).toHaveAttribute(
    'src',
    new RegExp(originals[2]!),
  )

  await reopened
    .getByRole('group', { name: '档案分页', exact: true })
    .getByRole('button', { name: '基础设定', exact: true })
    .click()
  await reopened.getByRole('textbox', { name: /^基础设定/ }).fill(`${description}重开后编辑。`)
  await reopened.getByRole('button', { name: '保存', exact: true }).click()
  await expect(reopened.getByRole('button', { name: '已保存', exact: true })).toBeDisabled()
  const savedAgain = await readItem(page, original.id)
  expect(savedAgain.coverAssetId).toBe(candidate)
  expect(savedAgain.images).toEqual(saved.images)
  expect(savedAgain.projectId).toBe(canvas.projectId)
  expect(savedAgain.profile).toEqual(original.profile)
})
