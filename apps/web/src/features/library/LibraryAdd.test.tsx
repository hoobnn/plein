// @vitest-environment happy-dom
import { describe, expect, it } from 'vite-plus/test'
import { renderApp, screen, waitFor } from '../../testing/render'
import { LibraryAdd } from './LibraryAdd'
import type { CanvasMedia } from './canvas'

const media = (kind: 'image' | 'video', index: number): CanvasMedia => ({
  elId: `el_${index}`,
  assetId: String(index).padStart(64, '0'),
  kind,
  name: `素材${index}`,
})

describe('画布上的「存入资产库」菜单', () => {
  it('选中的素材超出类别容量时说明原因并禁用该类别', async () => {
    const { user } = renderApp(
      <LibraryAdd media={[media('video', 1), media('video', 2)]} variant="bar" />,
    )
    await user.click(screen.getByRole('button', { name: '存入资产库' }))
    const prop = await screen.findByRole('button', { name: /^道具/ })
    expect((prop as HTMLButtonElement).disabled).toBe(true)
    expect(prop.textContent).toContain('道具只收图片，请先取消选择视频')
    const effect = screen.getByRole('button', { name: /^特效/ })
    expect((effect as HTMLButtonElement).disabled).toBe(true)
    expect(effect.textContent).toContain('每条特效只能保存 1 个参考视频，请先只选 1 个视频')
    // 只收图片的类别同样被挡住，并说清要取消视频
    const character = screen.getByRole('button', { name: /^角色/ })
    expect((character as HTMLButtonElement).disabled).toBe(true)
    expect(character.textContent).toContain('角色只收图片，请先取消选择视频')
  })

  it('同一类别的图片超出槽位容量时按槽位说明原因', async () => {
    const { user } = renderApp(
      <LibraryAdd media={[media('image', 1), media('image', 2)]} variant="bar" />,
    )
    await user.click(screen.getByRole('button', { name: '存入资产库' }))
    const effect = await screen.findByRole('button', { name: /^特效/ })
    expect((effect as HTMLButtonElement).disabled).toBe(true)
    expect(effect.textContent).toContain('每条特效只能保存 1 张封面，请先只选 1 张图片')
    // 道具有多角度槽位，两张图片都能放下
    expect((screen.getByRole('button', { name: /^道具/ }) as HTMLButtonElement).disabled).toBe(
      false,
    )
  })

  it('没有选中素材时不显示入口', async () => {
    renderApp(<LibraryAdd media={[]} variant="bar" />)
    await waitFor(() => expect(screen.queryByRole('button', { name: '存入资产库' })).toBeNull())
  })
})
