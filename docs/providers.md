# 模型平台接入

四个平台作为内置服务端插件加载，通过现有设置页配置和启用，默认关闭。节点的模型列表来自平台声明；仅启用的平台会参与自动选模型。生成使用各平台按量 API，模型目录不代表账号已经开通权限。

| 平台 / Provider ID       | 已接入能力                                                                         | 密钥                                                                      |
| ------------------------ | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| MiniMax `minimax/api`    | M3 / M2.7 对话、image-01 图片、H3 / H3-Max 视频、speech-2.8 配音、Music 3.0 纯音乐 | `MINIMAX_API_KEY`                                                         |
| 豆包语音 `doubao/speech` | TTS 2.0、已有复刻音色、Seed Audio 音乐 / 音效、极速录音识别                        | `VOLC_SPEECH_API_KEY`，或 `VOLC_SPEECH_APP_ID` + `VOLC_SPEECH_ACCESS_KEY` |
| 百炼 `aliyun/bailian`    | 千问对话、Qwen Image / 万相图片、Wan 3.0 视频、Qwen TTS                            | `DASHSCOPE_API_KEY`                                                       |
| 方舟 `volc/ark`          | Seed 对话、Seedream 图片、Seedance 视频                                            | `ARK_API_KEY`                                                             |

## 配置

1. 在设置页填写对应平台的密钥及地域等设置，点击保存。
2. MiniMax / 方舟可「测试连接」：分别调用模型列表 / 视频任务列表，不触发生成。通过不代表每个模型都可用。
3. 百炼 / 豆包只提供「检查配置」：校验本地凭据，明确未验证远端密钥、网络、模型权限和余额。
4. 启用平台，在图片、视频、配音等节点选择模型并执行。密钥由宿主保存，不放入画布。

MiniMax 默认中国区 `api.minimax.cn`，可选国际区 `api.minimax.io`，密钥应匹配地域。百炼支持北京、新加坡、美国地域；业务空间 ID 留空使用对应 DashScope 兼容端点。方舟默认北京，可在平台设置填写自定义模型 / Endpoint ID，再选择「自定义」模型条目。

## 接口实现

以官方接口文档为契约，直接使用宿主 `ctx.fetch`，确保域名许可、密钥访问、资产归属、取消信号和异步任务轮询一致。没有额外引入云厂商 SDK。每个平台独立声明模型、设置、密钥和最小网络权限；产物通过宿主写入资产库。

OpenAI 兼容的对话（`text.chat`）共用 `packages/providers/src/shared/llm.ts`，基于 Vercel AI SDK（`ai` + `@ai-sdk/openai-compatible`）：负责消息转换、流式读取、结构化输出按请求的 JSON Schema 校验（zod `fromJSONSchema`）、用量归一化；鉴权、端点、HTTP 与流内错误码的归类和脱敏仍由各平台适配器通过传给它的 `fetch` 和 `streamError` 提供，请求一律不重试。目前百炼已接入；火山方舟和 MiniMax 的对话仍是各自手写的请求，等插件 SDK 支持流式输出到界面或工具调用时再迁移。

SDK 新增 `testScope` 标记本地配置检查，以及 `credentialAlternatives` 表达豆包新旧鉴权方式；目录的 `configured` 只有在一组凭据完整时才为真。宿主取消使用独立的 10 秒信号，避免已取消的生成请求阻止远端取消请求。

## 能力边界

