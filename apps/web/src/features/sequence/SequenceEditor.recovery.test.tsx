// @vitest-environment happy-dom
import { zipSync } from 'fflate'
import { connect, setParams } from '@plein/doc'
import { expect, it, vi } from 'vite-plus/test'
import { act, fireEvent, renderApp, screen, waitFor } from '../../testing/render'
import { mockFetch } from '../../testing/fetch'
import { SequenceEditor } from './SequenceEditor'
import { sequenceFixture } from './testing'

vi.mock('./SequencePreview', () => ({ SequencePreview: () => null }))
vi.mock('./media', async (original) => ({
  ...(await original<typeof import('./media')>()),
  Filmstrip: () => null,
  Waveform: () => null,
}))
let serial = 0
function fixture() {
  const asset = `recovery-${++serial}`
  const f = sequenceFixture({ videos: [asset] })
  return { ...f, asset }
}
const meta = (id: string, duration: number | undefined = 2) => ({
  id,
  name: '镜头.webm',
  kind: 'video',
  mime: 'video/webm',
  duration,
  width: 96,
  height: 64,
})
const archive = () =>
  new Response(Uint8Array.from(zipSync({ 'timeline.otio': new Uint8Array([1]) })), {
    headers: { 'content-type': 'application/zip' },
  })
function downloaded() {
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:sequence-export')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  return vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
}

it.each(['header', 'inline', 'readonly', 'replacement'] as const)(
  '素材信息 %s 失败后可恢复，保留剪辑且不重复读取成功项',
  async (entry) => {
    const f = fixture()
    let broken = true
    let reads = 0
    mockFetch((request) => {
      if (new URL(request.url).pathname.endsWith('/meta')) {
        reads++
        return broken
          ? Response.json({ error: 'unavailable', message: '素材信息暂不可用' }, { status: 503 })
          : Response.json(meta(f.asset))
      }
    })
    const { user } = renderApp(<SequenceEditor />)
    expect((await screen.findByRole('alert', { name: '素材信息读取失败' })).textContent).toContain(
      '素材信息暂不可用',
    )
    const original = structuredClone(f.params())
    expect(screen.getByRole('button', { name: '导出工程' }).hasAttribute('disabled')).toBe(true)
    broken = false
    if (entry === 'readonly')
      act(() => {
        f.doc.readOnly = true
        f.refresh()
      })
    if (entry === 'replacement')
      act(() => {
        f.doc.mutable(f.sources[0]!)!.set('assetId', `${f.asset}-new`)
        f.refresh()
      })
    else
      await user.click(
        screen.getByRole('button', { name: entry === 'header' ? '重新加载预览' : '重试素材信息' }),
      )
    await waitFor(() =>
      expect(screen.queryByRole('alert', { name: '素材信息读取失败' })).toBeNull(),
    )
    expect(screen.getByRole('button', { name: '导出工程' }).hasAttribute('disabled')).toBe(false)
    expect(f.params()).toEqual(original)
    const done = reads
    await user.click(screen.getByRole('button', { name: '重新加载预览' }))
    expect(reads).toBe(done)
  },
)

it.each(['http', 'not-zip', 'network'] as const)(
  '工程文件 %s 失败不会下载错误内容，重试恢复并给出完成提示',
  async (mode) => {
    const f = fixture()
    const save = downloaded()
    let broken = true
    mockFetch((request) => {
      const path = new URL(request.url).pathname
      if (path.endsWith('/meta')) return Response.json(meta(f.asset))
      if (request.method === 'POST' && path === '/api/media/sequence-export')
        return Response.json({ url: '/api/media/sequence-export/test' })
      if (request.method === 'GET' && path === '/api/media/sequence-export/test') {
        if (!broken) return archive()
        if (mode === 'network') throw new TypeError('connection reset')
        return mode === 'http'
          ? Response.json({ error: 'unavailable', message: '工程下载暂不可用' }, { status: 503 })
          : new Response('<html>error</html>')
      }
    })
    const { user } = renderApp(<SequenceEditor />)
    const button = screen.getByRole('button', { name: '导出工程' })
    await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false))
    await user.click(button)
    expect((await screen.findByRole('alert', { name: '工程导出失败' })).textContent).toContain(
      mode === 'http' ? '工程下载暂不可用' : mode === 'network' ? '读取中断' : 'ZIP',
    )
    expect(save).not.toHaveBeenCalled()
    broken = false
    await user.click(button)
    await waitFor(() => expect(save).toHaveBeenCalledOnce())
    expect(screen.queryByRole('alert', { name: '工程导出失败' })).toBeNull()
    expect(screen.getByText(/已交给浏览器下载/)).toBeTruthy()
  },
)

