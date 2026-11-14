import { createElement } from '@plein/doc'
import { node, openDoc } from '@plein/doc/testing'
import { expect, it } from 'vite-plus/test'
import { adoptionChanged, adoptionRevisionOf, adoptionSnapshot, parseAdoption } from './adoption'

it('版本变了就算人工改过，A→B→A 与首次采用的既有批次都不误判', () => {
  // A→B→A：结果 id 和受理时一样，但采用版本变了
  expect(
    adoptionChanged({ result: 'res-a', revision: 'rev-1' }, { result: 'res-a', revision: 'rev-3' }),
  ).toBe(true)
  // A→人工 B→撤销回 A：采用版本单调向前，仍算人工改过
  expect(
    adoptionChanged({ result: 'res-a', revision: 'rev-1' }, { result: 'res-a', revision: 'rev-2' }),
  ).toBe(true)
  // 期间没人动过采用
  expect(
    adoptionChanged({ result: 'res-a', revision: 'rev-1' }, { result: 'res-a', revision: 'rev-1' }),
  ).toBe(false)
  // 旧画布没有版本：退回比较结果 id
  expect(adoptionChanged({ result: null }, { result: 'res-a', revision: undefined })).toBe(true)
  expect(adoptionChanged({ result: 'res-a' }, { result: 'res-a', revision: undefined })).toBe(false)
  // 受理时没有版本、后来有了：期间发生过显式采用
  expect(adoptionChanged({ result: 'res-a' }, { result: 'res-a', revision: 'rev-2' })).toBe(true)
  // 旧任务没有记录：不做判断
  expect(adoptionChanged(undefined, { result: 'res-a', revision: 'rev-2' })).toBe(false)
})

it('存储凭据兼容旧字符串、null 与坏格式', () => {
  expect(parseAdoption('"res-a"')).toEqual({ result: 'res-a' })
  expect(parseAdoption('null')).toEqual({ result: null })
  expect(parseAdoption(JSON.stringify({ result: 'res-a', revision: 'rev-1' }))).toEqual({
    result: 'res-a',
    revision: 'rev-1',
  })
  expect(parseAdoption('not json')).toBeUndefined()
  expect(parseAdoption({} as never)).toBeUndefined()
  expect(parseAdoption(null)).toBeUndefined()
})

it('从文档读采用版本：类型字段与旧文档的直接读取都兼容', () => {
  const doc = openDoc()
  const id = createElement(doc, node({ name: '节点' }))
  const el = doc.get(id)!
  expect(adoptionRevisionOf(doc, el)).toBeUndefined()
  // 显式采用命令写的字段（类型尚未合并前直接写元素）
  doc.mutable(id)!.set('adoptionRevision', 'rev-9')
  expect(adoptionRevisionOf(doc, doc.get(id)!)).toBe('rev-9')
  expect(adoptionSnapshot(doc, doc.get(id)!, 'res-a')).toBe(
    JSON.stringify({ result: 'res-a', revision: 'rev-9' }),
  )
  doc.destroy()
})
