import { describe, expect, it } from 'vitest'
import { loadConfig } from './config'

describe('loadConfig', () => {
  it('本机默认免登录、可用智能体；监听非本机地址时默认要求登录并关闭智能体', () => {
    expect(loadConfig({})).toMatchObject({ host: '127.0.0.1', auth: 'none', agent: true })
    expect(loadConfig({ PLEIN_HOST: '0.0.0.0' })).toMatchObject({ auth: 'password', agent: false })
    // 显式免登录也能对外，但智能体只看是否免登录
    expect(loadConfig({ PLEIN_HOST: '0.0.0.0', PLEIN_AUTH: 'none' }).agent).toBe(true)
    expect(loadConfig({ PLEIN_AGENT: '0' }).agent).toBe(false)
  })

  it('端口或认证方式不合法时启动失败', () => {
    expect(() => loadConfig({ PLEIN_PORT: 'abc' })).toThrow(/PLEIN_PORT/)
    expect(() => loadConfig({ PLEIN_PORT: '70000' })).toThrow(/PLEIN_PORT/)
    expect(() => loadConfig({ PLEIN_AUTH: 'token' })).toThrow(/PLEIN_AUTH/)
  })
})
