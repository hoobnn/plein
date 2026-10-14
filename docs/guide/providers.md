# 模型平台接入

四家平台以内置服务端插件的形式加载，默认关闭，在设置页填好配置后启用。节点里能选哪些模型，由平台自己声明；自动选模型时只考虑已启用的平台。生成走的是各平台的按量计费 API，模型出现在目录里，不代表你的账号已经开通了它的权限。

| 平台 / Provider ID       | 已接入能力                                                                         | 密钥                                                                      |
| ------------------------ | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| MiniMax `minimax/api`    | M3 / M2.7 对话、image-01 图片、H3 / H3-Max 视频、speech-2.8 配音、Music 3.0 纯音乐 | `MINIMAX_API_KEY`                                                         |
| 豆包语音 `doubao/speech` | TTS 2.0、已有复刻音色、Seed Audio 音乐 / 音效、极速录音识别                        | `VOLC_SPEECH_API_KEY`，或 `VOLC_SPEECH_APP_ID` + `VOLC_SPEECH_ACCESS_KEY` |
| 百炼 `aliyun/bailian`    | 千问对话、Qwen Image / 万相图片、Wan 3.0 视频、Qwen TTS                            | `DASHSCOPE_API_KEY`                                                       |
| 方舟 `volc/ark`          | Seed 对话、Seedream 图片、Seedance 视频                                            | `ARK_API_KEY`                                                             |

## 配置

1. 在设置页填写平台的密钥、地域等信息，点击保存。
2. MiniMax / 方舟可以「测试连接」：分别调用模型列表 / 视频任务列表接口，不会触发生成。测试通过，也不代表每个模型都能用。
3. 百炼 / 豆包只提供「检查配置」：只校验本地凭据，并明确告诉你远端密钥、网络、模型权限和余额都还没验证。
4. 启用平台，然后在图片、视频、配音等节点里选模型、运行。密钥由宿主保存，不会写进画布。

MiniMax 默认走中国区 `api.minimax.cn`，也可以选国际区 `api.minimax.io`，密钥要和地域对应。百炼支持北京、新加坡、美国三个地域；业务空间 ID 留空时，使用该地域的 DashScope 兼容端点。方舟默认北京地域；要用自定义模型，先在平台设置里填好模型 / Endpoint ID，再在模型列表里选「自定义」。

## 接口实现

适配器以官方接口文档为契约，直接调用宿主提供的 `ctx.fetch`，没有引入云厂商 SDK。这样域名许可、密钥访问、资产归属、取消信号和异步任务轮询都由宿主统一把关。每个平台各自声明模型、设置、密钥和所需的最小网络权限；生成的产物经宿主写入资产库。

OpenAI 兼容的对话（`text.chat`）共用 `packages/providers/src/shared/llm.ts`。它基于 Vercel AI SDK（`ai` + `@ai-sdk/openai-compatible`），负责消息转换、流式读取、按请求里的 JSON Schema 校验结构化输出（zod `fromJSONSchema`），以及用量归一化。鉴权、端点，以及 HTTP 错误码和流内错误码的归类与脱敏，仍由各平台适配器通过传入的 `fetch` 和 `streamError` 负责；请求一律不重试。目前只有百炼接入了这一层；火山方舟和 MiniMax 的对话还是各自手写请求，等插件 SDK 支持把流式输出送到界面、或支持工具调用时再迁过来。

SDK 新增了两个字段：`testScope` 用来标出「只检查本地配置」，`credentialAlternatives` 用来表达豆包的新旧两种鉴权方式；只有某一组凭据填完整时，目录里的 `configured` 才为真。宿主发送取消请求时使用独立的 10 秒信号，避免已取消的生成请求把远端取消请求也一起拦下。

## 能力边界

