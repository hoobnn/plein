// @vitest-environment happy-dom
import type { Engine } from '@plein/canvas-core'
import { addResults, createDoc, createElement, type PleinDoc } from '@plein/doc'
import {
  AI_SCENE_TYPE,
  AI_SUMMARY_TYPE,
  aiSceneNode,
  aiSummaryNode,
  type ShotAnalysisManifest,
} from '@plein/nodes'
import { describeNode } from '@plein/plugin-sdk'
import type { Catalog, JobInfo, PreparedInput } from '@plein/protocol'
import { afterEach, expect, it, vi } from 'vite-plus/test'
import { aiFixture } from '../../../../../packages/nodes/src/aiShotAnalysis.fixture'
import { useCanvas } from '../../stores/canvas'
import { useCatalog } from '../../stores/catalog'
import { useSession } from '../../stores/session'
import { mockFetch } from '../../testing/fetch'
import { act, renderApp, screen, waitFor, within } from '../../testing/render'
import { resetStoreAfterEach } from '../../testing/render'
import type { AiAnalysisTarget } from './AiAnalysisEditor'
import { AiAnalysisPanel } from './AiAnalysisPanel'

resetStoreAfterEach(useCatalog)

const catalog = {
  nodes: [describeNode(aiSceneNode, 'plein/core'), describeNode(aiSummaryNode, 'plein/core')],
  providers: [
    {
      id: 'mock',
      title: 'Mock',
      enabled: true,
      configured: true,
      models: [
        { id: 'vision', title: 'Vision', capabilities: ['text.chat'], features: ['vision'] },
        { id: 'text', title: 'Text', capabilities: ['text.chat'] },
      ],
    },
  ],
} as unknown as Catalog
const isDisabled = (element: HTMLElement) => (element as HTMLButtonElement).disabled
const rect = { x: 0, y: 0, w: 100, h: 80 }
const docs: PleinDoc[] = []
afterEach(() => {
  for (const doc of docs.splice(0)) doc.destroy()
})

function manifest(): ShotAnalysisManifest {
  const sample = aiFixture().value.request.scope
  return {
    version: 1,
    source: sample.source,
    timeBasis: 'first-video-frame',
    firstVideoPts: 5,
    duration: 3,
    algorithm: {
      name: 'ffmpeg-scene',
      version: 1,
      threshold: 0.35,
      minSceneSeconds: 0.6,
      manual: true,
    },
    scenes: [0, 1, 2].map((index) => ({
      id: `scene-${index + 1}`,
      start: index,
      end: index + 1,
      frame: { ...sample.scene.frame, at: index + 0.5, actualAt: index, actualEnd: index + 1 },
    })),
    notes: [],
  }
}

function fixture(targetResult: string | undefined = 'manifest') {
  const doc = createDoc()
  docs.push(doc)
  const local = createElement(doc, {
    ...rect,
    id: 'local',
    kind: 'node',
    nodeType: 'plein/shot-analysis',
  })
  addResults(doc, local, [
    {
      id: 'manifest',
      port: 'analysis',
      runId: 'local-run',
      at: 1,
      value: { type: 'json', value: manifest() },
    },
  ])
  const engine = { doc, selection: { set: vi.fn() } } as unknown as Engine
  const target: AiAnalysisTarget = {
    kind: 'local',
    nodeId: local,
    resultId: targetResult ?? 'missing',
  }
  useCanvas.setState({ engine, canvasId: 'canvas', aiAnalysis: target })
  useSession.setState({ info: { principal: { id: 'local', role: 'owner' } } as never })
  useCatalog.setState({ catalog })
  return { doc, engine, local, target }
}

function prepared(doc: PleinDoc, nodeId: string): PreparedInput {
  return {
    v: 1,
    nodeId,
    nodeType: doc.get(nodeId)?.nodeType ?? AI_SCENE_TYPE,
    preparedAt: 1,
    status: 'ready',
    inputHash: `hash-${nodeId}`,
    params: doc.get(nodeId)?.params ?? {},
    model: { ref: 'mock:vision', provider: 'mock', title: 'Vision' },
    inputs: {},
    refs: [],
    blocked: [],
    notices: [],
  }
}

function job(nodeId: string, runId: string, status: JobInfo['status']): JobInfo {
  return {
    id: runId,
    nodeId,
    nodeType: AI_SCENE_TYPE,
    status,
    attempts: 1,
    createdAt: 1,
    submissionHistory: [{ kind: 'submit_started', callKey: 'chat', at: 1, id: `submit-${runId}` }],
  }
}

function addSceneResult(doc: PleinDoc, nodeId: string, resultId: string) {
  const value = aiFixture()
  addResults(doc, nodeId, [
    {
      id: resultId,
      port: 'draft',
      runId: `run-${resultId}`,
      at: 1,
      value: { type: 'json', value: value.value },
    },
  ])
}

