import type { Engine } from '@plein/canvas-core'
import { createElement, updateElement } from '@plein/doc'
import { openDoc } from '@plein/doc/testing'
import type { MediaDerivation } from '@plein/protocol'
import { api } from '../../api/client'
import { applyDerivation } from '../../canvas/media'
import { expect, it, vi } from 'vite-plus/test'
import { captureVideoOperand } from './AdvancedVideo'

it('替换视频绑定元素身份与当前文件，移除后重建同ID同文件也需重新确认', () => {
  const doc = openDoc()
  try {
    const id = createElement(doc, { kind: 'video', assetId: 'original', x: 0, y: 0, w: 100, h: 80 })
    const engine = { doc } as Engine
    const current = captureVideoOperand(engine, { elId: id, assetId: 'original', kind: 'video' })
    expect(current()).toBe(true)
    updateElement(doc, id, { assetId: 'different' })
    expect(current()).toBe(false)
    updateElement(doc, id, { assetId: 'original', locked: true })
    expect(current()).toBe(false)
    updateElement(doc, id, { locked: false })
    doc.readOnly = true
    expect(current()).toBe(false)
    doc.readOnly = false
    doc.elementMaps.delete(id)
    createElement(doc, { id, kind: 'video', assetId: 'original', x: 0, y: 0, w: 100, h: 80 })
    expect(current()).toBe(false)
  } finally {
    doc.destroy()
  }
})

it('加工传输迟到返回时，失效的替换素材确认不能把结果放入画布', async () => {
  const doc = openDoc()
  const source = createElement(doc, { kind: 'video', assetId: 'source', x: 0, y: 0, w: 100, h: 80 })
  const replacement = createElement(doc, {
    kind: 'video',
    assetId: 'replacement',
    x: 200,
    y: 0,
    w: 100,
    h: 80,
  })
  const engine = { doc } as Engine
  const current = captureVideoOperand(engine, {
    elId: replacement,
    assetId: 'replacement',
    kind: 'video',
  })
  let release!: (value: MediaDerivation) => void
  const send = vi.spyOn(api, 'mediaDerive').mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve
      }),
  )
  try {
    const pending = applyDerivation(
      engine,
      {
        op: 'replace-range',
        assetId: 'source',
        replacementAssetId: 'replacement',
        start: 0,
        end: 1,
        replacementStart: 0,
      },
      source,
      undefined,
      current,
    )
    doc.elementMaps.delete(replacement)
    release({ assets: [] } as unknown as MediaDerivation)
    await expect(pending).rejects.toThrow('替换素材已变化')
    expect(send).toHaveBeenCalledTimes(1)
    expect([...doc.elements()]).toHaveLength(1)
  } finally {
    send.mockRestore()
    doc.destroy()
  }
})
