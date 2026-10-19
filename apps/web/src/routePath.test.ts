import { describe, expect, test } from 'vite-plus/test'
import { parseRoute, routeHash } from './routePath'

describe('地址边界', () => {
  test.each(['', '#', '#/', '#/?q=hello'])('首页 %s', (hash) => {
    expect(parseRoute(hash)).toEqual({ name: 'home' })
  })
  test.each(['#/demo', '#/demo/', '#/demo?n=2'])('演示 %s', (hash) => {
    expect(parseRoute(hash)).toEqual({ name: 'demo' })
  })
  test.each([
    '#/c/',
    '#/p',
    '#/c/id/extra',
    '#/p/id/more',
    '#/demo-other',
    '#/unknown',
    '#/p/%',
    '#/c/%GG',
    '#/c/%E0%A4%A',
    '#/c/%ED%A0%80',
  ])('无效链接 %s 不抛异常', (hash) => {
    expect(parseRoute(hash)).toEqual({ name: 'invalid' })
  })
  for (const name of ['canvas', 'project'] as const) {
    test(`${name} 编码 ID 往返及查询参数保持同一目标`, () => {
      const route = { name, id: '中文 /?%#' }
      const hash = routeHash(route)
      expect(parseRoute(hash)).toEqual(route)
      expect(parseRoute(`${hash}?mode=preview`)).toEqual(route)
      expect(parseRoute(`${hash}/?mode=preview`)).toEqual(route)
    })
  }
})
