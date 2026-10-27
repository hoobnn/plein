import { type Engine, Scene } from '@plein/canvas-core'
import type { CanvasElement, PleinDoc } from '@plein/doc'
import { corePlugin } from '@plein/nodes'
import { describeNode } from '@plein/plugin-sdk'
import type { Catalog, CharacterImageSlot, LibraryItem } from '@plein/protocol'
import { characterImageRevision } from '@plein/protocol'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { openDoc } from '@plein/doc/testing'
import {
  characterArchiveBody,
  characterArchiveSource,
  createCharacterImageDraft,
  sameCharacterArchiveSource,
} from './CharacterProduction'
import { placeInputOf, placeLibraryItem } from './canvas'

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)
const docs: PleinDoc[] = []
afterEach(() => {
  vi.unstubAllGlobals()
  for (const doc of docs.splice(0)) doc.destroy()
})

const catalog = {
  nodes: corePlugin.nodes.map((node) => ({
    ...describeNode(node, 'plein/core'),
    executable: true,
  })),
  providers: [],
  prompts: [],
} as unknown as Catalog

const character: LibraryItem = {
  id: 'lib_exact_id',
  kind: 'character',
  name: '林夏',
  projectId: 'project_original',
  description: '黑长直，白色外套',
  tags: { gender: '女' },
  voice: null,
  images: [],
  video: null,
  models: [],
  profile: null,
  favorite: false,
  usedAt: null,
  createdAt: 0,
  updatedAt: 0,
}

async function setup() {
  const doc = openDoc()
  docs.push(doc)
  const engine = {
    doc,
    scene: new Scene(doc),
    selection: { set: vi.fn() },
    setTool: vi.fn(),
    camera: {
      viewRect: { x: 0, y: 0, w: 1200, h: 900 },
      centerOn: vi.fn(),
    },
  } as unknown as Engine
  vi.stubGlobal('requestAnimationFrame', () => 0)
  const placed = await placeLibraryItem(engine, catalog, placeInputOf(character)!)
  return { doc, engine, cardId: placed.id! }
}

describe('角色图片制作草稿', () => {
  it('四类槽位按精确 ID 各建独立图片草稿、连入角色参考且不自动运行', async () => {
    const { doc, engine, cardId } = await setup()
    const slots: CharacterImageSlot[] = ['full_body', 'portrait', 'face_grid', 'character_3view']
    const ids = slots.map((slot) =>
      createCharacterImageDraft(engine, catalog, cardId, character, slot)!,
    )
    expect(new Set(ids).size).toBe(4)
    for (const [index, id] of ids.entries()) {
      const node = doc.get(id)!
      expect(node.nodeType).toBe('plein/image')
      expect(node.params?.characterAssetTarget).toEqual({
        libraryId: character.id,
        slot: slots[index],
      })
      expect(String(node.params?.prompt).split('\n')[0]).toBe('@林夏')
      expect(node.run).toBeUndefined()
      expect(node.results).toBeUndefined()
    }
    expect(doc.get(ids[2]!)?.params?.prompt).toContain('严格 3×3')
    expect(doc.get(ids[3]!)?.params?.prompt).toContain('正面、侧面、背面')
    expect(character.projectId).toBe('project_original')
  })

  it('只有当前采用候选可归档，换候选使旧确认失效且请求保留原身份', async () => {
    const { doc, engine, cardId } = await setup()
    const id = createCharacterImageDraft(engine, catalog, cardId, character, 'portrait')!
    const base = doc.get(id)!
    const first = {
      id: 'result_first',
      runId: 'run_first',
      port: 'images',
      value: { type: 'image', assetId: A },
    }
    const second = {
      id: 'result_second',
      runId: 'run_second',
      port: 'images',
      value: { type: 'image', assetId: B },
    }
    const pending = { ...base, results: [first], adopted: null } as CanvasElement
    expect(characterArchiveSource(pending, 'canvas_1')).toBeNull()
    const adopted = { ...pending, adopted: first.id } as CanvasElement
    const source = characterArchiveSource(adopted, 'canvas_1')!
    expect(source).toMatchObject({
      canvasId: 'canvas_1',
      nodeId: id,
      resultId: first.id,
      assetId: A,
      libraryId: character.id,
      slot: 'portrait',
    })
    const changed = {
      ...adopted,
      results: [first, second],
      adopted: second.id,
    } as CanvasElement
    expect(sameCharacterArchiveSource(changed, source)).toBe(false)
    expect(characterArchiveBody(source, character, 'face_grid', true)).toEqual({
      canvasId: 'canvas_1',
      nodeId: id,
      resultId: first.id,
      assetId: A,
      sourceSlot: 'portrait',
      slot: 'face_grid',
      expected: characterImageRevision(character),
      cover: true,
    })
  })
})