- 生成视频节点的模式由用户在生成器里指定：文生视频、图生视频（第 1 张图作首帧）、首尾帧（第 1、2 张图）、图片参考（全部图片作参考主体）。连入的图片按画布位置从上到下编号；图片数和模式对不上时提交前拦下。视频提示词里 `@` 资产卡时，只有图片参考模式会把参考图并入，其他模式只附文字设定并给出提示。参考图上限：Seedance 2.5 为 30 张，2.0 系列为 9 张，万相为 10 张，MiniMax H3 为 9 张。「生成音频」是通用开关：Seedance 传 `generate_audio`，万相传 `audio`，MiniMax H3 不支持（隐藏）。生成数量按条数并行提交。
- MiniMax H3 使用 V2：H3 为 4–15 整数秒、768P / 2K；H3-Max 为 5–15 秒、480P / 768P。首尾帧与参考素材互斥，V2 不支持 seed。此适配器视频参考仅接入图片。M2.7 对话仅支持纯文本；当前 MiniMax 对话适配器不支持强制 JSON Schema。
- MiniMax 图片仅支持单张人物参考图；MiniMax 配音不支持自由语气指令，可通过 `extra.emotion` 指定官方情绪，或使用豆包 / 千问 instruct 模型。
- Music 3.0 当前生成纯音乐，时长由模型决定。该旧音乐 API 可能仅向原付费用户开放；2026-10-12 本机账号实测返回 HTTP 410。Seed Audio 的目标时长写入提示词，属于软约束。豆包返回内嵌音频，暂不支持仅返回 URL 的音频产物。
- 百炼 Wan 3.0 的本地参考素材通过官方上传凭证上传 OSS，再交给生成接口。千问配音自然语言指令需要 instruct 模型，单次文本最多 600 字符。对话 JSON Schema 以 JSON mode + 提示词表达，当前不保证强制符合 Schema。
- 方舟支持本地图片编码为 data URL；本地视频 / 音频参考尚未接入素材库上传。Seedream 的画幅映射为对应模型支持的尺寸；多图生成应选择支持组图的 Lite 模型。Seedream 5 不支持 seed。
- MiniMax / 方舟仅对排队任务尝试远端取消；运行中任务无法由此接口取消。取消前查询状态，避免对已完成任务调用兼具删除语义的接口。百炼取消受官方排队状态限制。
- 不自动重试生成 POST；网络断开或缺少 task ID 时不得假定提交失败。宿主通过任务 journal 将异步 ID 存入 SQLite `jobs.calls`，重启后对已记录的 pending 调用继续轮询；机制已有源码实现，真实平台跨进程恢复仍需端到端验收。
- `audio.transcribe` 和 `audio.sfx` 可通过 Provider 调用，但现有基础节点尚无专门的识别 / 音效节点；音色复刻训练、设计、实时语音不在此次接入范围。

## 验证与官方来源

契约测试使用模拟 HTTP 响应，覆盖节点参数映射、二进制素材和音频、业务错误、任务状态、取消和权限清单；宿主集成测试检查插件目录、默认禁用状态、鉴权配置与取消信号。它们不证明账号模型权限或云端生成效果。

2026-10-12 按用户授权迁入本机 MCP 共享环境中的密钥，并进行云端生成实测。配置保存在被 Git 忽略的 `data/providers.json`（权限 600）；具体调用回执、成功资产和账号权限限制保存在本机 `data/provider-smoke-2026-10-12.json`。真实响应补齐了豆包结束包 `data:null`、百炼 OSS 音频 HTTP→HTTPS 下载以及 MiniMax 图片 OSS 域名的兼容处理。

- MiniMax：[对话](https://platform.minimax.cn/docs/api-reference/text-chat-openai)、[图片](https://platform.minimax.cn/docs/api-reference/image-generation-t2i)、[H3 V2](https://platform.minimax.cn/docs/api-reference/video-generation-v2-create)、[配音](https://platform.minimax.cn/docs/api-reference/speech-t2a-http)、[音乐](https://platform.minimax.cn/docs/api-reference/music-generation)。
- 豆包：[HTTP 配音](https://docs.volcengine.com/docs/DoubaoVoice/unidirectional-streaming-text-to-speech-http?lang=zh)、[Seed Audio](https://docs.volcengine.com/docs/DoubaoVoice/audio-generation-http?lang=zh)、[极速识别](https://www.volcengine.com/docs/6561/1631584?lang=zh)。
- 百炼：[Qwen Image](https://help.aliyun.com/zh/model-studio/qwen-image-generation-and-editing-api-reference)、[Wan 3.0](https://help.aliyun.com/zh/model-studio/wan3-video-generation-api-reference)、[Qwen TTS](https://help.aliyun.com/zh/model-studio/qwen-tts-api)、[异步任务](https://help.aliyun.com/zh/model-studio/manage-asynchronous-tasks)。
- 方舟：[模型列表](https://docs.volcengine.com/docs/ark/model-list?lang=zh)、[图片](https://docs.volcengine.com/docs/ark/image-generation-api?lang=zh)、[视频](https://docs.volcengine.com/docs/ark/create-video-generation-task-api?lang=zh)。
