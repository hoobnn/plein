import { Camera, type Engine, Scene } from '@plein/canvas-core'
import { createElement, type PleinDoc } from '@plein/doc'
import { openDoc } from '@plein/doc/testing'
import type { Asset } from '@plein/protocol'
import { afterEach, expect, it, vi } from 'vite-plus/test'
import { api } from '../api/client'
import { importFiles, importText, revealImports } from './import'

const docs: PleinDoc[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const doc of docs.splice(0)) doc.destroy()
})
function setup() {
  const doc = openDoc()
  docs.push(doc)
  const camera = new Camera()
  camera.setViewport(800, 600)
  const select = vi.fn(),
    zoomToFit = vi.fn()
  const engine = {
    doc,
    camera,
    scene: new Scene(doc),
    selection: { set: select },
    setTool: vi.fn(),
    zoomToFit,
  } as unknown as Engine
  return { doc, engine, select, zoomToFit }
}
const asset = (name: string, extra: Partial<Asset> = {}) =>
  ({ id: name, name, kind: 'image', width: 800, height: 400, ...extra }) as Asset
const image = (name: string) => new File(['image'], name, { type: 'image/png' })
it('上传最多三份并发，乱序返回仍按文件顺序放置，整批只占一个撤销步骤', async () => {
  const { doc, engine } = setup()
  let active = 0,
    max = 0
  const releases = new Map<string, () => void>()
  const upload = vi.spyOn(api, 'upload').mockImplementation(
    (file) =>
      new Promise((resolve) => {
        active++
        max = Math.max(max, active)
        releases.set(file.name, () => {
          active--
          resolve(asset(file.name))
        })
      }),
  )
  const files = Array.from({ length: 5 }, (_, i) => image(`${i}.png`))
  const progress = vi.fn()
  const pending = importFiles(engine, files, { x: 100, y: 300 }, progress)
  expect(upload).toHaveBeenCalledTimes(3)
  releases.get('2.png')!()
  await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(4))
  releases.get('0.png')!()
  await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(5))
  for (const name of ['1.png', '3.png', '4.png']) releases.get(name)!()
  const result = await pending
  expect(result.skipped).toEqual([])
  expect(max).toBe(3)
  expect([...doc.elements()].map((el) => el.name)).toEqual(files.map((f) => f.name))
  const rects = result.created.map((id) => doc.worldRect(id)!)
  for (const r of rects) expect([r.w, r.h]).toEqual([480, 240])
  for (let i = 1; i < rects.length; i++)
    expect(rects[i]!.x - rects[i - 1]!.x - rects[i - 1]!.w).toBe(24)
  expect(progress).toHaveBeenLastCalledWith(5, 5)
  doc.undo.undo()
  expect([...doc.elements()]).toHaveLength(0)
  doc.undo.redo()
  expect(result.created.map((id) => doc.worldRect(id))).toEqual(rects)
})
it('混合导入保留正文和成功媒体，逐项报告失败与不支持格式，后台模式不改选择', async () => {
  const { doc, engine, select } = setup()
  const text = Array.from({ length: 30 }, (_, i) => `正文 ${i}`).join('\n')
  const files = [
    new File([text], '正文.md'),
    image('still.png'),
    image('clip.mp4'),
    image('voice.wav'),
    image('bad.png'),
    image('unsupported.pdf'),
  ]
  const upload = vi.spyOn(api, 'upload').mockImplementation(async (file) => {
    if (file.name === 'bad.png') throw new Error('测试上传失败')
    if (file.name === 'unsupported.pdf') return asset(file.name, { kind: 'file' })
    if (file.name === 'clip.mp4')
      return asset(file.name, { kind: 'video', width: 1600, height: 900 })
    if (file.name === 'voice.wav') return asset(file.name, { kind: 'audio' })
    return asset(file.name, { width: undefined, height: undefined })
  })
  const result = await importFiles(engine, files, { x: 100, y: 300 }, undefined, { select: false })
  expect(upload).toHaveBeenCalledTimes(5)
  expect(result.skipped).toEqual(
    expect.arrayContaining([
      { name: 'bad.png', reason: '测试上传失败' },
      { name: 'unsupported.pdf', reason: expect.stringContaining('暂不支持这种文件') },
    ]),
  )
  const elements = result.created.map((id) => doc.get(id)!)
  expect(elements.map((el) => el.kind)).toEqual(['markdown', 'image', 'video', 'audio'])
  expect(elements[0]).toMatchObject({ w: 360, h: 480 })
  expect(doc.getText(elements[0]!.id)?.toString()).toBe(text)
  expect(elements[1]).toMatchObject({ w: 320, h: 240 })
  expect(elements[2]).toMatchObject({ w: 480, h: 270 })
  expect(select).not.toHaveBeenCalled()
})
it('取消后不继续上传排队文件，忽略取消的迟到传输不写入或发布后续进度', async () => {
  const { doc, engine, select } = setup()
  const releases: Array<() => void> = []
  const upload = vi.spyOn(api, 'upload').mockImplementation(
    (file) =>
      new Promise((resolve) => {
        releases.push(() => resolve(asset(file.name)))
      }),
  )
  const controller = new AbortController(),
    progress = vi.fn()
  const pending = importFiles(
    engine,
    Array.from({ length: 6 }, (_, i) => image(`${i}.png`)),
    { x: 0, y: 0 },
    progress,
    { signal: controller.signal },
  )
  expect(upload).toHaveBeenCalledTimes(3)
  controller.abort()
  for (const release of releases) release()
  await expect(pending).rejects.toThrow()
  expect(upload).toHaveBeenCalledTimes(3)
  expect(progress).not.toHaveBeenCalled()
  expect(select).not.toHaveBeenCalled()
  expect([...doc.elements()]).toHaveLength(0)
  expect(doc.undo.undoStack).toHaveLength(0)
})
it('只读、预先取消、全部失败和空批次都不创建空白元素或撤销步骤', async () => {
  const { doc, engine } = setup()
  const upload = vi.spyOn(api, 'upload').mockRejectedValue(new Error('测试全部失败'))
  doc.readOnly = true
  await expect(importFiles(engine, [image('a')], { x: 0, y: 0 })).rejects.toThrow('只读')
  doc.readOnly = false
  const controller = new AbortController()
  controller.abort()
  await expect(
    importFiles(engine, [image('a')], { x: 0, y: 0 }, undefined, { signal: controller.signal }),
  ).rejects.toThrow()
  expect(upload).not.toHaveBeenCalled()
  expect(await importFiles(engine, [], { x: 0, y: 0 })).toEqual({ created: [], skipped: [] })
  expect((await importFiles(engine, [image('a')], { x: 0, y: 0 })).created).toEqual([])
  expect([...doc.elements()]).toHaveLength(0)
  expect(doc.undo.undoStack).toHaveLength(0)
})
it('粘贴正文按最终范围归入分组，可独立撤销；可见产物不改变视角，超大产物缩放定位', () => {
  const { doc, engine, zoomToFit } = setup()
  const frame = createElement(doc, { kind: 'frame', x: 0, y: 0, w: 1000, h: 800 })
  importText(engine, '保留\n换行', { x: 300, y: 300 })
  const text = [...doc.elements()].find((el) => el.kind === 'markdown')!
  expect(text.parentId).toBe(frame)
  expect(doc.getText(text.id)?.toString()).toBe('保留\n换行')
  const original = [engine.camera.x, engine.camera.y, engine.camera.zoom]
  revealImports(engine, [])
  revealImports(engine, [text.id])
  expect([engine.camera.x, engine.camera.y, engine.camera.zoom]).toEqual(original)
  const wide = createElement(doc, {
    kind: 'image',
    assetId: 'wide',
    x: 2000,
    y: 0,
    w: 2000,
    h: 2000,
  })
  revealImports(engine, [wide])
  expect(zoomToFit).toHaveBeenCalledWith([wide])
  doc.undo.undo()
  doc.undo.undo()
  expect([...doc.elements()].map((el) => el.id)).toEqual([frame])
})
it('重复批量导入避让原有内容与前一批，一次撤销只移除本批文件', async () => {
  const { doc, engine } = setup()
  vi.spyOn(api, 'upload').mockImplementation(async (file) => asset(file.name))
  const blocker = createElement(doc, {
    kind: 'markdown',
    text: '导入前的原有卡片',
    x: 100,
    y: 300,
    w: 360,
    h: 160,
  })
  const batches: string[][] = []
  for (let n = 0; n < 2; n++) {
    const result = await importFiles(engine, [image('a.png'), image('b.png')], { x: 100, y: 300 })
    batches.push(result.created)
    const rects = result.created.map((id) => doc.worldRect(id)!)
    // 新导入的文件既不压住原有卡片，也不压住前一批
    for (const r of rects) {
      const overlap = (a: typeof r, b: typeof r) =>
        a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
      expect(overlap(r, doc.worldRect(blocker)!)).toBe(false)
      for (const other of rects) if (other !== r) expect(overlap(r, other)).toBe(false)
    }
  }
  expect([...doc.elements()]).toHaveLength(5)
  doc.undo.undo()
  expect([...doc.elements()].map((el) => el.id)).toEqual([blocker, ...batches[0]!])
  doc.undo.redo()
  expect([...doc.elements()].map((el) => el.id)).toEqual([blocker, ...batches.flat()])
})
it('导入落在分组内时保留父级，撤销只移除导入的文件不移除分组', async () => {
  const { doc, engine } = setup()
  vi.spyOn(api, 'upload').mockImplementation(async (file) => asset(file.name))
  const frame = createElement(doc, { kind: 'frame', x: 0, y: 0, w: 1600, h: 1000 })
  const result = await importFiles(engine, [image('a.png')], { x: 300, y: 300 })
  expect(doc.get(result.created[0]!)!.parentId).toBe(frame)
  doc.undo.undo()
  expect([...doc.elements()].map((el) => el.id)).toEqual([frame])
})
it('部分上传失败保留成功文件并说明原因，重新导入失败文件可恢复', async () => {
  const { doc, engine } = setup()
  let fail = true
  vi.spyOn(api, 'upload').mockImplementation(async (file) => {
    if (fail && file.name === 'still.png') throw new Error('上传暂不可用')
    return asset(file.name)
  })
  const first = await importFiles(engine, [image('still.png'), image('ok.png')], { x: 100, y: 300 })
  expect(first.created).toHaveLength(1)
  expect(first.skipped).toEqual([{ name: 'still.png', reason: '上传暂不可用' }])
  fail = false
  const second = await importFiles(engine, [image('still.png')], { x: 100, y: 300 })
  expect(second.created).toHaveLength(1)
  expect(second.skipped).toEqual([])
  expect([...doc.elements()].filter((el) => el.kind === 'image')).toHaveLength(2)
})
it('连续粘贴正文互相避让，每次粘贴独立撤销', () => {
  const { doc, engine } = setup()
  importText(engine, '第一段粘贴正文', { x: 300, y: 300 })
  importText(engine, '第二段粘贴正文', { x: 300, y: 300 })
  const texts = [...doc.elements()].filter((el) => el.kind === 'markdown')
  expect(texts.map((el) => doc.getText(el.id)?.toString())).toEqual([
    '第一段粘贴正文',
    '第二段粘贴正文',
  ])
  const [a, b] = texts.map((el) => doc.worldRect(el.id)!)
  expect(a!.x < b!.x + b!.w && a!.x + a!.w > b!.x && a!.y < b!.y + b!.h && a!.y + a!.h > b!.y).toBe(
    false,
  )
  doc.undo.undo()
  expect(
    [...doc.elements()]
      .filter((el) => el.kind === 'markdown')
      .map((el) => doc.getText(el.id)?.toString()),
  ).toEqual(['第一段粘贴正文'])
  doc.undo.redo()
  expect(
    [...doc.elements()]
      .filter((el) => el.kind === 'markdown')
      .map((el) => doc.getText(el.id)?.toString()),
  ).toEqual(['第一段粘贴正文', '第二段粘贴正文'])
})
it('网络中断与旧版 .doc 给出能照着做的原因', async () => {
  const { engine } = setup()
  vi.spyOn(api, 'upload').mockRejectedValue(new TypeError('Failed to fetch'))
  const offline = await importFiles(engine, [image('a.png')], { x: 0, y: 0 })
  expect(offline.skipped).toEqual([{ name: 'a.png', reason: '网络不可用，请检查连接后重试' }])
  vi.spyOn(api, 'upload').mockImplementation(async (file) => asset(file.name))
  const legacy = new File(['old'], '旧文件', { type: 'application/msword' })
  const docx = await importFiles(engine, [legacy], { x: 0, y: 0 })
  expect(docx.skipped).toEqual([
    { name: '旧文件', reason: '旧版 .doc 暂不支持，请另存为 .docx 或 .txt 后导入' },
  ])
})
