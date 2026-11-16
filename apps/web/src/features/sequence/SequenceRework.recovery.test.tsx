// @vitest-environment happy-dom
import {
  addResults,
  connect,
  createElement,
  currentResult,
  deleteElements,
  sequenceInstancesOf,
  setParams,
  writeRun,
} from '@plein/doc'
import { openDoc } from '@plein/doc/testing'
import { arrangeSequence, corePlugin, SequenceClip, sequenceNode } from '@plein/nodes'
import { describeNode } from '@plein/plugin-sdk'
import type { Catalog, PreparedInput } from '@plein/protocol'
import { expect, it, vi } from 'vite-plus/test'
import { useDocVersion } from '../../canvas/hooks'
import { mediaTestEngine } from '../../shell/media-tools/testEngine'
import { useCanvas } from '../../stores/canvas'
import { useCatalog } from '../../stores/catalog'
import { mockFetch } from '../../testing/fetch'
import { act, renderApp, resetStoreAfterEach, screen, waitFor, within } from '../../testing/render'
import { useRunRequests } from '../runs/runRequests'
import { useStale } from '../runs/stale'
import { SequenceRework } from './SequenceRework'
import { readReworkSession, writeReworkSession } from './reworkSessions'

resetStoreAfterEach(useCatalog)
resetStoreAfterEach(useRunRequests)
resetStoreAfterEach(useStale)

const originalAsset = 'a'.repeat(64)
const nextAsset = 'c'.repeat(64)

