// @vitest-environment happy-dom
import { addResults, connect, createElement, sequenceInstancesOf, setParams } from '@plein/doc'
import { openDoc } from '@plein/doc/testing'
import { arrangeSequence, corePlugin, SequenceClip, sequenceNode } from '@plein/nodes'
import { describeNode } from '@plein/plugin-sdk'
import type { Catalog, PreparedInput } from '@plein/protocol'
import { expect, it } from 'vite-plus/test'
import { useDocVersion } from '../../canvas/hooks'
import { mediaTestEngine } from '../../shell/media-tools/testEngine'
import { useCanvas } from '../../stores/canvas'
import { useCatalog } from '../../stores/catalog'
import { mockFetch } from '../../testing/fetch'
import { act, renderApp, resetStoreAfterEach, screen, waitFor, within } from '../../testing/render'
import { useRunRequests } from '../runs/runRequests'
import { useStale } from '../runs/stale'
import { SequenceRework } from './SequenceRework'

resetStoreAfterEach(useCatalog)
resetStoreAfterEach(useRunRequests)
resetStoreAfterEach(useStale)

it('模态内编辑独立草稿并请求生成，明确选择候选后只替换目标实例且保留剪辑设置', async () => {
  const doc = openDoc()
  const originalAsset = 'a'.repeat(64)
  const video = describeNode(
    corePlugin.nodes.find((node) => node.type === 'plein/video')!,
    'plein/core',
  )
  const sequence = describeNode(sequenceNode, 'plein/core')
  const source = createElement(doc, {
    kind: 'node',
    nodeType: video.type,
    nodeVersion: video.version,
    name: '原镜头',
    x: 0,
    y: 0,
    w: 160,
    h: 90,
    ports: { inputs: video.inputs, outputs: video.outputs },
    params: { ...video.defaults, model: 'plein/mock:video', mode: 'text', prompt: '原镜头输入' },
    adopted: 'original-result',
    results: [
      {
        id: 'original-result',
        runId: 'original-run',
        port: 'video',
        at: 1,
        value: { type: 'video', assetId: originalAsset },
      },
    ],
  })
  const id = createElement(doc, {
    kind: 'node',
    nodeType: sequence.type,
    nodeVersion: sequence.version,
    x: 200,
    y: 0,
    w: 160,
    h: 90,
    ports: { inputs: sequence.inputs, outputs: sequence.outputs },
    params: { instanceVersion: 2, clips: [] },
  })
  const edge = connect(doc, [source, 'video'], [id, 'clips'])!
  const settings = {
    source,
    port: 'video',
    edgeId: edge.id,
    sound: 'mix' as const,
    in: 1,
    out: 3,
    speed: 1.5,
    volume: 0.6,
    dialogue: 'voice',
    sfx: 'effect',
    subtitle: '原字幕',
    lineDelay: 0.2,
  }
  setParams(doc, id, {
    clips: [
      { ...settings, clipInstanceId: 'target' },
      { ...settings, clipInstanceId: 'other' },
    ],
    subtitleTrack: { inputKey: 'original-key', cues: [{ source: 'target', text: '手改字幕' }] },
  })
  doc.flush()
  const before = structuredClone(sequenceInstancesOf(doc.get(id)!))
  const original = structuredClone(doc.get(source))
  const engine = mediaTestEngine(doc)
  useCanvas.setState({ engine, canvasId: 'rework-canvas' })
  useCatalog.setState({
    catalog: {
      nodes: [{ ...video, executable: true }],
      plugins: [],
      prompts: [],
      elements: [],
      templates: [],
      defaultModels: {},
      providers: [
        {
          id: 'plein/mock',
          title: '模拟平台',
          enabled: true,
          configured: true,
          models: [{ id: 'video', title: '模拟视频', capabilities: ['video.generate'] }],
        },
      ],
    } as unknown as Catalog,
  })
  const submissions: Array<{ nodeId: string; body: unknown }> = []
  const previews: Array<{ nodeId: string; prompt: unknown }> = []
  mockFetch(async (request) => {
    const path = new URL(request.url).pathname
    const input = /\/nodes\/([^/]+)\/input$/.exec(path)
    if (input) {
      previews.push({ nodeId: input[1]!, prompt: doc.get(input[1]!)?.params?.prompt })
      return Response.json({
        v: 1,
        nodeId: input[1]!,
        nodeType: video.type,
        preparedAt: 1,
        status: 'ready',
        prompt: String(doc.get(input[1]!)?.params?.prompt),
        params: {},
        inputs: {},
        refs: [],
        notices: [],
        blocked: [],
        inputHash: 'prepared-draft',
      } satisfies PreparedInput)
    }
    const run = /\/nodes\/([^/]+)\/run$/.exec(path)
    if (run && request.method === 'POST') {
      submissions.push({ nodeId: run[1]!, body: await request.json() })
      return Response.json({ runId: 'rework-run' }, { status: 202 })
    }
    if (path === '/api/media/caps') return Response.json({ ffmpeg: true })
    if (path === `/api/assets/${'c'.repeat(64)}/meta`)
      return Response.json({ kind: 'video', duration: 5, width: 160, height: 90 })
  })
  function Harness() {
    useDocVersion(doc)
    const row = arrangeSequence(
      {
        instanceVersion: 2,
        clips: sequenceInstancesOf(doc.get(id)!).map((clip) => SequenceClip.parse(clip)),
      },
      {
        clips: [
          {
            type: 'video',
            kind: 'video',
            assetId: originalAsset,
            source,
            sourcePort: 'video',
            edgeId: edge.id,
          },
        ],
      },
    )[0]!
    return <SequenceRework engine={engine} sequenceId={id} row={row} writable={() => true} />
  }
  const view = renderApp(<Harness />)
  try {
    await view.user.click(screen.getByRole('button', { name: '修改并生成候选' }))
    const modal = screen.getByRole('dialog', { name: '剪辑片段返工' })
    const draft = [...doc.elements()].find(
      (element) => element.nodeType === video.type && element.id !== source,
    )!
    expect(draft.results ?? []).toEqual([])
    expect(draft.params?.prompt).toBe('原镜头输入')
    expect(submissions).toHaveLength(0)
    const generator = within(modal).getByTestId('generator')
    const prompt = within(generator).getByRole('textbox')
    await view.user.clear(prompt)
    await view.user.type(prompt, '返工后的镜头输入')
    await waitFor(() =>
      expect(previews.at(-1)).toEqual({ nodeId: draft.id, prompt: '返工后的镜头输入' }),
    )
    await view.user.click(within(generator).getByRole('button', { name: '生成' }))
    await waitFor(() =>
      expect(submissions).toEqual([{ nodeId: draft.id, body: { expect: 'prepared-draft' } }]),
    )
    expect(sequenceInstancesOf(doc.get(id)!)).toEqual(before)
    // 作业结果通过文档同步到达；HTTP 请求与生成器交互仍走真实客户端。
    await act(async () => {
      addResults(
        doc,
        draft.id,
        ['b', 'c'].map((char, index) => ({
          id: `candidate-${index + 1}`,
          runId: 'rework-run',
          port: 'video',
          at: 2,
          value: { type: 'video' as const, assetId: char.repeat(64) },
        })),
      )
      doc.flush()
    })
    const apply = within(modal).getByRole('button', { name: '仅替换此剪辑实例' })
    expect(apply.hasAttribute('disabled')).toBe(true)
    await view.user.selectOptions(
      within(modal).getByRole('combobox', { name: '返工视频候选' }),
      'candidate-2',
    )
    expect(
      [...modal.querySelectorAll('video')].map((element) => element.getAttribute('src')),
    ).toEqual([`/api/assets/${originalAsset}`, `/api/assets/${'c'.repeat(64)}`])
    await view.user.click(apply)
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '剪辑片段返工' })).toBeNull())
    const [changed, other] = sequenceInstancesOf(doc.get(id)!)
    expect(changed).toMatchObject({
      clipInstanceId: 'target',
      in: 1,
      out: 3,
      speed: 1.5,
      volume: 0.6,
      sound: 'mix',
      dialogue: 'voice',
      sfx: 'effect',
      subtitle: '原字幕',
      lineDelay: 0.2,
      segment: {
        asset: { assetId: 'c'.repeat(64) },
        duration: 5,
        selection: {
          canvasId: 'rework-canvas',
          nodeId: draft.id,
          resultId: 'candidate-2',
          runId: 'rework-run',
        },
      },
    })
    expect(other).toEqual(before[1])
    expect(doc.get(source)).toEqual(original)
    expect(doc.get(draft.id)?.params?.prompt).toBe('返工后的镜头输入')
    expect(doc.get(draft.id)?.results).toHaveLength(2)
    expect(doc.get(id)?.params?.subtitleTrack).toEqual({
      inputKey: 'original-key',
      cues: [{ source: 'target', text: '手改字幕' }],
    })
    expect(useCanvas.getState().notice).toContain('已仅替换此剪辑实例')
  } finally {
    view.unmount()
    doc.destroy()
  }
})
