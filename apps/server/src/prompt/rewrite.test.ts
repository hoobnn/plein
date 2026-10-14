import { API, type RewritePrompt, type RewritePromptResult } from '@plein/protocol'
import { beforeAll, describe, expect, it } from 'vite-plus/test'
import { startTestServer } from '../testing'
import { maskPrompt, unmaskPrompt } from './rewrite'

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