function fixture(options: { delayMeta?: boolean } = {}) {
  const doc = openDoc()
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
  const sequenceId = createElement(doc, {
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
  const edge = connect(doc, [source, 'video'], [sequenceId, 'clips'])!
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
  setParams(doc, sequenceId, {
    clips: [
      { ...settings, clipInstanceId: 'target' },
      { ...settings, clipInstanceId: 'other' },
    ],
    subtitleTrack: { inputKey: 'original-key', cues: [{ source: 'target', text: '手改字幕' }] },
  })
  doc.flush()
  const engine = mediaTestEngine(doc)
  useCanvas.setState({ engine, canvasId: 'rework-canvas' })
  useCatalog.setState({
    catalog: {
      nodes: [{ ...video, executable: true }],
      plugins: [],
      prompts: [],
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
  let releaseMeta!: () => void
  const metaGate = new Promise<void>((resolve) => (releaseMeta = resolve))
  mockFetch(async (request) => {
    const path = new URL(request.url).pathname
    const input = /\/nodes\/([^/]+)\/input$/.exec(path)
    if (input)
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
    const run = /\/nodes\/([^/]+)\/run$/.exec(path)
    if (run && request.method === 'POST') {
      submissions.push({ nodeId: run[1]!, body: await request.json() })
      return Response.json({ runId: 'rework-run' }, { status: 202 })
    }
    if (path === '/api/media/caps') return Response.json({ ffmpeg: true })
    if (/^\/api\/assets\/[^/]+\/meta$/.test(path)) {
      if (options.delayMeta) await metaGate
      return Response.json({ kind: 'video', duration: 5, width: 160, height: 90 })
    }
  })
  function Harness() {
    useDocVersion(doc)
    const adopted = currentResult(doc.get(source)!, 'video')
    const row = arrangeSequence(
      {
        instanceVersion: 2,
        clips: sequenceInstancesOf(doc.get(sequenceId)!).map((clip) => SequenceClip.parse(clip)),
      },
      {
        clips: [
          {
            type: 'video',
            kind: 'video',
            assetId: adopted?.value.type === 'video' ? adopted.value.assetId : originalAsset,
            source,
            sourcePort: 'video',
            edgeId: edge.id,
          },
        ],
      },
    )[0]!
    return (
      <SequenceRework engine={engine} sequenceId={sequenceId} row={row} writable={() => true} />
    )
  }
  const draftElements = () =>
    [...doc.elements()].filter(
      (element) => element.nodeType === video.type && element.id !== source,
    )
  return {
    doc,
    video,
    source,
    sequenceId,
    engine,
    submissions,
    Harness,
    draftElements,
    releaseMeta: () => releaseMeta(),
  }
}

it('关闭与刷新后续接同一返工草稿和候选，不重新提交生成', async () => {
  const { doc, sequenceId, submissions, Harness, draftElements } = fixture()
  try {
    const first = renderApp(<Harness />)
    await first.user.click(screen.getByRole('button', { name: '修改并生成候选' }))
    const modal = screen.getByRole('dialog', { name: '剪辑片段返工' })
    const draft = draftElements()[0]!
    await act(async () => {
      addResults(
        doc,
        draft.id,
        [1, 2].map((index) => ({
          id: `candidate-${index}`,
          runId: 'rework-run',
          port: 'video',
          at: index + 1,
          value: { type: 'video' as const, assetId: nextAsset },
        })),
      )
      doc.flush()
    })
    await first.user.click(within(modal).getByRole('combobox', { name: '返工视频候选' }))
    await first.user.click(screen.getByRole('option', { name: '候选 2 · candidate-2' }))
    await first.user.click(within(modal).getByRole('button', { name: '关闭' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '剪辑片段返工' })).toBeNull())
    expect(submissions).toHaveLength(0)
    first.unmount()

    const second = renderApp(<Harness />)
    try {
      await second.user.click(await screen.findByRole('button', { name: '继续上次返工草稿' }))
      const reopened = screen.getByRole('dialog', { name: '剪辑片段返工' })
      expect(draftElements()).toHaveLength(1)
      expect(draftElements()[0]!.id).toBe(draft.id)
      expect(
        within(reopened).getByRole('combobox', { name: '返工视频候选' }).textContent,
      ).toContain('candidate-2')
      expect(submissions).toHaveLength(0)
      await second.user.click(within(reopened).getByRole('button', { name: '仅替换此剪辑实例' }))
      await waitFor(() => expect(screen.queryByRole('dialog', { name: '剪辑片段返工' })).toBeNull())
      const [changed, other] = sequenceInstancesOf(doc.get(sequenceId)!)
      expect(changed?.segment?.selection).toMatchObject({
        canvasId: 'rework-canvas',
        nodeId: draft.id,
        resultId: 'candidate-2',
      })
      expect(changed?.speed).toBe(1.5)
      expect(other?.clipInstanceId).toBe('other')
      expect(submissions).toHaveLength(0)
      expect(readReworkSession('rework-canvas', sequenceId, 'target')).toBeUndefined()
    } finally {
      second.unmount()
    }
  } finally {
    doc.destroy()
  }
})

it('剪辑实例已变化时保留旧草稿并要先核对，确认后才替换', async () => {
  const { doc, sequenceId, submissions, Harness, draftElements } = fixture()
  try {
    const first = renderApp(<Harness />)
    await first.user.click(screen.getByRole('button', { name: '修改并生成候选' }))
    const draft = draftElements()[0]!
    await act(async () => {
      addResults(doc, draft.id, [
        {
          id: 'candidate-new',
          runId: 'rework-run',
          port: 'video',
          at: 2,
          value: { type: 'video' as const, assetId: nextAsset },
        },
      ])
      doc.flush()
    })
    await first.user.click(
      within(screen.getByRole('dialog', { name: '剪辑片段返工' })).getByRole('button', {
        name: '关闭',
      }),
    )
    act(() => {
      setParams(doc, sequenceId, {
        clips: sequenceInstancesOf(doc.get(sequenceId)!).map((clip) =>
          clip.clipInstanceId === 'target' ? { ...clip, speed: 1.25 } : clip,
        ),
      })
      doc.flush()
    })
    first.unmount()

    const second = renderApp(<Harness />)
    try {
      await second.user.click(await screen.findByRole('button', { name: '继续上次返工草稿' }))
      const modal = screen.getByRole('dialog', { name: '剪辑片段返工' })
      expect(within(modal).getByText(/已变化/)).toBeTruthy()
      const apply = () => within(modal).getByRole('button', { name: '仅替换此剪辑实例' })
      expect(apply().hasAttribute('disabled')).toBe(true)
      expect(draftElements()).toHaveLength(1)
      await second.user.click(
        within(modal).getByRole('button', { name: '我已核对最新剪辑设置，继续此草稿' }),
      )
      await second.user.click(within(modal).getByRole('combobox', { name: '返工视频候选' }))
      await second.user.click(screen.getByRole('option', { name: '候选 1 · candidate-new' }))
      await waitFor(() => expect(apply().hasAttribute('disabled')).toBe(false))
      await second.user.click(apply())
      await waitFor(() => expect(screen.queryByRole('dialog', { name: '剪辑片段返工' })).toBeNull())
      expect(sequenceInstancesOf(doc.get(sequenceId)!)[0]?.speed).toBe(1.25)
      expect(submissions).toHaveLength(0)
    } finally {
      second.unmount()
    }
  } finally {
    doc.destroy()
  }
})

it('本机存储里是另一份会话时不误报存储不可用，且取较新的一份不覆盖', async () => {
  const { doc, sequenceId, Harness } = fixture()
  try {
    const view = renderApp(<Harness />)
    try {
      await view.user.click(screen.getByRole('button', { name: '修改并生成候选' }))
      await view.user.click(
        within(screen.getByRole('dialog', { name: '剪辑片段返工' })).getByRole('button', {
          name: '关闭',
        }),
      )
      await waitFor(() => expect(screen.queryByRole('dialog', { name: '剪辑片段返工' })).toBeNull())
      const mine = readReworkSession('rework-canvas', sequenceId, 'target')!
      const reopen = async () => {
        await view.user.click(screen.getByRole('button', { name: '继续上次返工草稿' }))
        const modal = screen.getByRole('dialog', { name: '剪辑片段返工' })
        expect(within(modal).queryByText(/本机存储不可用/)).toBeNull()
        await view.user.click(within(modal).getByRole('button', { name: '关闭' }))
        await waitFor(() =>
          expect(screen.queryByRole('dialog', { name: '剪辑片段返工' })).toBeNull(),
        )
      }
      // 另一个标签页写了更新的一份：续接跟着它走，存储里的记录不被盖掉
      const theirs = { ...mine, sound: 'mix' as const, savedAt: mine.savedAt + 5000 }
      writeReworkSession(theirs)
      await reopen()
      expect(readReworkSession('rework-canvas', sequenceId, 'target')).toEqual(theirs)
      // 存储里是更旧的一份：不误报，并用当前这份重写，刷新后续接的是它
      const older = { ...theirs, sound: 'native' as const, savedAt: mine.savedAt - 5000 }
      writeReworkSession(older)
      await reopen()
      const stored = readReworkSession('rework-canvas', sequenceId, 'target')!
      expect(stored.savedAt).toBeGreaterThan(older.savedAt)
    } finally {
      view.unmount()
    }
  } finally {
    doc.destroy()
  }
})

it('草稿被删除或明确另起版本时安全处理，不误用旧关系', async () => {
  const { doc, sequenceId, Harness, draftElements } = fixture()
  try {
    const first = renderApp(<Harness />)
    await first.user.click(screen.getByRole('button', { name: '修改并生成候选' }))
    const firstDraft = draftElements()[0]!
    await first.user.click(
      within(screen.getByRole('dialog', { name: '剪辑片段返工' })).getByRole('button', {
        name: '另起版本',
      }),
    )
    await waitFor(() => expect(draftElements()).toHaveLength(2))
    const secondDraft = draftElements().find((element) => element.id !== firstDraft.id)!
    expect(readReworkSession('rework-canvas', sequenceId, 'target')?.draftId).toBe(secondDraft.id)
    expect(doc.get(firstDraft.id)).toBeDefined()
    await first.user.click(
      within(screen.getByRole('dialog', { name: '剪辑片段返工' })).getByRole('button', {
        name: '关闭',
      }),
    )
    await act(async () => {
      deleteElements(doc, [secondDraft.id])
      doc.flush()
    })
    first.unmount()

    const second = renderApp(<Harness />)
    try {
      await second.user.click(await screen.findByRole('button', { name: '修改并生成候选' }))
      await waitFor(() => expect(useCanvas.getState().notice).toContain('上次返工草稿已删除'))
      expect(screen.getByRole('dialog', { name: '剪辑片段返工' })).toBeTruthy()
      expect(draftElements()).toHaveLength(2)
      expect(draftElements().some((element) => element.id === secondDraft.id)).toBe(false)
    } finally {
      second.unmount()
    }
  } finally {
    doc.destroy()
  }
})
it('来源节点换了采用视频时旧草稿不能直接替换，明确核对后才继续', async () => {
  const { doc, source, sequenceId, submissions, Harness, draftElements } = fixture()
  try {
    const first = renderApp(<Harness />)
    await first.user.click(screen.getByRole('button', { name: '修改并生成候选' }))
    const draft = draftElements()[0]!
    await act(async () => {
      addResults(doc, draft.id, [
        {
          id: 'candidate-new',
          runId: 'rework-run',
          port: 'video',
          at: 2,
          value: { type: 'video' as const, assetId: nextAsset },
        },
      ])
      doc.flush()
    })
    const modal = screen.getByRole('dialog', { name: '剪辑片段返工' })
    await first.user.click(within(modal).getByRole('combobox', { name: '返工视频候选' }))
    await first.user.click(screen.getByRole('option', { name: '候选 1 · candidate-new' }))
    await first.user.click(within(modal).getByRole('button', { name: '关闭' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '剪辑片段返工' })).toBeNull())
    act(() => {
      addResults(doc, source, [
        {
          id: 'source-b',
          runId: 'source-run-b',
          port: 'video',
          at: 2,
          value: { type: 'video' as const, assetId: 'b'.repeat(64) },
        },
      ])
      doc.mutable(source)!.set('adopted', 'source-b')
      doc.flush()
    })
    first.unmount()

    const second = renderApp(<Harness />)
    try {
      await second.user.click(await screen.findByRole('button', { name: '继续上次返工草稿' }))
      const reopened = screen.getByRole('dialog', { name: '剪辑片段返工' })
      expect(within(reopened).getByText(/采用的来源视频已与开始返工时不同/)).toBeTruthy()
      const apply = () => within(reopened).getByRole('button', { name: '仅替换此剪辑实例' })
      expect(apply().hasAttribute('disabled')).toBe(true)
      expect(
        within(reopened).getByRole('button', { name: '另起版本' }).hasAttribute('disabled'),
      ).toBe(false)
      await second.user.click(
        within(reopened).getByRole('button', {
          name: '我已核对当前采用的来源视频，继续此草稿',
        }),
      )
      await waitFor(() => expect(apply().hasAttribute('disabled')).toBe(false))
      await second.user.click(apply())
      await waitFor(() => expect(screen.queryByRole('dialog', { name: '剪辑片段返工' })).toBeNull())
      expect(sequenceInstancesOf(doc.get(sequenceId)!)[0]?.segment?.selection).toMatchObject({
        nodeId: draft.id,
        resultId: 'candidate-new',
      })
      expect(submissions).toHaveLength(0)
    } finally {
      second.unmount()
    }
  } finally {
    doc.destroy()
  }
})

it('返工会话写不进本机时如实提示，关闭前确认且刷新后不假装能续接', async () => {
  const setItem = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
    throw new Error('quota')
  })
  const { doc, Harness } = fixture()
  try {
    const first = renderApp(<Harness />)
    await first.user.click(screen.getByRole('button', { name: '修改并生成候选' }))
    const modal = screen.getByRole('dialog', { name: '剪辑片段返工' })
    expect(within(modal).getByText(/本机存储不可用，关闭或刷新后无法续接/)).toBeTruthy()
    await first.user.click(within(modal).getByRole('button', { name: '关闭' }))
    expect(await screen.findByRole('dialog', { name: '返工草稿未保存' })).toBeTruthy()
    await first.user.click(screen.getByRole('button', { name: '继续编辑' }))
    expect(screen.getByRole('dialog', { name: '剪辑片段返工' })).toBeTruthy()
    await first.user.click(
      within(screen.getByRole('dialog', { name: '剪辑片段返工' })).getByRole('button', {
        name: '关闭',
      }),
    )
    expect(await screen.findByRole('dialog', { name: '返工草稿未保存' })).toBeTruthy()
    await first.user.click(screen.getByRole('button', { name: '仍然离开' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '剪辑片段返工' })).toBeNull())
    // 组件没卸载：继续同一内存草稿时也不能误标成刷新可恢复。
    await first.user.click(screen.getByRole('button', { name: '继续上次返工草稿' }))
    const resumed = screen.getByRole('dialog', { name: '剪辑片段返工' })
    expect(within(resumed).getByText(/本机存储不可用，关闭或刷新后无法续接/)).toBeTruthy()
    await first.user.click(within(resumed).getByRole('button', { name: '关闭' }))
    expect(await screen.findByRole('dialog', { name: '返工草稿未保存' })).toBeTruthy()
    await first.user.click(screen.getByRole('button', { name: '仍然离开' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '剪辑片段返工' })).toBeNull())
    first.unmount()

    const second = renderApp(<Harness />)
    try {
      await waitFor(() =>
        expect(screen.queryByRole('button', { name: '继续上次返工草稿' })).toBeNull(),
      )
      expect(screen.getByRole('button', { name: '修改并生成候选' })).toBeTruthy()
    } finally {
      second.unmount()
    }
  } finally {
    setItem.mockRestore()
    doc.destroy()
  }
})

