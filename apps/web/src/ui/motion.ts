import {
  AnimatePresence as MotionAnimate,
  type AnimatePresenceProps,
  MotionConfigContext,
  useIsPresent,
  type Variants,
} from 'motion/react'
import { createElement, type ReactNode, useContext, useSyncExternalStore } from 'react'
import { LazyMotion, MotionFeatureFailure, MotionHost } from './LazyMotion'

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
    transformOrigin: 'var(--transform-origin, var(--pop-origin, top left))',
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
    transition: { duration: duration.exit, ease: ease.exit },
  }),
}

/** 默认弹出：--pop-from scale(0.97)，--pop-to scale(0.98)，原点左上。 */
export const scaleVariants: Variants = {
  initial: { opacity: 0, scale: 0.97, transformOrigin: 'top left' },
  visible: {
    opacity: 1,
    scale: 1,
    transition: { duration: duration.base, ease: ease.spring },
  },
  exit: {
    opacity: 0,
    scale: 0.98,
    transition: { duration: duration.exit, ease: ease.exit },
  },
}

/** .ui-pop-up：从下方 8px 进入、向下方 6px 收回。 */
export const popUpVariants: Variants = {
  initial: { opacity: 0, y: 8 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: duration.base, ease: ease.spring },
  },
  exit: {
    opacity: 0,
    y: 6,
    transition: { duration: duration.exit, ease: ease.exit },
  },
}

/** .ui-pop-right：从右侧 12px 进入、向右侧 8px 收回，原点右中。 */
export const popRightVariants: Variants = {
  initial: { opacity: 0, x: 12, transformOrigin: 'right center' },
  visible: {
    opacity: 1,
    x: 0,
    transition: { duration: duration.base, ease: ease.spring },
  },
  exit: {
    opacity: 0,
    x: 8,
    transition: { duration: duration.exit, ease: ease.exit },
  },
}

/** .plein-agent-panel：8px + 97% 慢速进入，4px + 98% 退出，原点右下。 */
export const agentPanelVariants: Variants = {
  initial: { opacity: 0, y: 8, scale: 0.97, transformOrigin: 'bottom right' },
  visible: {
    opacity: 1,
    y: 0,
    scale: 1,
    transition: { duration: duration.slow, ease: ease.spring },
  },
  exit: {
    opacity: 0,
    y: 4,
    scale: 0.98,
    transition: { duration: duration.exit, ease: ease.exit },
  },
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
    transition: { duration: duration.exit, ease: ease.exit },
  },
}

/** 遮罩只淡入淡出；退场沿用 --dur-exit 与 --ease-standard。 */
export const fadeVariants: Variants = {
  initial: { opacity: 0 },
  visible: { opacity: 1, transition: { duration: duration.base, ease: ease.standard } },
  exit: {
    opacity: 0,
    transition: { duration: duration.exit, ease: ease.standard },
  },
}

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'
const canMatchMedia = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function'
const subscribeReducedMotion = (notify: () => void) => {
  if (!canMatchMedia()) return () => {}
  const query = window.matchMedia(REDUCED_MOTION_QUERY)
  query.addEventListener('change', notify)
  return () => query.removeEventListener('change', notify)
}
const readReducedMotion = () =>
  canMatchMedia() ? window.matchMedia(REDUCED_MOTION_QUERY).matches : false

/** Motion 自己只缓存首次读取值；关闭时必须使用最新的系统偏好。 */
function useLatestReducedMotion() {
  const { reducedMotion } = useContext(MotionConfigContext)
  const system = useSyncExternalStore(subscribeReducedMotion, readReducedMotion, () => false)
  return reducedMotion === 'never' ? false : reducedMotion === 'always' || system
}

/** 组件树始终稳定；减少动态效果只改变 m 的 exit，不在两种父组件之间切换。 */
export function AnimatePresence(props: AnimatePresenceProps & { children?: ReactNode }) {
  return createElement(LazyMotion, null, createElement(MotionAnimate, props))
}

/** AnimatePresence 的关闭态同时用于停用 Esc、点外面和锚点观察。 */
export function useOverlayClosing() {
  return !useIsPresent()
}

/**
 * Base UI 浮层的 modal 取值：退场一开始就不再是模态。
 * 否则退场动画的 140ms 里，页面其余部分仍被标成 inert/aria-hidden，Base UI 也还留着
 * 铺满视口的阻挡层，紧接着的点击和双击会被吞掉。退场动画本身与卸载时的焦点归还都不受影响。
 */
export function useOverlayModal() {
  return !useOverlayClosing()
}

/** 已经报过缺失宿主的变体：同一类浮层只提示一次，避免刷屏。 */
const reportedHostMissing = new WeakSet<Variants>()

/**
 * 打开处漏了 AnimatePresence / LazyMotion 时，m 组件拿不到渲染器，animate 永远不会执行，
 * 只能把初始变体的 opacity 0 留在面板上：浮层看不见，却仍在挡点击。
 * Modal 用这个判断降级成直接可见，并在开发期报错，提示去打开处补宿主。
 */
export function useMissingMotionHost(variants: Variants) {
  const host = useContext(MotionHost)
  if (!host && !reportedHostMissing.has(variants)) {
    reportedHostMissing.add(variants)
    if (import.meta.env.DEV)
      console.error(
        '[plein] 浮层缺少 Motion 宿主：在打开处包一层 <AnimatePresence> 或 <LazyMotion>，否则 m 组件会停在初始帧（opacity 0）。',
      )
  }
  return !host
}

/** 缺少 Motion 宿主时用的可见降级：不设初始帧，直接按最终状态渲染。 */
export const degradedOverlayMotion = {
  initial: false,
  animate: { opacity: 1 },
  'data-motion-host-missing': '',
  variants: undefined,
  custom: undefined,
} as const

/** 浮层统一的变体声明与关闭态标记；数值只来自本文件的变体。 */
export function useOverlayMotion(variants: Variants, custom?: PopSide) {
  const closing = useOverlayClosing()
  const reduced = useLatestReducedMotion()
  const featureFailed = useContext(MotionFeatureFailure)
  return {
    initial: featureFailed ? false : 'initial',
    animate: featureFailed ? { opacity: 1 } : 'visible',
    // 无 exit 时 AnimatePresence 不保留退场队列，等价于零时长且同步清理。
    exit: reduced || featureFailed ? undefined : 'exit',
    'data-plein-exiting': closing ? '' : undefined,
    'aria-hidden': closing || undefined,
    inert: closing || undefined,
    'data-motion-feature-failed': featureFailed ? '' : undefined,
    variants: featureFailed ? undefined : variants,
    custom: featureFailed ? undefined : custom,
  } as const
}
