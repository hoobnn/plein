import { CharacterProfile } from '@plein/nodes'
import { describe, expect, it } from 'vite-plus/test'
import { moveProfileOutfit } from './profileMoves'

function fixture(count = 0) {
  return CharacterProfile.parse({
    periods: [
      {
        id: 'a',
        name: '少年',
        outfits: [
          {
            id: 'uniform',
            name: '校服',
            aliases: ['旧校服'],
            description: '蓝白校服',
            images: ['a'.repeat(64)],
          },
        ],
      },
      {
        id: 'b',
        name: '青年',
        outfits: Array.from({ length: count }, (_, i) => ({ id: `b-${i}`, name: `服饰${i}` })),
      },
      { id: 'c', name: '成年' },
    ],
  })
}
describe('角色服饰跨时期移动', () => {
  it('移动保留服饰完整内容与引用编号，不修改原档案或其他时期', () => {
    const profile = fixture()
    const outfit = profile.periods[0]!.outfits[0]!
    const result = moveProfileOutfit(profile, 'a', 'uniform', 'b')!
    expect(result.periods[0]!.outfits).toEqual([])
    expect(result.periods[1]!.outfits).toEqual([outfit])
    expect(result.periods[1]!.outfits[0]).toBe(outfit)
    expect(result.periods[2]).toBe(profile.periods[2])
    expect(profile.periods[0]!.outfits).toEqual([outfit])
    expect(profile.periods[1]!.outfits).toEqual([])
    expect(moveProfileOutfit(result, 'b', 'uniform', 'a')).toEqual(profile)
  })
  it('满时期拒绝移动，剩余一格时允许移动且整个档案可验证', () => {
    expect(moveProfileOutfit(fixture(12), 'a', 'uniform', 'b')).toBeNull()
    const result = moveProfileOutfit(fixture(11), 'a', 'uniform', 'b')!
    expect(result.periods[1]!.outfits).toHaveLength(12)
    expect(CharacterProfile.safeParse(result).success).toBe(true)
  })
  it.each([
    ['missing', 'uniform', 'b'],
    ['a', 'uniform', 'missing'],
    ['a', 'missing', 'b'],
    ['a', 'uniform', 'a'],
  ])('失效来源或目标不取出服饰：%s/%s/%s', (from, outfit, to) => {
    const profile = fixture()
    const before = structuredClone(profile)
    expect(moveProfileOutfit(profile, from, outfit, to)).toBeNull()
    expect(profile).toEqual(before)
  })
})
