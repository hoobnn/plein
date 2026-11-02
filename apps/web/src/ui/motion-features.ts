import { domAnimation } from 'motion/react'

// 独立入口让打包器把动画特性留在异步 chunk，不能并回 MotionProvider。
export default domAnimation
