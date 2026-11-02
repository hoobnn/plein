import { describe, expect, it } from 'vite-plus/test'
import { cn } from './cn'

describe('cn', () => {
  it('保留不同分组的文字字号和颜色', () => {
    expect(cn('text-sm text-ink')).toBe('text-sm text-ink')
  })

  it('按后置类合并自定义阴影', () => {
    expect(cn('shadow-2 shadow-3')).toBe('shadow-3')
  })

  it('按后置类合并自定义控件高度与 Tailwind 高度', () => {
    expect(cn('h-md h-8')).toBe('h-8')
    expect(cn('h-8 h-md')).toBe('h-md')
  })

  it('通用控件类不参与工具类合并', () => {
    expect(cn('ui-input h-md', 'h-lg text-ink')).toBe('ui-input h-lg text-ink')
  })

  it('支持 clsx 条件输入', () => {
    expect(cn('ui-btn', { hidden: false, 'bg-hover': true })).toBe('ui-btn bg-hover')
  })
})
