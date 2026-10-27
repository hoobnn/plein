// @vitest-environment happy-dom
import type { ArchiveCharacterImage, LibraryItem } from '@plein/protocol'
import { characterImageRevision } from '@plein/protocol'
import { describe, expect, it, vi } from 'vite-plus/test'
import { mockFetch } from '../../testing/fetch'
import { renderApp, resetStoreAfterEach, screen, waitFor } from '../../testing/render'
import { ArchiveDialog } from './ArchiveCharacterImage'
import { useLibrary } from './store'

// 归档走真实 store 与真实 api client，只在 HTTP 边界拦截请求。
resetStoreAfterEach(useLibrary)

const asset = (seed: string) => seed.repeat(64).slice(0, 64)

const character = (over: Partial<LibraryItem> = {}): LibraryItem => ({
  id: 'lib-1',
  kind: 'character',
  name: '林夏',
  projectId: null,
  description: '',
  tags: {},
  voice: null,
  images: [{ slot: 'portrait', assetId: asset('a') }],
  video: null,
  models: [],
  profile: null,
  sceneViews: [],
  favorite: false,
  usedAt: null,
  createdAt: 1,
  updatedAt: 1,
  coverAssetId: null,
  ...over,
})

const source = {
  canvasId: 'canvas-1',
  nodeId: 'node-1',
  resultId: 'result-1',
  assetId: asset('b'),
  libraryId: 'lib-1',
  slot: 'portrait',
} as const

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

/**
 * 服务端角色已变：第一次归档 409，重新读取拿到的是另一份角色（换了名字、图片与封面）。
 * 请求体按真实协议记录下来，供断言比较两次提交的内容。
 */
function setup(options: { reload?: 'error' } = {}) {
  const latest = character({
    name: '陆川',
    updatedAt: 2,
    images: [{ slot: 'full_body', assetId: asset('c') }],
    coverAssetId: source.assetId,
  })
  const posts: ArchiveCharacterImage[] = []
  let conflict = true
  mockFetch(async (request) => {
    const url = new URL(request.url)
    if (request.method === 'GET' && url.pathname === '/api/library/lib-1') {
      if (options.reload === 'error') return json({ error: 'server', message: '读取失败' }, 500)
      return json(latest)
    }
    if (request.method === 'POST' && url.pathname === '/api/library/lib-1/character-image') {
      const body = (await request.clone().json()) as ArchiveCharacterImage
      posts.push(body)
      if (conflict) {
        conflict = false
        return json(
          { error: 'conflict', message: '角色或图片已变化，请重新读取后核对归档目标' },
          409,
        )
      }
      return json({ ...latest, updatedAt: 3 })
    }
    return undefined
  })
  return { latest, posts }
}

describe('归档到角色弹层', () => {
  it('冲突后重新读取到的最新角色才用于再次提交', async () => {
    const initial = character()
    const { latest, posts } = setup()
    const onClose = vi.fn()
    const { user } = renderApp(
      <ArchiveDialog
        source={source}
        item={initial}
        sourceIsCurrent={() => true}
        onClose={onClose}
      />,
    )

    // 第一次提交用的是最初读到的那份角色
    await user.click(screen.getByRole('button', { name: '确认归档' }))
    await waitFor(() => expect(posts).toHaveLength(1))
    expect(posts[0]!.expected).toBe(characterImageRevision(initial))
    expect(posts[0]!.slot).toBe('portrait')
    expect(posts[0]!.cover).toBe(false)

    // 冲突要看得见，且在重新读取前不允许再次确认
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('角色或图片已变化')
    })
    expect(screen.getByRole('alert').textContent).toContain('请重新读取角色后再确认')
    expect((screen.getByRole('button', { name: '请重新核对' }) as HTMLButtonElement).disabled).toBe(
      true,
    )

    await user.click(screen.getByRole('button', { name: '重新读取角色' }))
    await screen.findByRole('button', { name: '确认归档' })
    expect(screen.queryByRole('alert')).toBeNull()

    // 重新读取后的弹层仍然可选目标槽位
    await user.click(screen.getByRole('combobox', { name: '目标槽位' }))
    await user.click(await screen.findByRole('option', { name: '情绪九宫格' }))

    await user.click(screen.getByRole('button', { name: '确认归档' }))
    await waitFor(() => expect(posts).toHaveLength(2))

    // 再次提交必须带着最新角色的版本、槽位与封面，而不是最初那份
    expect(posts[1]!.expected).toBe(characterImageRevision(latest))
    expect(posts[1]!.expected).not.toBe(posts[0]!.expected)
    expect(posts[1]!.slot).toBe('face_grid')
    expect(posts[1]!.sourceSlot).toBe('portrait')
    expect(posts[1]!.cover).toBe(true)

    // 重新读取后弹层展示的是新角色，封面勾选也跟着新角色走
    expect(screen.getByAltText('陆川的当前候选图')).toBeTruthy()
    expect(
      (screen.getByRole('checkbox', { name: /设为独立封面/ }) as HTMLInputElement).checked,
    ).toBe(true)
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  it('重新读取失败时说明读不到，不放开确认按钮', async () => {
    const { posts } = setup({ reload: 'error' })
    const { user } = renderApp(
      <ArchiveDialog
        source={source}
        item={character()}
        sourceIsCurrent={() => true}
        onClose={vi.fn()}
      />,
    )

    await user.click(screen.getByRole('button', { name: '确认归档' }))
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('角色或图片已变化')
    })
    expect(posts).toHaveLength(1)

    await user.click(screen.getByRole('button', { name: '重新读取角色' }))
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('无法读取最新角色')
    })
    expect((screen.getByRole('button', { name: '请重新核对' }) as HTMLButtonElement).disabled).toBe(
      true,
    )
  })
})
