import { domainAllowed } from '@plein/plugin-sdk'
import { describe, expect, it } from 'vite-plus/test'
import { arkPlugin, bailianPlugin, doubaoPlugin, minimaxPlugin } from './index'

describe('内置平台插件的权限声明', () => {
  it.each([
    [
      '火山方舟',
      arkPlugin,
      ['ARK_API_KEY', 'ARK_TOS_ACCESS_KEY', 'ARK_TOS_SECRET_KEY'],
      ['volces.com', 'byteimg.com', 'ibytedtos.com', 'byteicdn.com'],
      ['ark.cn-beijing.volces.com', 'test-bucket.tos-cn-beijing.volces.com'],
    ],
    [
      '百炼',
      bailianPlugin,
      ['DASHSCOPE_API_KEY'],
      ['aliyuncs.com'],
      ['dashscope.aliyuncs.com', 'dashscope-result-sz.oss-cn-shenzhen.aliyuncs.com'],
    ],
    [
      '豆包语音',
      doubaoPlugin,
      ['VOLC_SPEECH_API_KEY', 'VOLC_SPEECH_APP_ID', 'VOLC_SPEECH_ACCESS_KEY'],
      ['bytedance.com'],
      ['openspeech.bytedance.com'],
    ],
    [
      'MiniMax',
      minimaxPlugin,
      ['MINIMAX_API_KEY'],
      ['minimax.cn', 'minimax.io', 'minimax.chat', 'minimaxi.com', 'hailuoai.com', 'aliyuncs.com'],
      ['api.minimax.cn', 'api.minimax.io', 'cdn.hailuoai.com'],
    ],
  ])('%s 只申请自家密钥、只读资产，网络只在平台域名内', (_, plugin, secrets, vendors, reach) => {
    const { permissions } = plugin.plugin.manifest
    expect(permissions.secrets).toEqual(secrets)
    expect(permissions.assets).toBe('read')
    for (const entry of permissions.network) {
      const host = entry.replace(/^\*\./, '')
      expect(
        vendors.some((d) => host === d || host.endsWith(`.${d}`)),
        entry,
      ).toBe(true)
    }
    for (const host of reach) expect(domainAllowed(permissions.network, host), host).toBe(true)
  })
})
