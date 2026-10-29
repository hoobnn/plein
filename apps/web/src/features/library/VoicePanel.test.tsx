// @vitest-environment happy-dom
import { expect, it } from 'vite-plus/test'
import { mockFetch } from '../../testing/fetch'
import { renderApp, resetStoreAfterEach, screen, waitFor } from '../../testing/render'
import { useCatalog } from '../../stores/catalog'
import { VoicePanel } from './VoicePanel'
import { voiceCatalog, designedVoice } from './voiceFixtures'

resetStoreAfterEach(useCatalog)

it('登记的豆包音色显示为未经验证，而不是已验证可用', async () => {
  useCatalog.setState({ catalog: voiceCatalog })
  mockFetch((request) => {
    if (new URL(request.url).pathname === '/api/voices' && request.method === 'GET')
      return Response.json([
        {
          ...designedVoice,
          provider: 'doubao/speech',
          source: 'register',
          voiceId: 'S_existing',
          previewAssetId: null,
        },
      ])
  })
  renderApp(<VoicePanel />)
  expect(await screen.findByText('已登记 · 未验证')).toBeTruthy()
  expect(screen.getByText(/登记不会验证平台音色或资源版本/)).toBeTruthy()
})

function setup() {
  useCatalog.setState({ catalog: voiceCatalog })
  const writes: unknown[] = []
  mockFetch(async (request) => {
    if (new URL(request.url).pathname !== '/api/voices') return
    if (request.method === 'GET') return Response.json([])
    if (request.method === 'POST') {
      writes.push(await request.json())
      return Response.json(designedVoice, { status: 201 })
    }
  })
  return { ...renderApp(<VoicePanel />), writes }
}

it('设计独立于复刻，必填验证后仅创建音色并保存不自动播放的试听', async () => {
  const view = setup()
  await view.user.click(screen.getByRole('button', { name: '音色设计' }))
  expect(screen.queryByLabelText('选择样本音频')).toBeNull()
  await view.user.type(screen.getByRole('textbox', { name: '名称' }), '测试音色')
  await view.user.type(screen.getByRole('textbox', { name: '音色描述' }), '沉稳的女声')
  expect((screen.getByRole('button', { name: '设计音色' }) as HTMLButtonElement).disabled).toBe(
    true,
  )
  await view.user.type(screen.getByRole('textbox', { name: '试听文本' }), '这是一段试听。')
  await view.user.click(screen.getByRole('button', { name: '设计音色' }))
  await screen.findByRole('listitem')
  expect(view.writes).toEqual([
    expect.objectContaining({
      mode: 'design',
      sampleAssetId: null,
      name: '测试音色',
      prompt: '沉稳的女声',
      previewText: '这是一段试听。',
    }),
  ])
  const audio = screen.getByLabelText('测试音色的试听音频') as HTMLAudioElement
  expect(audio.preload).toBe('none')
  expect(audio.autoplay).toBe(false)
  view.rerender(<VoicePanel />)
  expect(screen.getByRole('listitem').textContent).toContain('设计音色')
  await view.user.click(screen.getByRole('button', { name: '上传声音复刻' }))
  expect(screen.getByLabelText('选择样本音频')).toBeDefined()
  expect(screen.queryByRole('textbox', { name: '音色描述' })).toBeNull()
  expect((screen.getByRole('checkbox', { name: /降噪/ }) as HTMLInputElement).checked).toBe(false)
  expect((screen.getByRole('checkbox', { name: '音量归一化' }) as HTMLInputElement).checked).toBe(
    false,
  )
})

