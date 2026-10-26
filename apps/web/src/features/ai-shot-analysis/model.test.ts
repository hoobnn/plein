import {
  addResults,
  createDoc,
  createElement,
  currentProductionConfirmation,
  sourceMapOf,
  groupElements,
  exportElements,
  importElements,
} from '@plein/doc'
import type { Engine } from '@plein/canvas-core'
import { templateData, placeTemplate } from '../../canvas/groups'
import { useCanvas } from '../../stores/canvas'
import {
  AI_SCENE_TYPE,
  AI_SUMMARY_TYPE,
  aiSceneNode,
  aiSummaryNode,
  type ShotAnalysisManifest,
} from '@plein/nodes'
import { describeNode } from '@plein/plugin-sdk'
import type { Catalog } from '@plein/protocol'
import { describe, expect, it, vi } from 'vite-plus/test'
import { aiFixture } from '../../../../../packages/nodes/src/aiShotAnalysis.fixture'
import {
  aiModels,
  createScenePlan,
  createSummaryPlan,
  convertAiDrafts,
  draftReference,
  sameReportOrigin,
} from './model'

const catalog = {
  nodes: [describeNode(aiSceneNode, 'plein/core'), describeNode(aiSummaryNode, 'plein/core')],
  providers: [
    {
      id: 'mock',
      title: 'mock',
      enabled: true,
      configured: true,
      models: [
        { id: 'vision', title: 'vision', capabilities: ['text.chat'], features: ['vision'] },
        { id: 'text', title: 'text', capabilities: ['text.chat'] },
      ],
    },
  ],
} as unknown as Catalog
function fixture() {
  const doc = createDoc()
  const local = createElement(doc, {
    kind: 'node',
    nodeType: 'plein/shot-analysis',
    x: 0,
    y: 0,
    w: 280,
    h: 200,
  })
  const sample = aiFixture().value.request.scope
  const manifest: ShotAnalysisManifest = {
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
  addResults(doc, local, [
    {
      id: 'manifest',
      port: 'analysis',
      runId: 'local',
      at: 1,
      value: { type: 'json', value: manifest },
    },
  ])
  return { doc, local }
}
describe('P09计划与数据转换', () => {
  it('归纳报告必须精确匹配画布/节点/候选，复制保留resultId不能成为当前报告', () => {
    const origin = aiFixture().value.request.scope.origin
    expect(sameReportOrigin(origin, { ...origin })).toBe(true)
    for (const key of ['canvasId', 'nodeId', 'resultId'] as const)
      expect(sameReportOrigin(origin, { ...origin, [key]: 'copy' })).toBe(false)
  })
  it('真实复制和模板路径保留模型出处，P05当前绑定重映射且历史不授权', () => {
    const { doc } = fixture()
    const ai = createElement(doc, {
      kind: 'node',
      nodeType: AI_SCENE_TYPE,
      x: 0,
      y: 0,
      w: 200,
      h: 200,
    })
    addResults(doc, ai, [
      {
        id: 'result',
        port: 'draft',
        runId: 'job',
        at: 1,
        value: { type: 'json', value: aiFixture().value },
      },
    ])
    const ref = draftReference(doc, 'canvas', ai, 'result')!
    const made = convertAiDrafts(doc, 'canvas', [ref])
    const frame = groupElements(doc, [made.source, made.board])!
    const fake = { doc, selection: { set: vi.fn() }, setTool: vi.fn() } as unknown as Engine
    const data = JSON.parse(JSON.stringify(templateData(fake, frame)))
    const targetDoc = createDoc()
    const target = {
      doc: targetDoc,
      selection: { set: vi.fn() },
      setTool: vi.fn(),
    } as unknown as Engine
    const before = useCanvas.getState()
    useCanvas.setState({ engine: target, canvasId: 'target' })
    try {
      const [root] = placeTemplate(target, data, { x: 0, y: 0 })
      const board = targetDoc
        .descendants(root!)
        .find((node) => node.nodeType === 'plein/storyboard')!
      const source = targetDoc.descendants(root!).find((node) => node.kind === 'markdown')!
      expect(source.params?.aiDraftOrigin).toEqual(doc.get(made.source)!.params?.aiDraftOrigin)
      expect(sourceMapOf(targetDoc, board.id).sources[0]!.binding!.elementId).toBe(source.id)
      expect(sourceMapOf(targetDoc, board.id).snapshots[0]!.originAtCapture.elementId).toBe(
        made.source,
      )
      expect(currentProductionConfirmation(board, 'target')).toBeUndefined()
      const copied = importElements(targetDoc, exportElements(doc, [made.source, made.board]), {
        canvasId: 'target',
      })
      expect(copied).toHaveLength(2)
      expect(
        [...targetDoc.elements()].filter((node) => node.nodeType === 'plein/storyboard'),
      ).toHaveLength(2)
    } finally {
      useCanvas.setState(before)
      targetDoc.destroy()
      doc.destroy()
    }
  })
  it('配置/vision模型显式选择，选4镜或异步晚回不会留下新节点', async () => {
    const { doc, local } = fixture()
    expect(aiModels(catalog, true).map((model) => model.ref)).toEqual(['mock:vision'])
    await expect(
      createScenePlan(doc, catalog, 'canvas', local, 'manifest', ['scene-1'], '', ''),
    ).rejects.toThrow('视觉模型')
    await expect(
      createScenePlan(
        doc,
        catalog,
        'canvas',
        local,
        'manifest',
        ['scene-1', 'scene-2', 'scene-3', 'scene-4'],
        'mock:vision',
        '',
      ),
    ).rejects.toThrow('1 至 3')
    await expect(
      createScenePlan(
        doc,
        catalog,
        'canvas',
        local,
        'manifest',
        ['scene-1'],
        'mock:vision',
        '',
        () => false,
      ),
    ).rejects.toThrow('查看对象')
    expect([...doc.elements()].filter((node) => node.nodeType === AI_SCENE_TYPE)).toHaveLength(0)
    doc.destroy()
  })
  it('建空计划不修改P08；归纳固定精确候选，不能因候选删除静默换依据', async () => {
    const { doc, local } = fixture()
    const [id] = await createScenePlan(
      doc,
      catalog,
      'canvas',
      local,
      'manifest',
      ['scene-1'],
      'mock:vision',
      '光影',
    )
    expect(doc.get(id!)!.results ?? []).toHaveLength(0)
    expect(doc.get(local)!.results).toHaveLength(1)
    const result = aiFixture().value
    addResults(doc, id!, [
      {
        id: 'analysis',
        port: 'draft',
        runId: 'run',
        at: 2,
        value: { type: 'json', value: result },
      },
    ])
    const ref = draftReference(doc, 'canvas', id!, 'analysis')!
    const summary = createSummaryPlan(doc, catalog, 'canvas', [ref], 'mock:text', '归纳')
    expect(doc.get(summary)?.nodeType).toBe(AI_SUMMARY_TYPE)
    expect(doc.get(summary)?.params?.request).toHaveProperty('drafts', [ref])
    doc.mutable(id!)!.set('results', [])
    expect(() => createSummaryPlan(doc, catalog, 'canvas', [ref], 'mock:text', '')).toThrow(
      '已变化',
    )
    doc.destroy()
  })
  it('转换新建独立分镜和明确模型草稿出处，一次撤销且不伪造对白/运动/确认', () => {
    const { doc, local } = fixture()
    const node = createElement(doc, {
      kind: 'node',
      nodeType: AI_SCENE_TYPE,
      x: 0,
      y: 0,
      w: 200,
      h: 200,
    })
    addResults(doc, node, [
      {
        id: 'result',
        port: 'draft',
        runId: 'job',
        at: 1,
        value: { type: 'json', value: aiFixture().value },
      },
    ])
    const ref = draftReference(doc, 'canvas', node, 'result')!
    const made = convertAiDrafts(doc, 'canvas', [ref])
    expect(doc.get(made.source)!.text).toContain('非原剧情事实')
    expect(doc.get(made.source)!.params?.aiDraftOrigin).toHaveProperty(
      'kind',
      'ai-shot-draft-origin',
    )
    const shot = (
      doc.get(made.board)!.params!.shots as Array<{
        duration: number
        dialogue: unknown[]
        motionPrompt: string
      }>
    )[0]!
    expect(shot).toMatchObject({ duration: 5, dialogue: [], motionPrompt: '' })
    expect(sourceMapOf(doc, made.board).readSnapshotIds).toEqual([])
    expect(sourceMapOf(doc, made.board).links).toHaveLength(1)
    expect(currentProductionConfirmation(doc.get(made.board), 'canvas')).toBeUndefined()
    expect(doc.get(local)!.results).toHaveLength(1)
    doc.undo.undo()
    expect(doc.get(made.board)).toBeUndefined()
    expect(doc.get(made.source)).toBeUndefined()
    doc.undo.redo()
    expect(sourceMapOf(doc, made.board).snapshots[0]!.text).toBe(doc.get(made.source)!.text)
    doc.readOnly = true
    expect(() => convertAiDrafts(doc, 'canvas', [ref])).toThrow()
    doc.destroy()
  })
})
