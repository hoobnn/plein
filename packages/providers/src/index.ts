/**
 * 内置模型平台适配器（仅服务端）。每家平台是一个服务端插件，通过 plugin-sdk 注册。
 * 每个平台走统一的密钥、网络权限、模型选择和异步任务生命周期。
 */
export { mockPlugin, mockProvider } from './mock'
export { minimaxPlugin, minimaxProvider } from './minimax'
export { doubaoPlugin, doubaoProvider } from './doubao'
export { bailianPlugin, bailianProvider } from './bailian'
export { arkPlugin, arkProvider } from './ark'
