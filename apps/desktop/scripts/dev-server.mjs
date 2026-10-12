// 开发模式的服务端入口：utilityProcess 不支持 --import，这里手动注册 tsx 再加载 TypeScript 源码
import { register } from 'tsx/esm/api'

register()
await import(new URL('../../server/src/main.ts', import.meta.url).href)
