# 模型平台接入

四家平台以内置服务端插件的形式加载，默认关闭，在设置页填好配置后启用。节点里能选哪些模型，由平台自己声明。服务端不替节点挑模型：每种能力（文本、图像、视频、配音、配乐、音效、识别）在「设置 → 模型平台 → 默认模型」里有一个默认模型，新建节点时写进节点，节点上可以另选。还没设默认模型时，启用平台后取它支持该能力的第一个模型并记住，之后再启用别的平台不会改；默认模型所在的平台停用后，换成仍启用的平台里的第一个。打开旧画布时，模型留空的节点补成当前默认模型。生成走的是各平台的按量计费 API，模型出现在目录里，不代表你的账号已经开通了它的权限。

| 平台 / Provider ID       | 已接入能力                                                                                                   | 密钥                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| MiniMax `minimax/api`    | M3 / M2.7 对话、image-01 图片、H3 / Highspeed / Lite / Max 视频、speech-2.8 配音、声音复刻、Music 3.0 纯音乐 | `MINIMAX_API_KEY`                                                         |
| 豆包语音 `doubao/speech` | TTS 2.0、声音复刻 2.0、Seed Audio 音乐 / 音效、极速录音识别                                                  | `VOLC_SPEECH_API_KEY`，或 `VOLC_SPEECH_APP_ID` + `VOLC_SPEECH_ACCESS_KEY` |
| 百炼 `aliyun/bailian`    | 千问对话、Qwen Image / 万相图片、万相局部重绘、Wan 3.0 视频、Qwen TTS                                        | `DASHSCOPE_API_KEY`                                                       |
| 方舟 `volc/ark`          | Seed 对话、Seedream 图片、Seedance 视频                                                                      | `ARK_API_KEY`                                                             |

## 配置

1. 在设置页填写平台的密钥、地域等信息，点击保存。
2. MiniMax / 方舟可以「测试连接」：分别调用模型列表 / 视频任务列表接口，不会触发生成。测试通过，也不代表每个模型都能用。
3. 百炼 / 豆包只提供「检查配置」：只校验本地凭据，并明确告诉你远端密钥、网络、模型权限和余额都还没验证。
4. 启用平台，然后在图片、视频、配音等节点里选模型、运行。选择器支持按平台、模型名称或 ID 搜索，标出默认模型，并按当前用户记住最近六个选择。设置页的「已配置」仅表示所需配置完整；远端调用是否可用仍以连接检查和实际任务回执为准。密钥由宿主保存，不会写进画布。

MiniMax 默认走中国区 `api.minimax.cn`，也可以选国际区 `api.minimax.io`，密钥要和地域对应。百炼支持北京、新加坡、美国三个地域；业务空间 ID 留空时，使用该地域的 DashScope 兼容端点。方舟默认北京地域；要用自定义模型，先在平台设置里填好模型 / Endpoint ID，再在模型列表里选「自定义」。

## 接口实现

适配器以官方接口文档为契约，直接调用宿主提供的 `ctx.fetch`，没有引入云厂商 SDK。这样域名许可、密钥访问、资产归属、取消信号和异步任务轮询都由宿主统一把关。每个平台各自声明模型、设置、密钥和所需的最小网络权限；生成的产物经宿主写入资产库。

OpenAI 兼容的对话（`text.chat`）共用 `packages/providers/src/shared/llm.ts`。它基于 Vercel AI SDK（`ai` + `@ai-sdk/openai-compatible`），负责消息转换、流式读取、按请求里的 JSON Schema 校验结构化输出（zod `fromJSONSchema`），以及用量归一化。鉴权、端点，以及 HTTP 错误码和流内错误码的归类与脱敏，仍由各平台适配器通过传入的 `fetch` 和 `streamError` 负责；请求一律不重试。百炼和火山方舟已接入这一层，支持流式文字回调和工具调用；MiniMax 对话仍使用独立的非流式请求实现。

SDK 新增了两个字段：`testScope` 用来标出「只检查本地配置」，`credentialAlternatives` 用来表达豆包的新旧两种鉴权方式；只有某一组凭据填完整时，目录里的 `configured` 才为真。宿主发送取消请求时使用独立的 10 秒信号，避免已取消的生成请求把远端取消请求也一起拦下。

## 能力边界

