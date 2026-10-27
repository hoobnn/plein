// @vitest-environment happy-dom
import { CharacterProfile } from '@plein/nodes'
import { useState } from 'react'
import { describe, expect, it, type Mock, vi } from 'vite-plus/test'
import { mockFetch } from '../../testing/fetch'
import { fireEvent, renderApp, screen, waitFor, within } from '../../testing/render'
import type { CanvasMedia } from './canvas'
import { ExpressionsTab, PeriodsTab, type HeroControl } from './LibraryProfile'

/** 64 位十六进制的素材 id */
const asset = (seed: string) => seed.repeat(64).slice(0, 64)

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

/** 档案面板会读一次音色列表；这里只关心档案本身，音色返回空列表。 */
function mockVoices(
  handler?: (request: Request) => Response | undefined | Promise<Response | undefined>,
) {
  mockFetch(async (request) => {
    if (new URL(request.url).pathname === '/api/voices') return json([])
    return handler?.(request)
  })
}

interface Harness {
  /** 当前档案草稿；面板每次改动后同步到这里 */
  profile: CharacterProfile
  hero: HeroControl & {
    onPreview: Mock<HeroControl['onPreview']>
    onPin: Mock<HeroControl['onPin']>
  }
  user: ReturnType<typeof renderApp>['user']
}

/** 渲染「时期与服饰」页签，面板内部持有草稿状态。 */
function renderPeriods(initial: CharacterProfile, media: CanvasMedia[] = []): Harness {
  const state: Harness = {
    profile: initial,
    hero: { onPreview: vi.fn<HeroControl['onPreview']>(), onPin: vi.fn<HeroControl['onPin']>() },
    user: undefined as unknown as Harness['user'],
  }
  function Editor() {
    const [profile, setProfile] = useState(initial)
    return (
      <PeriodsTab
        name="林夏"
        profile={profile}
        onChange={(next) => {
          state.profile = next
          setProfile(next)
        }}
        media={media}
        hero={state.hero}
      />
    )
  }
  state.user = renderApp(<Editor />).user
  return state
}

/** 渲染「表情」页签 */
function renderExpressions(initial: CharacterProfile, media: CanvasMedia[] = []): Harness {
  const state: Harness = {
    profile: initial,
    hero: { onPreview: vi.fn<HeroControl['onPreview']>(), onPin: vi.fn<HeroControl['onPin']>() },
    user: undefined as unknown as Harness['user'],
  }
  function Editor() {
    const [profile, setProfile] = useState(initial)
    return (
      <ExpressionsTab
        profile={profile}
        onChange={(next) => {
          state.profile = next
          setProfile(next)
        }}
        media={media}
        hero={state.hero}
        sheet={null}
      />
    )
  }
  state.user = renderApp(<Editor />).user
  return state
}

const profileOf = (raw: unknown) => CharacterProfile.parse(raw)

/** 时期行按钮（左侧时间线） */
const lane = (text: string) =>
  screen.getAllByRole('button').find((button) => button.textContent?.includes(text))!

const textbox = (label: string) => screen.getByRole('textbox', { name: label }) as HTMLInputElement

