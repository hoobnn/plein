import { describe, expect, it } from 'vite-plus/test'
import { applyMotionEdit, MotionParams } from '@plein/nodes'
import { editMotionDocument, openMotionDocument } from './sdk'

describe('HyperFrames 编辑投影', () => {
  it('中文文本、位置与时间均经 SDK 结构化编辑，SDK 不创建第二套撤销栈', async () => {
    const params = MotionParams.parse({ title: '第一章', duration: 4 })
    const document = await openMotionDocument(params)
    try {
      expect(document.getElement('hf-title')?.text).toBe('第一章')
      editMotionDocument(document, { op: 'text', id: 'hf-title', text: '新的章节' })
      editMotionDocument(document, { op: 'style', id: 'hf-title', property: 'left', value: '12%' })
      editMotionDocument(document, { op: 'timing', id: 'hf-title', start: 0.5, end: 3 })
      expect(document.getElement('hf-title')).toMatchObject({
        text: '新的章节',
        start: 0.5,
        attributes: { 'data-duration': '2.5' },
        inlineStyles: { left: '12%' },
      })
      expect(document.canUndo()).toBe(false)
      expect(document.serialize()).toContain('data-hf-id="hf-title"')
    } finally {
      document.dispose()
    }
  })

  it('独立字段意图从最新文档派生，不复制 SDK 的 timing.duration 或整份旧覆盖', async () => {
    const original = MotionParams.parse({ duration: 6 })
    const sdk = await openMotionDocument(original)
    try {
      editMotionDocument(sdk, { op: 'style', id: 'hf-title', property: 'left', value: '14%' })
      const remote = applyMotionEdit(original, {
        op: 'style',
        id: 'hf-subtitle',
        property: 'top',
        value: '72%',
      })
      const merged = applyMotionEdit(remote, {
        op: 'style',
        id: 'hf-title',
        property: 'left',
        value: '14%',
      })
      expect(merged.overrides).toEqual({
        'hf-subtitle.style.top': '72%',
        'hf-title.style.left': '14%',
      })
      expect(original.overrides).toEqual({})
    } finally {
      sdk.dispose()
    }
  })
})
