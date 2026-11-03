import { afterEach, expect, it, vi } from 'vite-plus/test'
import { arkPlanProvider, arkProvider } from './index'
import { fakeContext } from '../testing'

afterEach(() => vi.useRealTimers())

it('套餐视频模型不提供草稿选项，按量平台仍保留，语音声明文本上限', () => {
  const plan = arkPlanProvider.models.find((model) => model.id === 'doubao-seedance-2-5-260628')!
  const api = arkProvider.models.find((model) => model.id === 'doubao-seedance-2-5-260628')!
  expect(plan.options?.shape).not.toHaveProperty('draft')
  expect(plan.options?.shape).toHaveProperty('adaptive_duration')
  expect(api.options?.shape).toHaveProperty('draft')
  expect(
    arkPlanProvider.models.find((model) => model.id === 'doubao-seed-tts-2.0')?.limits
      ?.promptMaxLength,
  ).toBe(3000)
})
it('目录查询只使用独立 AK/SK 签名，归一化并去重，不泄露套餐 Key', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-01T00:00:00Z'))
  const { ctx, fetch, body } = fakeContext(
    arkPlanProvider,
    [
      {
        Result: {
          Datas: [
            { ModelID: 'new-chat' },
            { ModelID: 'new-chat' },
            { ModelID: 'doubao-seedance-2.5' },
            { ModelID: 'doubao-embedding-vision' },
          ],
        },
      },
    ],
    {
      secret: {
        ARK_AGENT_PLAN_API_KEY: 'plan-secret',
        ARK_PLAN_ACCESS_KEY: 'access',
        ARK_PLAN_SECRET_KEY: 'secret',
      },
    },
  )
  const models = await arkPlanProvider.listRemoteModels!(ctx)
  expect(models).toEqual([
    { id: 'new-chat', kind: 'llm', agentOnly: true, features: ['tools', 'structured'] },
    { id: 'doubao-seedance-2-5-260628' },
  ])
  expect(body()).toEqual({ Edition: 'personal' })
  // 对照官方 @volcengine/openapi@1.36.2 Signer 生成，固定时间与虚拟凭证。
  expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get('Authorization')).toBe(
    'HMAC-SHA256 Credential=access/20261101/cn-beijing/ark/request, SignedHeaders=host;x-content-sha256;x-date, Signature=240c3513898c37e492583312c6fa3ce18252f4689cb8aeb2cbff2c78d327fd2e',
  )
  expect(fetch).toHaveBeenCalledWith(
    'https://ark.cn-beijing.volcengineapi.com/?Action=ListArkAgentPlanModel&Version=2024-01-01',
    expect.objectContaining({
      headers: expect.objectContaining({
        'X-Date': '20261101T000000Z',
        Authorization: expect.stringMatching(
          /^HMAC-SHA256 Credential=access\/20261101\/cn-beijing\/ark\/request, SignedHeaders=host;x-content-sha256;x-date, Signature=[a-f0-9]{64}$/,
        ),
      }),
    }),
  )
  expect(JSON.stringify(fetch.mock.calls)).not.toContain('plan-secret')
})
it('没有目录凭证时不误用套餐 Key 请求', async () => {
  const { ctx, fetch } = fakeContext(arkPlanProvider, [], {
    secret: { ARK_AGENT_PLAN_API_KEY: 'plan-secret' },
  })
  await expect(arkPlanProvider.listRemoteModels!(ctx)).rejects.toThrow('模型目录 Access Key')
  expect(fetch).not.toHaveBeenCalled()
})
