import { createElement, deleteElements, setParam, type PleinDoc } from '@plein/doc'
import { node, openDoc } from '@plein/doc/testing'
import { Shot } from '@plein/nodes'
import type { Catalog } from '@plein/protocol'
import { describe, expect, it } from 'vite-plus/test'
import {
  applyControlDraft,
  buildControlDraft,
  EMPTY_CONTROLS,
  shotControlContext,
} from './shotControlModel'

const catalogOf = (): Catalog => ({
  plugins: [],
  nodes: [],
  templates: [],
  prompts: [],
  elements: [],
  defaultModels: { 'video.generate': 'test/p:video', 'image.generate': 'test/p:image' },
  providers: [
    {
      id: 'test/p',
      title: '测试',
      plugin: 'test/plugin',
      settingsSchema: {},
      secrets: [],
      models: [
        {
          id: 'video',
          title: '原模型',
          capabilities: ['video.generate'],
          promptGuide: { version: 'guide-1', text: '先描述相机，再描述主体动作。' },
          limits: { duration: { min: 1, max: 10 } },
          optionsSchema: { type: 'object', properties: { fixed: { type: 'boolean' } } },
        },
        { id: 'image', title: '图像模型', capabilities: ['image.generate'] },
      ],
      enabled: true,
      configured: true,
    },
  ],
})
function seed(expanded = true) {
  const doc = openDoc()
  const shots = ['one', 'two'].map((id, no) => ({
    ...Shot.parse({
      id,
      no: no + 1,
      description: '原剧情',
      imagePrompt: '@主角 【不可改引用】原图手改',
      motionPrompt: '@主角 原运动手改',
      lighting: '原光影',
      characters: ['主角'],
      assetBindings: { 主角: { elementId: 'hero' } },
      dialogue: [{ id: 'line', character: '主角', line: '保留台词' }],
    }),
    manualExtra: '保留未知字段',
  }))
  const boardId = createElement(
    doc,
    node({ nodeType: 'plein/storyboard', params: { model: 'text/only', shots } }),
  )
  const videoId = expanded ? addVideo(doc, boardId) : undefined
  const catalog = catalogOf()
  const context = shotControlContext(doc, boardId, 'one', catalog)!
  return { doc, boardId, videoId, catalog, context }
}
const addVideo = (doc: PleinDoc, boardId: string) =>
  createElement(
    doc,
    node({
      nodeType: 'plein/video',
      params: {
        prompt: '展开节点自己的手改',
        duration: 4,
        model: 'test/p:video',
        source: { storyboard: boardId, shot: 'one', role: 'video' },
      },
    }),
  )
const controls = {
  ...EMPTY_CONTROLS,
  angle: '低机位仰拍',
  lens: '广角空间感',
  cameraMotion: '相机环绕主体',
  subjectMotion: '主体不转身，右手持信封',
  lightPosition: '主体左后方',
  lightDirection: '由左后向右前照射',
  keep: '原人物和服装',
  shotSize: '近景' as const,
}