it.each(['cancel', 'close', 'edit', 'preparing-close'] as const)(
  '等待工程时 %s 取消旧请求，重复点击只准备一次',
  async (entry) => {
    const f = fixture()
    const save = downloaded()
    let release!: (value: Response) => void
    const held = new Promise<Response>((resolve) => {
      release = resolve
    })
    let signal: AbortSignal | undefined
    let submits = 0
    mockFetch((request) => {
      const path = new URL(request.url).pathname
      if (path.endsWith('/meta')) return Response.json(meta(f.asset))
      if (request.method === 'POST' && path === '/api/media/sequence-export') {
        submits++
        if (entry === 'preparing-close') {
          signal = request.signal
          return held
        }
        return Response.json({ url: '/api/media/sequence-export/test' })
      }
      if (path === '/api/media/sequence-export/test') {
        signal = request.signal
        return held
      }
    })
    const { user } = renderApp(<SequenceEditor />)
    const button = screen.getByRole('button', { name: '导出工程' })
    await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false))
    act(() => {
      fireEvent.click(button)
      fireEvent.click(button)
    })
    await waitFor(() => expect(signal).toBeDefined())
    expect(submits).toBe(1)
    if (entry === 'cancel') await user.click(screen.getByRole('button', { name: '取消工程导出' }))
    else if (entry === 'edit') act(() => f.patch({ aspectRatio: '16:9' }))
    else await user.click(screen.getByRole('button', { name: '关闭' }))
    expect(signal!.aborted).toBe(true)
    await act(async () =>
      release(
        entry === 'preparing-close'
          ? Response.json({ url: '/api/media/sequence-export/test' })
          : archive(),
      ),
    )
    expect(save).not.toHaveBeenCalled()
    if (entry === 'edit')
      expect(screen.getByRole('alert', { name: '工程导出失败' }).textContent).toContain(
        '剪辑内容已变化',
      )
    if (entry === 'cancel') expect(screen.getByText(/已取消工程文件读取/)).toBeTruthy()
  },
)

it('失败成片可展开原始错误且说明已有交付被保留', async () => {
  const f = sequenceFixture({ animatic: true })
  act(() => {
    const node = f.doc.mutable(f.id)!
    node.set('results', [
      {
        id: 'old',
        runId: 'old-job',
        port: 'video',
        at: 1,
        value: { type: 'video', assetId: 'old-film' },
      },
    ])
    node.set('adopted', 'old')
    node.set('run', { id: 'failed-job', status: 'failed', error: '原始素材已损坏' })
    f.refresh()
  })
  mockFetch((request) =>
    new URL(request.url).pathname.endsWith('/meta') ? Response.json(meta('old-film')) : undefined,
  )
  renderApp(<SequenceEditor />)
  const error = await screen.findByRole('alert', { name: '成片导出失败' })
  expect(error.textContent).toContain('已有成片与交付记录已保留')
  expect(error.querySelector('pre')?.textContent).toBe('原始素材已损坏')
  expect(screen.getByRole('button', { name: '重新导出' }).hasAttribute('disabled')).toBe(false)
})

it.each(['delayed', 'failed', 'missing-duration', 'cancel', 'close'] as const)(
  '工程对白时长 %s 等待完整数据，不提交不完整声音',
  async (mode) => {
    const f = fixture()
    const voices = [`${f.asset}-first`, `${f.asset}-second`]
    const sources = voices.map((assetId) => f.add({ kind: 'audio', assetId, name: assetId }))
    for (const source of sources) connect(f.doc, [source, 'audio'], [f.id, 'dialogue'])
    const clips = f.params().clips as Array<Record<string, unknown>>
    setParams(f.doc, f.id, {
      clips: clips.map((clip) => ({
        ...clip,
        dialogue: sources[0],
        more: [sources[1]],
        lineGap: 0,
      })),
    })
    f.doc.flush()
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let first = true
    const bodies: Array<{ spec: { audio: Array<{ asset: { assetId: string } }> } }> = []
    const save = downloaded()
    mockFetch(async (request) => {
      const path = new URL(request.url).pathname
      if (path.endsWith('/meta')) {
        const id = path.split('/').at(-2)!
        if (id === voices[0] && first) {
          first = false
          await held
          if (mode === 'failed')
            return Response.json(
              { error: 'unavailable', message: '对白信息暂不可用' },
              { status: 503 },
            )
          if (mode === 'missing-duration')
            return Response.json({ ...meta(id), name: 'first.wav', duration: undefined })
        }
        return Response.json(meta(id, id === f.asset ? 2 : 0.1))
      }
      if (request.method === 'POST' && path === '/api/media/sequence-export') {
        bodies.push(await request.json())
        return Response.json({ url: '/api/media/sequence-export/voices' })
      }
      if (path === '/api/media/sequence-export/voices') return archive()
    })
    const { user } = renderApp(<SequenceEditor />)
    const button = screen.getByRole('button', { name: '导出工程' })
    await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false))
    await user.click(button)
    expect(screen.getByText(/正在读取素材时长，完成后/)).toBeTruthy()
    expect(bodies).toHaveLength(0)
    if (mode === 'cancel') await user.click(screen.getByRole('button', { name: '取消工程导出' }))
    if (mode === 'close') await user.click(screen.getByRole('button', { name: '关闭' }))
    await act(async () => release())
    if (mode === 'cancel' || mode === 'close') {
      expect(save).not.toHaveBeenCalled()
      expect(bodies).toHaveLength(0)
      return
    }
    if (mode === 'failed' || mode === 'missing-duration') {
      const error = await screen.findByRole('alert', { name: '工程导出失败' })
      expect(error.textContent).toContain(mode === 'failed' ? '对白信息暂不可用' : 'first.wav')
      expect(bodies).toHaveLength(0)
      expect(save).not.toHaveBeenCalled()
      if (mode === 'missing-duration') return
      await user.click(button)
    }
    await waitFor(() => expect(save).toHaveBeenCalledOnce())
    expect(bodies).toHaveLength(1)
    expect(bodies[0]!.spec.audio.map((audio) => audio.asset.assetId)).toEqual(
      expect.arrayContaining(voices),
    )
  },
)
