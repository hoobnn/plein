# 平台对接契约复核（2026-10-24）

本轮对照 Plein 的四个内置 Provider、官方接口正文与 `hoobnn-mcps` 已审查实现，检查端点、鉴权、请求字段层级、素材编码、响应格式、任务状态及模型生命周期。参考仓库为 `/Users/haobin/Code/personal/active/hoobnn-mcps`，当前提交 `d8daa0f14b23fc23b084588d6289c6dd6c0ceee8`；该仓库的功能范围比 Plein 大，不能将其已支持能力直接写成 Plein 已支持。

本轮取得 30 份官方正文，只读取公开文档、源码并运行本地测试，没有读取平台密钥或发送云端生成、识别和复刻请求。当前账号授权、计费和生成效果不属于本轮验收结果。

## 已修正问题

| 平台     | 原问题                                                                                              | 修正与证据                                                                                                                                                                                                                                                                                            |
| -------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 百炼     | 目录仍声明 `qwen3-tts-instruct-flash`，把 `instructions` / `optimize_instructions` 发送到旧语音协议 | 移除已下线 instruct 模型，旧节点提交时明确拒绝。保留官方仍列出的 `qwen3-tts-flash`，拒绝 `instruction`，也拒绝通过 `extra` 绕过。依据 [TTS 模型表](https://help.aliyun.com/zh/model-studio/tts-model)、[Qwen-TTS API](https://help.aliyun.com/zh/model-studio/qwen-tts-api)及参考仓库已审查下线记录。 |
| 方舟     | 视频返回尾帧固定标为 `image/png`                                                                    | 改为官方约定的 `image/jpeg`；回归测试检查 MIME 与 URL。[创建任务](https://docs.volcengine.com/docs/ark/create-video-generation-task-api?lang=zh)的 `return_last_frame` 明确规定 JPEG。                                                                                                                |
| 方舟     | Lite 组图模型没有生命周期提示                                                                       | 目录描述与指南注明停止新购，以及计划 EOS：2026-11-24 14:00（UTC+8）。保留现有接入，不自动换成能力不同的 Pro / Flash。[下线公告](https://docs.volcengine.com/docs/ark/model-deprecation-notice?lang=zh)中的 `doubao-seedream-5-0-260128` 与 `doubao-seedream-5-0-lite-260128` 同属此计划。             |
| 对接指南 | 写成只有百炼使用共享对话实现，豆包复刻只能参考社区资料                                              | 更新为百炼与方舟共享流式实现、MiniMax 独立非流式实现；补上本轮已取得的豆包复刻及查询官方来源，删除过时的来源限制描述。                                                                                                                                                                                |

## 当前协议映射

下表是现有实现对应的协议边界。端点路径相同并不代表不同模型的字段、地域和限制相同。

| 平台 / 能力         | 端点与请求格式                                                                                                                            | 响应与限制                                                                                                                                                                        |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MiniMax 对话        | `POST /v1/chat/completions`；`messages`，`stream=false`，`max_completion_tokens`                                                          | `choices[].message.content`；本地校验 JSON Schema，不发送平台强制 Schema 参数。M2.7 纯文本，M3 可带图片。                                                                         |
| MiniMax 图片        | `POST /v1/image_generation`；人物参考为 `subject_reference[].image_file`                                                                  | `data.image_urls`；最多一张人物参考，不能把普通多图编辑接口格式套入。                                                                                                             |
| MiniMax H3 视频     | `POST /v2/video_generation`；`content[]` 内按 `type` 放 `image_url` / `video_url` / `audio_url` 对象，`role` 区分首尾帧和参考素材         | `task_id` → `GET /v2/query/video_generation/{id}` → `task.content.url`。不是 V1 的 `file_id` 下载协议。本地参考使用官方允许的 Data URI，不要求照抄 MCP 的 `mm_file://` 上传策略。 |
| MiniMax 音频 / 复刻 | `POST /v1/t2a_v2`、`/v1/music_generation`；复刻先 multipart `/v1/files/upload`，再 `/v1/voice_clone`                                      | 合成音频为 hex，不能当 Base64 解码；复刻上传用途为 `voice_clone`。音乐的历史开放限制继续保留。                                                                                    |
| 豆包 TTS            | `POST /api/v3/tts/unidirectional`；`req_params.text/speaker/audio_params`，`additions` 为 JSON 字符串                                     | HTTP chunked JSON，处理 `data:null` 结束包，并要求完成码 `20000000`；请求 PCM 后统一包成 WAV，不能给每块 PCM 单独加头。                                                           |
| 豆包 Seed Audio     | `POST /api/v3/tts/create`；顶层 `model/text_prompt/audio_config`                                                                          | 顶层 `audio` 是 Base64；不能套用 TTS 的 `data` 字段或 MiniMax 的 hex。时长是提示词软约束。                                                                                        |
| 豆包识别            | `POST /api/v3/auc/bigmodel/recognize/flash`；`audio.data/format` + `request.model_name`，`X-Api-Sequence=-1`                              | 业务状态看响应头及正文；无有效语音 `20000003` 返回空文本。分句时间从毫秒换成 SDK 的秒。                                                                                           |
| 豆包复刻            | `POST /api/v3/tts/voice_clone`；`speaker_id`、`audio.data/format`、`extra_params`；查询 `/api/v3/tts/get_voice`                           | 官方状态 0/1 继续查询、2/4 可合成、3 失败；Plein 当前只支持控制台分配的 `S_` 音色。新 API Key 或旧 App/Access Key 鉴权按现有配置选择。                                            |
| 百炼对话            | `POST /compatible-mode/v1/chat/completions`；共享 AI SDK 转换消息、工具调用和 SSE                                                         | 要求 `[DONE]`；JSON mode 与本地 Schema 校验不能宣称平台强制 Schema。                                                                                                              |
| 百炼图片            | `POST /api/v1/services/aigc/multimodal-generation/generation`；`input.messages[].content[]`，`parameters.size` 为 `宽*高`                 | `output.choices[].message.content[].image`。当前使用 DashScope 原生协议；不能混用 OpenAI Images 的顶层 `image`、`宽x高` 及 `data[]` 响应。                                        |
| 百炼视频            | `POST /api/v1/services/aigc/video-generation/video-synthesis`；`input.media[]`、`parameters`，异步头 `X-DashScope-Async: enable`          | `output.task_id` → `/api/v1/tasks/{id}`。本地素材通过目标模型的上传凭证变成 `oss://`，使用 `X-DashScope-OssResourceResolve: enable`。                                             |
| 百炼图像编辑 / 精修 | `POST /api/v1/services/aigc/image2image/image-synthesis`；`wanx2.1-imageedit`，`input.function/base_image_url`，蒙版另放 `mask_image_url` | 异步任务；局部重绘、超分和扩图是不同 `function`，不能套用 Qwen 图像消息格式。                                                                                                     |
| 百炼 TTS            | `qwen3-tts-flash` 使用 multimodal-generation；`input.text/voice/language_type`                                                            | `output.audio.url`，保留签名将官方 HTTP OSS 结果改为 HTTPS。Qwen-Audio-TTS 的 `/api/v1/services/audio/tts/SpeechSynthesizer`、单数 `input.instruction` 属独立协议，当前未接入。   |
| 方舟对话            | `POST /api/v3/chat/completions`；共享流式实现                                                                                             | Chat Completions 的 `messages` 与 Responses 的 `input[]` 是不同协议；参考 MCP 对 Responses 历史消息的修正不应复制进此实现。                                                       |
| 方舟图片 / 抠图     | `POST /api/v3/images/generations`；`response_format=b64_json`，抠图使用 `layer_decomposition=true`、`output_format=png`                   | 普通生成按返回格式标记 MIME；抠图读取 `z_index/bounding_box`，背景层不作为主体候选。5.0 不支持 seed。                                                                             |
| 方舟视频            | `POST /api/v3/contents/generations/tasks`；`content[]`，音频开关为 `generate_audio`                                                       | 顶层 `id` → 查询任务 → `content.video_url/last_frame_url`；尾帧 JPEG。本地图片和音频可 Data URI；本地视频尚未上传素材库，因此提交前阻断。                                         |

## 来源与验证

[官方正文抓取记录](../benchmarks/2026-10-24-provider-doc-sources.json)保留来源 URL、实际读取地址、正文大小和 SHA-256，以及参考仓库提交号。火山页面的 HTML 壳不算正文，使用官方站点自身 `getDocDetail` 的 `Result.MDContent`；阿里云与 MiniMax 使用官方 `.md` 导出。个别请求发生 SSL 中断，经另一轮读取取得正文，回执单列最后一次失败，不将网络失败解释为模型不可用。

参考仓库的 `docs/audits/{volcengine-ark,ali-bailian,doubao-speech}.md`、`docs/minimax-contracts.md` 和四个平台实现用于交叉核对；官方正文决定字段契约，参考实现提供已发现问题和恢复边界。

Provider 测试共 232 项通过，Provider 包类型检查通过；插件宿主集成测试 34 项通过（首次被沙箱禁止监听 127.0.0.1，开放本机监听后通过）。代码格式、lint、Markdown lint 与 `git diff --check` 通过。本轮 Provider 回归覆盖四家参数映射、素材编码、流结束条件、业务错误、取消和任务查询；新增检查拒绝下线 instruct 模型及额外语气字段，强化尾帧 MIME 断言。运行命令：

```sh
pnpm exec vp test run packages/providers/src
pnpm --filter @plein/providers typecheck
pnpm exec vp test run apps/server/src/plugins/plugins.test.ts
```

本地通过不等于真实云端验收。没有新增幂等能力或自动重试生成 POST；`submit_unknown` 与已有远端任务 ID 的恢复规则继续保留。
