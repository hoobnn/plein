# 动态合成

Plein 的内置 `plein/motion` 节点使用本机合成渲染 SDK 渲染 HTML 动态合成，输出 MP4，并保存对应的源工程 ZIP、来源清单和原素材依赖。当前固定使用 `@hyperframes/producer`、`@hyperframes/sdk`、`@hyperframes/player` 0.8.186；渲染参数是 30 fps、`standard`、MP4、`strict`，单个 worker 内 `workers: 1`。

模板与参数合同见 [motion.ts](../../packages/nodes/src/motion.ts)，执行与物化见 [render.ts](../../apps/server/src/motion/render.ts)。

## 当前支持

| 模板          | 节点用途                                 | 消费的素材               |
| ------------- | ---------------------------------------- | ------------------------ |
| `title`       | 片头、章节卡：标题、副标题、强调线和背景 | 文本与颜色参数           |
| `character`   | 图片角色介绍                             | `image` 端口的第一张图片 |
| `video-title` | 给视频加标题包装                         | `video` 端口的第一段视频 |

两个素材端口都可为空；缺少匹配素材时保留模板布局占位。模板只显示与自身匹配的素材类型。

- 时长为 1–30 秒，时间按 30 fps 量化；画幅为 `9:16` 或 `16:9`，分辨率为 `720p` 或 `1080p`。
- 标题、副标题各最多 1000 字符。可编辑字段包括受限的文字、样式和出现/结束时间；长文字可用字号、位置、宽度覆盖排版。当前没有自动文字适配合同。
- `video-title` 支持非负 `sourceIn`、0.25–4 倍 `speed`，以及 `audio: mute | source`。素材门禁按量化后的 `hf-media` 可见窗口计算 `sourceIn + visibleDuration × speed`，可见窗口可以短于整段合成。
- 渲染器接收 PNG、JPEG、WebP、AVIF、GIF 图片，以及 MP4、WebM、MOV 视频；实际解码取决于配置的 FFmpeg 和 Chrome。预览还要求浏览器能直接解码对应素材。
- 源文件物化阶段限制为 256 MiB，包含输入素材、字体和 GSAP。输入资产先经宿主拥有者与原文件完整性校验。

## 本机运行配置

以下命令在仓库根目录执行，依赖按 [CONTRIBUTING.md](../../CONTRIBUTING.md) 安装。把占位路径改为本机实际可执行文件路径；调试时使用独立数据目录。

```sh
export PLEIN_FFMPEG_PATH="$(command -v ffmpeg)"
export PLEIN_FFPROBE_PATH="$(command -v ffprobe)"
export PLEIN_HYPERFRAMES_CHROME_PATH='/absolute/path/to/chrome-headless-shell'
export PLEIN_DATA_DIR='/absolute/path/to/isolated-plein-data'

test -x "$PLEIN_FFMPEG_PATH"
test -x "$PLEIN_FFPROBE_PATH"
test -x "$PLEIN_HYPERFRAMES_CHROME_PATH"
pnpm dev
```

宿主可以发现部分已安装 Chrome 或 Puppeteer 缓存，但部署和验收应显式配置 `PLEIN_HYPERFRAMES_CHROME_PATH`。Chrome 必须预先可用；当前 stage 不附带 Chrome，worker 也不会自动下载浏览器。Electron 用来执行 Node worker，并不替代 Producer 需要启动的 Chrome。

宿主把 FFmpeg/FFprobe 解析为绝对路径，再通过 `HYPERFRAMES_FFMPEG_PATH`、`HYPERFRAMES_FFPROBE_PATH` 交给 worker；Chrome 路径通过 `PRODUCER_HEADLESS_SHELL_PATH` 传入。worker 使用任务自己的 `HOME`、临时目录与最小环境，不继承宿主的 Provider 凭据。

渲染前会枚举指定 FFmpeg 的编码器，并实际编码一帧。优先使用可工作的 `libx264`，否则探测渲染 SDK 支持的硬件编码器。macOS 随包 LGPL FFmpeg 没有 `libx264` 时，已验证的路径是 `h264_videotoolbox` 加 `-allow_sw 1`。系统 FFmpeg 可用不能代替随包二进制验收。

## 离线资源与许可

`motionRuntimeAssets()` 从安装包依赖定位 GSAP 3.14.2 与 `@fontsource/noto-sans-sc` 5.2.8。项目物化 `vendor/gsap.min.js`、字体 CSS、400/700 两种字重的全部 WOFF2 子集及许可说明；当前锁定版本共有 202 个 WOFF2 子集。字体 CSS 保留完整 `unicode-range`，移除重复 WOFF fallback，与 stage 只复制 WOFF2 的规则一致。

