import { createElement } from '@plein/doc'
import { openDoc, node } from '@plein/doc/testing'
import { findMentions, mentionName, profileOf } from '@plein/nodes'
import { describe, expect, it } from 'vite-plus/test'
import { referenceClipboard } from './clipboard'

const source = () => {
  const doc = openDoc()
  for (const id of ['a', 'z'])
    createElement(
      doc,
      node({ id, name: '林夏', nodeType: 'plein/character', params: { description: id } }),
    )
  const text = createElement(
    doc,
    node({
      id: 'text',
      params: {
        prompt: '@林夏#002/少年 走来',
        requiredRefs: ['z'],
        clips: [{ source: 'a', in: 1, out: 4 }],
        assetBindings: { 林夏: { elementId: 'z' } },
        shots: [{ prompt: '@林夏#1 微笑' }],
      },
    }),
  )
  return { doc, text }
}
function resolved(doc: ReturnType<typeof openDoc>, text: string) {
  return findMentions(
    text,
    [...doc.elements()].flatMap((el) => {
      const name = mentionName(el)
      return name ? [{ id: el.id, name, profile: profileOf(el.params?.profile) }] : []
    }),
  )[0]?.id
}

describe('画布复制中的引用映射', () => {
  it('跨画布重新编号，保留档案、分镜嵌套引用和目标画布原有指向', () => {
    const { doc, text } = source()
    const data = JSON.parse(JSON.stringify(referenceClipboard.copy(doc, ['a', 'z', text])))
    const target = openDoc()
    const original = createElement(
      target,
      node({ id: 'm', name: '林夏', nodeType: 'plein/character' }),
    )
    const oldText = createElement(target, node({ params: { prompt: '@林夏 站着' } }))
    target.undo.stopCapturing()
    const pasted = referenceClipboard.paste(target, data)
    const image = target.get(pasted[2]!)!
    expect(target.get(resolved(target, image.params!.prompt as string)!)?.params?.description).toBe(
      'z',
    )
    expect(image.params!.prompt).toContain('/少年 走来')
    expect(image.params!.requiredRefs).toEqual([pasted[1]])
    expect(image.params!.clips).toEqual([{ source: pasted[0], in: 1, out: 4 }])
    expect(image.params!.assetBindings).toEqual({ 林夏: { elementId: pasted[1] } })
    const shots = image.params!.shots as { prompt: string }[]
    expect(target.get(resolved(target, shots[0]!.prompt)!)?.params?.description).toBe('a')
    expect(resolved(target, target.get(oldText)!.params!.prompt as string)).toBe(original)
    expect(doc.get(text)!.params!.prompt).toBe('@林夏#002/少年 走来')
    target.undo.undo()
    expect(target.get(pasted[2]!)).toBeUndefined()
    expect(target.get(oldText)!.params!.prompt).toBe('@林夏 站着')
    target.undo.redo()
    expect(resolved(target, target.get(pasted[2]!)!.params!.prompt as string)).toBe(pasted[1])
    doc.destroy()
    target.destroy()
  })

  it('未复制的外部依赖不会借用目标画布的同名素材', () => {
    const { doc, text } = source()
    const target = openDoc()
    createElement(target, node({ name: '林夏', nodeType: 'plein/character' }))
    const [pasted] = referenceClipboard.paste(target, referenceClipboard.copy(doc, [text]))
    expect(resolved(target, target.get(pasted!)!.params!.prompt as string)).toBeUndefined()
    createElement(target, node({ name: '林夏', nodeType: 'plein/character' }))
    expect(resolved(target, target.get(pasted!)!.params!.prompt as string)).toBeUndefined()
    doc.destroy()
    target.destroy()
  })

  it('同画布复制后原文和副本分别指向各自的角色', () => {
    const { doc, text } = source()
    const pasted = referenceClipboard.paste(doc, referenceClipboard.copy(doc, ['a', 'z', text]))
    expect(resolved(doc, doc.get(text)!.params!.prompt as string)).toBe('z')
    expect(resolved(doc, doc.get(pasted[2]!)!.params!.prompt as string)).toBe(pasted[1])
    doc.destroy()
  })
})
