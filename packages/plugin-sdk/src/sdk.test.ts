import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  defineNode,
  describeNode,
  domainAllowed,
  parseModelRef,
  parseNodeKey,
  PluginManifest,
  resolveParams,
} from '.'

const base = {
  type: 'acme/n',
  version: 2,
  title: 'N',
  category: 'util' as const,
  inputs: [],
  outputs: [{ id: 'out', label: 'Out', type: 'text' as const }],
}

describe('plugin-sdk', () => {
  it('解析节点键与模型引用', () => {
    expect(parseNodeKey('plein/image@1')).toEqual({ type: 'plein/image', version: 1 })
    expect(parseNodeKey('plein/image')).toBeNull()
    expect(parseNodeKey('Bad/x@1')).toBeNull()
    expect(parseModelRef('volc/ark:doubao-seed-1.6')).toEqual({
      provider: 'volc/ark',
      model: 'doubao-seed-1.6',
    })
    expect(parseModelRef('no-colon')).toBeNull()
  })

  it('域名匹配：精确与一级通配，不能被后缀伪造', () => {
    const allowed = ['api.acme.com', '*.volces.com']
    expect(domainAllowed(allowed, 'api.acme.com')).toBe(true)
    expect(domainAllowed(allowed, 'ark.cn-beijing.volces.com')).toBe(true)
    expect(domainAllowed(allowed, 'volces.com')).toBe(false)
    expect(domainAllowed(allowed, 'evilvolces.com')).toBe(false)
    expect(domainAllowed(allowed, 'api.acme.com.evil.com')).toBe(false)
  })

  it('defineNode 校验端口与默认值', () => {
    expect(() =>
      defineNode({
        ...base,
        outputs: [
          { id: 'a', label: 'A', type: 'text' },
          { id: 'a', label: 'A', type: 'text' },
        ],
        params: z.object({}),
      }),
    ).toThrow(/重复/)
    expect(() => defineNode({ ...base, params: z.object({ x: z.string() }) })).toThrow(/默认值/)
  })

  it('参数迁移与补默认值；高于已安装版本时报错', () => {
    const node = defineNode({
      ...base,
      params: z.object({ size: z.number().default(1), label: z.string().default('') }),
      migrate: (p, from) => (from === 1 ? { size: Number(p.scale ?? 1) * 2 } : p),
    })
    expect(resolveParams(node, { scale: 3 }, 1)).toEqual({ size: 6, label: '' })
    expect(resolveParams(node, { label: 'x' })).toEqual({ size: 1, label: 'x' })
    expect(() => resolveParams(node, {}, 3)).toThrow(/高于/)
  })

  it('describeNode 输出 JSON Schema 和默认值', () => {
    const node = defineNode({
      ...base,
      params: z.object({ model: z.string().default('').meta({ widget: 'model' }) }),
    })
    const d = describeNode(node, 'acme/p')
    expect(d.defaults).toEqual({ model: '' })
    expect((d.paramsSchema.properties as Record<string, { widget: string }>).model?.widget).toBe(
      'model',
    )
  })

  it('清单校验', () => {
    const ok = PluginManifest.parse({
      id: 'acme/p',
      version: '1.0.0',
      name: 'P',
      engines: { plein: '^0.1.0' },
    })
    expect(ok.permissions).toEqual({ network: [], secrets: [], assets: 'none' })
    expect(ok.contributes.nodes).toEqual([])
    expect(PluginManifest.safeParse({ ...ok, id: 'Acme' }).success).toBe(false)
    expect(PluginManifest.safeParse({ ...ok, version: '1.0' }).success).toBe(false)
    expect(PluginManifest.safeParse({ ...ok, permissions: { secrets: ['lower'] } }).success).toBe(
      false,
    )
    expect(
      PluginManifest.safeParse({ ...ok, permissions: { network: ['https://x.com'] } }).success,
    ).toBe(false)
  })
})
