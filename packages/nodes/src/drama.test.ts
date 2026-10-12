import { describe, expect, it } from 'vitest'
import {
  capabilityLabel,
  DEFAULT_SHOT_COUNT,
  dramaCapabilities,
  dramaTemplate,
  type DramaProviderLike,
  missingCapabilities,
  pickCapabilityModel,
} from './drama'

const providers: DramaProviderLike[] = [
  {
    id: 'ark',
    enabled: true,
    models: [
      { id: 'seed', capabilities: ['text.chat'] },
      { id: 'seedream', capabilities: ['image.generate'] },
      { id: 'seedance', capabilities: ['video.generate'] },
    ],
  },
  {
    id: 'doubao-speech',
    enabled: false,
    models: [{ id: 'seed-tts', capabilities: ['audio.speech', 'audio.music'] }],
  },
]

const byKey = (keys: string[]) => {
  const t = dramaTemplate()
  const map = new Map(t.elements.map((e) => [e.key, e]))
  return keys.map((k) => map.get(k)!)
}

describe('短剧模板骨架', () => {
  it('创意 → 剧本 → 角色场景 / 分镜 → 镜头 → 序列，连线都在', () => {
    const t = dramaTemplate()
    const keys = t.elements.map((e) => e.key)
    // key 重复会让按 key 连线连错节点
    expect(new Set(keys).size).toBe(keys.length)
    expect(keys).toContain('idea')
    expect(keys).toContain('script')
    expect(keys).toContain('cast')
    expect(keys).toContain('character')
    expect(keys).toContain('scene')
    expect(keys).toContain('shots')
    expect(keys).toContain('seq')
    // 样例车道：分镜图 → 镜头视频 → 配音 → 序列
    expect(keys).toContain('shotImage')
    expect(keys).toContain('shotVideo')
    expect(keys).toContain('shotSpeech')

    const edges = new Set(t.edges.map((e) => `${e.from[0]}.${e.from[1]}→${e.to[0]}.${e.to[1]}`))
    expect(edges).toContain('idea.text→script.prompt')
    expect(edges).toContain('script.text→cast.prompt')
    expect(edges).toContain('script.text→shots.script')
    expect(edges).toContain('character.images→charimg.references')
    expect(edges).toContain('charimg.images→shotImage.references')
    expect(edges).toContain('shotVideo.video→seq.clips')
    expect(edges).toContain('shotSpeech.audio→seq.dialogue')
    expect(edges).toContain('music.audio→seq.music')

    // 连线引用的 key 都真实存在
    const set = new Set(keys)
    for (const e of t.edges) {
      expect(set.has(e.from[0]), e.from[0]).toBe(true)
      expect(set.has(e.to[0]), e.to[0]).toBe(true)
    }
  })

  it('分镜图的图片接到视频的首帧：图生视频的结构由模板保证', () => {
    const t = dramaTemplate()
    expect(
      t.edges.some(
        (e) =>
          e.from[0] === 'shotImage' &&
          e.from[1] === 'images' &&
          e.to[0] === 'shotVideo' &&
          e.to[1] === 'firstFrame',
      ),
    ).toBe(true)
  })

  it('默认 8 个镜头，可以指定 6–10 之间的镜头数', () => {
    expect(byKey(['shots'])[0]!.params?.shotCount).toBe(DEFAULT_SHOT_COUNT)
    expect(
      dramaTemplate({ shotCount: 6 }).elements.find((e) => e.key === 'shots')?.params?.shotCount,
    ).toBe(6)
    // 越界时夹回范围，不接受一个跑不通的镜头数
    expect(
      dramaTemplate({ shotCount: 2 }).elements.find((e) => e.key === 'shots')?.params?.shotCount,
    ).toBe(6)
    expect(
      dramaTemplate({ shotCount: 30 }).elements.find((e) => e.key === 'shots')?.params?.shotCount,
    ).toBe(10)
    expect(String(byKey(['shots'])[0]!.params?.prompt)).toContain('8 个镜头')
  })

  it('剧本、角色抽取、分镜的中文提示词是可改的默认值，不是空串', () => {
    for (const key of ['script', 'cast', 'shots']) {
      const params = byKey([key])[0]!.params ?? {}
      const text = Object.values(params).join('\n')
      expect(text.trim().length).toBeGreaterThan(20)
      // 中文默认：既有英文占位也有中文句子
      expect(/[一-龥]{4,}/.test(text), key).toBe(true)
    }
    expect(byKey(['script'])[0]!.params?.system).toContain('编剧')
    expect(byKey(['cast'])[0]!.params?.prompt).toContain('角色和场景设定')
  })

  it('模型 id 不写死：模板只声明能力，具体模型由 catalog 决定', () => {
    const t = dramaTemplate()
    // 模板数据里没有任何模型字段
    for (const el of t.elements) expect(el.params?.model).toBeUndefined()
    expect(dramaCapabilities(t).sort()).toEqual([
      'audio.music',
      'audio.speech',
      'image.generate',
      'text.chat',
      'video.generate',
    ])

    expect(pickCapabilityModel(providers, 'text.chat')).toBe('ark:seed')
    expect(pickCapabilityModel(providers, 'video.generate')).toBe('ark:seedance')
    // 没启用的平台不算
    expect(pickCapabilityModel(providers, 'audio.speech')).toBe('')
    expect(pickCapabilityModel(null, 'text.chat')).toBe('')
    expect(missingCapabilities(t, providers)).toEqual(['配音', '配乐'])
    expect(missingCapabilities(t, [])).toEqual(['文本', '图像', '视频', '配音', '配乐'])
    expect(capabilityLabel('text.chat')).toBe('文本')
  })

  it('道具 / 风格卡是可选的：没有也不影响骨架', () => {
    const t = dramaTemplate()
    const optional = t.elements.filter((e) => e.optional)
    expect(optional.map((e) => e.key)).toEqual(['prop', 'style'])
    // 连线不依赖它们
    expect(t.edges.some((e) => e.from[0] === 'prop' || e.to[0] === 'style')).toBe(false)
  })

  it('布局是纯数据：同一份输入给出同一份模板', () => {
    expect(dramaTemplate()).toEqual(dramaTemplate())
  })
})
