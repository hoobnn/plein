/**
 * 内置模型平台适配器（仅服务端）。每家平台是一个服务端插件，通过 plugin-sdk 注册。
 * 0.1.0 先只有开发测试用的 mock；火山方舟、豆包语音等在后续里程碑加入。
 */
export { mockPlugin, mockProvider } from './mock'
