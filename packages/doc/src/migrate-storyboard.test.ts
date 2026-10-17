import * as Y from 'yjs'
import { describe, expect, it } from 'vite-plus/test'
import { connect, createDoc, createElement } from './index'
import { node, openDoc } from './testing'

describe('schema v4 分镜身份迁移', () => {
  it('旧 video@2 端口快照补兼容的媒体输入，原端口及连线可继续使用', () => {
    const old = openDoc()
    const video = createElement(
      old,
      node({
        nodeType: 'plein/video',
        nodeVersion: 2,
        ports: {
          inputs: [{ id: 'images', label: '图片', type: 'image', multiple: true }],
          outputs: [{ id: 'video', label: '视频', type: 'video' }],
        },
      }),
    )
    const sourceVideo = createElement(old, {
      kind: 'video',
      assetId: 'a'.repeat(64),
      x: 0,
      y: 0,
      w: 100,
      h: 100,
    })
    const sourceAudio = createElement(old, {
      kind: 'audio',
      assetId: 'b'.repeat(64),
      x: 0,
      y: 0,
      w: 100,
      h: 100,
    })
    expect(connect(old, [sourceVideo, 'video'], [video, 'videos'])).toBeNull()
    old.meta.set('schemaVersion', 3)
    const raw = new Y.Doc()
    Y.applyUpdate(raw, Y.encodeStateAsUpdate(old.ydoc))
    const migrated = createDoc(raw)
    expect(migrated.get(video)?.ports?.inputs.map((p) => p.id)).toEqual([
      'images',
      'videos',
      'audios',
    ])
    expect(migrated.undo.undoStack).toHaveLength(0)
    expect(connect(migrated, [sourceVideo, 'video'], [video, 'videos'])).not.toBeNull()
    expect(connect(migrated, [sourceAudio, 'audio'], [video, 'audios'])).not.toBeNull()
    old.destroy()
    migrated.destroy()
  })
  it('旧台词补稳定 id，既有配音对应原台词；唯一资产绑定，重名不猜，不改历史参数', () => {
    const old = openDoc()
    const actor = createElement(
      old,
      node({
        nodeType: 'plein/character',
        name: '林夏',
        params: { libraryId: 'lib_actor', voice: { provider: 'p', voiceId: 'v' } },
      }),
    )
    for (let i = 0; i < 2; i++) createElement(old, node({ nodeType: 'plein/scene', name: '天台' }))
    const board = createElement(
      old,
      node({
        nodeType: 'plein/storyboard',
        params: {
          shots: [
            {
              id: 's1',
              no: 1,
              characters: ['林夏', '天台'],
              dialogue: [
                { character: '林夏', line: '第一句' },
                { character: '林夏', line: '第二句' },
              ],
            },
          ],
        },
      }),
    )
    const speech = createElement(
      old,
      node({
        nodeType: 'plein/speech',
        params: {
          text: '我改过的台词',
          source: {
            storyboard: board,
            shot: 's1',
            role: 'speech',
            line: 1,
            plan: { version: 'old', params: { text: '第二句' }, keep: [] },
          },
        },
      }),
    )
    old.meta.set('schemaVersion', 3)
    const raw = new Y.Doc()
    Y.applyUpdate(raw, Y.encodeStateAsUpdate(old.ydoc))
    const migrated = createDoc(raw)
    const shots = migrated.get(board)?.params?.shots as Array<{
      assetBindings: Record<string, unknown>
      dialogue: Array<{ id: string; speaker?: unknown }>
    }>
    expect(shots[0]?.dialogue.map((d) => d.id)).toEqual(['dialogue_s1_0', 'dialogue_s1_1'])
    expect(shots[0]?.assetBindings).toEqual({ 林夏: { elementId: actor, libraryId: 'lib_actor' } })
    expect(shots[0]?.dialogue[0]?.speaker).toEqual({ elementId: actor, libraryId: 'lib_actor' })
    expect(migrated.get(speech)?.params).toMatchObject({
      text: '我改过的台词',
      source: { dialogueId: 'dialogue_s1_1', plan: { version: 'old' } },
    })
    expect(migrated.undo.undoStack).toHaveLength(0)
    const snapshot = Y.encodeStateAsUpdate(migrated.ydoc)
    const reopenedRaw = new Y.Doc()
    Y.applyUpdate(reopenedRaw, snapshot)
    const reopened = createDoc(reopenedRaw)
    expect(reopened.get(board)?.params?.shots).toEqual(shots)
    old.destroy()
    migrated.destroy()
    reopened.destroy()
  })
})
