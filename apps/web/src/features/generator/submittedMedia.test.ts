import type { PreparedInput } from '@plein/protocol'
import { expect, it } from 'vite-plus/test'
import { submittedMedia } from './submittedMedia'

it('参考编号沿用最终输入顺序，按三类独立编号并保留接续来源', () => {
  const inputs: PreparedInput['inputs'] = {
    images: [
      { type: 'image', assetId: 'tail', source: 'parent' },
      { type: 'image', assetId: 'picked' },
    ],
    prompt: [{ type: 'text', text: '描述' }],
    videos: [{ type: 'video', assetId: 'video' }],
    audios: [{ type: 'audio', assetId: 'audio' }],
  }
  const rows = submittedMedia({ inputs } as unknown as PreparedInput)
  expect(rows.map((v) => [v.assetId, v.token, v.port])).toEqual([
    ['tail', 'image1', 'images'],
    ['picked', 'image2', 'images'],
    ['video', 'video1', 'videos'],
    ['audio', 'audio1', 'audios'],
  ])
  expect(rows[0]?.source).toBe('parent')
  expect(
    submittedMedia({
      inputs: { images: inputs.images!.slice().reverse() },
    } as unknown as PreparedInput).map((v) => [v.assetId, v.token]),
  ).toEqual([
    ['picked', 'image1'],
    ['tail', 'image2'],
  ])
})
