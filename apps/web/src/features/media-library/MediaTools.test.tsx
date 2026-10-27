// @vitest-environment happy-dom
import { type Engine, Scene } from '@plein/canvas-core'
import { createElement, type PleinDoc } from '@plein/doc'
import { openDoc } from '@plein/doc/testing'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import { api } from '../../api/client'
import { useCanvas } from '../../stores/canvas'
import { mockFetch } from '../../testing/fetch'
import { renderApp, screen, waitFor, within } from '../../testing/render'
import { batchMediaOps } from '../../canvas/media'
import { MediaBatchTools, MediaTools } from '../../shell/MediaTools'

const docs: PleinDoc[] = []
afterEach(() => {
  vi.restoreAllMocks()
  useCanvas.setState({ engine: null, canvasId: null })
  for (const doc of docs.splice(0)) doc.destroy()
})

const derive = vi.fn()
beforeEach(() => {
  derive.mockReset()
  derive.mockResolvedValue({ assets: [], created: [] })
  vi.spyOn(api, 'mediaDerive').mockImplementation(derive)
  vi.spyOn(api, 'mediaCaps').mockResolvedValue({
    ffmpeg: true,
    subtitles: false,
    rubberband: false,
  } as never)
  mockFetch(async (request) => {
    const url = new URL(request.url)
    if (url.pathname === '/api/media/caps')
      return new Response(JSON.stringify({ ffmpeg: true, subtitles: false, rubberband: false }), {
        headers: { 'content-type': 'application/json' },
      })
    if (url.pathname.endsWith('/meta'))
      return new Response(
        JSON.stringify({
          id: 'asset-1',
          kind: 'image',
          mime: 'image/png',
          name: '海鸟.png',
          size: 10,
          width: 100,
          height: 80,
          duration: 5,
          variants: [],
          createdAt: 0,
        }),
        { headers: { 'content-type': 'application/json' } },
      )
    return undefined
  })
})

/** 够用的假引擎：加工流程只用到选择、相机、工具和文档。 */
function fakeEngine() {
  const doc = openDoc()
  docs.push(doc)
  const engine = {
    doc,
    scene: new Scene(doc),
    state: { tool: 'select' },
    camera: {
      viewRect: { x: 0, y: 0, w: 800, h: 600 },
      onChange: () => () => {},
      centerOn: () => {},
    },
    selection: { set: vi.fn(), onChange: () => () => {} },
    onStateChange: () => () => {},
    setTool: vi.fn(),
    zoomToFit: vi.fn(),
  } as unknown as Engine
  return { doc, engine }
}

const target = (elId: string, kind: 'image' | 'video' | 'audio', assetId = 'asset-1') => ({
  elId,
  assetId,
  kind,
})

/** 打开媒体工具条并进入指定操作的参数面板。 */
async function openForm(
  op: string | RegExp,
  targets: Array<{ elId: string; assetId: string; kind: 'image' | 'video' | 'audio' }>,
) {
  const { doc, engine } = fakeEngine()
  // 目标必须真实存在于文档里，加工入口会核对它
  for (const item of targets)
    createElement(doc, {
      id: item.elId,
      kind: item.kind,
      assetId: item.assetId,
      x: 0,
      y: 0,
      w: 160,
      h: 90,
    })
  // 加工前会核对当前引擎与画布，测试里要登记同一个引擎
  useCanvas.setState({ engine, canvasId: 'cv-1' })
  const view = renderApp(<MediaTools engine={engine} target={targets} />)
  await view.user.click(await screen.findByRole('button', { name: '媒体工具' }))
  const tools = await screen.findByRole('dialog', { name: '媒体工具' })
  await view.user.click(await within(tools).findByRole('button', { name: op }))
  return { ...view, tools }
}

/** 打开批量加工菜单：多选素材共用一份设置。 */
async function openBatch(
  targets: Array<{ elId: string; assetId: string; kind: 'image' | 'video' | 'audio' }>,
) {
  const { doc, engine } = fakeEngine()
  for (const item of targets)
    createElement(doc, {
      id: item.elId,
      kind: item.kind,
      assetId: item.assetId,
      x: 0,
      y: 0,
      w: 160,
      h: 90,
    })
  useCanvas.setState({ engine, canvasId: 'cv-1' })
  const view = renderApp(<MediaBatchTools engine={engine} targets={targets} />)
  await view.user.click(await screen.findByRole('button', { name: '批量加工' }))
  const tools = await screen.findByRole('dialog', { name: '批量加工' })
  return { ...view, tools }
}

