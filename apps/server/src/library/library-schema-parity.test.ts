import { describe, expect, it } from 'vite-plus/test'
import {
  CharacterProfile,
  PROFILE_LIMITS,
  ProfileLook,
  SceneView,
  type LibraryKindId,
} from '@plein/nodes'
import { LibraryKind, LibraryProfile, LibrarySceneView } from '@plein/protocol'

/**
 * @plein/protocol 与 @plein/nodes 各写了一份同构的资产库 schema：
 * protocol 是接口契约（服务端校验请求），nodes 是节点侧的领域模型。
 * 两边不互相依赖是有意为之，但字段上限一旦各自改就会悄悄跑偏，
 * 所以这里把它们钉在一起：任何一边改了上限而另一边没改，用例就会红。
 */

const assetId = 'a'.repeat(64)

const look = (id = 'l1') => ({
  id,
  name: '常服',
  aliases: [],
  description: '',
  images: [assetId],
})

const voice = { provider: 'p', voiceId: 'v' }

const period = (overrides: Record<string, unknown> = {}) => ({
  ...look(),
  voice,
  voiceStates: [{ id: 's1', name: '常态', aliases: [], voice }],
  outfits: [look('o1')],
  ...overrides,
})

describe('资产库 schema 在 protocol 与 nodes 之间保持一致', () => {
  it('分类取值两边相同', () => {
    const fromNodes: LibraryKindId[] = ['character', 'scene', 'prop', 'style', 'effect']
    expect(LibraryKind.options).toEqual(fromNodes)
  })

  it.each([
    ['periods', PROFILE_LIMITS.periods],
    ['outfits', PROFILE_LIMITS.outfits],
    ['voiceStates', PROFILE_LIMITS.voiceStates],
    ['expressions', PROFILE_LIMITS.expressions],
    ['images', PROFILE_LIMITS.images],
  ] as const)('%s 上限两边一致（%i）', (field, limit) => {
    const build = (count: number) => {
      if (field === 'periods')
        return {
          periods: Array.from({ length: count }, (_, i) => period({ id: `p${i}` })),
          expressions: [],
        }
      if (field === 'expressions')
        return { periods: [], expressions: Array.from({ length: count }, (_, i) => look(`e${i}`)) }
      const base = period()
      if (field === 'outfits') base.outfits = Array.from({ length: count }, (_, i) => look(`o${i}`))
      if (field === 'voiceStates')
        base.voiceStates = Array.from({ length: count }, (_, i) => ({
          id: `s${i}`,
          name: '常态',
          aliases: [],
          voice,
        }))
      if (field === 'images') base.images = Array.from({ length: count }, () => assetId)
      return { periods: [base], expressions: [] }
    }

    // 到上限两边都收；超一个两边都拒
    expect(CharacterProfile.safeParse(build(limit)).success).toBe(true)
    expect(LibraryProfile.safeParse(build(limit)).success).toBe(true)
    expect(CharacterProfile.safeParse(build(limit + 1)).success).toBe(false)
    expect(LibraryProfile.safeParse(build(limit + 1)).success).toBe(false)
  })

  it('造型条目的字段约束两边一致', () => {
    const tooLongName = { ...look(), name: 'x'.repeat(21) }
    expect(ProfileLook.safeParse(tooLongName).success).toBe(false)
    expect(LibraryProfile.safeParse({ periods: [], expressions: [tooLongName] }).success).toBe(
      false,
    )

    const badAlias = { ...look(), aliases: ['x'.repeat(21)] }
    expect(ProfileLook.safeParse(badAlias).success).toBe(false)
    expect(LibraryProfile.safeParse({ periods: [], expressions: [badAlias] }).success).toBe(false)
  })

  it('场景视角的字段约束两边一致', () => {
    const bad = { id: 'v1', name: '带 空格', aliases: [], description: '', images: [] }
    expect(SceneView.safeParse(bad).success).toBe(false)
    expect(LibrarySceneView.safeParse(bad).success).toBe(false)
  })
})
