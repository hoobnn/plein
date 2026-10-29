import { beforeAll, describe, expect, it, vi } from 'vite-plus/test'
import { arkPlanPlugin, arkPlanProvider } from '@plein/providers'
import { startTestServer, tempDir } from '../testing'
import { PluginHost } from './host'
import { PluginRegistry } from './registry'
import { ProviderConfigStore } from './config-store'
import { PermissionError } from './sandbox'

describe('方舟视频参考的 S3 兼容存储放行', () => {
  let assets: Awaited<ReturnType<typeof startTestServer>>['server']['assets']
  beforeAll(async () => {
    assets = (await startTestServer()).server.assets
  })

  async function reach(settings: Record<string, unknown>, urls: string[]) {
    const configs = new ProviderConfigStore(tempDir())
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response('ok'))
    const host = new PluginHost(new PluginRegistry(), configs, assets, { fetch })
    host.load([arkPlanPlugin], true)
    configs.update('volc/ark-plan', {
      enabled: true,
      settings,
      secrets: { ARK_AGENT_PLAN_API_KEY: 'plan-key' },
    })
    const results: unknown[] = []
    const spy = vi.spyOn(arkPlanProvider, 'test').mockImplementation(async (ctx) => {
      for (const url of urls)
        results.push(
          await ctx.fetch(url).then(
            () => 'ok',
            (e) => e,
          ),
        )
    })
    await host.testProvider('volc/ark-plan', 'local')
    spy.mockRestore()
    return results
  }

  it('只额外放行设置里的那一个存储主机', async () => {
    const results = await reach(
      {
        referenceStorage: 's3',
        referenceEndpoint: 'https://s3.oss-cn-hangzhou.aliyuncs.com',
        referenceBucket: 'plein-refs',
        referenceRegion: 'cn-hangzhou',
      },
      [
        'https://plein-refs.s3.oss-cn-hangzhou.aliyuncs.com/plein/x.mp4',
        'https://other.s3.oss-cn-hangzhou.aliyuncs.com/x',
        'https://ark.cn-beijing.volces.com/api/plan/v3/x',
      ],
    )
    expect(results[0]).toBe('ok')
    expect(results[1]).toBeInstanceOf(PermissionError)
    expect(results[2]).toBe('ok')
  })

  it('选 TOS 时不放行任何额外主机', async () => {
    const results = await reach(
      {
        referenceStorage: 'tos',
        referenceEndpoint: 'https://s3.oss-cn-hangzhou.aliyuncs.com',
        referenceBucket: 'plein-refs',
      },
      ['https://plein-refs.s3.oss-cn-hangzhou.aliyuncs.com/plein/x.mp4'],
    )
    expect(results[0]).toBeInstanceOf(PermissionError)
  })
})
