import { access, readFile } from 'node:fs/promises'
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import { runCli } from './cli'
import { jimengNovel, novelSpaces, novelProjects, resolveNovelTarget } from './jimeng-novel'

vi.mock('./cli', () => ({ runCli: vi.fn() }))
const cli = vi.mocked(runCli)
const target = '12998802275596'
const reply = (data: unknown) => JSON.stringify({ status: 'success', data, error: null })
const fields = { title: '第一集', text: '他走进门。' }
const item = { id: '1001', kind: 'text', fields, editable: true }

beforeEach(() => cli.mockReset())

describe('即梦短剧画布', () => {
  it('按页读取正文、场景描述和分镜提示词，保留超长 ID 的精度', async () => {
    cli
      .mockResolvedValueOnce(
        reply({
          items: [
            { nodeId: '1001', type: 'text', config: { name: '第一集', text: fields.text } },
            {
              nodeId: '1002',
              type: 'scene',
              config: { name: '主场景', viewName: '前门', description: '窄巷' },
            },
          ],
          nextCursor: 'p2',
        }),
      )
      .mockResolvedValueOnce(
        reply({
          items: [
            {
              nodeId: '9007199254740993000',
              type: 'video',
              key: 'E01/S01',
              status: 'running',
              config: {
                generation: { prompt: '推镜', duration: 7, references: [{ name: '阿杰' }] },
              },
            },
          ],
          nextCursor: null,
        }),
      )
    expect(await jimengNovel.list(target)).toEqual([
      item,
      { id: '1002', kind: 'scene', fields: { title: '前门', text: '窄巷' }, editable: true },
      {
        id: '9007199254740993000',
        kind: 'video',
        fields: { title: 'E01/S01', text: '推镜' },
        editable: false,
        references: [{ label: '阿杰', usage: 'reference' }],
        referenceRevision: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    ])
    expect(cli.mock.calls[1]?.[1]).toContain('--cursor')
    expect(
      cli.mock.calls.every(
        ([bin, args]) =>
          bin === 'jimeng-novel' &&
          args.includes('--config') &&
          args.includes('--full') &&
          args.includes(target),
      ),
    ).toBe(true)
  })

  it('单读节点保持生成状态、字段与引用，拒绝错发的节点回执', async () => {
    const result = reply({
      nodeId: '111',
      key: 'E01/S01',
      config: {
        type: 'video',
        name: '镜头',
        generation: {
          prompt: '推镜',
          references: [{ usage: 'firstFrame', name: '主角', ref: 'node:cast/甲' }],
        },
      },
      state: { status: 'running' },
    })
    cli.mockResolvedValue(result)
    expect(await jimengNovel.read!(target, '111')).toEqual({
      id: '111',
      kind: 'video',
      fields: { title: '镜头', text: '推镜' },
      references: [{ label: '主角', usage: 'firstFrame' }],
      referenceRevision: expect.stringMatching(/^[a-f0-9]{64}$/),
      editable: false,
    })
    await expect(jimengNovel.read!(target, '222')).rejects.toThrow('ID')
  })

  it('解析生成参考的顺序和帧用途，只暴露唯一节点 ID，并省略签名链接', async () => {
    cli.mockResolvedValueOnce(
      reply({
        items: [
          { nodeId: '1001', key: 'cast/甲', type: 'role', config: {} },
          {
            nodeId: '1002',
            type: 'video',
            config: {
              generation: {
                references: [
                  { name: '开场', usage: 'firstFrame', ref: 'node:cast/甲' },
                  {
                    name: 'https://private.invalid/sample?signature=token',
                    usage: 'lastFrame',
                    ref: 'https://private.invalid/asset?signature=token',
                  },
                  { name: '外部素材', ref: 'resource:123', extra: { signed: 'token' } },
                ],
              },
            },
          },
        ],
      }),
    )
    const second = (await jimengNovel.list(target))[1]!
    expect(second).toMatchObject({
      references: [
        { label: '开场', usage: 'firstFrame', sourceId: '1001' },
        { label: '参考 2', usage: 'lastFrame' },
        { label: '外部素材', usage: 'reference' },
      ],
    })
    expect(JSON.stringify(second)).not.toContain('token')
  })

  it('单读与列表共享参考版本，忽略签名轮换但区分换源', async () => {
    const config = (signature: string, id: string) => ({
      type: 'image',
      name: '参考',
      generation: {
        references: [
          { ref: 'node:cast/甲', name: '人物' },
          {
            ref: 'https://example.invalid/ref?id=' + id + '&X-Tos-Signature=' + signature,
            usage: 'lastFrame',
          },
        ],
      },
    })
    cli
      .mockResolvedValueOnce(
        reply({
          items: [
            { nodeId: '111', key: 'cast/甲', type: 'role', config: {} },
            { nodeId: '222', type: 'image', config: config('first', 'original') },
          ],
        }),
      )
      .mockResolvedValueOnce(reply({ nodeId: '222', config: config('renewed', 'original') }))
      .mockResolvedValueOnce(reply({ nodeId: '222', config: config('first', 'changed') }))
    const revision = (await jimengNovel.list(target))[1]!.referenceRevision
    expect(revision).toMatch(/^[a-f0-9]{64}$/)
    expect((await jimengNovel.read!(target, '222')).referenceRevision).toBe(revision)
    expect((await jimengNovel.read!(target, '222')).referenceRevision).not.toBe(revision)
  })

  it('只修改有差异的字段，保留生成参数和素材引用，同时清理临时文件', async () => {
    let path = ''
    cli.mockResolvedValueOnce(
      reply({
        nodeId: '1001',
        config: { type: 'video', name: fields.title, generation: { prompt: fields.text } },
      }),
    )
    cli.mockImplementationOnce(async (_bin, args) => {
      expect(args.slice(0, 4)).toEqual(['node', 'update', '--node-id', '1001'])
      path = args[args.indexOf('--prompt-file') + 1]!
      expect(await readFile(path, 'utf8')).toBe('新镜头')
      expect(args).not.toContain('--input-file')
      expect(args).not.toContain('--ref')
      return reply({
        nodeId: '1001',
        config: { type: 'video', name: fields.title, generation: { prompt: '新镜头' } },
      })
    })
    await jimengNovel.update(target, { ...item, kind: 'video' }, { ...fields, text: '新镜头' })
    await expect(access(path)).rejects.toThrow()
  })

  it('创建文本卡使用操作键并要求 CLI 回报同一键', async () => {
    cli.mockResolvedValueOnce(reply({ items: [] }))
    cli.mockImplementationOnce(async (_bin, args) => {
      expect(args).toEqual(
        expect.arrayContaining(['create', '--type', 'text', '--key', 'plein/op-123']),
      )
      const path = args[args.indexOf('--input-file') + 1]!
      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
        name: fields.title,
        text: fields.text,
      })
      return reply({
        key: 'plein/op-123',
        nodeId: '999',
        config: { type: 'text', name: fields.title, text: fields.text },
      })
    })
    expect(await jimengNovel.create!(target, fields, 'op-123')).toBe('999')
  })

  it.each(['role', 'scene', 'image', 'video'])('新建 %s 草稿沿用对应即梦卡片类型', async (kind) => {
    cli.mockResolvedValueOnce(reply({ items: [] }))
    cli.mockImplementationOnce(async (_bin, args) => {
      expect(args.slice(0, 4)).toEqual(['node', 'create', '--type', kind])
      const input = JSON.parse(await readFile(args[args.indexOf('--input-file') + 1]!, 'utf8'))
      const config = { ...input, type: kind }
      if (kind === 'role' || kind === 'scene') {
        expect(input.description).toBe(fields.text)
        if (kind === 'scene') expect(input.viewName).toBe(fields.title)
      } else {
        const prompt = await readFile(args[args.indexOf('--prompt-file') + 1]!, 'utf8')
        expect(prompt).toBe(fields.text)
        config.generation = { prompt }
      }
      expect(input.name).toBe(fields.title)
      return reply({ nodeId: '999', key: 'plein/card', config })
    })
    expect(await jimengNovel.create!(target, fields, 'card', kind)).toBe('999')
  })

  it('从正式 space list 返回个人和团队，在显式空间查询项目，保留 ID 精度', async () => {
    cli
      .mockResolvedValueOnce(
        reply({
          spaces: [
            { team_id: 0, name: '个人', current: true },
            { team_id: '90071992547409931', name: '制作组', current: false },
          ],
        }),
      )
      .mockResolvedValueOnce(
        JSON.stringify({
          status: 'success',
          context: { teamId: '90071992547409931' },
          data: { items: [{ projectId: target, name: '短剧' }] },
        }),
      )
    expect(await novelSpaces()).toEqual([
      { id: '0', title: '个人', current: true },
      { id: '90071992547409931', title: '制作组', current: false },
    ])
    expect(await novelProjects('90071992547409931')).toEqual([
      { id: '90071992547409931/' + target, title: '短剧' },
    ])
    await expect(novelProjects('--team-id')).rejects.toThrow()
    expect(cli.mock.calls.map(([, a]) => a)).toEqual([
      ['space', 'list', '--full', '-j'],
      ['canvas', 'list', '--limit', '100', '--team-id', '90071992547409931', '--full', '-j'],
    ])
  })

  it('裸 ID 只信任回执明确确认的项目与空间，显式空间无需重复探测', async () => {
    const data = { items: [] }
    cli
      .mockResolvedValueOnce(
        JSON.stringify({ status: 'success', context: { teamId: 0, projectId: target }, data }),
      )
      .mockResolvedValueOnce(reply(data))
      .mockResolvedValueOnce(
        JSON.stringify({ status: 'success', context: { teamId: '8', projectId: '999' }, data }),
      )
    expect(await resolveNovelTarget(target)).toBe('0/' + target)
    expect(await resolveNovelTarget(target)).toBe(target)
    await expect(resolveNovelTarget(target)).rejects.toThrow('其他项目')
    expect(await resolveNovelTarget('987/' + target)).toBe('987/' + target)
    expect(cli).toHaveBeenCalledTimes(3)
    expect(
      cli.mock.calls.every(([, a]) => a[0] === 'node' && a[1] === 'list' && a.includes('1')),
    ).toBe(true)
  })

  it('显式团队读写复用同一项目定位，缺空间或错项目的成功回执亦拒绝使用', async () => {
    const scoped = '987/' + target
    const env = (data: unknown, context: unknown = { projectId: target, teamId: '987' }) =>
      JSON.stringify({ status: 'success', data, context })
    const c = { nodeId: '1001', config: { type: 'text', name: fields.title, text: fields.text } }
    cli
      .mockResolvedValueOnce(env({ items: [] }))
      .mockResolvedValueOnce(env({ ...c, key: 'plein/op' }))
      .mockResolvedValueOnce(env(c))
      .mockResolvedValueOnce(env({ ...c, config: { ...c.config, text: '推镜' } }))
      .mockResolvedValueOnce(env({ items: [] }, { teamId: '987' }))
      .mockResolvedValueOnce(env(c, { projectId: target, teamId: '988' }))
    expect(await jimengNovel.create!(scoped, fields, 'op')).toBe('1001')
    await jimengNovel.update(scoped, item, { ...fields, text: '推镜' })
    await expect(jimengNovel.list(scoped)).rejects.toThrow('项目')
    await expect(jimengNovel.read!(scoped, '1001')).rejects.toThrow('空间')
    for (const [, args] of cli.mock.calls) {
      expect(args.filter((s) => s === '--team-id')).toHaveLength(1)
      expect(args[args.indexOf('--team-id') + 1]).toBe('987')
      expect(args[args.indexOf('--project-id') + 1]).toBe(target)
      expect(['list', 'create', 'get', 'update']).toContain(args[1])
    }
  })

  it('项目列表保留返回的顺序与长数字 ID，按官方游标翻页', async () => {
    cli
      .mockResolvedValueOnce(
        reply({ items: [{ projectId: '9007199254740993000', name: '第一部' }], nextCursor: 'abc' }),
      )
      .mockResolvedValueOnce(
        reply({ items: [{ projectId: '9007199254740993001', name: '第二部' }], nextCursor: null }),
      )
    expect(await jimengNovel.projects!()).toEqual([
      { id: '9007199254740993000', title: '第一部' },
      { id: '9007199254740993001', title: '第二部' },
    ])
    expect(cli.mock.calls[1]?.[1]).toEqual([
      'canvas',
      'list',
      '--limit',
      '100',
      '--cursor',
      'abc',
      '--full',
      '-j',
    ])
  })

  it('在创建超时后保护远端已编辑的同键卡片', async () => {
    cli.mockResolvedValueOnce(
      reply({
        items: [
          {
            nodeId: '777',
            key: 'plein/op-123',
            type: 'text',
            config: { name: '已修改', text: '' },
          },
        ],
      }),
    )
    await expect(jimengNovel.create!(target, fields, 'op-123')).rejects.toThrow('已有相同创建键')
    expect(cli).toHaveBeenCalledTimes(1)
  })

  it('拒绝无效目标与节点，不提交 CLI 命令', async () => {
    await expect(jimengNovel.list('--project-id')).rejects.toThrow()
    await expect(jimengNovel.update(target, { ...item, id: '--output' }, fields)).rejects.toThrow()
    expect(cli).not.toHaveBeenCalled()
  })

  it('遇到重复页或 CLI 错误时不交付残缺快照', async () => {
    cli.mockResolvedValue(reply({ items: [], nextCursor: 'p2' }))
    await expect(jimengNovel.list(target)).rejects.toThrow('重复')
    cli.mockResolvedValueOnce(
      JSON.stringify({ status: 'error', error: { code: 'PROJECT_NOT_READY' } }),
    )
    await expect(jimengNovel.list(target)).rejects.toThrow('PROJECT_NOT_READY')
  })
})
