import { createElement, setParam } from '@plein/doc'
import { node, openDoc } from '@plein/doc/testing'
import { expect, it } from 'vite-plus/test'
import { optionRecord, replaceModelOptions } from './modelOptions'

it('修复当前模型的历史布尔值与坏桶，保留其他模型参数并支持撤销重做', () => {
  for (const original of [
    { current: { watermark: 'false' }, other: { emotion: '保留' } },
    { current: null, other: { emotion: '保留' } },
    '损坏的整份参数',
  ]) {
    const doc = openDoc()
    try {
      const id = createElement(doc, node({ params: { options: original } }))
      doc.undo.stopCapturing()
      const next = replaceModelOptions(original, 'current', { watermark: false })
      setParam(doc, id, 'options', next)
      expect(doc.get(id)!.params!.options).toEqual({
        ...(typeof original === 'object' ? { other: { emotion: '保留' } } : {}),
        current: { watermark: false },
      })
      doc.undo.undo()
      expect(doc.get(id)!.params!.options).toEqual(original)
      doc.undo.redo()
      expect(doc.get(id)!.params!.options).toEqual(next)
      expect(replaceModelOptions(doc.get(id)!.params!.options, 'current', {})).toEqual({
        ...next,
        current: {},
      })
      expect(optionRecord(null)).toEqual({})
    } finally {
      doc.destroy()
    }
  }
})
