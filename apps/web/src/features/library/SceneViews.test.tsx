// @vitest-environment happy-dom
import type { SceneView } from '@plein/nodes'
import { useState } from 'react'
import { expect, it } from 'vite-plus/test'
import { renderApp, screen } from '../../testing/render'
import { SceneViews } from './SceneViews'

it('视角改名保留旧引用与独立参考图，重复名称不提交', async () => {
  let saved: SceneView[] = [
    {
      id: 'door',
      name: '门口',
      aliases: [],
      description: '从门口望向黑板',
      images: ['a'.repeat(64)],
    },
    { id: 'window', name: '窗边', aliases: [], description: '', images: [] },
  ]
  function Editor() {
    const [views, setViews] = useState(saved)
    return (
      <SceneViews
        value={views}
        onChange={(next) => {
          saved = next
          setViews(next)
        }}
        media={[]}
        disabled={false}
        onBusyChange={() => {}}
      />
    )
  }
  const { user } = renderApp(<Editor />)
  await user.click(screen.getByRole('button', { name: '门口 · 1 图' }))
  const name = screen.getByRole('textbox', { name: '视角名称' })
  await user.clear(name)
  await user.type(name, '门口正拍')
  await user.tab()
  expect(saved[0]).toMatchObject({ name: '门口正拍', aliases: ['门口'], images: ['a'.repeat(64)] })
  await user.clear(name)
  await user.type(name, '窗边')
  await user.tab()
  expect(screen.getByRole('alert').textContent).toBeTruthy()
  expect(saved[0]!.name).toBe('门口正拍')
  await user.click(screen.getByRole('button', { name: '添加视角' }))
  expect(saved).toHaveLength(3)
  await user.click(screen.getByRole('button', { name: '删除视角' }))
  expect(saved).toHaveLength(2)
  expect(saved[0]!.images).toEqual(['a'.repeat(64)])
})
