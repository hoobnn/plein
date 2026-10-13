import { describe, expect, it } from 'vite-plus/test'
import { z } from 'zod'
import {
  defineNode,
  defineProvider,
  describeNode,
  domainAllowed,
  inputAssets,
  inputText,
  type PortValue,
  ProviderError,
  type ProviderDefinition,
  parseModelRef,
  parseNodeKey,
  PluginManifest,
  providerConfigured,
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

  it('旧版本参数但节点没有 migrate 时报错', () => {
    const node = defineNode({ ...base, params: z.object({}) })
    expect(() => resolveParams(node, {}, 1)).toThrow(/不能从版本 1 升级/)
  })

  it('describeNode 给出默认值与运行方式', () => {
    const params = z.object({ model: z.string().default('') })
    const d = describeNode(defineNode({ ...base, params }), 'acme/p')
    expect(d).toMatchObject({ defaults: { model: '' }, execution: 'inline', plugin: 'acme/p' })
    const job = describeNode(defineNode({ ...base, params, capability: 'text.chat' }), 'acme/p')
    expect(job.execution).toBe('job')
  })

  it('清单校验', () => {
    const ok = PluginManifest.parse({
      id: 'acme/p',
      version: '1.0.0',
      name: 'P',
      engines: { plein: '^0.1.0' },
    })
    expect(ok.permissions).toEqual({ network: [], secrets: [], assets: 'none', media: false })
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

describe('Provider', () => {
  const provider = (extra: Partial<ProviderDefinition> = {}): ProviderDefinition => ({
    id: 'acme/p',
    title: 'P',
    settings: z.object({}),
    secrets: [
      { name: 'KEY', title: 'Key', required: true },
      { name: 'AK', title: 'AK' },
      { name: 'SK', title: 'SK' },
    ],
    models: [{ id: 'm', title: 'M', capabilities: ['text.chat'] }],
    submit: async () => ({ state: 'pending', remoteId: 'r' }),
    ...extra,
  })

  it.each([
    ['模型 id 重复', { models: [...provider().models, ...provider().models] }, /重复/],
    ['模型没有能力', { models: [{ id: 'm', title: 'M', capabilities: [] }] }, /能力/],
    ['鉴权组引用未声明的密钥', { credentialAlternatives: [['AK', 'NOPE']] }, /鉴权组/],
    ['鉴权组为空', { credentialAlternatives: [[]] }, /鉴权组/],
  ])('defineProvider 拒绝：%s', (_, extra, error) => {
    expect(() => defineProvider(provider(extra))).toThrow(error)
  })

  it.each([
    ['必填密钥已填', {}, { KEY: 'k' }, true],
    ['必填密钥只有空白', {}, { KEY: '  ' }, false],
    [
      '任一鉴权组填全',
      { credentialAlternatives: [['AK', 'SK']] },
      { KEY: 'k', AK: 'a', SK: 's' },
      true,
    ],
    ['鉴权组只填了一半', { credentialAlternatives: [['AK', 'SK']] }, { KEY: 'k', AK: 'a' }, false],
  ])('providerConfigured：%s', (_, extra, secrets, ok) => {
    expect(providerConfigured(provider(extra), secrets)).toBe(ok)
  })

  it('ProviderError 默认按错误码判断能否重试', () => {
    expect(new ProviderError('rate_limit', 'x').retryable).toBe(true)
    expect(new ProviderError('timeout', 'x').retryable).toBe(true)
    expect(new ProviderError('unavailable', 'x').retryable).toBe(true)
    expect(new ProviderError('auth', 'x').retryable).toBe(false)
    expect(new ProviderError('auth', 'x', { retryable: true }).retryable).toBe(true)
  })
})

describe('执行器输入', () => {
  const inputs: Record<string, PortValue[]> = {
    p: [
      { type: 'text', text: 'a' },
      { type: 'json', value: { k: 1 } },
      { type: 'image', assetId: 'i', kind: 'image' },
    ],
  }

  it('inputText 拼接文本与 JSON，没有时为 undefined', () => {
    expect(inputText(inputs, 'p')).toBe('a\n{"k":1}')
    expect(inputText(inputs, 'none')).toBeUndefined()
  })

  it('inputAssets 只取媒体', () => {
    expect(inputAssets(inputs, 'p')).toEqual([{ type: 'image', assetId: 'i', kind: 'image' }])
  })
})
