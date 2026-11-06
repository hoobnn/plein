import { API, type RewritePrompt, type RewritePromptResult } from '@plein/protocol'
import { beforeAll, describe, expect, it } from 'vite-plus/test'
import { startTestServer } from '../testing'
import { maskPrompt, optimizeSystem, unmaskPrompt, usesH3Structure } from './rewrite'

describe('maskPrompt / unmaskPrompt', () => {
  it('引用和占位换成标记，再原样换回', () => {
    const text = '@林夏站在【场景】里，@林夏走进雨中，@路人甲 回头'
    const { masked, kept } = maskPrompt(text, ['林夏'])
    expect(masked).toBe('⟦1⟧站在⟦2⟧里，⟦3⟧走进雨中，⟦4⟧ 回头')
    expect(kept).toEqual(['@林夏', '【场景】', '@林夏', '@路人甲'])
    expect(unmaskPrompt(masked, kept)).toBe(text)
  })

  it('模型丢了或编造了标记时返回 null', () => {
    const { kept } = maskPrompt('@林夏和【角色】', ['林夏'])
    expect(unmaskPrompt('只剩 ⟦1⟧', kept)).toBeNull()
    expect(unmaskPrompt('⟦1⟧⟦2⟧⟦3⟧', kept)).toBeNull()
    expect(unmaskPrompt('⟦2⟧ with ⟦1⟧', kept)).toBe('【角色】 with @林夏')
  })
})

describe('素材编号与改写结构', () => {
  it('带参考素材时正文里的素材编号也被保护，不会被改坏', () => {
    const { masked, kept } = maskPrompt('图1站在图片2旁，@视频3 与 Image 4、Audio 5', [], true)
    expect(kept).toEqual(['图1', '图片2', '@视频3', 'Image 4', 'Audio 5'])
    expect(unmaskPrompt(masked, kept)).toBe('图1站在图片2旁，@视频3 与 Image 4、Audio 5')
    // 不带参考素材时保持原行为
    expect(maskPrompt('图1站在旁边', []).kept).toEqual([])
    // 纯数字不是素材编号
    expect(maskPrompt('数字 12 与 图12', [], true).kept).toEqual(['图12'])
  })

  it('通用公式覆盖主体、动作、场景、光影、运镜、风格、画质、约束，并要求保留素材标签与正向约束', () => {
    for (const target of ['image', 'video'] as const) {
      const system = optimizeSystem(target, 'expand', false)
      expect(system).toContain('主体 + 动作 + 场景 + 光影 + 运镜 + 风格 + 画质 + 约束')
      expect(system).toContain('必须逐字保留')
      expect(system).toContain('正向表述')
    }
    expect(optimizeSystem('video', 'refine', false)).toContain('仅精修')
  })

  it('H3 参考任务使用六段结构，字段名与顺序固定', () => {
    const system = optimizeSystem('video', 'expand', true)
    const order = [
      'subject_definitions',
      'summary',
      'retention_analysis',
      'detailed_description',
      'overall_soundscape',
      'non_diegetic_music',
    ].map((name) =>
      system.indexOf(`- ${name}:`) >= 0 ? system.indexOf(`- ${name}:`) : system.indexOf(name),
    )
    expect(order.every((i) => i >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(system).toContain('⟦1⟧')
    expect(system).toContain('<Subject N>')
  })

  it('auto 只在 H3 多模态参考时启用六段结构，可强制开关', () => {
    const h3 = 'minimax/api:MiniMax-H3'
    expect(
      usesH3Structure({ generationModel: h3, inputContext: { mode: 'reference', references: [] } }),
    ).toBe(true)
    expect(
      usesH3Structure({ generationModel: h3, inputContext: { mode: 'text', references: [] } }),
    ).toBe(false)
    expect(
      usesH3Structure({
        generationModel: 'volc/ark:seedance',
        inputContext: { mode: 'reference', references: [] },
      }),
    ).toBe(false)
    expect(
      usesH3Structure({
        structure: 'default',
        generationModel: h3,
        inputContext: { mode: 'reference', references: [] },
      }),
    ).toBe(false)
    expect(usesH3Structure({ structure: 'h3' })).toBe(true)
  })
})

const start = (mock: boolean) => startTestServer({ mock })

const rewrite = (base: string, body: RewritePrompt | Record<string, unknown>) =>
  fetch(base + API.promptRewrite, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

describe('POST /api/prompt/rewrite', () => {
  let s: Awaited<ReturnType<typeof start>>
  beforeAll(async () => {
    s = await start(true)
  })

  it('优化：用已启用的对话模型改写，保留引用和占位', async () => {
    const res = await rewrite(s.url, {
      text: '@林夏在【场景】里奔跑',
      mode: 'optimize',
      target: 'video',
      mentions: ['林夏'],
    })
    expect(res.status).toBe(200)
    const out = (await res.json()) as RewritePromptResult
    expect(out.model).toBe('plein/mock:agent')
    expect(out.text).toBe('【mock】@林夏在【场景】里奔跑')
  })

  it('翻译：走同一个接口', async () => {
    const res = await rewrite(s.url, { text: 'a cat on @Luna', mode: 'translate' })
    expect(res.status).toBe(200)
    expect(((await res.json()) as RewritePromptResult).text).toBe('【mock】a cat on @Luna')
  })

  it('强制 H3 结构但目标不是 H3 模型时 400', async () => {
    const res = await rewrite(s.url, {
      text: '林夏走路',
      mode: 'optimize',
      target: 'video',
      structure: 'h3',
      generationModel: 'plein/mock:video',
    })
    expect(res.status).toBe(400)
  })

  it('参数不对或模型不可用时 400', async () => {
    expect((await rewrite(s.url, { text: '  ', mode: 'optimize' })).status).toBe(400)
    expect((await rewrite(s.url, { text: 'x', mode: 'polish' })).status).toBe(400)
    const res = await rewrite(s.url, { text: 'x', mode: 'optimize', model: 'plein/mock:image' })
    expect(res.status).toBe(400)
  })

  it('平台出错时 502 并带上错误码', async () => {
    const put = (failWith: string) =>
      fetch(`${s.url}${API.providerConfig('plein/mock')}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ settings: { failWith } }),
      })
    expect((await put('rate_limit')).status).toBe(200)
    const res = await rewrite(s.url, { text: '一只猫', mode: 'optimize' })
    expect(res.status).toBe(502)
    expect(((await res.json()) as { error: string }).error).toBe('rate_limit')
    await put('none')
  })

  it('没有启用对话模型时 409', async () => {
    const bare = await start(false)
    const res = await rewrite(bare.url, { text: '一只猫', mode: 'optimize' })
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: string }).error).toBe('no_model')
  })
})
