# 平台协议映射

四个内置 Provider 的端点、请求字段层级、素材编码与响应格式。字段契约以官方接口正文为准，改动适配器时同步更新本表；面向使用者的能力与限制见[模型平台接入](../guide/providers.md)。

下表是现有实现对应的协议边界。端点路径相同并不代表不同模型的字段、地域和限制相同。

| 平台 / 能力         | 端点与请求格式                                                                                                                            | 响应与限制                                                                                                                                                                                               |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MiniMax 对话        | `POST /v1/chat/completions`；`messages`，`stream=false`，`max_completion_tokens`                                                          | `choices[].message.content`；本地校验 JSON Schema，不发送平台强制 Schema 参数。M2.7 纯文本，M3 可带图片。                                                                                                |
| MiniMax 图片        | `POST /v1/image_generation`；人物参考为 `subject_reference[].image_file`                                                                  | `data.image_urls`；最多一张人物参考，不能把普通多图编辑接口格式套入。                                                                                                                                    |
| MiniMax H3 视频     | `POST /v2/video_generation`；`content[]` 内按 `type` 放 `image_url` / `video_url` / `audio_url` 对象，`role` 区分首尾帧和参考素材         | `task_id` → `GET /v2/query/video_generation/{id}` → `task.content.url`。不是 V1 的 `file_id` 下载协议。本地参考使用官方允许的 Data URI。                                                                 |
| MiniMax 音频 / 复刻 | `POST /v1/t2a_v2`、`/v1/music_generation`；复刻先 multipart `/v1/files/upload`，再 `/v1/voice_clone`                                      | 合成音频为 hex，不能当 Base64 解码；复刻上传用途为 `voice_clone`。音乐的历史开放限制继续保留。                                                                                                           |
| 豆包 TTS            | `POST /api/v3/tts/unidirectional`；`req_params.text/speaker/audio_params`，`additions` 为 JSON 字符串                                     | HTTP chunked JSON，处理 `data:null` 结束包，并要求完成码 `20000000`；请求 PCM 后统一包成 WAV，不能给每块 PCM 单独加头。                                                                                  |
| 豆包 Seed Audio     | `POST /api/v3/tts/create`；顶层 `model/text_prompt/audio_config`                                                                          | 顶层 `audio` 是 Base64；不能套用 TTS 的 `data` 字段或 MiniMax 的 hex。时长是提示词软约束。                                                                                                               |
| 豆包识别            | `POST /api/v3/auc/bigmodel/recognize/flash`；`audio.data/format` + `request.model_name`，`X-Api-Sequence=-1`                              | 业务状态看响应头及正文；无有效语音 `20000003` 返回空文本。分句时间从毫秒换成 SDK 的秒。                                                                                                                  |
| 豆包复刻            | `POST /api/v3/tts/voice_clone`；`speaker_id`、`audio.data/format`、`extra_params`；查询 `/api/v3/tts/get_voice`                           | 官方状态 0/1 继续查询、2/4 可合成、3 失败；支持预付费 `S_` 与后付费自定义音色，后付费使用 `speaker_id=custom_speaker_id` 并另传 `custom_speaker_id`。新 API Key 或旧 App/Access Key 鉴权按现有配置选择。 |
| 百炼对话            | `POST /compatible-mode/v1/chat/completions`；共享 AI SDK 转换消息、工具调用和 SSE                                                         | 要求 `[DONE]`；JSON mode 与本地 Schema 校验不能宣称平台强制 Schema。                                                                                                                                     |
| 百炼图片            | `POST /api/v1/services/aigc/multimodal-generation/generation`；`input.messages[].content[]`，`parameters.size` 为 `宽*高`                 | `output.choices[].message.content[].image`。当前使用 DashScope 原生协议；不能混用 OpenAI Images 的顶层 `image`、`宽x高` 及 `data[]` 响应。                                                               |
| 百炼视频            | `POST /api/v1/services/aigc/video-generation/video-synthesis`；`input.media[]`、`parameters`，异步头 `X-DashScope-Async: enable`          | `output.task_id` → `/api/v1/tasks/{id}`。本地素材通过目标模型的上传凭证变成 `oss://`，使用 `X-DashScope-OssResourceResolve: enable`。                                                                    |
| 百炼图像编辑 / 精修 | `POST /api/v1/services/aigc/image2image/image-synthesis`；`wanx2.1-imageedit`，`input.function/base_image_url`，蒙版另放 `mask_image_url` | 异步任务；局部重绘、超分和扩图是不同 `function`，不能套用 Qwen 图像消息格式。                                                                                                                            |
| 百炼 TTS            | `qwen3-tts-flash` 使用 multimodal-generation；`input.text/voice/language_type`                                                            | `output.audio.url`，保留签名将官方 HTTP OSS 结果改为 HTTPS。Qwen-Audio-TTS 的 `/api/v1/services/audio/tts/SpeechSynthesizer`、单数 `input.instruction` 属独立协议，当前未接入。                          |
| 方舟对话            | `POST /api/v3/chat/completions`；共享流式实现                                                                                             | Chat Completions 的 `messages` 与 Responses 的 `input[]` 是不同协议；参考 MCP 对 Responses 历史消息的修正不应复制进此实现。                                                                              |
| 方舟图片 / 抠图     | `POST /api/v3/images/generations`；`response_format=b64_json`，抠图使用 `layer_decomposition=true`、`output_format=png`                   | 普通生成按返回格式标记 MIME；抠图读取 `z_index/bounding_box`，背景层不作为主体候选。5.0 不支持 seed。                                                                                                    |
| 方舟视频            | `POST /api/v3/contents/generations/tasks`；`content[]`，音频开关为 `generate_audio`                                                       | 顶层 `id` → 查询任务 → `content.video_url/last_frame_url`；尾帧 JPEG。本地图片和音频可 Data URI；本地视频尚未上传素材库，因此提交前阻断。                                                                |
| 方舟 Agent Plan     | 图片 / 视频改用 `/api/plan/v3` 前缀，路径和请求体同上；`model` 换成套餐预置名（如 `doubao-seedance-2.5`），Bearer 用 Agent Plan 专属 Key  | `volc/ark-plan` 独立平台，模型 ID 与按量平台一致，查询 / 取消任务同样走套餐前缀。套餐文本模型禁止 API 调用，样片模式不支持，均在提交前阻断。                                                             |
| 方舟视频参考存储    | TOS 用官方 SDK 预签名；S3 兼容存储用 SigV4 查询串预签名，`PUT` 附 `x-amz-content-sha256: UNSIGNED-PAYLOAD`                                | 上传 15 分钟、读取 7 天签名；宿主按设置只额外放行上传主机。方舟只接受公网视频 URL 或预置 `asset://` 素材，不接受视频 Base64。                                                                            |

