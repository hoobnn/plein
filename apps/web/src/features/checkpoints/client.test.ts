import { describe, expect, it, onTestFinished, vi } from 'vite-plus/test'
import { ApiError } from '../../api/client'
import { saveSynchronizedCheckpoint } from './client'

describe('检查点保存同步等待', () => {
  it('离线时不请求，sync_pending后保留同一Snapshot重试，恢复后只保存一次', async () => {
    vi.useFakeTimers()
    onTestFinished(() => {
      vi.useRealTimers()
    })
    let connected = false
    const body = { name: '版本', expectedSnapshot: '包含删除集的快照' }
    const submit = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(409, 'sync_pending', '同步中'))
      .mockResolvedValueOnce({ id: 'cp_1' })
    const waiting = vi.fn()
    const saving = saveSynchronizedCheckpoint({
      canvasId: 'cv_1',
      body,
      signal: new AbortController().signal,
      connected: () => connected,
      current: () => true,
      onWaiting: waiting,
      submit,
    })
    expect(submit).not.toHaveBeenCalled()
    connected = true
    await vi.advanceTimersByTimeAsync(400)
    expect(submit).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(400)
    await expect(saving).resolves.toEqual({ id: 'cp_1' })
    expect(submit).toHaveBeenCalledTimes(2)
    expect(submit.mock.calls[0]![1]).toBe(body)
    expect(submit.mock.calls[1]![1]).toBe(body)
    expect(waiting).toHaveBeenCalled()
  })

  it('网络结果未知不自动重复创建，取消等待不发请求', async () => {
    const submit = vi.fn().mockRejectedValue(new TypeError('网络断开'))
    await expect(
      saveSynchronizedCheckpoint({
        canvasId: 'cv',
        body: { name: '版本', expectedSnapshot: 'x' },
        signal: new AbortController().signal,
        connected: () => true,
        current: () => true,
        onWaiting: () => {},
        submit,
      }),
    ).rejects.toThrow('网络断开')
    expect(submit).toHaveBeenCalledTimes(1)
    const ctrl = new AbortController()
    ctrl.abort(new Error('取消'))
    await expect(
      saveSynchronizedCheckpoint({
        canvasId: 'cv',
        body: { name: '版本', expectedSnapshot: 'x' },
        signal: ctrl.signal,
        connected: () => false,
        current: () => true,
        onWaiting: () => {},
        submit,
      }),
    ).rejects.toThrow('取消')
    expect(submit).toHaveBeenCalledTimes(1)
  })
})
