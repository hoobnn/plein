import {
  connect,
  createElement,
  deleteElements,
  inputEdges,
  setParam,
  sequenceInstancesOf,
} from '@plein/doc'
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
import {
  boundReferenceTokens,
  referenceBindings,
  resolveReferenceBindings,
} from '@plein/plugin-sdk'
import { describe, expect, it } from 'vite-plus/test'
import { referenceClipboard } from './clipboard'
import { expandedNodes } from './story/storyboard'
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
        referenceImagePicks: { z: ['asset-b'] },
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

  it('同画布复制后副本的选图配置指向副本角色', () => {
    const { doc, text } = source()
    const pasted = referenceClipboard.paste(doc, referenceClipboard.copy(doc, ['a', 'z', text]))
    const image = doc.get(pasted[2]!)!
    expect(image.params!.requiredRefs).toEqual([pasted[1]])
    expect(image.params!.referenceImagePicks).toEqual({ [pasted[1]!]: ['asset-b'] })
    expect(doc.get(text)!.params!.referenceImagePicks).toEqual({ z: ['asset-b'] })
    doc.destroy()
  })

  it('同画布复制资产卡时保留未复制媒体元素的参考入边', () => {
    const doc = openDoc()
    const card = createElement(
      doc,
      node({
        id: 'card',
        nodeType: 'plein/character',
        ports: {
          inputs: [{ id: 'references', label: '参考素材', type: 'any', multiple: true }],
          outputs: [],
        },
      }),
    )
    for (const kind of ['image', 'video', 'audio'] as const) {
      const source = createElement(doc, {
        kind,
        id: kind,
        assetId: `${kind}-asset`,
        x: 0,
        y: 0,
        w: 100,
        h: 80,
      })
      connect(doc, [source, kind], [card, 'references'])
    }
    const data = JSON.parse(JSON.stringify(referenceClipboard.copy(doc, [card])))
    expect(data.elements.map((el: { id: string }) => el.id)).toEqual([card])
    const [pasted] = referenceClipboard.paste(doc, data)
    expect(inputEdges(doc, pasted!, 'references').map((edge) => edge.from[0])).toEqual([
      'image',
      'video',
      'audio',
    ])
    expect(inputEdges(doc, card, 'references')).toHaveLength(3)
    doc.destroy()
  })

  it('已复制的内部参考边不重复，跨画布或上游删除后不补外部入边', () => {
    const doc = openDoc()
    const image = createElement(doc, {
      kind: 'image',
      id: 'image',
      assetId: 'image-asset',
      x: 0,
      y: 0,
      w: 100,
      h: 80,
    })
    const card = createElement(
      doc,
      node({
        id: 'card',
        nodeType: 'plein/character',
        ports: {
          inputs: [{ id: 'references', label: '参考图', type: 'image', multiple: true }],
          outputs: [],
        },
      }),
    )
    connect(doc, [image, 'image'], [card, 'references'])
    const [pastedImage, pastedCard] = referenceClipboard.paste(
      doc,
      referenceClipboard.copy(doc, [image, card]),
    )
    const internal = inputEdges(doc, pastedCard!, 'references')
    expect(internal).toHaveLength(1)
    expect(internal[0]!.from[0]).toBe(pastedImage)

    const external = JSON.parse(JSON.stringify(referenceClipboard.copy(doc, [card])))
    const target = openDoc()
    const [crossCanvas] = referenceClipboard.paste(target, external)
    expect(inputEdges(target, crossCanvas!, 'references')).toHaveLength(0)

    deleteElements(doc, [image])
    const [missingSource] = referenceClipboard.paste(doc, external)
    expect(inputEdges(doc, missingSource!, 'references')).toHaveLength(0)
    doc.destroy()
    target.destroy()
  })

  it('同画布复制重名角色和引用后，正文与名称绑定一起消歧且不留旧键', () => {
    const doc = openDoc()
    const card = createElement(doc, node({ id: 'card', name: '林夏', nodeType: 'plein/character' }))
    const target = createElement(
      doc,
      node({
        id: 'target',
        params: {
          prompt: '@林夏 站在窗边',
          [`referenceNameBinding:${encodeURIComponent('林夏')}:card`]: {
            type: 'image',
            assetId: 'asset-a',
            source: 'card',
          },
        },
      }),
    )
    const pasted = referenceClipboard.paste(doc, referenceClipboard.copy(doc, ['card', 'target']))
    const copyCard = pasted[0]!
    const copy = doc.get(pasted[1]!)!
    const original = doc.get(target)!
    expect(original.params?.prompt).toBe('@林夏#1 站在窗边')
    expect(copy.params?.prompt).toBe('@林夏#2 站在窗边')
    // 旧绑定键被显式清掉：参数里只剩当前别名的一份
    expect(
      Object.keys(original.params ?? {}).filter((key) => key.startsWith('referenceNameBinding:')),
    ).toEqual([`referenceNameBinding:${encodeURIComponent('林夏#1')}:card`])
    expect(
      Object.keys(copy.params ?? {}).filter((key) => key.startsWith('referenceNameBinding:')),
    ).toEqual([`referenceNameBinding:${encodeURIComponent('林夏#2')}:${copyCard}`])
    expect(referenceBindings(original.params)).toEqual({
      '林夏#1': { type: 'image', assetId: 'asset-a', source: 'card' },
    })
    expect(referenceBindings(copy.params)).toEqual({
      '林夏#2': { type: 'image', assetId: 'asset-a', source: copyCard },
    })
    // 两边各自解析到自己的来源，不会串到同名的另一张卡
    expect(
      resolveReferenceBindings(
        String(original.params?.prompt),
        [{ type: 'image', assetId: 'asset-a', source: card }],
        original.params,
      ),
    ).toEqual({ prompt: '@image1 站在窗边' })
    expect(
      resolveReferenceBindings(
        String(copy.params?.prompt),
        [{ type: 'image', assetId: 'asset-a', source: copyCard }],
        copy.params,
      ),
    ).toEqual({ prompt: '@image1 站在窗边' })
    doc.destroy()
  })

  it('生成节点不在 @ 目标集合里，复制后正文仍按绑定身份消歧', () => {
    const doc = openDoc()
    const video = createElement(doc, node({ id: 'g', name: '镜头', nodeType: 'plein/video' }))
    const target = createElement(
      doc,
      node({
        id: 'target',
        params: {
          prompt: '@镜头 缓慢推进',
          [`referenceNameBinding:${encodeURIComponent('镜头')}:g`]: {
            type: 'video',
            assetId: 'asset-v',
            source: 'g',
          },
        },
      }),
    )
    const pasted = referenceClipboard.paste(doc, referenceClipboard.copy(doc, ['g', 'target']))
    const copyVideo = pasted[0]!
    const copy = doc.get(pasted[1]!)!
    const original = doc.get(target)!
    // 同名 #序号按元素 id 排序：副本的新 id 排在原件前面。
    expect(original.params?.prompt).toBe('@镜头#2 缓慢推进')
    expect(copy.params?.prompt).toBe('@镜头#1 缓慢推进')
    expect(referenceBindings(original.params)).toEqual({
      '镜头#2': { type: 'video', assetId: 'asset-v', source: video },
    })
    expect(referenceBindings(copy.params)).toEqual({
      '镜头#1': { type: 'video', assetId: 'asset-v', source: copyVideo },
    })
    expect(
      resolveReferenceBindings(
        String(copy.params?.prompt),
        [{ type: 'video', assetId: 'asset-v', source: copyVideo }],
        copy.params,
      ),
    ).toEqual({ prompt: '@video1 缓慢推进' })
    doc.destroy()
  })

  it('扁平旧绑定与编号键里的来源随复制映射，外部来源不被认领', () => {
    const doc = openDoc()
    createElement(doc, {
      id: 'a',
      kind: 'image',
      name: '素材.png',
      assetId: 'assetA',
      x: 0,
      y: 0,
      w: 100,
      h: 80,
    })
    const target = createElement(
      doc,
      node({
        id: 'target',
        params: {
          prompt: '保持构图',
          'referenceBinding:image1:a:assetA': {
            type: 'image',
            assetId: 'assetA',
            source: 'a',
          },
          'image2:a:assetA': { type: 'image', assetId: 'assetA', source: 'a' },
          'image3:external:assetB': {
            type: 'image',
            assetId: 'assetB',
            source: 'external',
          },
        },
      }),
    )
    const pasted = referenceClipboard.paste(doc, referenceClipboard.copy(doc, ['a', 'target']))
    const copyImage = pasted[0]!
    const params = doc.get(pasted[1]!)!.params!
    expect(params).toMatchObject({
      [`referenceBinding:image1:${copyImage}:assetA`]: {
        type: 'image',
        assetId: 'assetA',
        source: copyImage,
      },
      [`image2:${copyImage}:assetA`]: { type: 'image', assetId: 'assetA', source: copyImage },
    })
    expect(params).not.toHaveProperty('referenceBinding:image1:a:assetA')
    expect(params).not.toHaveProperty('image2:a:assetA')
    // 未复制的外部来源保持原样
    expect(params['image3:external:assetB']).toEqual({
      type: 'image',
      assetId: 'assetB',
      source: 'external',
    })
    expect(doc.get(target)!.params?.['referenceBinding:image1:a:assetA']).toMatchObject({
      source: 'a',
    })
    doc.destroy()
  })

  it('粘贴无关节点不会把已有的同名冲突绑定解成一个来源', () => {
    const doc = openDoc()
    createElement(doc, node({ id: 'x', name: '蓝', nodeType: 'plein/character' }))
    createElement(doc, node({ id: 'y', name: '红', nodeType: 'plein/character' }))
    const key = (source: string) => `referenceNameBinding:${encodeURIComponent('蓝')}:${source}`
    const target = createElement(
      doc,
      node({
        id: 'target',
        params: {
          prompt: '@蓝',
          [key('x')]: { type: 'image', assetId: 'asset-x', source: 'x' },
          [key('y')]: { type: 'image', assetId: 'asset-y', source: 'y' },
        },
      }),
    )
    createElement(doc, node({ id: 'u', name: '无关', nodeType: 'plein/character' }))
    expect(referenceBindings(doc.get(target)!.params)['蓝']).toEqual({
      type: 'image',
      assetId: '',
      source: 'conflict',
    })
    referenceClipboard.paste(doc, referenceClipboard.copy(doc, ['u']))
    const params = doc.get(target)!.params!
    expect(params).toHaveProperty(key('x'))
    expect(params).toHaveProperty(key('y'))
    expect(referenceBindings(params)['蓝']).toEqual({
      type: 'image',
      assetId: '',
      source: 'conflict',
    })
    expect(params.prompt).toBe('@蓝')
    doc.destroy()
  })

  it('复制同名来源本身也不会让冲突绑定被普通 @ 重写解成单一来源', () => {
    const doc = openDoc()
    createElement(doc, node({ id: 'x', name: '蓝', nodeType: 'plein/character' }))
    createElement(doc, node({ id: 'y', name: '红', nodeType: 'plein/character' }))
    const key = (source: string) => `referenceNameBinding:${encodeURIComponent('蓝')}:${source}`
    const target = createElement(
      doc,
      node({
        id: 'target',
        params: {
          prompt: '@蓝 走近',
          [key('x')]: { type: 'image', assetId: 'asset-x', source: 'x' },
          [key('y')]: { type: 'image', assetId: 'asset-y', source: 'y' },
        },
      }),
    )
    // 复制「蓝」这张卡本身：画布上变成两个同名来源，正文行号会变，但绑定仍是冲突。
    referenceClipboard.paste(doc, referenceClipboard.copy(doc, ['x']))
    const params = doc.get(target)!.params!
    expect(params.prompt).toBe('@蓝 走近')
    expect(params).toHaveProperty(key('x'))
    expect(params).toHaveProperty(key('y'))
    expect(referenceBindings(params)['蓝']).toEqual({
      type: 'image',
      assetId: '',
      source: 'conflict',
    })
    // 持久绑定仍然认领这处正文，不退回普通 @ 候选。
    expect(boundReferenceTokens(String(params.prompt), params).map((token) => token.name)).toEqual([
      '蓝',
    ])
    doc.destroy()
  })

  it('跨画布粘贴只复制下游时，不凭同 id 认领目标画布的另一份素材', () => {
    const source = openDoc()
    createElement(source, {
      id: 'shared',
      kind: 'image',
      name: '图',
      assetId: 'asset-a',
      x: 0,
      y: 0,
      w: 100,
      h: 100,
    })
    const target = createElement(
      source,
      node({
        id: 'target',
        params: {
          prompt: '@图 保持构图',
          requiredRefs: ['shared'],
          referenceImagePicks: { shared: ['asset-a'] },
        },
      }),
    )
    const data = JSON.parse(
      JSON.stringify(referenceClipboard.copy(source, [target], { canvasId: 'canvas-a' })),
    )
    const destination = openDoc()
    const sameId = createElement(destination, {
      id: 'shared',
      kind: 'image',
      name: '图',
      assetId: 'asset-b',
      x: 0,
      y: 0,
      w: 100,
      h: 100,
    })
    const [imported] = referenceClipboard.paste(destination, data, { canvasId: 'canvas-b' })
    const params = destination.get(imported!)!.params!
    // 保留可读原名，不生成不存在的 #0，也不改指目标画布的素材。
    expect(params.prompt).toBe('@图 保持构图')
    const binding = referenceBindings(params)['图']!
    expect(binding.source).not.toBe(sameId)
    expect(binding.source).toContain('plein-external/')
    expect(binding.assetId).toBe('')
    // 正文仍被持久绑定认领，后续同名素材出现也不会按普通 @ 重绑。
    expect(boundReferenceTokens(String(params.prompt), params).map((token) => token.name)).toEqual([
      '图',
    ])
    // 必需参考与选图里的外部 id 也换成不存在的地址，不挂到同 id 素材上。
    expect(params.requiredRefs).not.toContain(sameId)
    expect(Object.keys(params.referenceImagePicks ?? {})).not.toContain(sameId)
    source.destroy()
    destination.destroy()
  })

  it('跨画布复制 Markdown 正文与消费者时，正文外部 @ 仍保留可读并失效', () => {
    const source = openDoc()
    createElement(source, {
      id: 'shared',
      kind: 'image',
      name: '图',
      assetId: 'asset-a',
      x: 0,
      y: 0,
      w: 100,
      h: 100,
    })
    const markdown = createElement(source, {
      kind: 'markdown',
      id: 'md',
      text: '看见 @图 舞蹈',
      x: 0,
      y: 200,
      w: 200,
      h: 100,
    })
    const consumer = createElement(
      source,
      node({
        id: 'consumer',
        nodeType: 'plein/video',
        ports: {
          inputs: [{ id: 'prompt', label: '提示词', type: 'text', multiple: true }],
          outputs: [],
        },
        params: { prompt: '' },
      }),
    )
    connect(source, [markdown, 'text'], [consumer, 'prompt'])
    const data = JSON.parse(
      JSON.stringify(
        referenceClipboard.copy(source, [markdown, consumer], { canvasId: 'canvas-a' }),
      ),
    )
    const destination = openDoc()
    createElement(destination, {
      id: 'shared',
      kind: 'image',
      name: '图',
      assetId: 'asset-b',
      x: 0,
      y: 0,
      w: 100,
      h: 100,
    })
    const pasted = referenceClipboard.paste(destination, data, { canvasId: 'canvas-b' })
    const imported = destination.get(pasted[0]!)!
    expect(imported.text).toBe('看见 @图 舞蹈')
    const binding = referenceBindings(imported.params)['图']!
    expect(binding.source).toContain('plein-external/')
    expect(binding.source).not.toBe('shared')
    // 正文仍能识别出这处持久引用，运行时不会让目标画布的同名素材接管。
    expect(
      boundReferenceTokens('看见 @图 舞蹈', imported.params).map((token) => token.name),
    ).toEqual(['图'])
    source.destroy()
    destination.destroy()
  })

  it('跨画布同时复制素材时，Markdown 正文里的引用仍正常映射到副本', () => {
    const source = openDoc()
    const image = createElement(source, {
      id: 'shared',
      kind: 'image',
      name: '图',
      assetId: 'asset-a',
      x: 0,
      y: 0,
      w: 100,
      h: 100,
    })
    const markdown = createElement(source, {
      kind: 'markdown',
      id: 'md',
      text: '看见 @图 舞蹈',
      x: 0,
      y: 200,
      w: 200,
      h: 100,
    })
    const consumer = createElement(
      source,
      node({
        id: 'consumer',
        nodeType: 'plein/video',
        ports: {
          inputs: [{ id: 'prompt', label: '提示词', type: 'text', multiple: true }],
          outputs: [],
        },
        params: { prompt: '' },
      }),
    )
    connect(source, [markdown, 'text'], [consumer, 'prompt'])
    const data = JSON.parse(
      JSON.stringify(
        referenceClipboard.copy(source, [image, markdown, consumer], { canvasId: 'canvas-a' }),
      ),
    )
    const destination = openDoc()
    createElement(destination, {
      id: 'shared',
      kind: 'image',
      name: '图',
      assetId: 'asset-b',
      x: 0,
      y: 0,
      w: 100,
      h: 100,
    })
    const pasted = referenceClipboard.paste(destination, data, { canvasId: 'canvas-b' })
    const importedImage = pasted[0]!
    const importedMarkdown = destination.get(pasted[1]!)!
    // 素材本身复制进来时引用跟着副本；目标画布还有同名素材，所以补上消歧序号。
    expect(importedMarkdown.text).toBe('看见 @图#1 舞蹈')
    expect(resolved(destination, importedMarkdown.text!)).toBe(importedImage)
    const binding = referenceBindings(importedMarkdown.params)['图']
    expect(binding).toBeUndefined()
    source.destroy()
    destination.destroy()
  })

  it('跨画布外部持久绑定保留原名，不跟随目标画布同 id 元素的新名字', () => {
    const source = openDoc()
    createElement(source, {
      id: 'shared',
      kind: 'image',
      name: '图',
      assetId: 'asset-a',
      x: 0,
      y: 0,
      w: 100,
      h: 100,
    })
    const target = createElement(
      source,
      node({
        id: 'target',
        params: {
          prompt: '@图 舞蹈',
          [`referenceNameBinding:${encodeURIComponent('图')}:shared`]: {
            type: 'image',
            assetId: 'asset-a',
            source: 'shared',
          },
        },
      }),
    )
    const data = JSON.parse(
      JSON.stringify(referenceClipboard.copy(source, [target], { canvasId: 'canvas-a' })),
    )
    const destination = openDoc()
    createElement(destination, {
      id: 'shared',
      kind: 'image',
      name: '新图',
      assetId: 'asset-b',
      x: 0,
      y: 0,
      w: 100,
      h: 100,
    })
    const [imported] = referenceClipboard.paste(destination, data, { canvasId: 'canvas-b' })
    const params = destination.get(imported!)!.params!
    // 未复制的素材即使和目标画布元素同 id，也不能改叫目的端的名字。
    expect(params.prompt).toBe('@图 舞蹈')
    // 原来的资产证据保留，来源改成不可命中的地址。
    expect(referenceBindings(params)['图']).toMatchObject({
      assetId: 'asset-a',
      source: expect.stringContaining('plein-external/'),
    })
    expect(referenceBindings(params)['新图']).toBeUndefined()
    source.destroy()
    destination.destroy()
  })

  it('跨画布粘贴不按同 id 恢复未复制的素材参考边', () => {
    const source = openDoc()
    const image = createElement(source, {
      id: 'shared',
      kind: 'image',
      assetId: 'asset-a',
      x: 0,
      y: 0,
      w: 100,
      h: 100,
    })
    const card = createElement(
      source,
      node({
        id: 'card',
        name: '角色卡',
        nodeType: 'plein/character',
        ports: {
          inputs: [{ id: 'references', label: '参考素材', type: 'any', multiple: true }],
          outputs: [],
        },
      }),
    )
    connect(source, [image, 'image'], [card, 'references'])
    const data = JSON.parse(
      JSON.stringify(referenceClipboard.copy(source, [card], { canvasId: 'canvas-a' })),
    )
    const destination = openDoc()
    createElement(destination, {
      id: 'shared',
      kind: 'image',
      assetId: 'asset-b',
      x: 0,
      y: 0,
      w: 100,
      h: 100,
    })
    const [pasted] = referenceClipboard.paste(destination, data, { canvasId: 'canvas-b' })
    expect(inputEdges(destination, pasted!, 'references')).toHaveLength(0)
    source.destroy()
    destination.destroy()
  })

  it('同画布粘贴仍保留未复制元素的活动引用', () => {
    const doc = openDoc()
    const shared = createElement(doc, {
      id: 'shared',
      kind: 'image',
      name: '图',
      assetId: 'asset-a',
      x: 0,
      y: 0,
      w: 100,
      h: 100,
    })
    const target = createElement(doc, node({ id: 'target', params: { prompt: '@图 保持构图' } }))
    const data = referenceClipboard.copy(doc, [target], { canvasId: 'canvas-a' })
    const [imported] = referenceClipboard.paste(doc, data, { canvasId: 'canvas-a' })
    const params = doc.get(imported!)!.params!
    expect(params.prompt).toBe('@图 保持构图')
    expect(referenceBindings(params)).toEqual({})
    expect(resolved(doc, String(params.prompt))).toBe(shared)
    doc.destroy()
  })

  it('跨画布复制时名称绑定跟随副本，不认领目标画布的同名卡', () => {
    const doc = openDoc()
    createElement(doc, node({ id: 'card', name: '林夏', nodeType: 'plein/character' }))
    const target = createElement(
      doc,
      node({
        params: {
          prompt: '@林夏 回头',
          [`referenceNameBinding:${encodeURIComponent('林夏')}:card`]: {
            type: 'image',
            assetId: 'asset-a',
            source: 'card',
          },
        },
      }),
    )
    const data = JSON.parse(JSON.stringify(referenceClipboard.copy(doc, ['card', target])))
    const destination = openDoc()
    const sameName = createElement(
      destination,
      node({ id: 'local', name: '林夏', nodeType: 'plein/character' }),
    )
    const pasted = referenceClipboard.paste(destination, data)
    const imported = destination.get(pasted[1]!)!
    const binding = referenceBindings(imported.params)
    expect(Object.keys(binding)).toEqual(['林夏#1'])
    expect(binding['林夏#1']?.source).toBe(pasted[0])
    expect(binding['林夏#1']?.source).not.toBe(sameName)
    expect(imported.params?.prompt).toBe('@林夏#1 回头')
    expect(resolved(destination, String(imported.params?.prompt))).toBe(pasted[0])
    doc.destroy()
    destination.destroy()
  })

  it('跨画布只复制展开节点、分镜表和资产未带入时，来源记录不指向目标画布同 id 元素', () => {
    const doc = openDoc()
    createElement(doc, node({ id: 'board', nodeType: 'plein/storyboard' }))
    const shotNode = createElement(
      doc,
      node({
        id: 'shot-node',
        params: { source: { storyboard: 'board', shot: 's1', role: 'video' } },
      }),
    )
    const sequence = createElement(
      doc,
      node({
        id: 'seq',
        params: { clips: [{ source: 'clip-src', start: 0 }] },
      }),
    )
    const data = JSON.parse(
      JSON.stringify(referenceClipboard.copy(doc, [shotNode, sequence], { canvasId: 'canvas-a' })),
    )
    const destination = openDoc()
    // 目标画布恰好有同 id 的分镜表（检查点恢复出的画布与原画布 id 相同）。
    createElement(destination, node({ id: 'board', nodeType: 'plein/storyboard' }))
    const pasted = referenceClipboard.paste(destination, data, { canvasId: 'canvas-b' })
    const imported = destination.get(pasted[0]!)!
    const src = imported.params?.source as { storyboard: string; shot: string; detached?: boolean }
    expect(src.storyboard).not.toBe('board')
    expect(src.storyboard).toContain('plein-external/')
    expect(src.shot).toBe('s1')
    expect(src.detached).toBe(true)
    // 目标分镜表不会把它当成自己的展开节点，批量运行也就不会重复付费生成。
    expect(expandedNodes(destination, 'board').size).toBe(0)
    const clips = destination.get(pasted[1]!)!.params?.clips as Array<{ source: string }>
    expect(clips[0]!.source).toContain('plein-external/')
    doc.destroy()
    destination.destroy()
  })

  it('跨画布复制分镜表但不带资产时，镜头资产绑定不挂到目标画布同 id 素材', () => {
    const doc = openDoc()
    const board = createElement(
      doc,
      node({
        id: 'board',
        nodeType: 'plein/storyboard',
        params: { shots: [{ id: 's1', assetBindings: { 林夏: { elementId: 'role-card' } } }] },
      }),
    )
    const data = JSON.parse(
      JSON.stringify(referenceClipboard.copy(doc, [board], { canvasId: 'canvas-a' })),
    )
    const destination = openDoc()
    createElement(destination, node({ id: 'role-card', name: '别人', nodeType: 'plein/character' }))
    const [imported] = referenceClipboard.paste(destination, data, { canvasId: 'canvas-b' })
    const shots = destination.get(imported!)!.params?.shots as Array<{
      assetBindings: Record<string, { elementId: string }>
    }>
    expect(shots[0]!.assetBindings['林夏']!.elementId).toContain('plein-external/')
    doc.destroy()
    destination.destroy()
  })
})