it('真实提交一次后刷新续接同 draft 与 run，发布候选并采用不新增 POST', async () => {
  const { doc, sequenceId, submissions, Harness, draftElements } = fixture()
  try {
    const first = renderApp(<Harness />)
    await first.user.click(screen.getByRole('button', { name: '修改并生成候选' }))
    const modal = screen.getByRole('dialog', { name: '剪辑片段返工' })
    const draft = draftElements()[0]!
    const generator = within(modal).getByTestId('generator')
    const prompt = within(generator).getByRole('textbox', { name: '提示词' })
    await waitFor(() => expect(prompt).toBeTruthy())
    await first.user.click(within(generator).getByRole('button', { name: '生成' }))
    await waitFor(() => expect(submissions).toHaveLength(1))
    await act(async () => {
      writeRun(doc, draft.id, { id: 'rework-run', status: 'running', at: 1 })
      doc.flush()
    })
    first.unmount()

    const second = renderApp(<Harness />)
    try {
      await second.user.click(await screen.findByRole('button', { name: '继续上次返工草稿' }))
      const reopened = screen.getByRole('dialog', { name: '剪辑片段返工' })
      expect(draftElements()).toHaveLength(1)
      expect(draftElements()[0]!.id).toBe(draft.id)
      expect(doc.get(draft.id)?.run).toMatchObject({ id: 'rework-run', status: 'running' })
      expect(submissions).toHaveLength(1)
      await act(async () => {
        writeRun(doc, draft.id, { id: 'rework-run', status: 'succeeded', at: 2 })
        addResults(doc, draft.id, [
          {
            id: 'candidate-combined',
            runId: 'rework-run',
            port: 'video',
            at: 2,
            value: { type: 'video' as const, assetId: nextAsset },
          },
        ])
        doc.flush()
      })
      await second.user.click(within(reopened).getByRole('combobox', { name: '返工视频候选' }))
      await second.user.click(screen.getByRole('option', { name: '候选 1 · candidate-combined' }))
      await second.user.click(within(reopened).getByRole('button', { name: '仅替换此剪辑实例' }))
      await waitFor(() => expect(screen.queryByRole('dialog', { name: '剪辑片段返工' })).toBeNull())
      expect(sequenceInstancesOf(doc.get(sequenceId)!)[0]?.segment?.selection).toMatchObject({
        nodeId: draft.id,
        resultId: 'candidate-combined',
        runId: 'rework-run',
      })
      expect(submissions).toHaveLength(1)
    } finally {
      second.unmount()
    }
  } finally {
    doc.destroy()
  }
})