describe('角色档案面板', () => {
  it('时期名重名时回车就地提示不改名，改成合法名字后旧名进别名', async () => {
    mockVoices()
    const state = renderPeriods(
      profileOf({
        periods: [
          { id: 'teen', name: '少年', description: '保留少年设定' },
          { id: 'youth', name: '青年', description: '保留青年设定' },
        ],
      }),
    )
    const input = textbox('时期名')
    input.focus()
    fireEvent.change(input, { target: { value: '青年' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect(document.activeElement).toBe(input)
    expect(screen.getByRole('alert').textContent).toContain('已经用过了')
    // 纠错期间不提交草稿
    expect(state.profile.periods[0]!.name).toBe('少年')

    fireEvent.change(input, { target: { value: '成年' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(input.getAttribute('aria-invalid')).toBe('false')
    expect(input.value).toBe('成年')
    expect(state.profile.periods[0]).toMatchObject({ name: '成年', aliases: ['少年'] })
    expect(state.profile.periods[0]!.description).toBe('保留少年设定')
  })

  it('名称草稿按 Esc 还原成已存的名字，不留下未提交的修改', async () => {
    mockVoices()
    const state = renderPeriods(profileOf({ periods: [{ id: 'teen', name: '少年' }] }))
    const input = textbox('时期名')
    input.focus()
    fireEvent.change(input, { target: { value: '临时编辑' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(input.value).toBe('少年')
    expect(state.profile.periods[0]!.name).toBe('少年')
  })

  it('输入法组字时的回车与取消不提交也不清除档案名称', async () => {
    mockVoices()
    const state = renderPeriods(profileOf({ periods: [{ id: 'teen', name: '少年' }] }))
    const input = textbox('时期名')
    input.focus()
    fireEvent.change(input, { target: { value: '正在选字' } })

    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229, isComposing: false })
    expect(input.value).toBe('正在选字')
    expect(document.activeElement).toBe(input)
    expect(state.profile.periods[0]!.name).toBe('少年')

    fireEvent.keyDown(input, { key: 'Escape', keyCode: 229, isComposing: false })
    expect(input.value).toBe('正在选字')

    fireEvent.keyDown(input, { key: 'Enter', isComposing: true })
    expect(input.value).toBe('正在选字')
    expect(state.profile.periods[0]!.name).toBe('少年')
  })

  it('删除时期后焦点回到相邻时期，删光后落到添加入口', async () => {
    mockVoices()
    const state = renderPeriods(
      profileOf({
        periods: [
          { id: 'teen', name: '少年', description: '保留少年设定' },
          { id: 'youth', name: '青年', description: '保留青年设定' },
        ],
        expressions: [{ id: 'happy', name: '开心' }],
      }),
    )
    fireEvent.click(screen.getByRole('button', { name: '删除时期「少年」' }))
    const youth = lane('青年')
    expect(document.activeElement).toBe(youth)
    expect(textbox('时期名').value).toBe('青年')

    fireEvent.click(screen.getByRole('button', { name: '删除时期「青年」' }))
    const add = screen.getByRole('button', { name: '添加时期' })
    expect(document.activeElement).toBe(add)
    expect(state.profile.periods).toEqual([])
    expect(state.profile.expressions.map((x) => x.id)).toEqual(['happy'])
  })

  it('删除服饰后焦点回到所属时期，其他时期与描述完整保留', async () => {
    mockVoices()
    const state = renderPeriods(
      profileOf({
        periods: [
          {
            id: 'teen',
            name: '少年',
            description: '保留少年设定',
            aliases: ['初中'],
            outfits: [{ id: 'uniform', name: '校服', description: '保留校服材质' }],
          },
          { id: 'youth', name: '青年', description: '保留青年设定' },
        ],
      }),
    )
    fireEvent.click(screen.getByRole('button', { name: '少年 · 校服' }))
    fireEvent.click(screen.getByRole('button', { name: '删除服饰「校服」' }))
    expect(document.activeElement).toBe(lane('少年'))
    expect(state.profile.periods[0]).toMatchObject({
      id: 'teen',
      name: '少年',
      description: '保留少年设定',
      aliases: ['初中'],
      outfits: [],
    })
    expect(state.profile.periods[1]).toMatchObject({ id: 'youth', description: '保留青年设定' })
  })

  it('表情删除后聚焦邻项，删光后落到添加表情入口并可直接键盘添加', async () => {
    mockVoices()
    const state = renderExpressions(
      profileOf({
        expressions: [
          { id: 'happy', name: '开心' },
          { id: 'sad', name: '难过' },
        ],
      }),
    )
    const editor = () => document.querySelector('.lib-look-editor') as HTMLElement
    fireEvent.click(screen.getByRole('button', { name: '编辑「开心」' }))
    fireEvent.click(within(editor()).getByRole('button', { name: '删除' }))
    const next = screen.getByRole('button', { name: '编辑「难过」' })
    expect(document.activeElement).toBe(next)

    // 展开邻项再删，末项删除后落到添加表情入口
    fireEvent.click(next)
    fireEvent.click(within(editor()).getByRole('button', { name: '删除' }))
    const add = screen.getByRole('button', { name: '添加表情' })
    expect(document.activeElement).toBe(add)
    expect(state.profile.expressions).toEqual([])

    // 末项退出后可以直接键盘开始添加
    fireEvent.click(add)
    const pop = document.querySelector('.lib-add-pop') as HTMLElement
    const preset = within(pop).getByRole('button', { name: '开心' })
    expect(document.activeElement).toBe(preset)
    fireEvent.keyDown(preset, { key: 'Escape' })
    // 菜单收起时「添加」按钮会被重建，按当前 DOM 重新取
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '添加表情' }))
  })

  it('添加菜单与自定义输入逐层取消回到上一层按钮', async () => {
    mockVoices()
    const state = renderPeriods(profileOf({ periods: [{ id: 'teen', name: '少年' }] }))
    const add = screen.getByRole('button', { name: '添加时期' })
    add.focus()
    fireEvent.click(add)

    const menu = screen.getByRole('group', { name: '添加时期' })
    const preset = within(menu).getByRole('button', { name: '童年' })
    expect(document.activeElement).toBe(preset)

    fireEvent.click(within(menu).getByRole('button', { name: '自定义' }))
    const custom = textbox('自定义名字')
    fireEvent.change(custom, { target: { value: '暂时输入' } })
    fireEvent.keyDown(custom, { key: 'Escape' })
    const customButton = within(menu).getByRole('button', { name: '自定义' })
    expect(document.activeElement).toBe(customButton)

    fireEvent.keyDown(customButton, { key: 'Escape' })
    expect(document.querySelector('.lib-add-pop')).toBeNull()
    // 菜单收起时「添加」按钮会被重建，按当前 DOM 重新取
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '添加时期' }))
    expect(textbox('时期名').value).toBe('少年')
    expect(state.profile.periods).toHaveLength(1)
  })

  it('自定义名字在输入法组字时不提前添加，正常回车只保存一次', async () => {
    mockVoices()
    const state = renderPeriods(
      profileOf({
        periods: [
          {
            id: 'teen',
            name: '少年',
            description: '保留时期设定',
            outfits: [{ id: 'uniform', name: '校服', description: '保留服饰设定' }],
          },
        ],
        expressions: [{ id: 'happy', name: '开心', description: '保留表情设定' }],
      }),
    )
    fireEvent.click(screen.getByRole('button', { name: '添加时期' }))
    const menu = screen.getByRole('group', { name: '添加时期' })
    fireEvent.click(within(menu).getByRole('button', { name: '自定义' }))
    const custom = textbox('自定义名字')
    fireEvent.change(custom, { target: { value: '自定义阶段' } })

    for (const event of [
      { key: 'Enter', isComposing: true },
      { key: 'Enter', keyCode: 229, isComposing: false },
      { key: 'Escape', isComposing: true },
      { key: 'Escape', keyCode: 229, isComposing: false },
    ]) {
      fireEvent.keyDown(custom, event)
      expect(custom.value).toBe('自定义阶段')
      expect(document.activeElement).toBe(custom)
      expect(state.profile.periods).toHaveLength(1)
    }

    fireEvent.keyDown(custom, { key: 'Enter' })
    expect(screen.queryByRole('textbox', { name: '自定义名字' })).toBeNull()
    const input = textbox('时期名')
    expect(input.value).toBe('自定义阶段')
    expect(document.activeElement).toBe(input)
    expect(state.profile.periods).toHaveLength(2)
    // 其余设定原样保留
    expect(state.profile.periods[0]).toMatchObject({
      id: 'teen',
      name: '少年',
      description: '保留时期设定',
    })
    expect(state.profile.periods[0]!.outfits[0]).toMatchObject({
      id: 'uniform',
      name: '校服',
      description: '保留服饰设定',
    })
    expect(state.profile.expressions).toHaveLength(1)
    expect(state.profile.expressions[0]).toMatchObject({ id: 'happy', name: '开心' })
  })

  it('加到第八个时期后添加入口退出，删掉一个后重新出现', async () => {
    mockVoices()
    const periods = Array.from({ length: 7 }, (_, i) => ({
      id: `p${i}`,
      name: `阶段${i + 1}`,
      description: `保留${i}`,
    }))
    const state = renderPeriods(profileOf({ periods }))
    fireEvent.click(screen.getByRole('button', { name: '添加时期' }))
    const menu = screen.getByRole('group', { name: '添加时期' })
    fireEvent.click(within(menu).getByRole('button', { name: '青年' }))

    const input = textbox('时期名')
    expect(input.value).toBe('青年')
    expect(document.activeElement).toBe(input)
    expect(screen.queryByRole('button', { name: '添加时期' })).toBeNull()
    expect(state.profile.periods).toHaveLength(8)

    fireEvent.click(screen.getByRole('button', { name: '删除时期「青年」' }))
    expect(document.activeElement).toBe(lane('阶段7'))
    expect(screen.getByRole('button', { name: '添加时期' })).toBeTruthy()
    expect(state.profile.periods.map((x) => x.id)).toEqual(periods.map((x) => x.id))
  })

  it('次音色填满第六项后聚焦新状态，删掉后回到邻项并恢复添加', async () => {
    mockVoices()
    const states = Array.from({ length: 5 }, (_, i) => ({
      id: `s${i}`,
      name: `状态${i + 1}`,
      voice: { provider: 'mock', voiceId: `voice${i}` },
    }))
    const state = renderPeriods(
      profileOf({ periods: [{ id: 'one', name: '少年', voiceStates: states }] }),
    )
    const add = screen.getByRole('button', { name: '生病' })
    add.focus()
    fireEvent.click(add)

    const names = screen.getAllByRole('textbox', { name: '状态' }) as HTMLInputElement[]
    expect(names).toHaveLength(6)
    expect(document.activeElement).toBe(names[5])
    expect(state.profile.periods[0]!.voiceStates).toHaveLength(6)

    fireEvent.click(screen.getByRole('button', { name: '删除次音色「生病」' }))
    const after = screen.getAllByRole('textbox', { name: '状态' }) as HTMLInputElement[]
    expect(document.activeElement).toBe(after[4])
    expect(after[4]!.value).toBe('状态5')
    expect(screen.getByRole('button', { name: '生病' })).toBeTruthy()
    expect(state.profile.periods[0]!.voiceStates).toHaveLength(5)
  })

  it('时期往返排序后焦点跟着移动的时期，素材与说明完整保留', async () => {
    mockVoices()
    const state = renderPeriods(
      profileOf({
        periods: [
          { id: 'teen', name: '少年', description: '保留少年样貌' },
          { id: 'youth', name: '青年', description: '保留青年样貌' },
          { id: 'adult', name: '成年', description: '保留成年样貌' },
        ],
      }),
    )
    const back = screen.getByRole('button', { name: '往后挪' })
    back.focus()
    fireEvent.click(back)
    expect(document.activeElement).toBe(lane('少年'))
    expect(textbox('时期名').value).toBe('少年')
    expect(state.profile.periods.map((x) => x.id)).toEqual(['youth', 'teen', 'adult'])

    fireEvent.click(screen.getByRole('button', { name: '往后挪' }))
    expect(state.profile.periods.map((x) => x.id)).toEqual(['youth', 'adult', 'teen'])
    // 末项不能再往后挪
    expect((screen.getByRole('button', { name: '往后挪' }) as HTMLButtonElement).disabled).toBe(
      true,
    )

    fireEvent.click(screen.getByRole('button', { name: '往前挪' }))
    expect(state.profile.periods.map((x) => x.id)).toEqual(['youth', 'teen', 'adult'])
    expect(state.profile.periods[0]).toMatchObject({ id: 'youth', description: '保留青年样貌' })
  })

  it('表情改名后大图标题跟着改，收起后不再残留旧标题', async () => {
    mockVoices()
    const happy = asset('a')
    const state = renderExpressions(
      profileOf({ expressions: [{ id: 'happy', name: '开心', images: [happy] }] }),
    )
    fireEvent.click(screen.getByRole('button', { name: '编辑「开心」' }))
    const input = textbox('名字')
    fireEvent.change(input, { target: { value: '微笑' } })
    fireEvent.blur(input)

    await waitFor(() => {
      const last = state.hero.onPin.mock.calls.at(-1)
      expect(last?.[1]).toBe('微笑')
    })
    expect(state.profile.expressions[0]).toMatchObject({ name: '微笑', aliases: ['开心'] })
  })

  it('悬停时期行时预览该时期的图，离开后撤下', async () => {
    mockVoices()
    const teen = asset('b')
    const state = renderPeriods(
      profileOf({ periods: [{ id: 'teen', name: '少年', images: [teen] }] }),
    )
    const button = lane('少年')
    fireEvent.pointerEnter(button)
    expect(state.hero.onPreview).toHaveBeenLastCalledWith(teen, '少年时期')
    fireEvent.pointerLeave(button)
    expect(state.hero.onPreview.mock.calls.at(-1)).toEqual([null])
  })

  it('服饰的自定义名字在组字时不提前添加，正常回车只添加一套', async () => {
    mockVoices()
    const state = renderPeriods(
      profileOf({
        periods: [{ id: 'teen', name: '少年', description: '保留时期设定' }],
      }),
    )
    fireEvent.click(screen.getByRole('button', { name: '加服饰' }))
    const menu = document.querySelector('.lib-add-pop') as HTMLElement
    fireEvent.click(within(menu).getByRole('button', { name: '自定义' }))
    const custom = textbox('自定义名字')
    fireEvent.change(custom, { target: { value: '运动服' } })

    fireEvent.keyDown(custom, { key: 'Enter', isComposing: true })
    expect(custom.value).toBe('运动服')
    expect(state.profile.periods[0]!.outfits).toHaveLength(0)

    fireEvent.keyDown(custom, { key: 'Enter' })
    expect(screen.queryByRole('textbox', { name: '自定义名字' })).toBeNull()
    const input = textbox('服饰名')
    expect(input.value).toBe('运动服')
    expect(document.activeElement).toBe(input)
    expect(state.profile.periods[0]!.outfits).toHaveLength(1)
    expect(state.profile.periods[0]!.description).toBe('保留时期设定')
  })

  it('表情的自定义名字在组字时不提前添加，正常回车只添加一个', async () => {
    mockVoices()
    const state = renderExpressions(profileOf({ expressions: [] }))
    fireEvent.click(screen.getByRole('button', { name: '添加表情' }))
    const menu = document.querySelector('.lib-add-pop') as HTMLElement
    fireEvent.click(within(menu).getByRole('button', { name: '自定义' }))
    const custom = textbox('自定义名字')
    fireEvent.change(custom, { target: { value: '眨眼' } })

    fireEvent.keyDown(custom, { key: 'Enter', keyCode: 229 })
    expect(custom.value).toBe('眨眼')
    expect(state.profile.expressions).toHaveLength(0)

    fireEvent.keyDown(custom, { key: 'Enter' })
    expect(screen.queryByRole('textbox', { name: '自定义名字' })).toBeNull()
    expect(textbox('名字').value).toBe('眨眼')
    expect(state.profile.expressions).toHaveLength(1)
  })

  it('服饰加满十二套后入口退出，删掉一套后恢复', async () => {
    mockVoices()
    const outfits = Array.from({ length: 11 }, (_, i) => ({
      id: `o${i}`,
      name: `服饰${i + 1}`,
      description: `保留${i}`,
    }))
    const state = renderPeriods(profileOf({ periods: [{ id: 'teen', name: '少年', outfits }] }))
    fireEvent.click(screen.getByRole('button', { name: '加服饰' }))
    const menu = document.querySelector('.lib-add-pop') as HTMLElement
    fireEvent.click(within(menu).getByRole('button', { name: '校服' }))

    expect(state.profile.periods[0]!.outfits).toHaveLength(12)
    expect(screen.queryByRole('button', { name: '加服饰' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '少年 · 校服' }))
    fireEvent.click(screen.getByRole('button', { name: '删除服饰「校服」' }))
    expect(screen.getByRole('button', { name: '加服饰' })).toBeTruthy()
    expect(state.profile.periods[0]!.outfits).toHaveLength(11)
  })

  it('表情加满二十四个后入口退出', async () => {
    mockVoices()
    const expressions = Array.from({ length: 23 }, (_, i) => ({
      id: `e${i}`,
      name: `表情${i + 1}`,
    }))
    const state = renderExpressions(profileOf({ expressions }))
    fireEvent.click(screen.getByRole('button', { name: '添加表情' }))
    const menu = document.querySelector('.lib-add-pop') as HTMLElement
    fireEvent.click(within(menu).getByRole('button', { name: '开心' }))

    expect(state.profile.expressions).toHaveLength(24)
    expect(screen.queryByRole('button', { name: '添加表情' })).toBeNull()
  })

  it('批量上传时失败的文件单独列出，成功项照常保留', async () => {
    const sent: string[] = []
    mockVoices((request) => {
      if (request.method !== 'POST' || !request.url.endsWith('/api/assets')) return undefined
      const name = decodeURIComponent(request.headers.get('x-file-name') ?? '')
      sent.push(name)
      if (name.includes('坏')) return json({ error: '服务器拒绝了这个文件' }, 500)
      return json({ id: asset(name) }, 201)
    })
    const state = renderPeriods(profileOf({ periods: [{ id: 'teen', name: '少年' }] }))
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, {
      target: {
        files: [
          new File([new Uint8Array([1])], '好图.png', { type: 'image/png' }),
          new File([new Uint8Array([2])], '坏图.png', { type: 'image/png' }),
        ],
      },
    })

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('坏图.png')
    })
    expect(screen.getByRole('alert').textContent).toContain('已添加 1 张图片')
    expect(state.profile.periods[0]!.images).toHaveLength(1)
    expect(sent).toEqual(['好图.png', '坏图.png'])
  })

  it('超出剩余数量时一个文件都不上传', async () => {
    const sent: string[] = []
    mockVoices((request) => {
      if (request.method !== 'POST' || !request.url.endsWith('/api/assets')) return undefined
      sent.push(decodeURIComponent(request.headers.get('x-file-name') ?? ''))
      return json({ id: asset('z') }, 201)
    })
    const state = renderPeriods(
      profileOf({
        periods: [{ id: 'teen', name: '少年', images: [asset('a'), asset('b'), asset('c')] }],
      }),
    )
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, {
      target: {
        files: [
          new File([new Uint8Array([1])], '一.png', { type: 'image/png' }),
          new File([new Uint8Array([2])], '二.png', { type: 'image/png' }),
        ],
      },
    })

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('最多还能添加 1 张')
    })
    expect(sent).toEqual([])
    expect(state.profile.periods[0]!.images).toHaveLength(3)
  })

  it('服饰跨时期移动：已满的目标不可选，选了也留在原时期', async () => {
    mockVoices()
    const picture = asset('e')
    const full = Array.from({ length: 12 }, (_, i) => ({ id: `f${i}`, name: `满额${i}` }))
    const state = renderPeriods(
      profileOf({
        periods: [
          {
            id: 'teen',
            name: '少年',
            outfits: [{ id: 'uniform', name: '校服', aliases: ['制服'], images: [picture] }],
          },
          { id: 'youth', name: '青年', outfits: full },
          { id: 'adult', name: '成年' },
        ],
      }),
    )
    const { user } = state
    fireEvent.click(screen.getByRole('button', { name: '少年 · 校服' }))
    await user.click(screen.getByRole('combobox', { name: '属于时期' }))
    const options = screen.getAllByRole('option')
    expect(options.map((o) => o.textContent)).toEqual(['少年', '青年（服饰已满 12 套）', '成年'])
    expect(options[1]!.getAttribute('aria-disabled')).toBe('true')

    await user.click(options[1]!)
    expect(state.profile.periods[0]!.outfits).toHaveLength(1)
    expect(state.profile.periods[0]!.outfits[0]!.images).toEqual([picture])
    expect(state.profile.periods[1]!.outfits).toHaveLength(12)
  })

  it('服饰移到未满的目标时期：图片与旧名一起过去', async () => {
    mockVoices()
    const picture = asset('e')
    const state = renderPeriods(
      profileOf({
        periods: [
          {
            id: 'teen',
            name: '少年',
            outfits: [{ id: 'uniform', name: '校服', aliases: ['制服'], images: [picture] }],
          },
          { id: 'youth', name: '青年' },
          { id: 'adult', name: '成年' },
        ],
      }),
    )
    const { user } = state
    fireEvent.click(screen.getByRole('button', { name: '少年 · 校服' }))
    await user.click(screen.getByRole('combobox', { name: '属于时期' }))
    await user.click(screen.getByRole('option', { name: '成年' }))
    expect(state.profile.periods[0]!.outfits).toHaveLength(0)
    expect(state.profile.periods[2]!.outfits).toHaveLength(1)
    expect(state.profile.periods[2]!.outfits[0]).toMatchObject({
      id: 'uniform',
      name: '校服',
      aliases: ['制服'],
      images: [picture],
    })
  })

  it('时期排序保持选中项，逐次删除切到相邻项', async () => {
    mockVoices()
    const state = renderPeriods(
      profileOf({
        periods: [
          { id: 'teen', name: '少年', description: '保留少年样貌' },
          { id: 'youth', name: '青年', description: '保留青年样貌' },
          { id: 'adult', name: '成年', description: '保留成年样貌' },
        ],
      }),
    )
    fireEvent.click(lane('青年'))
    expect(textbox('时期名').value).toBe('青年')

    fireEvent.click(screen.getByRole('button', { name: '往前挪' }))
    expect(textbox('时期名').value).toBe('青年')
    expect(state.profile.periods.map((x) => x.id)).toEqual(['youth', 'teen', 'adult'])

    fireEvent.click(screen.getByRole('button', { name: '删除时期「青年」' }))
    expect(textbox('时期名').value).toBe('少年')
    fireEvent.click(screen.getByRole('button', { name: '删除时期「少年」' }))
    expect(textbox('时期名').value).toBe('成年')
    fireEvent.click(screen.getByRole('button', { name: '删除时期「成年」' }))
    expect(state.profile.periods).toEqual([])
    // 顺序之外的素材仍在档案里
    expect(state.profile.expressions).toEqual([])
  })

  it('时期改名后大图标题跟着改成新名字', async () => {
    mockVoices()
    const teen = asset('f')
    const state = renderPeriods(
      profileOf({ periods: [{ id: 'teen', name: '少年', images: [teen] }] }),
    )
    const input = textbox('时期名')
    input.focus()
    fireEvent.change(input, { target: { value: '青年' } })
    fireEvent.blur(input)

    await waitFor(() => {
      expect(state.hero.onPin.mock.calls.at(-1)).toEqual([teen, '青年时期'])
    })
    expect(state.profile.periods[0]).toMatchObject({ name: '青年', aliases: ['少年'] })
  })

  it('选图弹层在上传期间禁用候选，上传结束后恢复', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    mockVoices(async (request) => {
      if (request.method !== 'POST' || !request.url.endsWith('/api/assets')) return undefined
      await gate
      return json({ id: asset('d') }, 201)
    })
    renderPeriods(profileOf({ periods: [{ id: 'teen', name: '少年' }] }), [
      { elId: 'e1', assetId: asset('c'), kind: 'image', name: '画布图' },
    ])

    fireEvent.click(screen.getByRole('button', { name: '从画布选' }))
    const candidate = screen.getByRole('button', { name: '选择图片「画布图」' })
    expect((candidate as HTMLButtonElement).disabled).toBe(false)

    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    void fireEvent.change(input, {
      target: { files: [new File([new Uint8Array([1])], '新图.png', { type: 'image/png' })] },
    })
    await waitFor(() => {
      expect((candidate as HTMLButtonElement).disabled).toBe(true)
    })

    release()
    await waitFor(() => {
      expect((candidate as HTMLButtonElement).disabled).toBe(false)
    })
  })

  it('自定义名字撞上档案里已有的名字时，说明被谁占了且不添加', async () => {
    mockVoices()
    const state = renderPeriods(
      profileOf({
        periods: [{ id: 'teen', name: '少年' }],
        expressions: [{ id: 'happy', name: '开心' }],
      }),
    )
    fireEvent.click(screen.getByRole('button', { name: '添加时期' }))
    const menu = document.querySelector('.lib-add-pop') as HTMLElement
    fireEvent.click(within(menu).getByRole('button', { name: '自定义' }))
    const custom = textbox('自定义名字')
    fireEvent.change(custom, { target: { value: '少年' } })
    fireEvent.keyDown(custom, { key: 'Enter' })

    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain('已经用过了')
    expect(alert.textContent).toContain('时期「少年」')
    expect(state.profile.periods).toHaveLength(1)
    expect(custom.value).toBe('少年')
  })

  it('自定义名字撞上表情名时同样说明占用者', async () => {
    mockVoices()
    const state = renderExpressions(profileOf({ expressions: [{ id: 'happy', name: '开心' }] }))
    fireEvent.click(screen.getByRole('button', { name: '添加表情' }))
    const menu = document.querySelector('.lib-add-pop') as HTMLElement
    fireEvent.click(within(menu).getByRole('button', { name: '自定义' }))
    const custom = textbox('自定义名字')
    fireEvent.change(custom, { target: { value: '开心' } })
    fireEvent.keyDown(custom, { key: 'Enter' })

    expect(screen.getByRole('alert').textContent).toContain('表情「开心」')
    expect(state.profile.expressions).toHaveLength(1)
  })

  it('时期加满后说明上限，服饰加满也说明上限', async () => {
    mockVoices()
    const periods = Array.from({ length: 8 }, (_, i) => ({
      id: `p${i}`,
      name: `阶段${i + 1}`,
      outfits: Array.from({ length: 12 }, (_, j) => ({ id: `o${i}-${j}`, name: `服饰${j + 1}` })),
    }))
    renderPeriods(profileOf({ periods }))
    expect(screen.getByText('已达 8 个时期上限，删掉一个才能继续添加。')).toBeTruthy()
    expect(screen.getAllByText('已达 12 套服饰上限')).toHaveLength(8)
    expect(screen.getByText('8/8')).toBeTruthy()
  })
})
