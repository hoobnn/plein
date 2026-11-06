import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vite-plus/test'
import { BREAKPOINT, MENU_H, MENU_W, PANEL_W } from './layout'

const tokens = readFileSync(new URL('../styles/tokens.css', import.meta.url), 'utf8')
const px = (name: string) => {
  const hit = new RegExp(`${name}:\\s*(\\d+)px`).exec(tokens)
  if (!hit) throw new Error(`tokens.css 缺少 ${name}`)
  return Number(hit[1])
}

describe('布局尺度 JS 与 CSS 同源', () => {
  it('面板、菜单宽度与 tokens.css 一致，相机内缩和页面留白才不会和真实面板错位', () => {
    for (const k of Object.keys(PANEL_W) as (keyof typeof PANEL_W)[])
      expect(PANEL_W[k]).toBe(px(`--panel-w-${k}`))
    for (const k of Object.keys(MENU_W) as (keyof typeof MENU_W)[])
      expect(MENU_W[k]).toBe(px(`--menu-w-${k}`))
    expect(MENU_H).toBe(px('--menu-h'))
  })

  it('断点与 Tailwind 主题里的四档一致', () => {
    for (const k of Object.keys(BREAKPOINT) as (keyof typeof BREAKPOINT)[])
      expect(BREAKPOINT[k]).toBe(px(`--breakpoint-${k}`))
  })
})
