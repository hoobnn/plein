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
  next: vi.fn(),
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
    canvases() {
      return {
        next: () => calls.next(),
        return: async () => ({ done: true, value: undefined }),
      }
    }
  },
}))

const track = { canDecode: () => calls.decode(), getFirstTimestamp: () => calls.timestamp() }
const engines: PreviewEngine[] = []
let warn: ReturnType<typeof vi.spyOn>
const createVideo = vi.fn(() => ({
  onerror: null as (() => void) | null,
  paused: true,
  readyState: 0,
  currentTime: 0,
  playbackRate: 1,
  muted: false,
  videoWidth: 0,
  videoHeight: 0,
  seeking: false,
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
  removeAttribute: vi.fn(),
  pause: vi.fn(),
  play: vi.fn(async () => {}),
  load: vi.fn(),
}))
beforeEach(() => {
  vi.clearAllMocks()
  calls.primary.mockResolvedValue(track)
  calls.decode.mockResolvedValue(true)
  calls.timestamp.mockResolvedValue(0)
  calls.canvas.mockResolvedValue(null)
  calls.next.mockResolvedValue({ done: true, value: undefined })
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
function open(playhead = new Playhead(), total = 2, onIssues: (count: number) => void = () => {}) {
  const engine = new PreviewEngine(playhead, onIssues)
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
  it('未知MIME先保留alpha，元数据确定MP4后释放原生元素并使用WebCodecs', async () => {
    const engine = open()
    const scene = {
      width: 96,
      height: 64,
      total: 2,
      sounds: [],
      clips: [
        {
          key: 'clip',
          assetId: 'asset',
          kind: 'video' as const,
          start: 0,
          length: 2,
          in: 0,
          speed: 1,
          native: true,
        },
      ],
    }
    engine.setScene(scene)
    await settle()
    expect(createVideo).toHaveBeenCalledOnce()
    const video = createVideo.mock.results[0]!.value
    engine.setScene({ ...scene, clips: scene.clips.map((clip) => ({ ...clip, native: false })) })
    await settle()
    expect(video.removeAttribute).toHaveBeenCalledWith('src')
    expect(video.load).toHaveBeenCalledOnce()
    expect(calls.sink).toHaveBeenCalledOnce()
  })
  it('真正的解码失败回退不会被普通场景刷新反复改回WebCodecs', async () => {
    calls.primary.mockRejectedValue(new Error('unsupported video'))
    const engine = open()
    await settle()
    engine.setScene({
      width: 96,
      height: 64,
      total: 2,
      sounds: [],
      clips: [
        { key: 'clip', assetId: 'asset', kind: 'video', start: 0, length: 2, in: 0, speed: 1 },
      ],
    })
    await settle()
    expect(calls.primary).toHaveBeenCalledOnce()
    expect(createVideo).toHaveBeenCalledOnce()
    expect(createVideo.mock.results[0]!.value.load).not.toHaveBeenCalled()
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
        expect(createVideo).not.toHaveBeenCalled()
        expect(warn).not.toHaveBeenCalled()
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
      expect(createVideo).not.toHaveBeenCalled()
      expect(warn).not.toHaveBeenCalled()
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

describe('已初始化视频的读取失败', () => {
  for (const playing of [false, true]) {
    it(`${playing ? '播放迭代' : '暂停取帧'}失败会降级，回退也失败时可见且可重试`, async () => {
      const issues = vi.fn()
      const playhead = new Playhead()
      playhead.setTotal(2)
      if (!playing) calls.canvas.mockRejectedValueOnce(new Error('frame decode failed'))
      const engine = open(playhead, 2, issues)
      await settle()
      if (playing) {
        calls.next.mockRejectedValueOnce(new Error('iterator decode failed'))
        playhead.play()
        await settle()
      }
      expect(createVideo).toHaveBeenCalledOnce()
      expect(warn).toHaveBeenCalledOnce()
      expect(calls.dispose).toHaveBeenCalledOnce()
      createVideo.mock.results[0]!.value.onerror?.()
      expect(issues).toHaveBeenLastCalledWith(1)
      engine.retryFailed()
      await settle()
      expect(issues).toHaveBeenLastCalledWith(0)
      expect(calls.primary).toHaveBeenCalledTimes(2)
    })
  }
})

describe('透明叠加原生video与唯一播放头', () => {
  it('强制native，不创建CanvasSink；入点变速、几何、opacity按同一时钟绘制并在离轨时停播', () => {
    const playhead = new Playhead()
    playhead.setTotal(4)
    const engine = new PreviewEngine(playhead)
    engines.push(engine)
    engine.setScene({
      width: 96,
      height: 64,
      total: 4,
      clips: [],
      sounds: [],
      overlays: [
        {
          id: 'overlay',
          key: 'overlay',
          assetId: 'alpha',
          kind: 'video',
          native: true,
          seekOnly: true,
          start: 1,
          length: 2,
          in: 0.5,
          speed: 2,
          x: 0.25,
          y: 0.5,
          width: 0.5,
          height: 0.25,
          opacity: 0.4,
        },
      ],
    })
    engine.attach({
      width: 0,
      height: 0,
      dataset: {},
      getContext: () => ({ fillRect: vi.fn(), drawImage: calls.draw }),
    } as unknown as HTMLCanvasElement)
    playhead.seek(1.25)
    expect(createVideo).toHaveBeenCalledOnce()
    const video = createVideo.mock.results[0]!.value
    expect(video.muted).toBe(true)
    expect(video.currentTime).toBe(1)
    expect(video.play).not.toHaveBeenCalled()
    video.readyState = 2
    video.videoWidth = 96
    video.videoHeight = 64
    playhead.seek(1.5)
    expect(calls.draw).toHaveBeenLastCalledWith(video, 24, 32, 48, 16)
    expect(calls.sink).not.toHaveBeenCalled()
    video.paused = false
    playhead.seek(3)
    expect(video.pause).toHaveBeenCalled()
    engine.dispose()
    expect(video.removeAttribute).toHaveBeenCalledWith('src')
    expect(video.load).toHaveBeenCalled()
  })
})

it('图片失败暂停并提示，重试清除失败且保留播放头，成功后重新绘制', () => {
  const images: Array<{
    onload: (() => void) | null
    onerror: (() => void) | null
    src: string
    complete: boolean
    naturalWidth: number
    naturalHeight: number
  }> = []
  vi.stubGlobal(
    'Image',
    class {
      onload = null
      onerror = null
      src = ''
      complete = false
      naturalWidth = 0
      naturalHeight = 0
      constructor() {
        images.push(this)
      }
    },
  )
  const issues = vi.fn()
  const playhead = new Playhead()
  playhead.setTotal(2)
  const engine = new PreviewEngine(playhead, issues)
  engines.push(engine)
  engine.setScene({
    width: 96,
    height: 64,
    total: 2,
    sounds: [],
    clips: [
      { key: 'image', assetId: 'still', kind: 'image', start: 0, length: 2, in: 0, speed: 1 },
    ],
  })
  engine.attach({
    width: 0,
    height: 0,
    dataset: {},
    getContext: () => ({ fillRect: vi.fn(), drawImage: calls.draw }),
  } as unknown as HTMLCanvasElement)
  playhead.seek(0.5)
  playhead.play()
  images[0]!.onerror?.()
  expect(issues).toHaveBeenLastCalledWith(1)
  expect(playhead.playing).toBe(false)
  engine.retryFailed()
  expect(issues).toHaveBeenLastCalledWith(0)
  expect(playhead.t).toBeCloseTo(0.5, 1)
  expect(images[0]!.onload).toBeNull()
  Object.assign(images[1]!, { complete: true, naturalWidth: 96, naturalHeight: 64 })
  images[1]!.onload?.()
  expect(calls.draw).toHaveBeenCalledWith(images[1], 0, 0, 96, 64)
})
