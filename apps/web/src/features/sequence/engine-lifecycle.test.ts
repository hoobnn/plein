import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import { PreviewEngine } from './engine'
import { Playhead } from './playhead'

const calls = vi.hoisted(() => ({
  primary: vi.fn(),
  decode: vi.fn(),
  timestamp: vi.fn(),
  sink: vi.fn(),
  dispose: vi.fn(),
  canvas: vi.fn(),
  draw: vi.fn(),
}))
vi.mock('mediabunny', () => ({
  ALL_FORMATS: [],
  UrlSource: class {},
  Input: class {
    getPrimaryVideoTrack() {
      return calls.primary()
    }
    dispose() {
      calls.dispose()
    }
  },
  CanvasSink: class {
    constructor() {
      calls.sink()
    }
    getCanvas(time: number) {
      return calls.canvas(time)
    }
    async *canvases() {
      yield* []
    }
  },
}))

const track = { canDecode: () => calls.decode(), getFirstTimestamp: () => calls.timestamp() }
const engines: PreviewEngine[] = []
let warn: ReturnType<typeof vi.spyOn>
const createVideo = vi.fn(() => ({
  paused: true,
  readyState: 0,
  currentTime: 0,
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
  removeAttribute: vi.fn(),
  pause: vi.fn(),
  load: vi.fn(),
}))
beforeEach(() => {
  vi.clearAllMocks()
  calls.primary.mockResolvedValue(track)
  calls.decode.mockResolvedValue(true)
  calls.timestamp.mockResolvedValue(0)
  calls.canvas.mockResolvedValue(null)
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn(() => 1),
  )
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  vi.stubGlobal('VideoDecoder', class {})
  vi.stubGlobal('AudioContext', undefined)
  vi.stubGlobal('document', { createElement: createVideo })
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  for (const engine of engines.splice(0)) engine.dispose()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
function open(playhead = new Playhead(), total = 2) {
  const engine = new PreviewEngine(playhead)
  engines.push(engine)
  engine.setScene({
    width: 96,
    height: 64,
    total,
    sounds: [],
    clips: [{ key: 'clip', assetId: 'asset', kind: 'video', start: 0, length: 2, in: 0, speed: 1 }],
  })
  engine.attach({
    width: 0,
    height: 0,
    dataset: {},
    getContext: () => ({ fillRect: vi.fn(), drawImage: calls.draw }),
  } as unknown as HTMLCanvasElement)
  return engine
}
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

describe('视频解码初始化与释放', () => {
  for (const phase of ['primary', 'decode', 'timestamp'] as const) {
    for (const rejected of [false, true]) {
      it(`${phase} 读取中释放后，迟到${rejected ? '失败' : '成功'}不再初始化或降级`, async () => {
        let release!: (value: unknown) => void
        let fail!: (error: Error) => void
        const pending = new Promise((resolve, reject) => {
          release = resolve
          fail = reject
        })
        calls[phase].mockReturnValue(pending)
        const engine = open()
        await vi.waitFor(() => expect(calls[phase]).toHaveBeenCalledOnce())
        engine.dispose()
        if (rejected) fail(new Error('InputDisposedError'))
        else release(phase === 'primary' ? track : phase === 'decode' ? true : 0)
        await settle()
        expect(calls.sink).not.toHaveBeenCalled()
        expect(createVideo).not.toHaveBeenCalled()
        expect(warn).not.toHaveBeenCalled()
        expect(calls.dispose).toHaveBeenCalledOnce()
        if (phase === 'primary') expect(calls.decode).not.toHaveBeenCalled()
        if (phase !== 'timestamp') expect(calls.timestamp).not.toHaveBeenCalled()
      })
    }
  }
  it('活动预览解码失败仍回退到 video 元素', async () => {
    calls.primary.mockRejectedValue(new Error('unsupported video'))
    open()
    await settle()
    expect(warn).toHaveBeenCalledOnce()
    expect(createVideo).toHaveBeenCalledOnce()
    expect(calls.dispose).toHaveBeenCalledOnce()
  })
  it('活动预览正常初始化 WebCodecs，不创建回退元素', async () => {
    open()
    await settle()
    expect(calls.sink).toHaveBeenCalledOnce()
    expect(warn).not.toHaveBeenCalled()
    expect(createVideo).not.toHaveBeenCalled()
  })
})

describe('等待中的暂停画面切换', () => {
  for (const action of ['pause', 'park'] as const) {
    for (const rejected of [false, true]) {
      it(`${action} 后旧帧迟到${rejected ? '失败' : '成功'}，无需额外操作就继续获取新位置`, async () => {
        let release!: () => void
        let fail!: (error: Error) => void
        calls.canvas.mockReturnValueOnce(
          new Promise((resolve, reject) => {
            release = () => resolve(null)
            fail = reject
          }),
        )
        const playhead = new Playhead()
        playhead.setTotal(4)
        open(playhead, 4)
        await vi.waitFor(() => expect(calls.canvas).toHaveBeenCalledOnce())
        if (action === 'pause') {
          playhead.play()
          playhead.pause()
        } else playhead.seek(3)
        playhead.seek(1)
        if (rejected) fail(new Error('old frame canceled'))
        else release()
        await settle()
        expect(calls.canvas).toHaveBeenCalledTimes(2)
        expect(calls.canvas).toHaveBeenLastCalledWith(1)
      })
    }
  }
  for (const rejected of [false, true]) {
    it(`暂停时连续定位，旧位置${rejected ? '失败' : '画面'}不阻断或覆盖新位置`, async () => {
      let release!: (frame: unknown) => void
      let fail!: (error: Error) => void
      calls.canvas.mockReturnValueOnce(
        new Promise((resolve, reject) => {
          release = resolve
          fail = reject
        }),
      )
      const playhead = new Playhead()
      playhead.setTotal(2)
      open(playhead)
      await vi.waitFor(() => expect(calls.canvas).toHaveBeenCalledOnce())
      playhead.seek(1)
      if (rejected) fail(new Error('old position failed'))
      else release({ canvas: { width: 96, height: 64 }, timestamp: 0, duration: 0.04 })
      await settle()
      expect(calls.draw).not.toHaveBeenCalled()
      expect(calls.canvas).toHaveBeenCalledTimes(2)
      expect(calls.canvas).toHaveBeenLastCalledWith(1)
    })
  }
  for (const disposed of [false, true]) {
    it(`${disposed ? '释放后' : '当前位置'}的读取失败不自动无限重试`, async () => {
      let fail!: (error: Error) => void
      calls.canvas.mockReturnValueOnce(
        new Promise((_, reject) => {
          fail = reject
        }),
      )
      const engine = open()
      await vi.waitFor(() => expect(calls.canvas).toHaveBeenCalledOnce())
      if (disposed) engine.dispose()
      fail(new Error('decode failed'))
      await settle()
      expect(calls.canvas).toHaveBeenCalledOnce()
    })
  }
})
