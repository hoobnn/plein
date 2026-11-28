import { expect, it } from 'vite-plus/test'
import { canonicalTarget, parseNovelTarget, projectLockKey } from './targets'

it('规范化短剧项目时区分裸 ID、个人与团队并保留大整数', () => {
  const canonical = (target: string) => canonicalTarget({ provider: 'jimeng-novel', target }).target
  for (const target of ['12', '0/12', '987/1000', '90071992547409931/90071992547409932'])
    expect(canonical(target)).toBe(target)
  expect(parseNovelTarget('987/1000')).toEqual({ teamId: '987', projectId: '1000' })
  expect(canonical('https://jimeng.jianying.com/novel/detail/canvas?projectId=12')).toBe('12')
  for (const target of [
    '00/12',
    '0/0',
    '1/02',
    'team/1000',
    '1/2/3',
    '--team-id=1',
    'https://jimeng.jianying.com/?projectId=0%2F12',
  ])
    expect(() => canonical(target)).toThrow()
})

it('裸 ID 与同号的各显式空间共用写锁，绑定仍保留所选 ID', () => {
  const key = (target: string) =>
    projectLockKey(canonicalTarget({ provider: 'jimeng-novel', target }))
  expect(key('12')).toBe(key('0/12'))
  expect(key('0/12')).toBe(key('77/12'))
  expect(key('12')).not.toBe(key('77/13'))
})

const canvasUuid = '188d3a67-5773-4b30-88d2-d2c13351aef7'
const origin = 'https://jimeng.jianying.com'
const canvasUrl = origin + '/ai-tool/ai-canvas/' + canvasUuid
const canvasTarget = (target: string) =>
  canonicalTarget({ provider: 'jimeng-canvas', target }).target

it('解析官网创建回执的路径、分享参数及既有 query 定位', () => {
  for (const target of [
    canvasUrl,
    canvasUrl + '/?utm_source=share#canvas',
    canvasUuid.toUpperCase(),
    origin + '/ai-tool/ai-canvas/' + canvasUuid.toUpperCase(),
    origin + '/ai-tool/ai-canvas/?projectId=' + canvasUuid,
    origin + '/?a=1&projectId=' + canvasUuid,
  ]) {
    expect(canvasTarget(target)).toBe(canvasUuid)
  }
})

it('拒绝多重身份、来源混淆及通过规范化伪造的项目路径', () => {
  const other = '432dc28e-a3ce-4566-8e05-e14cd0298b15'
  for (const target of [
    canvasUrl + '?projectId=' + canvasUuid,
    canvasUrl + '?projectId=' + other,
    origin + '/?projectId=' + canvasUuid + '&projectId=' + canvasUuid,
    origin + '/ai-tool/ai-canvas/wrong?projectId=' + canvasUuid,
    canvasUrl + '/extra?projectId=' + canvasUuid,
    canvasUrl + '%2Fother',
    origin + '/spoof/../ai-tool/ai-canvas/' + canvasUuid,
    origin + '/x/%2e%2e/ai-tool/ai-canvas/' + canvasUuid,
    origin + '/ai-tool/ai-canvas/a/../' + canvasUuid,
    origin + '\\ai-tool\\ai-canvas\\' + canvasUuid,
    canvasUrl.replace('jimeng.jianying.com', 'jimeng.jianying.com.evil.invalid'),
    canvasUrl.replace('jimeng.jianying.com', 'fake@jimeng.jianying.com'),
    canvasUrl.replace('jimeng.jianying.com', '@jimeng.jianying.com'),
    canvasUrl.replace('https://', 'http://'),
    canvasUrl.replace(canvasUuid, '20'),
    origin + '/ai-tool/ai-canvas/' + canvasUuid + '/' + other,
  ])
    expect(() => canvasTarget(target), target).toThrow()
  expect(() => canonicalTarget({ provider: 'jimeng-novel', target: canvasUrl })).toThrow()
})