it('建立计划和预检零调用，确认前不提交模型', async () => {
  const { doc, engine, target } = fixture()
  const runs: string[] = []
  mockFetch((request) => {
    const path = new URL(request.url).pathname
    const match = path.match(/^\/api\/canvases\/canvas\/nodes\/([^/]+)\/input$/)
    if (request.method === 'GET' && match) return Response.json(prepared(doc, match[1]!))
    if (request.method === 'POST' && path.endsWith('/run')) runs.push(path)
    return undefined
  })
  const { user } = renderApp(<AiAnalysisPanel engine={engine} target={target} onClose={vi.fn()} />)
  const panel = screen.getByRole('dialog', { name: 'AI 拉片草稿' })
  await user.click(within(panel).getAllByRole('checkbox')[0]!)
  await user.selectOptions(within(panel).getByLabelText('逐镜视觉模型'), 'mock:vision')
  await user.click(within(panel).getByRole('button', { name: '建立所选逐镜计划（零调用）' }))
  const plan = await within(panel).findByRole('region', { name: '待确认分析计划' })
  expect(plan.textContent).toContain('本计划 1 个作业')
  expect(runs).toEqual([])
  expect(isDisabled(within(plan).getByRole('button', { name: '确认运行本计划（可能计费）' }))).toBe(
    true,
  )
  await user.click(within(plan).getByRole('button', { name: '预检实际输入与费用' }))
  await waitFor(() =>
    expect(
      isDisabled(within(plan).getByRole('button', { name: '确认运行本计划（可能计费）' })),
    ).toBe(false),
  )
  expect(runs).toEqual([])
})

it('旧预检晚回不能授权换入的分析节点', async () => {
  const { doc, engine, local, target } = fixture()
  const next = createElement(doc, {
    ...rect,
    kind: 'node',
    nodeType: AI_SCENE_TYPE,
    params: { model: 'mock:vision', request: aiFixture().value.request },
  })
  let release!: () => void
  let entered!: () => void
  const accepted = new Promise<void>((resolve) => (entered = resolve))
  const gate = new Promise<void>((resolve) => (release = resolve))
  const runs: string[] = []
  mockFetch((request) => {
    const path = new URL(request.url).pathname
    if (path === `/api/canvases/canvas/nodes/${local}/input`) return undefined
    const scene = [...doc.elements()].find(
      (node) =>
        node.nodeType === AI_SCENE_TYPE && path === `/api/canvases/canvas/nodes/${node.id}/input`,
    )
    if (scene) {
      entered()
      return gate.then(() => Response.json(prepared(doc, scene.id)))
    }
    if (request.method === 'POST' && path.endsWith('/run')) runs.push(path)
    return undefined
  })
  const { user, rerender } = renderApp(
    <AiAnalysisPanel
      key={JSON.stringify(target)}
      engine={engine}
      target={target}
      onClose={vi.fn()}
    />,
  )
  const panel = screen.getByRole('dialog', { name: 'AI 拉片草稿' })
  await user.click(within(panel).getAllByRole('checkbox')[0]!)
  await user.selectOptions(within(panel).getByLabelText('逐镜视觉模型'), 'mock:vision')
  await user.click(within(panel).getByRole('button', { name: '建立所选逐镜计划（零调用）' }))
  await user.click(await within(panel).findByRole('button', { name: '预检实际输入与费用' }))
  await accepted
  const nextTarget: AiAnalysisTarget = { kind: 'node', nodeId: next }
  act(() => {
    useCanvas.setState({ aiAnalysis: nextTarget })
    rerender(
      <AiAnalysisPanel
        key={JSON.stringify(nextTarget)}
        engine={engine}
        target={nextTarget}
        onClose={vi.fn()}
      />,
    )
  })
  release()
  await waitFor(() =>
    expect(isDisabled(screen.getByRole('button', { name: '确认运行本计划（可能计费）' }))).toBe(
      true,
    ),
  )
  expect(doc.get(next)?.results ?? []).toEqual([])
  expect(runs).toEqual([])
})

