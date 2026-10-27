// @vitest-environment happy-dom
import { Asset } from '@plein/protocol'
import { useState } from 'react'
import { expect, it } from 'vite-plus/test'
import { mockFetch } from '../../testing/fetch'
import { renderApp, screen, waitFor } from '../../testing/render'
import { useCompositionSourcePicker } from './CompositionSourcePicker'

const source = (n: string) => ({
  version: 1 as const,
  bundleAssetId: 'a'.repeat(64),
  manifestAssetId: n.repeat(64),
  dependencyAssetIds: [],
  rendererIdentity: 'test',
})
const asset = { id: 'a'.repeat(64), name: '合成片段' } as Asset
function Picker() {
  const { resolve, picker } = useCompositionSourcePicker('canvas', true)
  const [result, setResult] = useState(''),
    [error, setError] = useState('')
  return (
    <>
      <button
        type="button"
        onClick={() => {
          setError('')
          void resolve(asset).then(
            (value) => setResult(value?.manifestAssetId ?? '无来源'),
            (failure: Error) => setError(failure.message),
          )
        }}
      >
        放入素材
      </button>
      {picker}
      <output aria-label="选定来源">{result}</output>
      {error && <p role="alert">{error}</p>}
    </>
  )
}
it.each([0, 1, 2])('%i 个源版本不猜测，多来源取消后可重新选择', async (count) => {
  mockFetch((request) =>
    new URL(request.url).pathname.endsWith('/sources')
      ? Response.json({
          sources: ['b', 'c']
            .slice(0, count)
            .map((n) => ({ title: `源${n}`, compositionSource: source(n) })),
        })
      : undefined,
  )
  const { user } = renderApp(<Picker />)
  await user.click(screen.getByRole('button', { name: '放入素材' }))
  if (count === 2) {
    await screen.findByRole('dialog', { name: '选择素材源版本' })
    expect(screen.getByLabelText('选定来源').textContent).toBe('')
    await user.click(screen.getByRole('button', { name: '关闭' }))
    await screen.findByRole('alert')
    expect(screen.getByLabelText('选定来源').textContent).toBe('')
    await user.click(screen.getByRole('button', { name: '放入素材' }))
    await user.click(await screen.findByRole('combobox', { name: '可编辑源版本' }))
    await user.click(screen.getByRole('option', { name: '源c · 版本 2' }))
    await user.click(screen.getByRole('button', { name: '放入此源版本' }))
  }
  await waitFor(() =>
    expect(screen.getByLabelText('选定来源').textContent).toBe(
      count === 0 ? '无来源' : source(count === 1 ? 'b' : 'c').manifestAssetId,
    ),
  )
})
it('读取失败不降级无来源，用户重试后保留精确身份', async () => {
  let fail = true
  mockFetch((request) =>
    new URL(request.url).pathname.endsWith('/sources')
      ? fail
        ? Response.json({ message: '源工程暂时不可读' }, { status: 503 })
        : Response.json({ sources: [{ title: '源b', compositionSource: source('b') }] })
      : undefined,
  )
  const { user } = renderApp(<Picker />)
  await user.click(screen.getByRole('button', { name: '放入素材' }))
  expect((await screen.findByRole('alert')).textContent).toBe('源工程暂时不可读')
  expect(screen.getByLabelText('选定来源').textContent).toBe('')
  fail = false
  await user.click(screen.getByRole('button', { name: '放入素材' }))
  await waitFor(() =>
    expect(screen.getByLabelText('选定来源').textContent).toBe(source('b').manifestAssetId),
  )
})