音色设计使用独立的 `voiceDesign` 能力：豆包 `POST /api/v3/tts/voice_design` 的提示词为 `prompt.text_prompt` / `prompt.image_prompt.image_bytes`，试听为顶层 `text`，槽位为 `speaker_id`；MiniMax `POST /v1/voice_design` 使用顶层 `prompt` / `preview_text` / `voice_id`，响应 `trial_audio` 是 hex。豆包设计与复刻共用状态查询，MiniMax 设计同步返回音色 ID。详细限制及官方来源见[音色设计与声音复刻](../guide/providers.md#音色设计与声音复刻)。

MiniMax 复刻的主音频上传用途为 `voice_clone`（10–300 秒）；增强参考用途为 `prompt_audio`（小于 8 秒），对应 `clone_prompt.prompt_audio` 与 `clone_prompt.prompt_text`。可选试听同时发送 `text` 和 `model`。两家的降噪与归一化不再写死，默认关闭；豆包 `disable_volume_normalization` 与界面开关反向映射。短样本建议与平台硬性限制分别处理。

本地契约测试：

```sh
pnpm exec vp test run packages/providers/src
pnpm --filter @plein/providers typecheck
pnpm exec vp test run apps/server/src/plugins/plugins.test.ts
```

本地通过不等于真实云端验收。生成类 POST 不自动重试，`submit_unknown` 与已有远端任务 ID 的恢复规则不变。