- 生成视频节点的模式由用户在生成器里指定：文生视频、图生视频（第 1 张图作首帧）、首尾帧（第 1、2 张图）、图片参考（全部图片作参考主体）。连入的图片按画布位置从上到下编号；图片数和模式对不上时提交前拦下。视频提示词里 `@` 资产卡时，只有图片参考模式会把参考图并入，其他模式只附文字设定并给出提示。参考图上限：Seedance 2.5 为 30 张，2.0 系列为 9 张，万相为 10 张，MiniMax H3 为 9 张。「生成音频」是通用开关：Seedance 传 `generate_audio`，万相传 `audio`，MiniMax H3 不支持（隐藏）。生成数量按条数并行提交。
- MiniMax H3 使用 V2：H3 为 4–15 整数秒、768P / 2K；H3-Max 为 5–15 秒、480P / 768P。首尾帧与参考素材互斥，V2 不支持 seed。此适配器视频参考仅接入图片。M2.7 对话仅支持纯文本；当前 MiniMax 对话适配器不支持强制 JSON Schema。
- MiniMax 图片仅支持单张人物参考图；MiniMax 配音不支持自由语气指令，可通过 `extra.emotion` 指定官方情绪，或使用豆包 / 千问 instruct 模型。
- Music 3.0 当前生成纯音乐，时长由模型决定。该旧音乐 API 可能仅向原付费用户开放；2026-10-12 本机账号实测返回 HTTP 410。Seed Audio 的目标时长写入提示词，属于软约束。豆包返回内嵌音频，暂不支持仅返回 URL 的音频产物。
- 百炼 Wan 3.0 的本地参考素材通过官方上传凭证上传 OSS，再交给生成接口。千问配音自然语言指令需要 instruct 模型，单次文本最多 600 字符。对话 JSON Schema 以 JSON mode + 提示词表达，当前不保证强制符合 Schema。
- 方舟支持本地图片编码为 data URL；本地视频 / 音频参考尚未接入素材库上传。Seedream 的画幅映射为对应模型支持的尺寸；多图生成应选择支持组图的 Lite 模型。Seedream 5 不支持 seed。
- MiniMax / 方舟仅对排队任务尝试远端取消；运行中任务无法由此接口取消。取消前查询状态，避免对已完成任务调用兼具删除语义的接口。百炼取消受官方排队状态限制。
- 不自动重试生成 POST；网络断开或缺少 task ID 时不得假定提交失败。宿主通过任务 journal 将异步 ID 存入 SQLite `jobs.calls`，重启后对已记录的 pending 调用继续轮询；机制已有源码实现，真实平台跨进程恢复仍需端到端验收。
- 提交后没收到回应时任务记为「提交结果未知」。内置真实平台都没有声明按幂等键查询（`lookup`）或幂等提交（`idempotent`），这时只能在任务面板人工核查：填平台控制台里查到的任务 ID 接着取结果，或确认未受理后重新提交（可能重复计费）。mock 平台实现了 `lookup`，用来测试自动核查。
- 平台已生成、下载或保存失败时，调用记录留着结果（内嵌字节 16 MB 以内）或远端任务 ID，任务面板可「重新获取」；结果地址返回 401 / 403 / 404 / 410 时先重新查询平台拿新地址，平台不支持查询时如实提示无法取回。
- `audio.transcribe` 和 `audio.sfx` 可通过 Provider 调用，但现有基础节点尚无专门的识别 / 音效节点；音色复刻训练、设计、实时语音不在此次接入范围。

## 验证与官方来源

契约测试用模拟的 HTTP 响应，覆盖节点参数映射、二进制素材和音频、业务错误、任务状态、取消和权限清单；宿主集成测试检查插件目录、默认禁用状态、鉴权配置与取消信号。这些测试证明不了账号有没有模型权限，也证明不了云端的实际生成效果。

2026-10-12，经用户授权，迁入本机 MCP 共享环境中的密钥，并进行了一轮云端生成实测。配置保存在被 Git 忽略的 `data/providers.json`（权限 600）；每次调用的回执、生成成功的资产和账号权限限制，记在本机的 `data/provider-smoke-2026-10-12.json`。真实响应暴露出的几处问题都已兼容：豆包结束包里的 `data:null`、百炼 OSS 音频需要从 HTTP 改走 HTTPS 下载，以及 MiniMax 图片的 OSS 域名。

- MiniMax：[对话](https://platform.minimax.cn/docs/api-reference/text-chat-openai)、[图片](https://platform.minimax.cn/docs/api-reference/image-generation-t2i)、[H3 V2](https://platform.minimax.cn/docs/api-reference/video-generation-v2-create)、[配音](https://platform.minimax.cn/docs/api-reference/speech-t2a-http)、[音乐](https://platform.minimax.cn/docs/api-reference/music-generation)。
- 豆包：[HTTP 配音](https://docs.volcengine.com/docs/DoubaoVoice/unidirectional-streaming-text-to-speech-http?lang=zh)、[Seed Audio](https://docs.volcengine.com/docs/DoubaoVoice/audio-generation-http?lang=zh)、[极速识别](https://www.volcengine.com/docs/6561/1631584?lang=zh)。
- 百炼：[Qwen Image](https://help.aliyun.com/zh/model-studio/qwen-image-generation-and-editing-api-reference)、[Wan 3.0](https://help.aliyun.com/zh/model-studio/wan3-video-generation-api-reference)、[Qwen TTS](https://help.aliyun.com/zh/model-studio/qwen-tts-api)、[异步任务](https://help.aliyun.com/zh/model-studio/manage-asynchronous-tasks)。
- 方舟：[模型列表](https://docs.volcengine.com/docs/ark/model-list?lang=zh)、[图片](https://docs.volcengine.com/docs/ark/image-generation-api?lang=zh)、[视频](https://docs.volcengine.com/docs/ark/create-video-generation-task-api?lang=zh)。
