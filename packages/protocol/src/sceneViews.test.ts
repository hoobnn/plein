import { describe, it, expect } from 'vite-plus/test'
import { LibrarySceneViews } from './library'
const view = { id: 'door', name: '门口', aliases: [], description: '', images: ['a'.repeat(64)] }
describe('场景视角协议', () => {
  it('协议拒绝重复标识、重名或旧名冲突及不可引用字符', () => {
    expect(LibrarySceneViews.safeParse([view, { ...view, name: '窗边' }]).success).toBe(false)
    expect(
      LibrarySceneViews.safeParse([
        view,
        { ...view, id: 'window', name: '窗边', aliases: ['门口'] },
      ]).success,
    ).toBe(false)
    expect(LibrarySceneViews.safeParse([{ ...view, aliases: ['无法/引用'] }]).success).toBe(false)
    expect(LibrarySceneViews.safeParse([{ ...view, name: '无法 引用' }]).success).toBe(false)
  })
})