it('部分失败只保留并重新预检失败镜，成功镜不重复提交', async () => {
  const { doc, engine, target } = fixture()
  const runs = new Map<string, number>()
  const jobs = new Map<string, JobInfo>()
  mockFetch((request) => {
    const path = new URL(request.url).pathname
    const input = path.match(/^\/api\/canvases\/canvas\/nodes\/([^/]+)\/input$/)
    if (request.method === 'GET' && input) return Response.json(prepared(doc, input[1]!))
    const run = path.match(/^\/api\/canvases\/canvas\/nodes\/([^/]+)\/run$/)
    if (request.method === 'POST' && run) {
      const nodeId = run[1]!
      const attempt = (runs.get(nodeId) ?? 0) + 1
      runs.set(nodeId, attempt)
      const runId = `run-${nodeId}-${attempt}`
      const secondScene = JSON.stringify(doc.get(nodeId)?.params?.request).includes('scene-2')
      jobs.set(runId, job(nodeId, runId, secondScene && attempt === 1 ? 'failed' : 'succeeded'))
      return Response.json({ runId }, { status: 202 })
    }
    const jobMatch = path.match(/^\/api\/canvases\/canvas\/jobs\/([^/]+)$/)
    if (request.method === 'GET' && jobMatch) return Response.json(jobs.get(jobMatch[1]!))
    return undefined
  })
  const { user } = renderApp(<AiAnalysisPanel engine={engine} target={target} onClose={vi.fn()} />)
  const panel = screen.getByRole('dialog', { name: 'AI 拉片草稿' })
  const scenes = within(panel).getAllByRole('checkbox')
  await user.click(scenes[0]!)
  await user.click(scenes[1]!)
  await user.selectOptions(within(panel).getByLabelText('逐镜视觉模型'), 'mock:vision')
  await user.click(within(panel).getByRole('button', { name: '建立所选逐镜计划（零调用）' }))
  let plan = await within(panel).findByRole('region', { name: '待确认分析计划' })
  await user.click(within(plan).getByRole('button', { name: '预检实际输入与费用' }))
  await waitFor(() =>
    expect(
      isDisabled(within(plan).getByRole('button', { name: '确认运行本计划（可能计费）' })),
    ).toBe(false),
  )
  await user.click(within(plan).getByRole('button', { name: '确认运行本计划（可能计费）' }))
  await waitFor(() => expect(plan.textContent).toContain('本计划 1 个作业'))
  expect([...runs.values()].reduce((a, b) => a + b, 0)).toBe(2)
  plan = within(panel).getByRole('region', { name: '待确认分析计划' })
  await user.click(within(plan).getByRole('button', { name: '预检实际输入与费用' }))
  await waitFor(() =>
    expect(
      isDisabled(within(plan).getByRole('button', { name: '确认运行本计划（可能计费）' })),
    ).toBe(false),
  )
  await user.click(within(plan).getByRole('button', { name: '确认运行本计划（可能计费）' }))
  await waitFor(() =>
    expect(within(panel).queryByRole('region', { name: '待确认分析计划' })).toBeNull(),
  )
  expect([...runs.values()].reduce((a, b) => a + b, 0)).toBe(3)
  expect([...runs.values()].filter((count) => count === 2)).toHaveLength(1)
})

it('本地依据失效时不展示画布其他来源的归纳结果', () => {
  const { doc, engine, target } = fixture('missing')
  const draft = aiFixture()
  const summary = createElement(doc, { ...rect, kind: 'node', nodeType: AI_SUMMARY_TYPE })
  addResults(doc, summary, [
    {
      id: 'other-summary',
      port: 'draft',
      runId: 'summary-run',
      at: 1,
      value: {
        type: 'json',
        value: {
          version: 1,
          kind: 'ai-summary-draft',
          promptVersion: 'scene-summary-v1',
          model: { ref: 'mock:text' },
          request: { id: 'summary', modelRef: 'mock:text', focus: '', drafts: [draft] },
          evidence: {
            input: 'model-draft-text-only',
            audio: 'unknown',
            motion: 'unknown',
            fullVideoRead: false,
          },
          draft: { summary: '其他来源的归纳不应出现', inferences: [], unknowns: [] },
        },
      },
    },
  ])
  renderApp(<AiAnalysisPanel engine={engine} target={target} onClose={vi.fn()} />)
  expect(screen.getByText('请求或本地清单不可用。请从本地拉片清单创建新分析版本。')).not.toBeNull()
  expect(screen.getByRole('region', { name: '独立归纳结果' }).textContent).not.toContain(
    '其他来源的归纳不应出现',
  )
  expect(screen.queryByText('采样归纳草稿 · 非完整影片审片')).toBeNull()
})

it('同 scene 的历史版本可同时勾选，取消一份不影响另一份', async () => {
  const { doc, engine, target } = fixture()
  const first = createElement(doc, { ...rect, kind: 'node', nodeType: AI_SCENE_TYPE })
  const second = createElement(doc, { ...rect, kind: 'node', nodeType: AI_SCENE_TYPE })
  addSceneResult(doc, first, 'scene-version-1')
  addSceneResult(doc, second, 'scene-version-2')
  const { user } = renderApp(<AiAnalysisPanel engine={engine} target={target} onClose={vi.fn()} />)
  const drafts = screen.getByRole('region', { name: '逐镜模型草稿' })
  const versions = within(drafts).getAllByRole('checkbox')
  expect(versions).toHaveLength(2)
  await user.click(versions[0]!)
  expect((versions[0] as HTMLInputElement).checked).toBe(true)
  await user.click(versions[1]!)
  expect((versions[0] as HTMLInputElement).checked).toBe(true)
  expect((versions[1] as HTMLInputElement).checked).toBe(true)
  expect(drafts.textContent).toContain('归纳仅读取所选 2 份文字草稿')
  await user.click(versions[0]!)
  expect((versions[0] as HTMLInputElement).checked).toBe(false)
  expect((versions[1] as HTMLInputElement).checked).toBe(true)
  expect(drafts.textContent).toContain('归纳仅读取所选 1 份文字草稿')
})
