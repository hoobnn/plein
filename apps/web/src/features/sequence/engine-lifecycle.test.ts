import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import { PreviewEngine } from './engine'
import { Playhead } from './playhead'

const calls = vi.hoisted(() => ({
  primary: vi.fn(),
  decode: vi.fn(),
  timestamp: vi.fn(),
  sink: vi.fn(),
  dispose: vi.fn(),
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
    async getCanvas() {
      return null
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
function open() {
  const engine = new PreviewEngine(new Playhead())
  engines.push(engine)
  engine.setScene({
    width: 96,
    height: 64,
    total: 2,
    sounds: [],
    clips: [{ key: 'clip', assetId: 'asset', kind: 'video', start: 0, length: 2, in: 0, speed: 1 }],
  })
  engine.attach({
    width: 0,
    height: 0,
    dataset: {},
    getContext: () => ({}),
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
