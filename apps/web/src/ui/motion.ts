import { useIsPresent, useReducedMotion, type Variants } from 'motion/react'

/**
 * 与 tokens.css 一一对应：spring = cubic-bezier(0.22, 1, 0.36, 1)，
 * standard = cubic-bezier(0.4, 0, 0.2, 1)，exit = cubic-bezier(0.4, 0, 1, 1)。
 */
const ease = {
  spring: [0.22, 1, 0.36, 1],
  standard: [0.4, 0, 0.2, 1],
  exit: [0.4, 0, 1, 1],
} as const

/** 与 tokens.css 一一对应：fast 120ms、base 180ms、slow 280ms、exit 140ms。 */
const duration = { fast: 0.12, base: 0.18, slow: 0.28, exit: 0.14 } as const

export type PopSide = 'above' | 'below'

/** --pop-from / --pop-to：菜单沿锚点方向移动 4px，97% 进、98% 出。 */
export const popVariants: Variants = {
  initial: (side: PopSide = 'below') => ({
    opacity: 0,
    y: side === 'above' ? 4 : -4,
    scale: 0.97,
    transformOrigin: 'var(--transform-origin, center)',
  }),
  visible: {
    opacity: 1,
    y: 0,
    scale: 1,
    transition: { duration: duration.base, ease: ease.spring },
  },
  exit: (side: PopSide = 'below') => ({
    opacity: 0,
    y: side === 'above' ? 2 : -2,
    scale: 0.98,
    pointerEvents: 'none',
    transition: { duration: duration.exit, ease: ease.exit },
  }),
}

/** 提示条：--pop-from translateY(-6px)，--pop-to translateY(-4px)。 */
export const toastVariants: Variants = {
  initial: { opacity: 0, y: -6 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: duration.base, ease: ease.spring },
  },
  exit: {
    opacity: 0,
    y: -4,
    pointerEvents: 'none',
    transition: { duration: duration.exit, ease: ease.exit },
  },
}

/** 对话框：--pop-from translateY(6px) scale(0.985)，--pop-to translateY(3px) scale(0.99)。 */
export const dialogVariants: Variants = {
  initial: { opacity: 0, y: 6, scale: 0.985 },
  visible: {
    opacity: 1,
    y: 0,
    scale: 1,
    transition: { duration: duration.slow, ease: ease.spring },
  },
  exit: {
    opacity: 0,
    y: 3,
    scale: 0.99,
    pointerEvents: 'none',
    transition: { duration: duration.exit, ease: ease.exit },
  },
}

/** 遮罩只淡入淡出；退场沿用 --dur-exit 与 --ease-standard。 */
export const fadeVariants: Variants = {
  initial: { opacity: 0 },
  visible: { opacity: 1, transition: { duration: duration.base, ease: ease.standard } },
  exit: {
    opacity: 0,
    pointerEvents: 'none',
    transition: { duration: duration.exit, ease: ease.standard },
  },
}

/** AnimatePresence 的关闭态同时用于停用 Esc、点外面和锚点观察。 */
export function useOverlayClosing() {
  return !useIsPresent()
}

/** 减少动态效果时以零时长完成退场，不让透明度过渡拖住卸载。 */
export function useOverlayMotion(variants: Variants, custom?: PopSide) {
  const reduced = useReducedMotion()
  return {
    initial: 'initial',
    animate: 'visible',
    exit: 'exit',
    variants,
    custom,
    transition: reduced ? { duration: 0 } : undefined,
  } as const
}
