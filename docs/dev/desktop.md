# 桌面端

0.1.0 的发布范围与决策见 [路线图](../plan/roadmap-0.1.0.md)。

2026-10-12 用户提出提前加入桌面端架构，同日确认采用 Electron 并先做阶段 1、2（已完成，见下）。目标是同一套 `apps/server` + `apps/web` 既能 `docker compose up` 自部署，也能装成双击即用的桌面应用，两条路共用代码，不分叉。

## 方案比较

|              | Electron（推荐）                                                                                   | Tauri + Node sidecar                                                                                                                             |
| ------------ | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 服务端怎么跑 | Electron 自带 Node（44.x 为 Node 24），`apps/server` 放进 `utilityProcess` 原样运行，不用另带 Node | 另外打包一份 Node 可执行文件和 `node_modules` 作为 sidecar 子进程，再加一层 Rust 外壳                                                            |
| 页面渲染     | 自带固定版本的 Chromium，各平台一致；与开发、Playwright 测试用的是同一内核                         | 系统 WebView：macOS 是 WKWebView，Windows 是 WebView2，Linux 是 WebKitGTK。PixiJS 的 WebGL / WebGPU 和视频解码在三个平台上表现不同，Linux 上最弱 |
| 视频编解码   | 内置 H.264 / AAC 等专有解码，生成的 MP4 能直接播放                                                 | 依赖系统；WebKitGTK 依赖 GStreamer 插件，用户机器上不一定有                                                                                      |
| 原生模块     | sharp 和 better-sqlite3（13.x）都是 N-API 预编译包，Electron 里直接可用，不用重新编译（已验证）    | 用普通 Node 运行，但每个平台都要单独打一份 Node + 模块                                                                                           |
| 安装包体积   | 较大，约 100 MB 起（不含 ffmpeg）                                                                  | 外壳小，但带上 Node 和原生模块后差距缩到几十 MB                                                                                                  |
| 团队成本     | 全部 TypeScript；自动更新、签名、公证有成熟工具（electron-builder）                                | 要维护 Rust 外壳，sidecar 的启动、退出、端口传递要自己写                                                                                         |

结论：plein 的核心是 Node 服务端 + 重度依赖 WebGL 和视频播放的前端，Electron 能让桌面端和 Docker、浏览器跑的是同一份代码、同一个内核，成本最低。Tauri 的体积优势在带上 Node 之后不明显，换来的是三套 WebView 的兼容问题。

## 进程结构

```text
Electron 主进程（apps/desktop）
 ├─ utilityProcess：apps/server（Hono + SQLite + 资产 + 插件宿主），监听 127.0.0.1 随机端口
 │    └─ 以后的第三方插件子进程（M5，stdio JSON-RPC，不变）
 └─ BrowserWindow：加载 http://127.0.0.1:<端口>/，就是现在的 apps/web 构建产物
```

窗口仍通过 HTTP 和 WebSocket 访问本机服务，前端代码不用区分桌面端和浏览器。只有少数原生能力（打开数据目录、选择导出位置、系统菜单）通过 preload 暴露一个很小的 `window.pleinDesktop`，浏览器里不存在时自动隐藏对应入口。

## 需要调整的地方

| 方面         | Docker / 自部署（不变）                     | 桌面端                                                                                                                                                                                                                                                            |
| ------------ | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 服务端入口   | `main.ts` 读环境变量启动                    | 把启动逻辑抽成 `startServer(config) → { port, close }`，`main.ts` 和桌面端都调用它；`port: 0` 时由系统分配端口，再通过 `process.parentPort` 告诉主进程                                                                                                            |
| 数据目录     | `PLEIN_DATA_DIR`，默认仓库下 `data/`        | 系统应用数据目录下的 `data/`（macOS `~/Library/Application Support/plein`，Windows `%APPDATA%\plein`，Linux `~/.config/plein`），日志在同级 `logs/`；目录结构与 Docker 完全相同，可以互相拷贝；设置里可一键打开，改位置以后再做；开发时可用 `PLEIN_DATA_DIR` 覆盖 |
| 认证         | 本机 `none`，对外 `password`（Better Auth） | 默认 `none`，但每次启动生成随机令牌，主进程把它写进窗口的 Cookie，服务端只认带令牌的请求，防止本机其他程序或浏览器里的网页访问这个端口。以后加「允许局域网访问」开关时切到 `password` 模式，账号体系不变                                                          |
| ffmpeg       | 镜像里 `apt install ffmpeg`                 | 按平台随安装包附带 ffmpeg / ffprobe（选 LGPL 构建），路径通过新增的 `PLEIN_FFMPEG_PATH` / `PLEIN_FFPROBE_PATH` 传给服务端；找不到时沿用现在的降级逻辑（只存原文件）                                                                                               |
| 前端静态文件 | `PLEIN_WEB_DIST`                            | 打进安装包 `resources/`，通过 `PLEIN_WEB_DIST` 传入（仓库路径只作为未设置时的默认值）                                                                                                                                                                             |
| 原生模块     | 镜像内 `pnpm install`                       | 都是 N-API 预编译包，打包时按目标平台带上对应的包即可                                                                                                                                                                                                             |
| 退出         | SIGTERM 时保存并退出                        | 主进程退出前先通知服务端关闭，等 Yjs 落盘和 SQLite 关闭后再退出                                                                                                                                                                                                   |
| 更新         | 拉新镜像                                    | electron-updater，从 GitHub Releases 检查更新                                                                                                                                                                                                                     |

