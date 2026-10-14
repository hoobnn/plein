import { describe, expect, it } from 'vite-plus/test'
import { capabilityLabel, DEFAULT_SHOT_COUNT, dramaCapabilities, dramaTemplate } from './drama'

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
    // 样例车道：分镜图 → 镜头视频、配音（不接序列）
    expect(keys).toContain('shotImage')
    expect(keys).toContain('shotVideo')
    expect(keys).toContain('shotSpeech')

    const edges = new Set(t.edges.map((e) => `${e.from[0]}.${e.from[1]}→${e.to[0]}.${e.to[1]}`))
    expect(edges).toContain('idea.text→script.prompt')
    expect(edges).toContain('script.text→cast.prompt')
    expect(edges).toContain('script.text→shots.script')
    expect(edges).toContain('cast.text→shots.script')
    expect(edges).toContain('charimg.images→character.references')
    expect(edges).toContain('music.audio→seq.music')
    // 分镜图接到镜头视频，视频用图生视频模式
    expect(edges).toContain('shotImage.images→shotVideo.images')
    expect(t.elements.find((e) => e.key === 'shotVideo')?.params?.mode).toBe('image')
    // 样例不进成片：真实镜头由分镜展开时按顺序接入序列
    expect(edges).not.toContain('shotVideo.video→seq.clips')
    expect(edges).not.toContain('shotSpeech.audio→seq.dialogue')

    // 连线引用的 key 都真实存在
    const set = new Set(keys)
    for (const e of t.edges) {
      expect(set.has(e.from[0]), e.from[0]).toBe(true)
      expect(set.has(e.to[0]), e.to[0]).toBe(true)
    }
  })

  it('卡片都落在所属分组里，同一分组里互不重叠', () => {
    const t = dramaTemplate()
    const map = new Map(t.elements.map((e) => [e.key, e]))
    const abs = (key: string): { x: number; y: number; w: number; h: number } => {
      const e = map.get(key)!
      const p = e.parent ? abs(e.parent) : { x: 0, y: 0 }
      return { x: p.x + e.x, y: p.y + e.y, w: e.w, h: e.h }
    }
    const inside = (a: ReturnType<typeof abs>, b: ReturnType<typeof abs>) =>
      a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h
    const overlap = (a: ReturnType<typeof abs>, b: ReturnType<typeof abs>) =>
      a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
    // 卡片必须挂在分组下：只是叠在分组上面的话，整组运行数不到它
    const container = (key: string) => map.get(key)!.parent
    const cards = t.elements.filter((e) => e.shape === 'element')
    for (const c of cards) {
      const box = container(c.key)
      expect(box, `${c.key} 应落在某个分组里`).toBeDefined()
      expect(inside(abs(c.key), abs(box!)), `${c.key} 超出 ${box}`).toBe(true)
    }
    for (const a of cards)
      for (const b of cards) {
        if (a.key >= b.key || container(a.key) !== container(b.key)) continue
        expect(overlap(abs(a.key), abs(b.key)), `${a.key} 与 ${b.key} 重叠`).toBe(false)
      }
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

  it('剧本、角色抽取、分镜带可改的默认提示词', () => {
    for (const key of ['script', 'cast', 'shots']) {
      expect(String(byKey([key])[0]!.params?.prompt ?? '').trim(), key).not.toBe('')
    }
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
    expect(capabilityLabel('text.chat')).toBe('文本')
  })

  it('道具 / 风格卡是可选的：没有也不影响骨架', () => {
    const t = dramaTemplate()
    const optional = t.elements.filter((e) => e.optional)
    expect(optional.map((e) => e.key)).toEqual(['prop', 'style'])
    // 连线不依赖它们
    expect(t.edges.some((e) => e.from[0] === 'prop' || e.to[0] === 'style')).toBe(false)
  })
})
