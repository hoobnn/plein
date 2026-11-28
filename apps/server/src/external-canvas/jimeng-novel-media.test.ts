import { beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import { readFile } from 'node:fs/promises'
import { runCli } from './cli'
import { jimengNovelMedia } from './jimeng-novel-media'

vi.mock('./cli', () => ({ runCli: vi.fn() }))
const cli = vi.mocked(runCli)
const target = '10001'
const media = { nodeId: '201', assetId: '301', title: '镜头', kind: 'video' as const }
const reply = (data: unknown, team?: string) =>
  JSON.stringify({ status: 'success', data, context: { projectId: target, teamId: team } })
const selection = (id = media.assetId) => ({
  nodeId: media.nodeId,
  config: { type: media.kind },
  state: { selectedAssetId: id },
})

beforeEach(() => cli.mockReset())

describe('短剧素材', () => {
  it('从当前选中项列出可下载的角色设定图；空间未知时关闭写入', async () => {
    cli.mockResolvedValueOnce(
      reply({
        items: [
          { nodeId: '201', type: 'role', selectedAssetId: '301', config: { name: '角色' } },
          { nodeId: '202', type: 'video', config: { name: '未采用' } },
        ],
      }),
    )
    expect(await jimengNovelMedia.listMedia(target)).toEqual([
      { nodeId: '201', assetId: '301', title: '角色', kind: 'image', replaceable: false },
    ])
    expect(cli).toHaveBeenCalledTimes(1)
  })

  it('按节点 ID 复核选中版本，准确继承当前状态与可写空间', async () => {
    cli
      .mockResolvedValueOnce(
        reply({ ...selection(), config: { type: 'video', name: '镜头' } }, '0'),
      )
      .mockResolvedValueOnce(reply({ items: [{ projectId: target, name: '验收' }] }, '0'))
    expect(await jimengNovelMedia.readMedia!(target, media.nodeId)).toEqual([
      { ...media, replaceable: true },
    ])
    expect(cli.mock.calls[0]?.[1]?.slice(0, 4)).toEqual(['node', 'get', '--node-id', media.nodeId])
    expect(cli.mock.calls.some(([, args]) => args[0] === 'node' && args[1] === 'list')).toBe(false)
  })

  it('素材在下载期间被切换时丢弃下载回执', async () => {
    cli.mockResolvedValueOnce(
      reply({ nodeId: media.nodeId, assetId: '其他素材', localPath: '/tmp/selected.mp4' }),
    )
    await expect(jimengNovelMedia.download(target, media, '/tmp/selected.mp4')).rejects.toThrow()
  })

  it('没有能够定位目标空间的凭据时，在上传前结束', async () => {
    cli.mockResolvedValueOnce(reply(selection()))
    await expect(jimengNovelMedia.replace!(target, media, '/tmp/selected.mp4')).rejects.toThrow(
      '空间',
    )
    expect(cli).toHaveBeenCalledTimes(1)
  })

  it('准备替换时节点已开始生成，跳过上传', async () => {
    const current = selection()
    cli.mockResolvedValueOnce(
      reply({ ...current, state: { ...current.state, status: 'running' } }, '12'),
    )
    await expect(jimengNovelMedia.replace!(target, media, '/tmp/selected.mp4')).rejects.toThrow(
      '正在生成',
    )
    expect(cli).toHaveBeenCalledTimes(1)
  })

  it('列项目返回的空间与请求不符时阻止上传', async () => {
    cli
      .mockResolvedValueOnce(reply(selection(), '12'))
      .mockResolvedValueOnce(reply({ items: [{ projectId: target, name: '验收' }] }, '13'))
    await expect(jimengNovelMedia.replace!(target, media, '/tmp/selected.mp4')).rejects.toThrow(
      '未确认目标空间',
    )
    expect(cli).toHaveBeenCalledTimes(2)
  })

  it('显式使用同一空间上传，二次核对选中项后回写资产 ID', async () => {
    cli
      .mockResolvedValueOnce(reply(selection(), '0'))
      .mockResolvedValueOnce(reply({ items: [{ projectId: target, name: '验收' }] }, '0'))
      .mockResolvedValueOnce(reply({ assetId: '302', type: 'video', status: 'ready' }, '0'))
      .mockResolvedValueOnce(reply(selection(), '0'))
      .mockImplementationOnce(async (_bin, args) => {
        expect(args).toEqual(expect.arrayContaining(['--team-id', '0', '--node-id', media.nodeId]))
        expect(JSON.parse(await readFile(args[args.indexOf('--input-file') + 1]!, 'utf8'))).toEqual(
          { assetId: '302' },
        )
        return reply(selection('302'), '0')
      })
    expect(await jimengNovelMedia.replace!(target, media, '/tmp/selected.mp4')).toBe('302')
    expect(cli.mock.calls[2]?.[1]).toEqual(
      expect.arrayContaining([
        'resource',
        'upload',
        '--file',
        '/tmp/selected.mp4',
        '--team-id',
        '0',
      ]),
    )
  })

  it('在限定短剧项目下载与替换，上传只传已确认的空间，节点命令另带项目', async () => {
    const scope = '987/' + target
    cli
      .mockResolvedValueOnce(
        reply(
          { nodeId: media.nodeId, assetId: media.assetId, localPath: '/tmp/selected.mp4' },
          '987',
        ),
      )
      .mockResolvedValueOnce(reply(selection(), '987'))
      .mockResolvedValueOnce(reply({ items: [{ projectId: target, name: '项目' }] }, '987'))
      .mockResolvedValueOnce(reply({ assetId: '302', type: 'video', status: 'ready' }, '987'))
      .mockResolvedValueOnce(reply(selection(), '987'))
      .mockResolvedValueOnce(reply(selection('302'), '987'))
    await jimengNovelMedia.download(scope, media, '/tmp/selected.mp4')
    expect(await jimengNovelMedia.replace!(scope, media, '/tmp/selected.mp4')).toBe('302')
    for (const [, args] of cli.mock.calls) {
      expect(args.filter((a) => a === '--team-id')).toHaveLength(1)
      expect(args[args.indexOf('--team-id') + 1]).toBe('987')
      if (args[0] === 'node') expect(args[args.indexOf('--project-id') + 1]).toBe(target)
      else expect(args).not.toContain('--project-id')
      expect(['download', 'get', 'list', 'upload', 'update']).toContain(args[1])
    }
  })

  it('上传期间选中项变化时保留原有绑定', async () => {
    cli
      .mockResolvedValueOnce(reply(selection(), '12'))
      .mockResolvedValueOnce(reply({ items: [{ projectId: target, name: '验收' }] }, '12'))
      .mockResolvedValueOnce(reply({ assetId: '302', type: 'video', status: 'ready' }, '12'))
      .mockResolvedValueOnce(reply(selection('310'), '12'))
    await expect(jimengNovelMedia.replace!(target, media, '/tmp/selected.mp4')).rejects.toThrow(
      '已变化',
    )
    expect(cli).toHaveBeenCalledTimes(4)
  })
})
