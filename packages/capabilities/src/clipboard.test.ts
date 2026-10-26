import { createElement, setParam, sequenceInstancesOf } from '@plein/doc'
import { openDoc, node } from '@plein/doc/testing'
import {
  findMentions,
  mentionName,
  profileOf,
  sequenceNode,
  arrangeSequence,
  createSubtitleTrack,
  subtitleTrackStale,
} from '@plein/nodes'
import { describe, expect, it } from 'vite-plus/test'
import { referenceClipboard } from './clipboard'
import { aiFixture } from '../../nodes/src/aiShotAnalysis.fixture'

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
  it('typed clip copies remap scope/instance/key while preserving literal subtitles and fixed origin', () => {
    const doc = openDoc(),
      target = openDoc()
    const role = createElement(doc, node({ name: '林夏', nodeType: 'plein/character' }))
    createElement(target, node({ name: '林夏', nodeType: 'plein/character' }))
    const board = createElement(doc, node({ nodeType: 'plein/storyboard', params: { shots: [] } }))
    const segment = {
      version: 1,
      segmentId: 'fixed',
      asset: { assetId: 'a'.repeat(64), kind: 'video' },
      duration: 8,
      origin: {
        canvasId: 'original',
        nodeId: 'original-generator',
        port: 'video',
        resultId: 'r',
        runId: 'run',
      },
    }
    const params = sequenceNode.params.parse({
      instanceVersion: 2,
      clips: [
        {
          source: 'deleted-view',
          port: 'video',
          clipInstanceId: 'original-clip',
          segment,
          sound: 'native',
          in: 0,
          out: 2,
          subtitle: '@林夏 literal',
          narrative: { canvasId: 'original', boardId: board, shotId: 'shot' },
        },
      ],
    })
    const sequence = createElement(
      doc,
      node({ nodeType: 'plein/sequence', nodeVersion: 2, params }),
    )
    const rows = arrangeSequence(params, {})
    const track = createSubtitleTrack(params, rows, { clips: [8], dialogue: [undefined] })
    const orphan = {
      id: 'orphan',
      source: 'deleted-source',
      start: 0,
      end: 1,
      text: '@林夏 old literal',
      hidden: false,
    }
    track.unmappedCues = [{ cue: orphan, reason: '来源已删除，未绑定' }]
    track.legacyTrack = { inputKey: 'original legacy key', cues: [orphan] }
    setParam(doc, sequence, 'subtitleTrack', track)
    const copied = referenceClipboard.paste(
      target,
      referenceClipboard.copy(doc, [role, board, sequence]),
      { canvasId: 'target' },
    )
    const imported = target.get(copied[2]!)!,
      c = sequenceInstancesOf(imported)[0]!
    expect(c.clipInstanceId).not.toBe('original-clip')
    expect(c.segment).toEqual(segment)
    expect(c.narrative).toMatchObject({ canvasId: 'target', boardId: copied[1] })
    expect(c.subtitle).toBe('@林夏 literal')
    const next = sequenceNode.params.parse(imported.params)
    expect(next.subtitleTrack!.cues[0]!.text).toBe('@林夏 literal')
    expect(next.subtitleTrack!.cues[0]!.source).toBe(c.clipInstanceId)
    expect(next.subtitleTrack!.unmappedCues).toEqual(track.unmappedCues)
    expect(next.subtitleTrack!.legacyTrack).toEqual(track.legacyTrack)
    expect(subtitleTrackStale(next, arrangeSequence(next, {}))).toBe(false)
    doc.destroy()
    target.destroy()
  })
  it('同名@别名冲突不能重写已固定AI请求、归纳候选或模型Markdown出处全文', () => {
    const doc = openDoc(),
      target = openDoc()
    const role = createElement(doc, node({ name: '林夏', nodeType: 'plein/character' }))
    createElement(target, node({ name: '林夏', nodeType: 'plein/character' }))
    const draft = aiFixture()
    draft.value.draft.description = '@林夏 原始模型文字'
    draft.value.request.focus = '@林夏 仅作为数据'
    const origin = { version: 1, kind: 'ai-shot-draft-origin', drafts: [draft] }
    const summary = { id: 'summary', modelRef: 'mock:text', focus: '@林夏', drafts: [draft] }
    const sceneNode = createElement(
      doc,
      node({
        nodeType: 'plein/shot-scene-draft',
        params: { model: 'mock:vision', request: draft.value.request },
      }),
    )
    const summaryNode = createElement(
      doc,
      node({
        nodeType: 'plein/shot-summary-draft',
        params: { model: 'mock:text', request: summary },
      }),
    )
    const sourceNode = createElement(doc, {
      kind: 'markdown',
      x: 0,
      y: 0,
      w: 200,
      h: 100,
      text: '模型分析草稿 @林夏',
      params: { aiDraftOrigin: origin },
    })
    const editable = createElement(doc, node({ params: { prompt: '@林夏 原有引用' } }))
    const pasted = referenceClipboard.paste(
      target,
      referenceClipboard.copy(doc, [role, sceneNode, summaryNode, sourceNode, editable]),
    )
    expect(target.get(pasted[1]!)!.params?.request).toEqual(draft.value.request)
    expect(target.get(pasted[2]!)!.params?.request).toEqual(summary)
    expect(target.get(pasted[3]!)!.params?.aiDraftOrigin).toEqual(origin)
    expect(target.get(pasted[3]!)!.text).toBe('模型分析草稿 @林夏')
    expect(target.get(pasted[4]!)!.params?.prompt).not.toBe('@林夏 原有引用')
    expect(resolved(target, target.get(pasted[4]!)!.params!.prompt as string)).toBe(pasted[0])
    doc.destroy()
    target.destroy()
  })
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
