import { describe, expect, it } from 'vite-plus/test'
import type { Catalog } from '@plein/protocol'
import { creationScopeReason, mediaCreationCatalog } from './catalog'
const target = { elId: 'image', assetId: 'a', kind: 'image' as const }
describe('media tool declarations', () => {
  it('checks enabled model operation declarations instead of treating all image processing as available', () => {
    const catalog = {
      nodes: [],
      prompts: [],
      providers: [
        {
          enabled: true,
          models: [{ capabilities: ['image.process'], limits: { imageOperations: ['upscale'] } }],
        },
        {
          enabled: false,
          models: [
            {
              capabilities: ['image.process'],
              limits: { imageOperations: ['cutout', 'outpaint'] },
            },
          ],
        },
      ],
    } as unknown as Catalog
    const tools = mediaCreationCatalog(catalog)
    expect(tools.supportsProcess('upscale')).toBe(true)
    expect(tools.supportsProcess('cutout')).toBe(false)
    expect(tools.supportsProcess('outpaint')).toBe(false)
    expect(tools.hasImageModel).toBe(false)
  })
  it('keeps draft nodes and recipes discoverable without configured generation models', () => {
    const image = {
      type: 'plein/image',
      capability: 'image.generate',
      inputs: [{ id: 'images', type: 'image' }],
    }
    const tools = mediaCreationCatalog({
      nodes: [image],
      providers: [],
      prompts: [
        { id: 'three-view', title: '三视图', appliesTo: ['image.generate'], template: 'test' },
        { id: 'video', title: '运镜', appliesTo: ['video.generate'], template: 'test' },
      ],
    } as unknown as Catalog)
    expect(tools.image).toBe(image)
    expect(tools.recipes.map((p) => p.id)).toEqual(['three-view'])
    expect(tools.hasImageModel).toBe(false)
  })
  it('provides actionable scope reasons for mixed selection, read only and locked media', () => {
    expect(creationScopeReason([target], false, false)).toBeNull()
    expect(creationScopeReason([target, { ...target, kind: 'video' }], false, false)).toContain(
      '请先单选',
    )
    expect(creationScopeReason([target], true, false)).toContain('只读')
    expect(creationScopeReason([target], false, true)).toContain('锁定')
  })
})
