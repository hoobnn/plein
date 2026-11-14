import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, type Page, test } from './fixtures'
import { centerOf, newProject, waitEngine, zoomTo } from './canvas'

let dir = ''
test.beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'plein-draft-recovery-'))
  execFileSync('ffmpeg', [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=c=red:s=96x64:d=2:r=10',
    '-c:v',
    'libvpx-vp9',
    '-deadline',
    'realtime',
    join(dir, 'source.webm'),
  ])
})
test.afterAll(() => rmSync(dir, { recursive: true, force: true }))

async function openBoard(page: Page, board: string) {
  await zoomTo(page, [board])
  const point = await centerOf(page, board)
  await page.mouse.dblclick(point.x, point.y)
  const editor = page.getByRole('dialog', { name: '分镜表', exact: true })
  await expect(editor).toBeVisible()
  return editor
}

async function openWorkbench(page: Page, board: string, no: number) {
  const editor = await openBoard(page, board)
  await editor.getByRole('button', { name: '详细卡片', exact: true }).click()
  await editor.getByRole('button', { name: `镜头 ${no} 工作台`, exact: true }).click()
  const workspace = page.getByRole('dialog', { name: '镜头工作台', exact: true })
  await expect(workspace).toBeVisible()
  return workspace
}

function shotText(page: Page, board: string, index: number) {
  return page.evaluate(
    ([board, index]) =>
      (window.__plein.engine.doc.get(board)!.params!.shots as Array<{ description: string }>)[
        index
      ]!.description,
    [board, index] as const,
  )
}

async function openSequence(page: Page, id: string) {
  await zoomTo(page, [id])
  const point = await centerOf(page, id)
  await page.mouse.dblclick(point.x, point.y)
  const editor = page.getByRole('dialog', { name: '序列', exact: true })
  await expect(editor).toBeVisible()
  return editor
}

function draftInfo(page: Page, source: string) {
  return page.evaluate((source) => {
    const draft = [...window.__plein.engine.doc.elements()].find(
      (element) =>
        element.nodeType === 'plein/video' &&
        element.id !== source &&
        element.name?.includes('返工草稿'),
    )
    const run = draft?.run as unknown as { id?: string; status?: string } | undefined
    return draft ? { id: draft.id, runId: run?.id, status: run?.status } : null
  }, source)
}

function sequenceClips(page: Page, id: string) {
  return page.evaluate(
    (id) =>
      (window.__plein.engine.doc.get(id)!.params!.clips as Array<Record<string, unknown>>).map(
        (clip) => ({
          segment: clip.segment as
            | { selection?: { nodeId?: string; resultId?: string; runId?: string } }
            | undefined,
          in: clip.in,
          out: clip.out,
          speed: clip.speed,
        }),
      ),
    id,
  )
}