it('切换平台清除槽位和图片，展示各平台的设计与复刻约束', async () => {
  const { user, writes } = setup()
  const select = async (label: string, option: string) => {
    await user.click(screen.getByRole('combobox', { name: label }))
    await user.click(screen.getByRole('option', { name: option }))
  }
  await user.click(screen.getByRole('button', { name: '音色设计' }))
  await select('平台', '豆包语音')
  await user.type(screen.getByRole('textbox', { name: '音色 ID' }), 'S_old')
  expect(screen.getByLabelText('选择角色图片（可选）')).toBeDefined()
  expect(screen.getByRole('textbox', { name: '试听文本' }).getAttribute('maxlength')).toBe('300')
  await select('平台', 'MiniMax')
  expect(screen.queryByLabelText('选择角色图片（可选）')).toBeNull()
  expect(screen.queryByRole('textbox', { name: '音色 ID' })).toBeNull()
  expect(screen.getByRole('textbox', { name: '试听文本' }).getAttribute('maxlength')).toBe('500')
  await select('平台', '豆包语音')
  expect((screen.getByRole('textbox', { name: '音色 ID' }) as HTMLInputElement).value).toBe('')
  await user.click(screen.getByRole('button', { name: '取消' }))
  await user.click(screen.getAllByRole('button', { name: '上传声音复刻' })[0]!)
  await select('平台', '豆包语音')
  await select('音色类型', '后付费自定义音色')
  expect(screen.getByRole('textbox', { name: '音色 ID（可选）' })).toBeDefined()
  await select('平台', 'MiniMax')
  expect(screen.queryByRole('textbox', { name: '音色 ID（可选）' })).toBeNull()
  await user.click(screen.getByText('增强参考（可选）'))
  expect(screen.getByLabelText('选择增强参考音频')).toBeDefined()
  expect(writes).toEqual([])
})

it('首次读取给出等待状态，失败可重试恢复空态', async () => {
  useCatalog.setState({ catalog: voiceCatalog })
  let release!: (response: Response) => void
  let attempt = 0
  mockFetch((request) => {
    if (new URL(request.url).pathname !== '/api/voices') return
    if (attempt++ === 0)
      return new Promise<Response>((resolve) => {
        release = resolve
      })
    return Response.json([])
  })
  const { user } = renderApp(<VoicePanel />)
  expect(screen.getByRole('status').textContent).toBe('正在读取音色…')
  await waitFor(() => expect(release).toBeDefined())
  release(Response.json({ error: '离线' }, { status: 503 }))
  await screen.findByRole('alert')
  await user.click(screen.getByRole('button', { name: '重试' }))
  await screen.findByText('还没有自己的音色')
})

/** 平台目录副本：指定 plein/mock 的密钥组数 */
const withCredentialCount = (count: number) => ({
  ...voiceCatalog,
  providers: voiceCatalog.providers.map((p) =>
    p.id === 'plein/mock' ? { ...p, credentialCount: count } : p,
  ),
})

it('平台有多组密钥时音色显示所属 Key 标签，单组不显示', async () => {
  useCatalog.setState({ catalog: withCredentialCount(2) })
  mockFetch((request) => {
    if (new URL(request.url).pathname === '/api/voices' && request.method === 'GET')
      return Response.json([{ ...designedVoice, credentialLabel: '团队' }])
  })
  renderApp(<VoicePanel />)
  await screen.findByText('测试音色')
  expect(screen.getByText('团队')).toBeTruthy()

  // 同一音色在单组平台上不再显示标签
  useCatalog.setState({ catalog: withCredentialCount(1) })
  await waitFor(() => expect(screen.queryByText('团队')).toBeNull())
})

it('没记录所属 Key 或平台组数不明的音色不显示标签', async () => {
  useCatalog.setState({ catalog: withCredentialCount(2) })
  mockFetch((request) => {
    if (new URL(request.url).pathname === '/api/voices' && request.method === 'GET')
      return Response.json([{ ...designedVoice, credentialLabel: null }])
  })
  renderApp(<VoicePanel />)
  await screen.findByText('测试音色')
  expect(screen.queryByText('团队')).toBeNull()
  // 目录没返回组数时同样保持安静，不猜
  useCatalog.setState({ catalog: voiceCatalog })
  await waitFor(() => expect(screen.queryByText('团队')).toBeNull())
})
