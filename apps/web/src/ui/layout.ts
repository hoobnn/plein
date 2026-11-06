/**
 * 布局尺度的 JS 侧来源，数值与 styles/tokens.css 的同名令牌逐一对应
 * （ui/layout.test.ts 会读取 tokens.css 对比，改一边必须改另一边）。
 * CSS 里的 @media 不能引用变量，手写这里的断点数字。
 */

/** 断点：sm 手机窄屏 · compact 右侧面板和双栏对话框的收拢点 · lg 首页收列 · xl 顶栏展开 */
export const BREAKPOINT = { sm: 640, compact: 900, lg: 1024, xl: 1280 } as const

export type Breakpoint = keyof typeof BREAKPOINT

/** `(min-width: Npx)` 查询串，与 Tailwind 的同名前缀等价 */
export const minWidth = (bp: Breakpoint) => `(min-width: ${BREAKPOINT[bp]}px)`

/** 浮动外框离视口边，对应 --chrome-inset */
export const CHROME_INSET = 12

/** 右侧浮层面板宽度，对应 --panel-w-sm / md / lg */
export const PANEL_W = { sm: 320, md: 360, lg: 400 } as const

/** 右侧浮层实际占掉的画布宽度：面板宽度加上离视口右边的间距 */
export const panelFootprint = (size: keyof typeof PANEL_W) => PANEL_W[size] + CHROME_INSET

/** 菜单与选择器宽度，对应 --menu-w-sm / md / lg 与 --menu-h */
export const MENU_W = { sm: 220, md: 240, lg: 280 } as const
export const MENU_H = 440
