import type { Engine } from '@plein/canvas-core'
import type { PreparedInput } from '@plein/protocol'
import { afterEach, beforeEach, expect, it, vi } from 'vite-plus/test'
import { ApiError, api } from '../../api/client'
import * as groups from '../../canvas/groups'
import { useCanvas } from '../../stores/canvas'
import { abortGroupRuns, useGroupRuns } from './groupRuns'
import { useRunRequests } from './runRequests'
import { useCancelRequests } from './cancelRequests'
import { cancelGroup, cancelNode, runFlowFrom, runFrame, runNode } from './run'

const engine = () => ({ doc: { get: () => ({ run: { id: 'visible-run' } }) } }) as unknown as Engine
beforeEach(() => {
  vi.useFakeTimers()
  abortGroupRuns()
  useCanvas.setState({ engine: engine(), canvasId: 'canvas' })
})
afterEach(() => {
  abortGroupRuns()
  useRunRequests.setState({ pending: new Set() })
  useCancelRequests.setState({ pending: new Set() })
  useCanvas.setState({ engine: null, canvasId: null })
  useCanvas.getState().notify(null)
  vi.restoreAllMocks()
  vi.useRealTimers()
})
it('运行等待跨入口防重入，受理后释放登记并保留重试和已看输入身份', async () => {
  let release!: (value: { runId: string }) => void
  const send = vi.spyOn(api, 'runNode').mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve
      }) as ReturnType<typeof api.runNode>,
  )
  const pending = runNode('node', { expect: 'input-signature', retryOf: 'failed-run' })
  expect(await runNode('node')).toBeNull()
  expect(send).toHaveBeenCalledTimes(1)
  expect(send).toHaveBeenCalledWith('canvas', 'node', {
    expect: 'input-signature',
    retryOf: 'failed-run',
  })
  release({ runId: 'new-run' })
  expect(await pending).toBe('new-run')
  expect(useRunRequests.getState().pending.size).toBe(0)
})
it('当前输入变化返回新实际输入供用户重审，失败后允许重新提交', async () => {
  const input = { signature: 'new-signature' } as unknown as PreparedInput
  const send = vi
    .spyOn(api, 'runNode')
    .mockRejectedValueOnce(new ApiError(409, 'input_changed', '实际输入已变化', { input }))
    .mockResolvedValueOnce({ runId: 'retried' } as never)
  const onChanged = vi.fn()
  expect(await runNode('node', { expect: 'old', onChanged })).toBeNull()
  expect(onChanged).toHaveBeenCalledWith(input)
  expect(useCanvas.getState().notice).toBe('实际输入已变化')
  expect(await runNode('node')).toBe('retried')
  expect(send).toHaveBeenCalledTimes(2)
})
it('单节点迟到输入冲突不在切回同画布后的新引擎里改面板或提示', async () => {
  let fail!: (error: Error) => void
  vi.spyOn(api, 'runNode').mockImplementation(
    () =>
      new Promise((_resolve, reject) => {
        fail = reject
      }),
  )
  const onChanged = vi.fn(),
    pending = runNode('node', { onChanged })
  useCanvas.setState({ engine: engine() })
  fail(new ApiError(409, 'input_changed', '旧输入冲突', { input: {} }))
  expect(await pending).toBeNull()
  expect(onChanged).not.toHaveBeenCalled()
  expect(useCanvas.getState().notice).toBeNull()
})
it.each(['node', 'group'] as const)(
  '%s 停止等待防重入，旧引擎失败静默，当前失败可提示并重试',
  async (kind) => {
    let fail!: (error: Error) => void
    const send = kind === 'node' ? vi.spyOn(api, 'cancelNode') : vi.spyOn(api, 'cancelGroup')
    send.mockImplementation(
      () =>
        new Promise<void>((_resolve, reject) => {
          fail = reject
        }),
    )
    const run = () => (kind === 'node' ? cancelNode('node') : cancelGroup('group'))
    const pending = run()
    await run()
    expect(send).toHaveBeenCalledTimes(1)
    if (kind === 'node')
      expect(send).toHaveBeenCalledWith('canvas', 'node', { runId: 'visible-run' })
    useCanvas.setState({ engine: engine() })
    fail(new Error('旧停止失败'))
    await pending
    expect(useCanvas.getState().notice).toBeNull()
    send.mockRejectedValueOnce(new Error('当前停止失败')).mockResolvedValueOnce(undefined)
    await run()
    expect(useCanvas.getState().notice).toBe('当前停止失败')
    await run()
    expect(send).toHaveBeenCalledTimes(3)
    expect(useCancelRequests.getState().pending.size).toBe(0)
  },
)
it.each(['frame', 'flow'] as const)(
  '%s 的迟到登记和成功不覆盖新运行状态或弹旧结果',
  async (kind) => {
    let release!: (value: groups.GroupRun) => void
    let onStart: ((id: string) => void) | undefined
    const outcome: groups.GroupRun = {
      succeeded: 1,
      cached: 0,
      failed: 0,
      canceled: 0,
      skipped: 0,
      stopped: false,
    }
    const send =
      kind === 'frame'
        ? vi.spyOn(groups, 'runGroup').mockImplementation((_canvas, _frame, opts) => {
            onStart = opts?.onStart
            return new Promise((resolve) => {
              release = resolve
            })
          })
        : vi.spyOn(groups, 'runFlow').mockImplementation(
            () =>
              new Promise((resolve) => {
                release = resolve
              }),
          )
    const pending =
      kind === 'frame' ? runFrame('frame', '水杯组') : runFlowFrom('node', 'downstream', '水杯')
    if (kind === 'frame') {
      await runFrame('frame', '水杯组')
      expect(send).toHaveBeenCalledTimes(1)
    }
    abortGroupRuns()
    useCanvas.setState({ engine: engine() })
    useGroupRuns.getState().begin('frame')
    useGroupRuns.getState().started('frame', 'new-group')
    onStart?.('old-group')
    release(outcome)
    await pending
    expect(useGroupRuns.getState().runs.frame).toBe('new-group')
    expect(useCanvas.getState().notice).toBeNull()
  },
)
it('演示画布不提交远端运行或停止请求，并明确说明入口限制', async () => {
  useCanvas.setState({ canvasId: null })
  const start = vi.spyOn(api, 'runNode'),
    stop = vi.spyOn(api, 'cancelNode')
  expect(await runNode('node')).toBeNull()
  await runFrame('frame', '本地')
  await runFlowFrom('node', 'upstream', '本地')
  await cancelNode('node')
  await cancelGroup('group')
  expect(start).not.toHaveBeenCalled()
  expect(stop).not.toHaveBeenCalled()
  expect(useCanvas.getState().notice).toContain('演示画布不能运行节点')
})