源工程中的素材、脚本与字体使用本地相对路径。DOM 检查分别审查资源属性、CSS、script 执行上下文，拒绝外部 URL、绝对路径、目录越界和联网脚本；普通转义标题文字中的 `fetch(...)` 或 `url(...)` 不会按代码执行。此合同只接受受限模板与结构化覆盖，不是任意 HTML/JavaScript 的执行沙箱。

| 资源                         | 已随资源保留的许可依据                                                                                                      |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 渲染 SDK（`@hyperframes/*`） | Apache-2.0，发布包的 `LICENSE`                                                                                              |
| Noto Sans SC                 | SIL Open Font License 1.1，源包内 `licenses/noto-sans-sc.txt`                                                               |
| GSAP                         | 包元数据指定的 [Standard License](https://gsap.com/standard-license/)，保留脚本版权头、`licenses/gsap-notice.md` 和包元数据 |
| 随包 FFmpeg                  | 桌面端 LGPL 构建与随附许可，准备方式见 [桌面端](desktop.md)                                                                 |

各资源适用各自许可；渲染 SDK 的 Apache-2.0 标签不覆盖全部第三方依赖。

## Worker 与 stage 打包

[server 构建配置](../../apps/server/vite.config.ts) 和 [stage-server.mjs](../../apps/desktop/scripts/stage-server.mjs) 都保留两个入口：

```text
server/main.mjs
server/motion/worker.mjs
server/node_modules/...
```

stage 保留渲染 SDK 发布包及其运行时依赖、GSAP、Noto Sans SC 和原生模块。复制过滤器必须保留 GSAP `README.md`、字体 400/700 CSS、对应 WOFF2 和许可文件；这些文件会在运行时读取。

```sh
node apps/desktop/scripts/stage-server.mjs
```

该命令准备 `apps/desktop/stage/server`。随包 FFmpeg/FFprobe 需要另行准备到 `apps/desktop/stage/ffmpeg`，构建方式见 [build-ffmpeg.sh](../../apps/desktop/scripts/build-ffmpeg.sh) 与 [桌面端](desktop.md)。

开发模式只在确实存在时使用 `worker.ts` 与 `tsx`。打包模式查找真实存在的 `worker.mjs` 或 `motion/worker.mjs`；缺失时报错，不回退到源码目录。Electron 路径启动 worker 时设置 `ELECTRON_RUN_AS_NODE=1`。

## 取消与错误定位

进度经 IPC 发送，结果必须收到完成消息并等到子进程 `close` 后才能采用。取消会停止 probe/render；POSIX 分支终止 worker 进程组，5 秒宽限后强制结束。宿主等到关闭后再清理任务工作目录，避免删除仍被 Chrome/FFmpeg 使用的文件。

| 错误                                           | 检查内容                                                            |
| ---------------------------------------------- | ------------------------------------------------------------------- |
| `motion_runtime_unavailable`                   | 绝对媒体工具路径、Chrome、worker 入口、GSAP、字体及许可资源是否完整 |
| `motion_encoder_unavailable`                   | 指定 FFmpeg 是否真的能编码 H.264，而不只是列出了编码器名字          |
| `motion_invalid_input`                         | 输入 MIME、入点、速度和量化后的媒体可见窗口是否匹配源时长           |
| `motion_external_resource`                     | 资源属性、CSS 或脚本是否违反离线模板合同                            |
| `motion_source_too_large`                      | 物化源文件总量是否超过限制                                          |
| `motion_probe_failed` / `motion_probe_timeout` | 媒体工具返回错误或探测未在期限内完成                                |
| `motion_render_failed`                         | worker/Chrome/编码失败，或 `strict` 正确性检查阻止了输出            |

`MotionError` 标为不可自动重试。底层主动取消为 `AbortError`，宿主映射为取消状态；取消不应作为普通渲染故障重试。成功结果保留 warnings，不能仅根据进度达到 100% 认定资产已经入库。

## 从普通视频继续编辑

历史或素材库放入画布的普通视频保留来源身份。选中视频，在结果操作条点击「从源版本继续编辑」，会打开对应版本的新动态合成节点，并把旧版原素材一起恢复为独立连线；原视频保留，一次撤销可移除整个副本。只读画布禁用此入口。来源不兼容、资产缺失或身份无效时显示具体错误。

读取过程中切换画布、删除/替换视频或改变来源身份，迟到请求不会写入旧目标或另一张画布。多个源版本需先在素材库选择，普通视频自身只绑定所选的一个版本。

## 源版本与升级

每次输出保存 `plein.motion-source.v1` manifest、完整参数与 overrides、输入绑定和 SHA-256、`dependencyAssetIds`、文件清单、渲染身份及依赖版本锁。源 ZIP 中的 HTML 是 SDK stamp 后实际参与渲染的版本。

恢复接口只从当前拥有者可访问的 manifest 和原素材重建新节点，不执行 ZIP 内的任意 HTML。它强制校验当前渲染 SDK 版本和 `templateVersion === MOTION_TEMPLATE_VERSION`；缺少版本字段或版本不匹配的旧源会拒绝恢复，保留原资产而不静默改写。

维护时遵守以下版本规则：

1. 修改模板视觉、默认值或时间合同，提升 [motion.ts](../../packages/nodes/src/motion.ts) 的 `MOTION_TEMPLATE_VERSION`，并同步相关 fixtures 和兼容性测试。
2. 改变渲染适配器语义，提升 [identity.ts](../../apps/server/src/motion/identity.ts) 的 `adapter` 版本。身份同时包含模板版本、引擎/资源版本及媒体工具、Chrome 指纹，用于使旧缓存失效。
3. 更新渲染 SDK、GSAP 或字体时，同步依赖、运行时常量和 `hyperframes.lock.json` 的生成字段，再运行下面的真实验收。适配器版本升级本身不提供旧源迁移。

## 可复现验收

验收脚本只使用本机素材与渲染器。以下独立脚本读取 `PRODUCER_HEADLESS_SHELL_PATH`，因此先把应用层 Chrome 配置桥接给脚本：

```sh
export PRODUCER_HEADLESS_SHELL_PATH="$PLEIN_HYPERFRAMES_CHROME_PATH"
apps/server/node_modules/.bin/tsx apps/server/src/motion/smoke.ts
apps/server/node_modules/.bin/tsx apps/server/src/motion/acceptance.ts
```

`smoke.ts` 验证 1 秒标题卡的 H.264、720p、30 帧和冻结源 ZIP，输出 `output.mp4`、`source.zip`、`frame.png`。`acceptance.ts` 生成测试视频，验证非零入点、2 倍速、原声音轨、源清单和渲染中取消，输出 `acceptance.json`、两张窗口截图及 `render/output.mp4`。默认各自创建临时目录并打印路径；需要固定目录时设置 `PLEIN_MOTION_SMOKE_DIR`。

独立 stage 验收前，确认 `apps/desktop/stage/ffmpeg` 已有当前平台二进制，且 Electron 已按桌面开发文档准备：

```sh
node apps/desktop/scripts/stage-server.mjs
node apps/server/src/motion/stage-acceptance.build.mjs
```

脚本复制 stage/server 和随包 FFmpeg 到独立临时目录，以 Electron run-as-node 执行真实 `server/motion/worker.mjs`；检查包与字体在复制目录内解析、没有源码符号链接且无法解析 `tsx`，并验证短源/短媒体 slot、缺 worker、缺字体。输出目录、`stage-acceptance.json`、`stage-frame.png` 和 MP4 路径会打印到终端。可用 `PLEIN_MOTION_STAGE_NODE` 显式指定执行二进制。

正向矩阵复用上述成功 stage 和已有的音轨视频，不重复已绿负例。将下面两个路径替换为前两步打印的实际目录与视频：

```sh
export PLEIN_MOTION_STAGE_REUSE='/absolute/path/to/successful-stage-root'
export PLEIN_MOTION_REUSED_VIDEO='/absolute/path/to/source-acceptance/render/output.mp4'
node apps/server/src/motion/matrix-acceptance.build.mjs
```

矩阵补验 6 秒、720×1280、180 帧的图片角色模板及长中文排版，并复核已存在的视频音轨产物；记录实测耗时与 stage/server 逻辑体积。未可靠测量跨 worker、Chrome、FFmpeg 的完整峰值内存时，不以单个 Node 进程的 maxRSS 代替。

矩阵脚本复用 [benchmarks/hyperframes](../benchmarks/hyperframes/) 里的源媒体参数夹具，其余产物（截图、验收 JSON、MP4 与完整源 ZIP）都写在验收临时目录里，不提交进仓库。

修改后可先跑维护回归：

```sh
node_modules/.bin/vp test run apps/server/src/motion
node_modules/.bin/markdownlint docs/dev/motion-composition.md
```