## 分期

| 阶段            | 内容                                                                                                                                                                                                                | 放在                 |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| 1. 服务端可嵌入 | `startServer`、随机端口、可配置的 ffmpeg 路径、桌面令牌；Docker 行为不变                                                                                                                                            | 已完成（2026-10-12） |
| 2. 桌面壳       | 新增 `apps/desktop`：主进程、utilityProcess、启动令牌、preload（打开数据目录）；`pnpm dev:desktop` 连 Vite，`pnpm start:desktop` 用构建产物                                                                         | 已完成（2026-10-12） |
| 3. 打包         | electron-builder 出 macOS 安装包（dmg + zip，Apple 芯片），附带 LGPL ffmpeg（libass + VideoToolbox）；CI 打标签时签名、公证并发布（复用 hoobnn/ci-workflows）；本机构建没有证书时 ad-hoc 签名。Windows / Linux 暂缓 | 已完成（2026-10-13） |
| 4. 发布         | 自动更新；Windows 签名暂缓（2026-10-13）                                                                                                                                                                            | M5，打 `v0.1.0` 时   |

## 桌面端体验（2026-10-12，先只做 macOS）

用户确认先做以下五项，再出安装包；Windows 暂不考虑（没有签名证书）。

- **首次启动引导**：没有可用的模型平台时首页弹出，先填密钥并测试连接（保存即启用），再从短剧模板或空白画布开始；看过一次不再弹。浏览器版同样适用。
- **后台任务**：服务端经 `parentPort` 把任务动态（`RunActivity`）发给主进程。Dock 徽标显示排队和运行中的任务数，Dock 图标显示平均进度；窗口不在前台时，任务结束（批量结束时只发一条汇总）发系统通知，点通知回到画布并定位节点。
- **退出与休眠**：有任务时退出先确认（远端任务下次启动继续查询）；有任务时阻止系统休眠。
- **服务端崩溃**：意外退出后自动重启并重新载入页面，一分钟内再次退出才报错，错误框可打开日志目录。
- **文件进出**：下载走系统“另存为”，记住上次目录，保存后提示并可“在访达中显示”；序列编辑器加“另存为…”；拖入或选择整个文件夹导入（含子文件夹，跳过隐藏文件，单次最多 500 个）。
- **端口沿用**：服务端尽量沿用上次的端口（存在 `<userData>/desktop.json`），否则网页的本地设置（主题、侧栏、智能体选择、引导是否看过）每次启动都会丢；端口被占用时换一个。

## 打包（2026-10-13）

- `pnpm --filter @plein/desktop ffmpeg`：从源码构建 ffmpeg / ffprobe 到 `apps/desktop/stage/ffmpeg`（需要 `brew install meson ninja pkgconf`）。LGPL 构建，静态链接 libass、freetype、fribidi、harfbuzz，字体走 CoreText，只依赖系统框架；没有 libx264，服务端的 `h264Args()` 在这种情况下改用 `h264_videotoolbox`（按码率，`-allow_sw` 兜底）。
- `pnpm dist:desktop`：构建前端，`scripts/stage-server.mjs` 把服务端连同全部依赖打成一个 `main.mjs`，只有 better-sqlite3、sharp 两个原生模块按当前平台从已安装的依赖复制（约 40 MB）；再由 `electron-builder.config.mjs` 出 `release/Plein-<版本>-arm64.dmg` 和 zip。extraResources 会跳过 node_modules，原生模块在 afterPack 里补进去，签名时一并签上。
- 打包后的服务端可以单独验证：`PLEIN_E2E_SERVER="node --no-experimental-webstorage apps/desktop/stage/server/main.mjs" pnpm e2e`。
- CI：`.github/workflows/release.yml`（推送 `v*` 标签发布 GitHub Release；手动运行只出 Artifacts，可取消 `sign` 试运行，不需要凭据）。`ci.yml` 检查与 `build` job 并行：`build` 用 setup-node 和 ffmpeg 缓存（按脚本内容）打出 ad-hoc 签名的 `Plein.app`，以 tar 上传；再调用 [hoobnn/ci-workflows](https://github.com/hoobnn/ci-workflows) 的 `macos-release.yml@v1`（`app-artifact`），用 `inner-binaries: auto` 和 `inner-entitlements` 由内向外重签 Helper、Framework、原生模块和 ffmpeg，公证后出 `Plein-<版本>-macOS-arm64.zip`、`.dmg` 和 `.sha256`。Helper 缺 `allow-jit` 会崩溃，所以内层签名必须带 entitlements。凭据与其他 macOS 应用相同，见 ci-workflows 的 README。本机 `pnpm dist:desktop` 照旧，没有证书时 ad-hoc 签名。
- Intel Mac 暂不出包：要在 x64 机器上装依赖（sharp 的平台包）并单独构建 ffmpeg。

## 已定与默认

- 采用 Electron（2026-10-12 确认）。
- 平台默认 macOS 和 Windows 优先，Linux 只出 AppImage。
- Docker 继续作为正式部署方式。
- 开发模式下 utilityProcess 不接受 `--import`，服务端源码通过 `apps/desktop/scripts/dev-server.mjs` 手动注册 tsx 后加载。
