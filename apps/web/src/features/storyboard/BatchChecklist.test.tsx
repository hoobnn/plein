// @vitest-environment happy-dom
import type { Engine } from '@plein/canvas-core'
import { shotSegmentMapping } from '@plein/capabilities'
import { connect, createElement, setParam } from '@plein/doc'
import { node, openDoc } from '@plein/doc/testing'
import { sequenceNode, Shot } from '@plein/nodes'
import { describeNode } from '@plein/plugin-sdk'
import type { StoryboardBatchPlan, StoryboardBatchRequest } from '@plein/protocol'
import { expect, it, vi } from 'vite-plus/test'
import { useCanvas } from '../../stores/canvas'
import { mockFetch } from '../../testing/fetch'
import { act, renderApp, screen, waitFor } from '../../testing/render'
import { BatchChecklist } from './BatchChecklist'

it.each(['scope', 'content'] as const)(
  '两条 live 序列同帧变更 %s 拒绝旧确认，重新核对后才提交',
  async (change) => {
    const doc = openDoc()
    const canvasId = 'canvas'
    const shot = Shot.parse({ id: 'shot', no: 1, duration: 2, description: '镜头' })
    const boardId = createElement(
      doc,
      node({ nodeType: 'plein/storyboard', params: { shots: [shot] } }),
    )
    const source = createElement(
      doc,
      node({
        nodeType: 'plein/video',
        params: { source: { storyboard: boardId, shot: shot.id, role: 'video' } },
        ports: { inputs: [], outputs: [{ id: 'video', label: '视频', type: 'video' }] },
      }),
    )
    const descriptor = describeNode(sequenceNode, 'plein/core')
    const sequences = ['第一序列', '第二序列'].map((name) => {
      const id = createElement(
        doc,
        node({
          name,
          nodeType: sequenceNode.type,
          nodeVersion: sequenceNode.version,
          ports: { inputs: descriptor.inputs, outputs: descriptor.outputs },
          params: { instanceVersion: 2, clips: [] },
        }),
      )
      expect(connect(doc, [source, 'video'], [id, 'clips'])).toBeTruthy()
      return id
    })
    doc.flush()
    const scope = { canvasId, boardId, shotId: shot.id }
    for (const sequenceId of sequences) {
      const mapping = shotSegmentMapping(doc, { ...scope, sequenceId })
      expect(mapping.problem).toBeUndefined()
      expect(mapping.instances).toHaveLength(1)
      expect(mapping.instances[0]!.source).toBe(source)
    }
    const engine = { doc } as Engine
    useCanvas.setState({ engine, canvasId, sync: 'connected' })
    const initial: StoryboardBatchRequest = {
      shotIds: [shot.id],
      role: 'video',
      reuseExisting: false,
      sequenceId: sequences[0],
    }
    const previews: StoryboardBatchRequest[] = []
    const commits: unknown[] = []
    let release!: () => void
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    mockFetch(async (request) => {
      const path = new URL(request.url).pathname
      if (request.method === 'POST' && path.endsWith('/storyboard-batch/preview')) {
        const body = (await request.json()) as StoryboardBatchRequest
        previews.push(body)
        const revision = previews.length
        if (body.sequenceId === sequences[1]) await pending
        const mapping = shotSegmentMapping(doc, { ...scope, sequenceId: body.sequenceId })
        const plan: StoryboardBatchPlan = {
          token: `token:${body.sequenceId}:${revision}`,
          expiresAt: Date.now() + 60_000,
          sourceId: boardId,
          request: body,
          scope: { canvasId, boardId, sequenceId: body.sequenceId, sequenceIds: sequences },
          rows: [
            {
              key: shot.id,
              nodeId: source,
              shotId: shot.id,
              shotNo: 1,
              name: '镜头视频',
              prerequisite: false,
              action: 'run',
              reason: '为当前序列生成新候选',
              calls: 1,
              mapping: { ...mapping, sequenceId: body.sequenceId! },
            },
          ],
          summary: { run: 1, reuse: 0, blocked: 0, skip: 0, calls: 1, prices: [], unknownCalls: 1 },
        }
        return Response.json(plan)
      }
      if (request.method === 'POST' && path.endsWith('/storyboard-batch/commit')) {
        commits.push(await request.json())
        return Response.json({ groupId: 'group', total: 1 })
      }
    })
    const started = vi.fn()
    const { user, unmount } = renderApp(
      <BatchChecklist
        engine={engine}
        canvasId={canvasId}
        boardId={boardId}
        request={initial}
        onClose={() => {}}
        onLocate={() => {}}
        onStarted={started}
      />,
    )
    try {
      const confirm = screen.getByRole<HTMLButtonElement>('button', { name: '确认并开始生成' })
      await waitFor(() => expect(confirm.disabled).toBe(false))
      expect(screen.getByLabelText('清单冻结范围').textContent).toContain(sequences[0])
      const select = screen.getByRole<HTMLSelectElement>('combobox', { name: '批量清单序列范围' })
      // 范围变化走真实 change；文档变化在确认前同步作废预检，不靠重渲染禁用按钮。
      confirm.addEventListener(
        'click',
        () => {
          if (change === 'scope') {
            select.value = sequences[1]!
            select.dispatchEvent(new Event('change', { bubbles: true }))
          } else {
            setParam(doc, source, 'prompt', '同帧更新后的生成输入')
            doc.flush()
            expect(confirm.disabled).toBe(false)
          }
        },
        { capture: true, once: true },
      )
      await act(async () => {
        confirm.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      if (change === 'content') {
        expect(commits).toEqual([])
        expect(screen.getByRole('alert').textContent).toContain('清单范围或内容已变化，请重新检查')
        expect(started).not.toHaveBeenCalled()
        expect(confirm.disabled).toBe(true)
        await user.click(screen.getByRole('button', { name: '重新检查清单' }))
        await waitFor(() => expect(confirm.disabled).toBe(false))
        await user.click(confirm)
        await waitFor(() => expect(started).toHaveBeenCalledExactlyOnceWith(1))
        expect(previews.map((request) => request.sequenceId)).toEqual([sequences[0], sequences[0]])
        expect(commits).toEqual([{ token: `token:${sequences[0]}:2` }])
        return
      }
      await waitFor(() => expect(previews).toHaveLength(2))
      expect(previews.map((request) => request.sequenceId)).toEqual(sequences)
      expect(commits).toEqual([])
      expect(started).not.toHaveBeenCalled()
      expect(confirm.disabled).toBe(true)
      expect(screen.getByText('正在准备实际输入，不会调用生成平台…')).toBeTruthy()
      await act(async () => release())
      await waitFor(() => expect(confirm.disabled).toBe(false))
      expect(screen.getByLabelText('清单冻结范围').textContent).toContain(sequences[1])
      await user.click(confirm)
      await waitFor(() => expect(started).toHaveBeenCalledExactlyOnceWith(1))
      expect(commits).toEqual([{ token: `token:${sequences[1]}:2` }])
    } finally {
      await act(async () => release())
      unmount()
      doc.destroy()
    }
  },
)