test(
  '工作台两镜草稿整页刷新后恢复，正式内容变化时保留草稿不自动覆盖',
  { tag: '@core' },
  async ({ page }) => {
    await newProject(page)
    const board = await page.evaluate(() =>
      window.__plein.addNode({
        type: 'plein/storyboard',
        name: '草稿恢复分镜',
        x: 200,
        y: 150,
        params: {
          shots: [1, 2].map((no) => ({
            id: `draft-${no}`,
            no,
            duration: 3,
            description: `第${no}镜原始画面`,
            imagePrompt: `第${no}镜原始首帧`,
            motionPrompt: `第${no}镜原始运动`,
            lighting: '原始光影',
            characters: [],
            dialogue: [],
          })),
        },
      }),
    )

    let workspace = await openWorkbench(page, board, 1)
    const field = workspace.getByRole('textbox', { name: '工作台画面描述', exact: true })
    await field.fill('第一镜本机草稿')
    await workspace.getByRole('button', { name: '下一镜', exact: true }).click()
    await expect(field).toHaveValue('第2镜原始画面')
    await field.fill('第二镜本机草稿')
    await workspace.getByRole('button', { name: '关闭', exact: true }).click()
    await expect(workspace).toBeHidden()

    // 真实整页 reload 后仍从本机恢复，而不是只靠 DOM 挂载
    await page.reload()
    await waitEngine(page)
    workspace = await openWorkbench(page, board, 1)
    await expect(field).toHaveValue('第一镜本机草稿')
    await expect(workspace.getByText('已恢复本机未保存草稿。')).toBeVisible()

    // 应用第一镜不碰第二镜草稿
    await workspace.getByRole('button', { name: '保存本镜字段', exact: true }).click()
    await expect.poll(() => shotText(page, board, 0)).toBe('第一镜本机草稿')
    await workspace.getByRole('button', { name: '下一镜', exact: true }).click()
    await expect(field).toHaveValue('第二镜本机草稿')
    await workspace.getByRole('button', { name: '关闭', exact: true }).click()
    await expect(workspace).toBeHidden()

    // 在工作台外正常编辑正式分镜，再打开仍保留草稿并提示冲突
    let editor = await openBoard(page, board)
    await editor.getByRole('button', { name: '详细卡片', exact: true }).click()
    const descriptions = editor.getByRole('textbox', { name: '画面', exact: true })
    await descriptions.nth(1).fill('第二镜正式新版本')
    await descriptions.nth(1).blur()
    await expect.poll(() => shotText(page, board, 1)).toBe('第二镜正式新版本')
    await editor.getByRole('button', { name: '镜头 2 工作台', exact: true }).click()
    workspace = page.getByRole('dialog', { name: '镜头工作台', exact: true })
    await expect(workspace).toBeVisible()
    await expect(field).toHaveValue('第二镜本机草稿')
    await expect(workspace.getByText(/镜头内容已有新版本/)).toBeVisible()
    await expect(
      workspace.getByRole('button', { name: '保存本镜字段', exact: true }),
    ).toBeDisabled()
    await workspace.getByRole('button', { name: '重新载入本镜', exact: true }).click()
    await expect(field).toHaveValue('第二镜正式新版本')
    await workspace.getByRole('button', { name: '关闭', exact: true }).click()
    await expect(workspace).toBeHidden()

    await page.reload()
    await waitEngine(page)
    expect(await shotText(page, board, 0)).toBe('第一镜本机草稿')
    expect(await shotText(page, board, 1)).toBe('第二镜正式新版本')
  },
)

