import { describe, expect, it } from 'vite-plus/test'
import { filterReferenceCandidates, type ReferenceCandidate } from './referenceCandidates'

const candidate = (over: Partial<ReferenceCandidate> = {}): ReferenceCandidate => ({
  sourceId: 'src1',
  sourceName: '画布中的人物图',
  outputId: 'images',
  outputType: 'image',
  portLabel: '参考图',
  portId: 'images',
  portType: 'image',
  ...over,
})

describe('画布参考候选的搜索', () => {
  it('按来源名与端口标签搜索，不区分大小写', () => {
    const list = [
      candidate(),
      candidate({
        sourceId: 'src2',
        sourceName: '接入素材的视频',
        outputId: 'videos',
        portLabel: '视频参考',
      }),
    ]
    expect(filterReferenceCandidates(list, '人物图')).toHaveLength(1)
    expect(filterReferenceCandidates(list, '人物图')[0]!.sourceName).toBe('画布中的人物图')
    expect(filterReferenceCandidates(list, '视频')).toHaveLength(1)
    expect(filterReferenceCandidates(list, '视频参考')).toHaveLength(1)
    // 搜不到时不能把全部候选都返回
    expect(filterReferenceCandidates(list, '不存在')).toHaveLength(0)
  })
  it('空查询与纯空格都返回全部候选', () => {
    const list = [candidate(), candidate({ sourceId: 'src2' })]
    expect(filterReferenceCandidates(list, '')).toHaveLength(2)
    expect(filterReferenceCandidates(list, '   ')).toHaveLength(2)
  })

  it('不区分大小写', () => {
    const list = [candidate({ sourceName: 'Photo Reference' })]
    expect(filterReferenceCandidates(list, 'photo')).toHaveLength(1)
    expect(filterReferenceCandidates(list, 'PHOTO')).toHaveLength(1)
  })
})
