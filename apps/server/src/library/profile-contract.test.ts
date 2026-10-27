import type { LibraryItem } from '@plein/protocol'
import { describe, expect, it } from 'vite-plus/test'
import { bootServer, request } from '../testing'

/** 建一个角色档案条目，返回条目的 id 与读回的档案。 */
async function createCharacter(
  server: Awaited<ReturnType<typeof bootServer>>['server'],
  profile: unknown,
  name = '档案合同',
) {
  const created = await request(server, '/api/library', {
    method: 'POST',
    body: JSON.stringify({ kind: 'character', name, profile }),
  })
  return { created, item: created.status === 201 ? ((await created.json()) as LibraryItem) : null }
}

describe('角色档案保存合同', () => {
  it('保存后重新读取，时期、服饰、表情与旧名原样还在', async () => {
    const { server } = await bootServer()
    const { created, item } = await createCharacter(server, {
      periods: [
        {
          id: 'teen',
          name: '少年',
          aliases: ['初中'],
          description: '保留少年设定',
          outfits: [
            { id: 'uniform', name: '校服', aliases: ['制服'], description: '保留校服材质' },
          ],
        },
      ],
      expressions: [{ id: 'happy', name: '开心', description: '保留眉眼动作' }],
    })
    expect(created.status).toBe(201)

    const read = await request(server, `/api/library/${item!.id}`)
    expect(read.status).toBe(200)
    expect(((await read.json()) as LibraryItem).profile).toMatchObject({
      periods: [
        {
          id: 'teen',
          name: '少年',
          aliases: ['初中'],
          description: '保留少年设定',
          outfits: [
            { id: 'uniform', name: '校服', aliases: ['制服'], description: '保留校服材质' },
          ],
        },
      ],
      expressions: [{ id: 'happy', name: '开心', description: '保留眉眼动作' }],
    })
  })

  it('改名后的旧名照旧存着，重新打开档案还在', async () => {
    const { server } = await bootServer()
    const { item } = await createCharacter(server, {
      periods: [{ id: 'teen', name: '少年', aliases: ['初中'] }],
    })
    const patched = await request(server, `/api/library/${item!.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        profile: { periods: [{ id: 'teen', name: '成年', aliases: ['初中', '少年'] }] },
      }),
    })
    expect(patched.status).toBe(200)

    const read = await request(server, `/api/library/${item!.id}`)
    expect(((await read.json()) as LibraryItem).profile!.periods[0]).toMatchObject({
      name: '成年',
      aliases: ['初中', '少年'],
    })
  })

  it('名字不合法时整份档案不落库，已有档案保持原样', async () => {
    const { server } = await bootServer()
    const { item } = await createCharacter(server, {
      periods: [{ id: 'teen', name: '少年', description: '保留少年设定' }],
    })

    const patched = await request(server, `/api/library/${item!.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        profile: { periods: [{ id: 'teen', name: '', description: '别的改动' }] },
      }),
    })
    expect(patched.status).toBe(400)

    const read = await request(server, `/api/library/${item!.id}`)
    expect(((await read.json()) as LibraryItem).profile!.periods[0]).toMatchObject({
      name: '少年',
      description: '保留少年设定',
    })
  })

  it('数量超过上限时拒绝保存，原有档案不受影响', async () => {
    const { server } = await bootServer()
    const { item } = await createCharacter(server, {
      periods: [{ id: 'teen', name: '少年' }],
    })
    const tooManyPeriods = Array.from({ length: 9 }, (_, i) => ({ id: `p${i}`, name: `阶段${i}` }))
    const tooManyOutfits = Array.from({ length: 13 }, (_, i) => ({ id: `o${i}`, name: `服饰${i}` }))
    const tooManyExpressions = Array.from({ length: 25 }, (_, i) => ({
      id: `e${i}`,
      name: `表情${i}`,
    }))
    const tooManyAliases = Array.from({ length: 9 }, (_, i) => `旧名${i}`)

    for (const profile of [
      { periods: tooManyPeriods },
      { periods: [{ id: 'teen', name: '少年', outfits: tooManyOutfits }] },
      { periods: [], expressions: tooManyExpressions },
      { periods: [{ id: 'teen', name: '少年', aliases: tooManyAliases }] },
    ]) {
      const patched = await request(server, `/api/library/${item!.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ profile }),
      })
      expect(patched.status).toBe(400)
    }

    const read = await request(server, `/api/library/${item!.id}`)
    expect(((await read.json()) as LibraryItem).profile!.periods).toHaveLength(1)
  })

  it('新建时档案不合法直接拒绝，不会留下空条目', async () => {
    const { server } = await bootServer()
    const { created } = await createCharacter(server, {
      periods: Array.from({ length: 9 }, (_, i) => ({ id: `p${i}`, name: `阶段${i}` })),
    })
    expect(created.status).toBe(400)

    const list = await request(server, '/api/library')
    expect((await list.json()) as LibraryItem[]).toEqual([])
  })
})