- 生成视频节点的模式由用户在生成器里指定：文生视频、图生视频（第 1 张图作首帧）、仅尾帧（1 张图作结束画面）、首尾帧（第 1、2 张图）、多模态参考（按类型送入图片、视频和音频）。连入图片按参考槽位的明确顺序编号；移动上游节点不会改变顺序，拖动缩略图或点击前移/后移才会重排。替换保留原槽位，点击缩略图可以预览。旧画布首次迁移时按原来的空间顺序固化一次。图片数和模式对不上时提交前拦下。视频提示词里 `@` 资产卡时，只有多模态参考模式会把参考图并入，其他模式只附文字设定并给出提示。参考图上限：Seedance 2.5 为 30 张，2.0 系列为 9 张，万相为 10 张，MiniMax H3 为 9 张。「生成音频」是通用开关：Seedance 传 `generate_audio`，万相传 `audio`，MiniMax H3 不支持（隐藏）。生成数量按条数并行提交。
- MiniMax H3 使用 V2：H3 为 4–15 整数秒、768P / 2K；H3-Max 为 5–15 秒、480P / 768P。首尾帧与参考素材互斥，V2 不支持 seed。此适配器支持图片、视频与音频参考，分别按官方类型和用途提交，本地素材经宿主读取和编码。M2.7 对话仅支持纯文本；当前 MiniMax 对话适配器不支持强制 JSON Schema。
- MiniMax 图片仅支持单张人物参考图；MiniMax 配音不支持自由语气指令，可通过 `extra.emotion` 指定官方情绪，或使用豆包语音。
- Music 3.0 当前生成纯音乐，时长由模型决定。该旧音乐 API 可能仅向原付费用户开放；2026-10-12 本机账号实测返回 HTTP 410。Seed Audio 的目标时长写入提示词，属于软约束。豆包返回内嵌音频，暂不支持仅返回 URL 的音频产物。
- 百炼 Wan 3.0 的本地参考素材通过官方上传凭证上传 OSS，再交给生成接口。局部重绘（`image.edit`）用万相通用图像编辑 `wanx2.1-imageedit` 的 `description_edit_with_mask`：原图和蒙版（黑底白区，与原图同尺寸）同样走 OSS 上传，异步任务；目前只有它原生支持蒙版，方舟和 MiniMax 不声明这项能力，界面不会用整图重绘或裁切贴回冒充。还没做真实平台验收。千问配音当前只接入 `qwen3-tts-flash`，不支持自然语言语气指令，单次文本最多 600 字符。已下线的 `qwen3-tts-instruct-flash` 不再列出，旧节点提交时在本地拒绝；不自动替换模型。Qwen-Audio-TTS 使用独立的 `SpeechSynthesizer` 协议，当前尚未接入。对话 JSON Schema 以 JSON mode + 提示词表达，当前不保证强制符合 Schema。
- 方舟支持本地图片和音频编码为 data URL；本地视频参考仍需平台素材库上传，当前不声明这项能力，界面会在提交前阻断并提示使用支持本地视频的其他模型。Seedream 的画幅映射为对应模型支持的尺寸；Lite 支持组图，但已停止新购，官方计划于 2026-11-24 14:00（UTC+8）关停 `doubao-seedream-5-0-260128` / `doubao-seedream-5-0-lite-260128`；目录保留现有接入并显示迁移提示。Pro / Flash 只支持单图，不能直接替代组图能力。Seedream 5 不支持 seed。
- MiniMax / 方舟仅对排队任务尝试远端取消；运行中任务无法由此接口取消。取消前查询状态，避免对已完成任务调用兼具删除语义的接口。百炼取消受官方排队状态限制。
- 不自动重试生成 POST；网络断开或缺少 task ID 时不得假定提交失败。宿主通过任务 journal 将异步 ID 存入 SQLite `jobs.calls`，重启后对已记录的 pending 调用继续轮询；机制已有源码实现，真实平台跨进程恢复仍需端到端验收。
- 提交后没收到回应时任务记为「提交结果未知」。内置真实平台都没有声明按幂等键查询（`lookup`）或幂等提交（`idempotent`），这时只能在任务面板人工核查：填平台控制台里查到的任务 ID 接着取结果，或确认未受理后重新提交（可能重复计费）。mock 平台实现了 `lookup`，用来测试自动核查。
- 平台已生成、下载或保存失败时，调用记录留着结果（内嵌字节 16 MB 以内）或远端任务 ID，任务面板可「重新获取」；结果地址返回 401 / 403 / 404 / 410 时先重新查询平台拿新地址，平台不支持查询时如实提示无法取回。
- `audio.transcribe` 和 `audio.sfx` 已有专门的识别 / 音效节点，音效可从分镜展开并接入序列；音色设计和实时语音不在此次接入范围。

