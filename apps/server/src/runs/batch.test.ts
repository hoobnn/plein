import { connect, currentResult } from '@plein/doc'
import { describe, expect, it } from 'vite-plus/test'
import { addCharacter, addNode, bootServer, createCanvas, mockSettings, until } from '../testing'

describe('批量出分镜图', () => {
  it('镜头 @ 到的角色卡还没出定妆图时先出，出完再出镜头图；已有的沿用', async () => {
    const { server } = await bootServer()
    mockSettings(server, {})
    const { id, doc } = await createCanvas(server)
    const hero = addCharacter(doc, '林夏', { description: '二十岁，短发' }, { x: 300 })
    const portrait = addNode(doc, 'plein/image', { params: { prompt: '林夏的定妆参考图' } })
    connect(doc, [portrait, 'images'], [hero, 'references'])
    const shots = [1, 2].map((i) =>
      addNode(doc, 'plein/image', { params: { prompt: `@林夏 镜头 ${i}` }, x: 600 * i }),
    )

    const done = async (groupId: string) => {
      await until(() => server.runs.groupState(groupId, 'local')?.status !== 'running', 20_000)
      return server.runs.groupState(groupId, 'local')!
    }
    const first = server.runs.runBatch(id, shots[0]!, shots, 'local')
    expect(first.total).toBe(3)
    expect((await done(first.groupId)).summary).toMatchObject({ succeeded: 3, failed: 0 })

    const jobs = server.runs.list(id).jobs
    const of = (node: string) => jobs.find((j) => j.nodeId === node)!
    for (const s of shots) expect(of(s).startedAt!).toBeGreaterThanOrEqual(of(portrait).finishedAt!)
    expect(currentResult(doc.get(portrait)!)?.value.type).toBe('image')

    // 再批量一次：定妆图没改，沿用；镜头图照常重跑
    const again = server.runs.runBatch(id, shots[0]!, shots, 'local')
    expect((await done(again.groupId)).summary).toMatchObject({ succeeded: 2, cached: 1 })
  }, 30_000)
})