describe('镜头控制草稿', () => {
  it('相机与主体、光源位置与方向分开，原文引用和手改保留，模型指南按声明版本序列化', () => {
    const { doc, context, catalog } = seed()
    const draft = buildControlDraft(context, 'video', controls)
    expect(draft.values.motionPrompt).toContain('@主角 原运动手改；相机视角：低机位仰拍')
    expect(draft.values.motionPrompt).toContain('相机运动：相机环绕主体')
    expect(draft.values.motionPrompt).toContain('主体动作：主体不转身，右手持信封')
    expect(draft.values.lighting).toBe('原光影；光源位置：主体左后方；照射方向：由左后向右前照射')
    expect(draft.values.imagePrompt).toContain('@主角 【不可改引用】原图手改')
    expect(draft.values.imagePrompt).not.toContain('相机环绕主体')
    expect(draft.values.imagePrompt).toContain('主体动作／姿态：主体不转身')
    expect(JSON.parse(JSON.stringify(catalog)).providers[0].models[0].promptGuide).toEqual({
      version: 'guide-1',
      text: '先描述相机，再描述主体动作。',
    })
    expect(context.models.video[0]).toMatchObject({
      future: false,
      ref: 'test/p:video',
      info: { title: '原模型' },
    })
    expect(context.models.image[0]).toMatchObject({ future: true, ref: 'test/p:image' })
    doc.destroy()
  })

  it('只采用选中字段，原节点/其他镜头/引用/台词/额外字段保留且一次撤销', () => {
    const { doc, boardId, videoId, context, catalog } = seed()
    const before = structuredClone(doc.get(boardId)!.params!.shots as unknown[])
    const nodeBefore = doc.get(videoId!)!.params
    const draft = buildControlDraft(context, 'video', controls)
    draft.values.motionPrompt += '；用户继续改草稿'
    doc.undo.clear()
    expect(
      applyControlDraft(doc, boardId, 'one', catalog, draft, ['motionPrompt', 'lighting']),
    ).toBe(true)
    const after = doc.get(boardId)!.params!.shots as Array<Record<string, unknown>>
    expect(after[0]).toEqual({
      ...(before[0] as object),
      motionPrompt: draft.values.motionPrompt,
      lighting: draft.values.lighting,
      edited: true,
    })
    expect(after[1]).toEqual(before[1])
    expect(doc.get(videoId!)!.params).toEqual(nodeBefore)
    expect(doc.undo.undoStack).toHaveLength(1)
    doc.undo.undo()
    expect(doc.get(boardId)!.params!.shots).toEqual(before)
    doc.undo.redo()
    expect((doc.get(boardId)!.params!.shots as typeof after)[0]!.motionPrompt).toBe(
      draft.values.motionPrompt,
    )
    doc.destroy()
  })

  it.each(['shot', 'model', 'duplicate', 'node-type', 'deleted'] as const)(
    '等待期间%s变化拒绝旧草稿',
    (change) => {
      const { doc, boardId, videoId, context, catalog } = seed()
      const draft = buildControlDraft(context, 'video', controls)
      if (change === 'shot')
        setParam(doc, boardId, 'shots', [
          { ...context.shot, lighting: '协作者刚修改' },
          Shot.parse({ id: 'two', no: 2 }),
        ])
      if (change === 'model') setParam(doc, videoId!, 'model', 'test/p:new-model')
      if (change === 'duplicate') addVideo(doc, boardId)
      if (change === 'node-type') doc.mutable(videoId!)!.set('nodeType', 'another/video')
      if (change === 'deleted') deleteElements(doc, [boardId])
      const before = doc.get(boardId)?.params
      expect(applyControlDraft(doc, boardId, 'one', catalog, draft, ['motionPrompt'])).toBe(false)
      expect(doc.get(boardId)?.params).toEqual(before)
      doc.destroy()
    },
  )

  it('尚未展开的默认模型或指南版本变化使旧草稿过期；未配置只显示通用参考', () => {
    const { doc, boardId, context, catalog } = seed(false)
    const draft = buildControlDraft(context, 'video', controls)
    catalog.defaultModels['video.generate'] = 'test/p:other'
    expect(applyControlDraft(doc, boardId, 'one', catalog, draft, ['motionPrompt'])).toBe(false)
    catalog.defaultModels['video.generate'] = 'test/p:video'
    catalog.providers[0]!.models[0]!.promptGuide!.version = 'guide-2'
    expect(applyControlDraft(doc, boardId, 'one', catalog, draft, ['motionPrompt'])).toBe(false)
    catalog.providers[0]!.configured = false
    expect(shotControlContext(doc, boardId, 'one', catalog)!.models.video[0]!.info).toBeUndefined()
    doc.destroy()
  })

  it('只读、无选中字段和坏景别不会写入；没有新生成或采用入口', () => {
    const { doc, boardId, context, catalog } = seed()
    const draft = buildControlDraft(context, 'video', controls)
    const before = doc.get(boardId)!.params
    expect(applyControlDraft(doc, boardId, 'one', catalog, draft, [])).toBe(false)
    doc.readOnly = true
    expect(applyControlDraft(doc, boardId, 'one', catalog, draft, ['motionPrompt'])).toBe(false)
    doc.readOnly = false
    draft.values.shotSize = '坏景别' as never
    expect(applyControlDraft(doc, boardId, 'one', catalog, draft, ['shotSize'])).toBe(false)
    expect(doc.get(boardId)!.params).toEqual(before)
    doc.destroy()
  })
})
