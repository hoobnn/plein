import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import { PreviewEngine, type Scene } from './engine'
import { Playhead } from './playhead'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}
const engines: PreviewEngine[] = []
const sources: Array<{
  start: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
  disconnect: ReturnType<typeof vi.fn>
}> = []
const decode = vi.fn()
const close = vi.fn(async () => {})
const requests = vi.fn<typeof fetch>()
const gain = () => ({
  gain: { setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() },
  connect: vi.fn(),
  disconnect: vi.fn(),
})
beforeEach(() => {
  sources.length = 0
  decode.mockReset().mockResolvedValue({ duration: 10 })
  requests.mockReset().mockImplementation(async () => new Response(new Uint8Array([1, 2, 3])))
  close.mockClear()
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn(() => 1),
  )
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  vi.stubGlobal('fetch', requests)
  vi.stubGlobal(
    'AudioContext',
    class {
      state = 'running'
      currentTime = 0
      destination = {}
      createGain = gain
      decodeAudioData = decode
      close = close
      addEventListener() {}
      removeEventListener() {}
      createBufferSource() {
        const source = {
          start: vi.fn(),
          stop: vi.fn(),
          disconnect: vi.fn(),
          playbackRate: { value: 1 },
          connect: vi.fn(() => gain()),
          addEventListener: vi.fn(),
        }
        sources.push(source)
        return source
      }
    },
  )
})
afterEach(() => {
  for (const engine of engines.splice(0)) engine.dispose()
  vi.unstubAllGlobals()
})
const scene: Scene = {
  width: 96,
  height: 64,
  total: 10,
  clips: [],
  sounds: [{ assetId: 'voice', start: 0, offset: 0, duration: 10, gain: 1 }],
}
function setup() {
  const playhead = new Playhead()
  playhead.setTotal(10)
  const issues = vi.fn()
  const engine = new PreviewEngine(playhead, issues)
  engines.push(engine)
  engine.setScene(scene)
  playhead.play()
  return { engine, playhead, issues }
}
const settle = async () => {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

describe('配音读取与预览释放', () => {
  it.each(['http', 'decode'] as const)(
    '%s 失败暂停并提示，只重试失败来源后可恢复声音',
    async (mode) => {
      if (mode === 'http') requests.mockResolvedValueOnce(new Response(null, { status: 503 }))
      else decode.mockRejectedValueOnce(new Error('invalid audio'))
      const { engine, playhead, issues } = setup()
      await vi.waitFor(() => expect(issues).toHaveBeenLastCalledWith(1))
      expect(playhead.playing).toBe(false)
      expect(sources).toHaveLength(0)
      engine.retryFailed()
      await vi.waitFor(() => expect(issues).toHaveBeenLastCalledWith(0))
      await settle()
      playhead.play()
      await vi.waitFor(() => expect(sources).toHaveLength(1))
      expect(sources[0]!.start).toHaveBeenCalledOnce()
      expect(requests).toHaveBeenCalledTimes(2)
    },
  )
  it('关闭时立即停止已有声音并释放音频上下文', async () => {
    const { engine } = setup()
    await vi.waitFor(() => expect(sources).toHaveLength(1))
    engine.dispose()
    expect(sources[0]!.stop).toHaveBeenLastCalledWith()
    expect(sources[0]!.disconnect).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()
  })
  it('关闭时取消未完成读取，迟到响应不继续解码或播放', async () => {
    const held = deferred<Response>()
    requests.mockReturnValueOnce(held.promise)
    const { engine, issues } = setup()
    const signal = requests.mock.calls[0]![1]!.signal!
    engine.dispose()
    expect(signal.aborted).toBe(true)
    held.resolve(new Response(new Uint8Array([1])))
    await settle()
    expect(decode).not.toHaveBeenCalled()
    expect(sources).toHaveLength(0)
    expect(issues).not.toHaveBeenCalled()
  })
  it('解码中关闭，迟到成功不再排程旧声音', async () => {
    const held = deferred<AudioBuffer>()
    decode.mockReturnValueOnce(held.promise)
    const { engine } = setup()
    await vi.waitFor(() => expect(decode).toHaveBeenCalledOnce())
    engine.dispose()
    held.resolve({ duration: 10 } as AudioBuffer)
    await settle()
    expect(sources).toHaveLength(0)
  })
  it('移出后重新加入同一配音，旧失败不能暂停新的播放或污染错误状态', async () => {
    const held = deferred<Response>()
    requests.mockReturnValueOnce(held.promise)
    const { engine, playhead, issues } = setup()
    const oldSignal = requests.mock.calls[0]![1]!.signal!
    engine.setScene({ ...scene, sounds: [] })
    expect(oldSignal.aborted).toBe(true)
    engine.setScene(scene)
    await vi.waitFor(() => expect(sources).toHaveLength(1))
    held.reject(new Error('old failed'))
    await settle()
    expect(playhead.playing).toBe(true)
    expect(issues).not.toHaveBeenCalled()
    expect(requests).toHaveBeenCalledTimes(2)
  })
  it('暂停后迟到解码不播放，再播放复用成功缓冲', async () => {
    const held = deferred<AudioBuffer>()
    decode.mockReturnValueOnce(held.promise)
    const { playhead } = setup()
    await vi.waitFor(() => expect(decode).toHaveBeenCalledOnce())
    playhead.pause()
    held.resolve({ duration: 10 } as AudioBuffer)
    await settle()
    expect(sources).toHaveLength(0)
    playhead.play()
    await vi.waitFor(() => expect(sources).toHaveLength(1))
    expect(requests).toHaveBeenCalledOnce()
  })
})