## 声音复刻

资产库的「音色」页管理自己的音色：上传一段样本在平台上复刻（会计费），或登记平台控制台里已有的音色 ID（不调用平台）。音色只能在同一家平台的配音模型里用，复刻好的音色出现在角色卡和配音节点的音色下拉里，标为「我的」。从 Plein 删除音色不会删除平台上的音色。

复刻不是模型能力，而是 Provider 上可选的 `voiceClone`：`voiceId` 说明音色 ID 由用户填（`slot`）还是由宿主生成（`generated`），`clone` 提交样本，`status` 查训练状态。训练状态不另起后台任务，拉音色列表时顺手查训练中的音色（同一音色至少隔 15 秒），也可以手动刷新，重启后照常接着查。

- MiniMax：先 `POST /v1/files/upload`（`purpose=voice_clone`，multipart）拿 `file_id`，再 `POST /v1/voice_clone`，成功即可用。音色 ID 由宿主生成（字母开头、小写字母和数字）。需要实名认证，未认证时平台返回 2038，按鉴权失败报出。样本 10 秒至 5 分钟、MP3 / M4A / WAV、20 MB 以内，时长和大小在上传前拦下。复刻出的音色 7 天内没用于正式合成会被平台删除。
- 豆包：音色 ID 要填控制台开通声音复刻后分配的 `S_` 开头 ID，同一 ID 再上传会重新训练。`POST /api/v3/tts/voice_clone` 提交样本（base64，开启降噪），`POST /api/v3/tts/get_voice` 查状态：1 训练中，2、4 可用，3 失败。样本 WAV / MP3 / OGG / M4A / AAC、10 MB 以内。配音时音色以 `S_` 开头就自动走 `seed-icl-2.0` 资源，即使节点选的是合成 2.0。本轮已通过官方文档站的 `getDocDetail` 取得[声音复刻](https://docs.volcengine.com/docs/DoubaoVoice/tone-training-http?lang=zh)和[状态查询](https://docs.volcengine.com/docs/DoubaoVoice/tone-query-http?lang=zh)正文，字段及状态枚举与当前实现相符；尚未进行本轮云端训练验证。

## 验证与官方来源

2026-10-24 按四个平台的官方正文核对了当前接入范围：移除百炼已下线的 instruct 模型和语气字段，方舟尾帧改为 JPEG MIME，并注明 Seedream Lite 下线日期。逐平台的端点与请求结构见[平台协议映射](../dev/provider-protocols.md)。

契约测试用模拟的 HTTP 响应，覆盖节点参数映射、二进制素材和音频、业务错误、任务状态、取消和权限清单；宿主集成测试检查插件目录、默认禁用状态、鉴权配置与取消信号。这些测试证明不了账号有没有模型权限，也证明不了云端的实际生成效果。

2026-10-12，经用户授权，迁入本机 MCP 共享环境中的密钥，并进行了一轮云端生成实测。配置保存在被 Git 忽略的 `data/providers.json`（权限 600）；每次调用的回执、生成成功的资产和账号权限限制，记在本机的 `data/provider-smoke-2026-10-12.json`。真实响应暴露出的几处问题都已兼容：豆包结束包里的 `data:null`、百炼 OSS 音频需要从 HTTP 改走 HTTPS 下载，以及 MiniMax 图片的 OSS 域名。

- MiniMax：[对话](https://platform.minimax.cn/docs/api-reference/text-chat-openai)、[图片](https://platform.minimax.cn/docs/api-reference/image-generation-t2i)、[H3 V2](https://platform.minimax.cn/docs/api-reference/video-generation-v2-create)、[配音](https://platform.minimax.cn/docs/api-reference/speech-t2a-http)、[音乐](https://platform.minimax.cn/docs/api-reference/music-generation)。
- 豆包：[HTTP 配音](https://docs.volcengine.com/docs/DoubaoVoice/unidirectional-streaming-text-to-speech-http?lang=zh)、[Seed Audio](https://docs.volcengine.com/docs/DoubaoVoice/audio-generation-http?lang=zh)、[极速识别](https://www.volcengine.com/docs/6561/1631584?lang=zh)。
- 百炼：[Qwen Image](https://help.aliyun.com/zh/model-studio/qwen-image-generation-and-editing-api-reference)、[Wan 3.0](https://help.aliyun.com/zh/model-studio/wan3-video-generation-api-reference)、[通用图像编辑](https://help.aliyun.com/zh/model-studio/wanx-image-edit)、[Qwen TTS](https://help.aliyun.com/zh/model-studio/qwen-tts-api)、[异步任务](https://help.aliyun.com/zh/model-studio/manage-asynchronous-tasks)。
- 方舟：[模型列表](https://docs.volcengine.com/docs/ark/model-list?lang=zh)、[图片](https://docs.volcengine.com/docs/ark/image-generation-api?lang=zh)、[视频](https://docs.volcengine.com/docs/ark/create-video-generation-task-api?lang=zh)。

## 图片精修与多模态参考

“图片精修”使用独立的 `image.process` 能力。百炼万相 `wanx2.1-imageedit` 支持原生 `super_resolution` 与 `expand`，方舟 Seedream Pro / Flash 支持 `layer_decomposition` 拆出透明 PNG 候选。不同模型只显示实际支持的操作；原始素材和旧候选保留。局部重绘仍使用 `image.edit` 蒙版合同。

视频生成的“多模态参考”模式可接图片、视频和音频。MiniMax H3 系列和百炼万相接入本地视频 / 音频；方舟的本地视频通过私有 TOS 桶上传后使用限时签名 URL，图片与音频仍使用 Base64。方舟视频参考需要额外配置 TOS，缺少配置时阻断，不发送视频 Base64。图片、视频、音频均在生成前展示实际输入，模型不支持、数量/格式/尺寸/时长超限会阻断。各模型限制不同，不用一个平台的约束替代另一个平台。

本轮按公开接口实现并通过模拟 HTTP 契约测试，未据此宣称所有账户权限、透明边缘质量、扩图自然度或声画参考效果已经真实平台验收。

MiniMax H3 / H3-Max 的首帧、仅尾帧、首尾帧图片与参考图片使用相同的格式、大小、尺寸和宽高比检查：JPEG / PNG / WEBP / HEIC / HEIF，单张不超过 30 MB，宽高 256–5760 像素，宽高比 0.4–2.5。首尾帧模式不能混入参考图片、视频或音频。参考视频仅支持 MP4 / MOV，H.264 / H.265 视频流、AAC / MP3 音轨（允许无音轨），帧率 23.976–60 fps；编码与帧率由宿主从原文件探测，无法读取时提交前阻断，请检查 ffprobe 和素材完整性。视频最多 3 段、单段不超过 50 MB；音频仅支持 WAV / MP3，最多 3 段、单段不超过 15 MB。视频和音频均须每段 2–15 秒，且各类总时长分别不超过 15 秒；参考图片最多 9 张。素材经 Base64 编码后仍受总请求体 64 MB 限制。

### MiniMax 与火山方舟参考模式对齐

| 模型                       | 参考图 | 参考视频 | 参考音频 | 单独音频参考     | 输出                 |
| -------------------------- | ------ | -------- | -------- | ---------------- | -------------------- |
| H3                         | 9 张   | 3 段     | 3 段     | 支持             | 4–15 秒，768P / 2K   |
| H3-Highspeed               | 9 张   | 3 段     | 3 段     | 支持             | 4–15 秒，768P        |
| H3-Lite                    | 9 张   | 3 段     | 3 段     | 支持             | 4–15 秒，480P / 768P |
| H3-Max                     | 9 张   | 3 段     | 3 段     | 支持             | 5–15 秒，480P / 768P |
| Seedance 2.0 / Fast / Mini | 9 张   | 3 段     | 3 段     | 需搭配图片或视频 | 4–15 秒              |
| Seedance 2.5               | 30 张  | 10 段    | 10 段    | 支持             | 4–30 秒              |

H3 系列开放 21:9；参考模式可选智能画幅，Lite 参考模式与全部 H3 文生视频仍须具体画幅。MiniMax 始终要求非空提示词；Seedance 有首帧或参考素材时允许留空。模型目录只声明接口能力，不代表账号已开通。

参考输入按图片、视频、音频分组，各类从 1 编号。点击素材下方的 `@image1` / `@video1` / `@audio1` 可将编号插入提示词末尾；也支持手写 `@图片1` / `@视频1` / `@音频1`。编号指当前同类输入槽位，重排会改变该槽位对应的素材；替换保留槽位。引用越界时前后端阻断。服务端会转换为各平台的提示词写法，实际输入预览展示转换后的提示词；这些编号不参与画布元素的同名匹配。

`@角色名`、`@场景名` 等现有引用保持原有行为；在 MiniMax / 方舟参考模式下，服务端按最终合并、去重后的参考图顺序追加名字到素材编号的对应关系。编号映射在每次预览和执行前重建，不写回用户提示词。

#### 火山视频参考的 TOS 配置

在「设置 → 模型平台 → 火山方舟」填写视频参考 TOS 桶、地域，以及 TOS Access Key / Secret Key。密钥仅进入平台配置，不写入画布或提示词；TOS 密钥须能对该私有桶的 `plein/video-references/` 前缀执行 PutObject / GetObject。地域填写桶的实际地域，默认 `cn-beijing`。普通文字、图片和音频参考不需要 TOS 配置。

本地原件经宿主鉴权读取和 ffprobe 检查后，上传到 `plein/video-references/<内容 SHA-256>.mp4`（或 `.mov`）；同一内容复用对象键。使用官方 TOS SDK 在本地签名，上传仍经过宿主网络权限和取消信号。上传签名有效期 15 分钟，生成请求内的读取签名有效期 7 天，以覆盖排队；不要求开放桶公共读。上传失败明确记录为生成尚未提交；生成受理后的恢复仍保留远端任务 ID，不重复提交。

签名到期不会删除对象。建议由桶生命周期清理 `plein/video-references/`，保留时间需覆盖七天签名及生成窗口；Plein 不创建桶、不更改桶权限或生命周期，也不会在生成受理后立即删除参考视频。

方舟参考视频支持 MP4 / MOV，H.264 / H.265，24–60 fps；单个文件不超过 200 MB，宽高 300–6000 像素、宽高比 0.4–2.5，总像素 407696–8295044。音轨须为 AAC / MP3，MOV 另支持 PCM，可无音轨。2.0 系列视频与音频各类总时长分别不超过 15 秒；2.5 分别不超过 30 秒，每段至少 2 秒。视频传 URL，避免因 Base64 膨胀触发 64 MB 请求限制；图片和音频仍受该总请求限制。

#### Seedance 2.5 参考任务

「参数 → 更多参数 → 参考任务」支持自动判断、生成新视频、编辑参考视频、延长参考视频。编辑与延长必须有参考视频。编辑自动使用智能画幅、保持原视频时长（接口 `ratio=adaptive`、`duration=-1`），参考视频至少 4 秒；延长自动使用智能画幅。其余任务可启用「自动时长」，由模型决定时长。自动控制的时长、画幅不再显示为可手动修改的字段。提示词仍需表达对应编辑或延长意图，最终任务识别和限制以平台响应为准。

官方契约：[MiniMax H3 V2](https://platform.minimax.io/docs/api-reference/video-generation-v2-create)、[Seedance 创建任务](https://docs.volcengine.com/docs/ark/create-video-generation-task-api?lang=zh)、[Seedance 2.5 任务约束](https://docs.volcengine.com/docs/ark/seedance-2-5?lang=zh)、[TOS 官方 SDK](https://github.com/volcengine/ve-tos-js-sdk)。本轮验证范围和回执见 [多模态参考验收记录](../video-reference-alignment.md)。

模型菜单按已实现的输入模式禁用不支持的选项；例如方舟和万相不开放仅尾帧，服务端预览也会阻断。MiniMax 首帧 / 尾帧以及 Seedance 2.5 首帧 / 首尾帧自动跟随输入画幅。存在角色等软引用时，素材编号与搭配限制由服务端根据最终展开的素材校验，避免用尚未展开的图片数量误拦。