test(
  '返工生成中关闭并整页刷新，续接同 draft 与 run 且只替换指定实例',
  { tag: '@core' },
  async ({ page, request }) => {
    const config = '/api/providers/plein/mock/config'
    const original = await (await request.get(config)).json()
    expect(
      (
        await request.put(config, {
          data: { settings: { ...original.settings, latencyMs: 5_000 } },
        })
      ).ok(),
    ).toBe(true)

    await newProject(page)
    const upload = await page.request.post('/api/assets', {
      headers: { 'content-type': 'video/webm', 'x-file-name': 'source.webm' },
      data: readFileSync(join(dir, 'source.webm')),
    })
    expect(upload.status()).toBe(201)
    const assetId = (await upload.json()).id as string
    const { source, sequenceId } = await page.evaluate((assetId) => {
      const makeSource = (name: string, x: number) => {
        const id = window.__plein.addNode({
          type: 'plein/video',
          name,
          x,
          y: 200,
          params: {
            model: 'plein/mock:video',
            mode: 'text',
            prompt: '可返工的来源镜头',
            duration: 2,
          },
        })
        const node = window.__plein.engine.doc.mutable(id)! as unknown as {
          set(key: string, value: unknown): void
        }
        node.set('results', [
          {
            id: `${name}-ready`,
            runId: 'source-fixture',
            port: 'video',
            at: 1,
            value: { type: 'video', assetId },
          },
        ])
        return id
      }
      const source = makeSource('返工来源镜头', -400)
      const otherSource = makeSource('保留的来源镜头', -800)
      const sequenceId = window.__plein.addNode({
        type: 'plein/sequence',
        name: '返工验收序列',
        x: 400,
        y: 200,
        params: {
          instanceVersion: 2,
          subtitles: false,
          aspectRatio: '16:9',
          resolution: '720p',
          clips: [],
        },
      })
      const doc = window.__plein.engine.doc as unknown as {
        edgeMap: { set(id: string, edge: unknown): void }
        mutable(id: string): { get(key: string): unknown } | undefined
      }
      doc.edgeMap.set('edge-rework', {
        id: 'edge-rework',
        from: [source, 'video'],
        to: [sequenceId, 'clips'],
        order: 'a0',
      })
      doc.edgeMap.set('edge-other', {
        id: 'edge-other',
        from: [otherSource, 'video'],
        to: [sequenceId, 'clips'],
        order: 'a1',
      })
      const params = doc.mutable(sequenceId)!.get('params') as {
        set(key: string, value: unknown): void
      }
      params.set('clips', [
        {
          clipInstanceId: 'target',
          source,
          port: 'video',
          edgeId: 'edge-rework',
          in: 0,
          out: 0.8,
          speed: 1.2,
          volume: 0.6,
          sound: 'native',
          subtitle: '原字幕',
        },
        {
          clipInstanceId: 'other',
          source: otherSource,
          port: 'video',
          edgeId: 'edge-other',
          in: 0,
          out: 1,
          speed: 1,
          volume: 0.5,
          sound: 'native',
          subtitle: '保留字幕',
        },
      ])
      return { source, sequenceId }
    }, assetId)

    const runRequests: string[] = []
    page.on('request', (event) => {
      if (
        event.method() === 'POST' &&
        /\/api\/canvases\/[^/]+\/nodes\/[^/]+\/run$/.test(new URL(event.url()).pathname)
      )
        runRequests.push(event.url())
    })

    let editor = await openSequence(page, sequenceId)
    const rework = editor.getByRole('region', { name: '剪辑内返工', exact: true })
    await expect(rework).toBeVisible()
    await rework.getByRole('button', { name: '修改并生成候选', exact: true }).click()
    let modal = page.getByRole('dialog', { name: '剪辑片段返工', exact: true })
    await expect(modal).toBeVisible()
    const generator = modal.getByTestId('generator')
    const runButton = generator.getByRole('button', { name: '生成', exact: true })
    await expect(runButton).toBeEnabled({ timeout: 30_000 })
    await runButton.click()
    await expect.poll(() => runRequests.length).toBe(1)
    await expect
      .poll(async () => (await draftInfo(page, source))?.status, { timeout: 30_000 })
      .toBe('running')
    const beforeReload = await draftInfo(page, source)
    expect(beforeReload?.id).toBeTruthy()
    expect(beforeReload?.runId).toBeTruthy()

    await modal.getByRole('button', { name: '关闭', exact: true }).click()
    await expect(modal).toBeHidden()
    await page.reload()
    await waitEngine(page)

    editor = await openSequence(page, sequenceId)
    await expect(
      editor.getByRole('button', { name: '继续上次返工草稿', exact: true }),
    ).toBeVisible()
    await editor.getByRole('button', { name: '继续上次返工草稿', exact: true }).click()
    modal = page.getByRole('dialog', { name: '剪辑片段返工', exact: true })
    await expect(modal).toBeVisible()
    const afterReload = await draftInfo(page, source)
    expect(afterReload?.id).toBe(beforeReload!.id)
    expect(afterReload?.runId).toBe(beforeReload!.runId)
    expect(runRequests).toHaveLength(1)

    await expect
      .poll(
        () =>
          page.evaluate(
            (id) =>
              (
                window.__plein.engine.doc.get(id)!.results as unknown as
                  | Array<{ port: string }>
                  | undefined
              )?.filter((result) => result.port === 'video').length ?? 0,
            beforeReload!.id!,
          ),
        { timeout: 30_000 },
      )
      .toBeGreaterThan(0)
    const candidateId = await page.evaluate((id) => {
      const results = window.__plein.engine.doc.get(id)!.results as unknown as Array<{
        id: string
        port: string
      }>
      return results.find((result) => result.port === 'video')!.id
    }, beforeReload!.id!)
    await modal.getByRole('combobox', { name: '返工视频候选', exact: true }).click()
    await page.getByRole('option').filter({ hasText: candidateId }).click()
    await modal.getByRole('button', { name: '仅替换此剪辑实例', exact: true }).click()
    await expect(modal).toBeHidden({ timeout: 30_000 })

    await expect
      .poll(async () => (await sequenceClips(page, sequenceId))[0])
      .toMatchObject({
        segment: {
          selection: {
            nodeId: beforeReload!.id,
            resultId: candidateId,
            runId: beforeReload!.runId,
          },
        },
        in: 0,
        out: 0.8,
        speed: 1.2,
      })
    const clips = await sequenceClips(page, sequenceId)
    expect(clips[1]).toMatchObject({ in: 0, out: 1, speed: 1 })
    expect(clips[1]?.segment).toBeUndefined()
    expect(runRequests).toHaveLength(1)
  },
)