it('探测媒体期间同一来源换了采用视频，旧替换不会生效', async () => {
  const awaitAsset = 'e'.repeat(64)
  const { doc, source, sequenceId, submissions, Harness, draftElements, releaseMeta } = fixture({
    delayMeta: true,
  })
  try {
    const view = renderApp(<Harness />)
    await view.user.click(screen.getByRole('button', { name: '修改并生成候选' }))
    const draft = draftElements()[0]!
    await act(async () => {
      addResults(doc, draft.id, [
        {
          id: 'candidate-await',
          runId: 'rework-run',
          port: 'video',
          at: 2,
          value: { type: 'video' as const, assetId: awaitAsset },
        },
      ])
      doc.flush()
    })
    const modal = screen.getByRole('dialog', { name: '剪辑片段返工' })
    await view.user.click(within(modal).getByRole('combobox', { name: '返工视频候选' }))
    await view.user.click(screen.getByRole('option', { name: '候选 1 · candidate-await' }))
    await view.user.click(within(modal).getByRole('button', { name: '仅替换此剪辑实例' }))
    act(() => {
      addResults(doc, source, [
        {
          id: 'source-b-await',
          runId: 'source-run-b',
          port: 'video',
          at: 2,
          value: { type: 'video' as const, assetId: 'b'.repeat(64) },
        },
      ])
      doc.mutable(source)!.set('adopted', 'source-b-await')
      doc.flush()
    })
    releaseMeta()
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('来源视频已变化'))
    expect(sequenceInstancesOf(doc.get(sequenceId)!)[0]?.segment).toBeUndefined()
    expect(submissions).toHaveLength(0)
    view.unmount()
  } finally {
    doc.destroy()
  }
})