describe('媒体工具的参数校验', () => {
  it('截取拒绝看不懂的入点，保留输入并聚焦到出错字段，不发加工请求', async () => {
    const { user, tools } = await openForm('截取一段', [target('el-1', 'video')])
    const start = within(tools).getByRole('textbox', { name: '入点' })
    await user.clear(start)
    await user.type(start, 'oops')
    await user.click(within(tools).getByRole('button', { name: '开始加工' }))
    expect((await within(tools).findByRole('alert')).textContent).toContain('入点时间看不懂')
    expect((start as HTMLInputElement).value).toBe('oops')
    expect(document.activeElement).toBe(start)
    expect(derive).not.toHaveBeenCalled()
  })

  it('变速拒绝空值，修正前不提交也不关闭表单', async () => {
    const { user, tools } = await openForm(/^变速/, [target('el-1', 'video')])
    const input = within(tools).getByRole('textbox', { name: '倍数' })
    await user.clear(input)
    await user.click(within(tools).getByRole('button', { name: '开始加工' }))
    expect((await within(tools).findByRole('alert')).textContent).toContain(
      '倍数需为 0.25–4 之间的数字',
    )
    expect(derive).not.toHaveBeenCalled()
    // 表单仍在，可以改成合法倍数再提交
    await user.type(input, '1.5')
    await user.click(within(tools).getByRole('button', { name: '开始加工' }))
    await waitFor(() => expect(derive).toHaveBeenCalledTimes(1))
    expect(derive.mock.calls[0]![0]).toMatchObject({ op: 'speed', speed: 1.5 })
  })

  it('裁剪拒绝零尺寸，不静默改成一像素后加工', async () => {
    const { user, tools } = await openForm('裁剪', [target('el-1', 'image')])
    const width = within(tools).getByRole('textbox', { name: '宽' })
    await user.clear(width)
    await user.type(width, '0')
    await user.click(within(tools).getByRole('button', { name: '开始加工' }))
    expect(await within(tools).findByRole('alert')).toBeTruthy()
    expect(derive).not.toHaveBeenCalled()
  })

  it('抽帧时间不能晚于视频末尾，出错时保留填写并聚焦', async () => {
    const { user, tools } = await openForm('抽帧成图片', [target('el-1', 'video')])
    const at = within(tools).getByRole('textbox', { name: '第几秒' })
    await user.clear(at)
    await user.type(at, '999')
    await user.click(within(tools).getByRole('button', { name: '开始加工' }))
    expect((await within(tools).findByRole('alert')).textContent).toContain(
      '取帧时间需早于视频末尾',
    )
    expect((at as HTMLInputElement).value).toBe('999')
    expect(document.activeElement).toBe(at)
    expect(derive).not.toHaveBeenCalled()
  })
})

describe('批量加工的适用范围', () => {
  it('混选图片与音视频时各项操作标明可用数量，只对适用素材发请求', async () => {
    const { user, tools } = await openBatch([
      target('el-image', 'image', 'asset-image'),
      target('el-video', 'video', 'asset-video'),
      target('el-audio', 'audio', 'asset-audio'),
    ])
    // 每项操作说明自己会处理几份素材，用户不必猜
    expect(within(tools).getByRole('button', { name: /^旋转 90°/ }).textContent).toContain(
      '1 张图片',
    )
    expect(within(tools).getByRole('button', { name: /^变速/ }).textContent).toContain('2 段音视频')
    expect(within(tools).getByRole('button', { name: /^分离音频与画面/ }).textContent).toContain(
      '1 段视频',
    )

    await user.click(within(tools).getByRole('button', { name: /^旋转 90°/ }))
    await waitFor(() => expect(derive).toHaveBeenCalledTimes(1))
    // 只提交图片，不适用的音视频不该被加工
    expect(derive.mock.calls[0]![0]).toMatchObject({ op: 'rotate', assetId: 'asset-image' })
  })

  it('本机没有音视频加工能力时，纯逻辑只保留图片加工', () => {
    // 能力读取在会话内缓存，DOM 层不再重复验证；作用范围由纯逻辑保证
    expect(
      batchMediaOps([target('el-image', 'image'), target('el-video', 'video')], {
        ffmpeg: false,
        subtitles: false,
        rubberband: false,
      } as never),
    ).toEqual(['rotate', 'flip'])
  })
})

describe('媒体工具的可用性说明', () => {
  it('素材被锁定时停用加工并说明原因', async () => {
    const { doc, engine } = fakeEngine()
    createElement(doc, {
      id: 'el-1',
      kind: 'image',
      assetId: 'asset-1',
      x: 0,
      y: 0,
      w: 160,
      h: 90,
      locked: true,
    })
    useCanvas.setState({ engine, canvasId: 'cv-1' })
    const view = renderApp(<MediaTools engine={engine} target={[target('el-1', 'image')]} />)
    await view.user.click(await screen.findByRole('button', { name: '媒体工具' }))
    const tools = await screen.findByRole('dialog', { name: '媒体工具' })
    const notices = within(tools)
      .getAllByRole('status')
      .map((node) => node.textContent ?? '')
      .join(' ')
    expect(notices).toContain('所选素材已锁定')
    // 本地处理整体停用
    expect(
      (within(tools).getByRole('group', { name: '本地处理' }) as HTMLFieldSetElement).disabled,
    ).toBe(true)
  })

  it('只读画布停用加工并说明原因', async () => {
    const { doc, engine } = fakeEngine()
    createElement(doc, {
      id: 'el-1',
      kind: 'image',
      assetId: 'asset-1',
      x: 0,
      y: 0,
      w: 160,
      h: 90,
    })
    doc.readOnly = true
    useCanvas.setState({ engine, canvasId: 'cv-1' })
    const view = renderApp(<MediaTools engine={engine} target={[target('el-1', 'image')]} />)
    await view.user.click(await screen.findByRole('button', { name: '媒体工具' }))
    const tools = await screen.findByRole('dialog', { name: '媒体工具' })
    const notices = within(tools)
      .getAllByRole('status')
      .map((node) => node.textContent ?? '')
      .join(' ')
    expect(notices).toContain('当前画布只读')
    expect(
      (within(tools).getByRole('group', { name: '本地处理' }) as HTMLFieldSetElement).disabled,
    ).toBe(true)
  })
})
