// @vitest-environment happy-dom
import { expect, it } from 'vite-plus/test'
import { renderApp, screen } from '../../testing/render'
import { BatchPlanDetails } from './BatchPlanDetails'

it('区分图生视频首帧和未送入的 @ 参考图', () => {
  renderApp(
    <BatchPlanDetails
      plan={{
        expiresAt: 1,
        sourceId: 'board',
        request: { shotIds: ['shot'], role: 'video', reuseExisting: false },
        rows: [
          {
            key: 'shot',
            name: '镜头',
            prerequisite: false,
            action: 'run',
            reason: '',
            calls: 1,
            input: {
              v: 1,
              nodeId: 'video',
              nodeType: 'plein/video',
              preparedAt: 1,
              status: 'ready',
              params: { mode: 'image' },
              inputs: { images: [{ type: 'image', assetId: 'first' }] },
              refs: [
                {
                  elementId: 'hero',
                  kind: 'character',
                  name: '角色',
                  required: false,
                  available: ['reference'],
                  sent: [],
                },
              ],
              notices: [],
              blocked: [],
            },
          },
        ],
        summary: { run: 1, reuse: 0, blocked: 0, skip: 0, calls: 1, prices: [], unknownCalls: 1 },
      }}
    />,
  )
  expect(screen.getByText(/首帧：已送入 1 张上游分镜图/)).toBeTruthy()
  expect(screen.getByText(/角色：作为 @ 引用直接送入 0 张参考图/)).toBeTruthy()
})

it('首帧模式没有图片输入时不显示首帧送入数量', () => {
  renderApp(
    <BatchPlanDetails
      plan={{
        expiresAt: 1,
        sourceId: 'board',
        request: { shotIds: ['shot'], role: 'video', reuseExisting: false },
        rows: [
          {
            key: 'shot',
            name: '镜头',
            prerequisite: false,
            action: 'run',
            reason: '',
            calls: 1,
            input: {
              v: 1,
              nodeId: 'video',
              nodeType: 'plein/video',
              preparedAt: 1,
              status: 'ready',
              params: { mode: 'image' },
              inputs: { images: [] },
              refs: [
                {
                  elementId: 'hero',
                  kind: 'character',
                  name: '角色',
                  required: false,
                  available: ['reference'],
                  sent: [],
                },
              ],
              notices: [],
              blocked: [],
            },
          },
        ],
        summary: { run: 1, reuse: 0, blocked: 0, skip: 0, calls: 1, prices: [], unknownCalls: 1 },
      }}
    />,
  )
  expect(screen.queryByText(/首帧：已送入/)).toBeNull()
  expect(screen.getByText(/角色：作为 @ 引用直接送入 0 张参考图/)).toBeTruthy()
})

it('多模态模式显示实际送入的连线素材总数，避免与未送入的 @ 引用混淆', () => {
  renderApp(
    <BatchPlanDetails
      plan={{
        expiresAt: 1,
        sourceId: 'board',
        request: { shotIds: ['shot'], role: 'video', reuseExisting: false },
        rows: [
          {
            key: 'shot',
            name: '镜头',
            prerequisite: false,
            action: 'run',
            reason: '',
            calls: 1,
            input: {
              v: 1,
              nodeId: 'video',
              nodeType: 'plein/video',
              preparedAt: 1,
              status: 'ready',
              params: { mode: 'reference' },
              inputs: {
                images: [{ type: 'image', assetId: 'connected-image' }],
                audios: [{ type: 'audio', assetId: 'connected-audio' }],
              },
              refs: [
                {
                  elementId: 'hero',
                  kind: 'character',
                  name: '角色',
                  required: false,
                  available: ['reference'],
                  sent: [],
                },
              ],
              notices: [],
              blocked: [],
            },
          },
        ],
        summary: { run: 1, reuse: 0, blocked: 0, skip: 0, calls: 1, prices: [], unknownCalls: 1 },
      }}
    />,
  )
  expect(screen.getByText(/实际送入模型：1 张图片、0 段视频、1 段音频/)).toBeTruthy()
  expect(screen.getByText(/角色：作为 @ 引用直接送入 0 张参考图/)).toBeTruthy()
})
