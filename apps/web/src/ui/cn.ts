import { clsx, type ClassValue } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      shadow: [{ shadow: ['1', '2', '3', '4'] }],
      'font-size': [{ text: ['2xs'] }],
      h: [{ h: ['xs', 'sm', 'md', 'lg', 'xl'] }],
    },
  },
})

/**
 * 合并条件类名与 Tailwind 冲突类。ui-* 通用控件类不注册进合并分组，
 * tailwind-merge 会把它们当普通类保留，不会因后面的工具类而误删。
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