it('另起版本会取消仍在探测媒体的旧替换', async () => {
  const awaitAsset = 'f'.repeat(64)
  const { doc, sequenceId, submissions, Harness, draftElements, releaseMeta } = fixture({
    delayMeta: true,
  })
  try {
    const view = renderApp(<Harness />)
    await view.user.click(screen.getByRole('button', { name: '修改并生成候选' }))
    const firstDraft = draftElements()[0]!
    await act(async () => {
      addResults(doc, firstDraft.id, [
        {
          id: 'candidate-stale-run',
          runId: 'rework-run',
          port: 'video',
          at: 2,
          value: { type: 'video' as const, assetId: awaitAsset },
        },
      ])
      doc.flush()
    })
    const modal = screen.getByRole('dialog', { name: '剪辑片段返工' })
    await view.user.click(within(modal).getByRole('combobox', { name: '返工视频候选' }))
    await view.user.click(screen.getByRole('option', { name: '候选 1 · candidate-stale-run' }))
    await view.user.click(within(modal).getByRole('button', { name: '仅替换此剪辑实例' }))
    await view.user.click(within(modal).getByRole('button', { name: '另起版本' }))
    await waitFor(() => expect(draftElements()).toHaveLength(2))
    releaseMeta()
    await waitFor(() =>
      expect(
        within(screen.getByRole('dialog', { name: '剪辑片段返工' })).getByRole('button', {
          name: '仅替换此剪辑实例',
        }),
      ).toBeTruthy(),
    )
    expect(sequenceInstancesOf(doc.get(sequenceId)!)[0]?.segment).toBeUndefined()
    expect(submissions).toHaveLength(0)
    view.unmount()
  } finally {
    doc.destroy()
  }
})
