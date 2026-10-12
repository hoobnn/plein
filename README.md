# Plein

AI 无限画布：视觉创作 + 工作流编排，追求极致审美与丝滑体验。

## 结构

```text
apps/web              Vite + React 19 + Tailwind v4 前端
apps/server           本地服务：Hono（Node）+ SQLite + Yjs 同步 + 资产 + Better Auth
apps/desktop          桌面端：Electron 外壳，在 utilityProcess 里运行 apps/server
packages/canvas-core  画布内核：PixiJS v8 + 相机 + 输入
packages/doc          文档模型：Yjs（Element / Edge / Undo）
packages/flow         工作流：依赖图、执行顺序、按依赖调度、缓存键
packages/protocol     前后端共享的接口约定（zod）
packages/plugin-sdk   插件 API：清单、节点、Provider、执行器（见 docs/plugins.md）
packages/nodes        内置节点声明（plein/core）
packages/providers    模型平台适配器（服务端）：MiniMax、豆包语音、百炼、火山方舟及 mock
```

## 本地部署

```bash
docker compose up -d     # 打开 http://localhost:8787
```

画布、素材和数据库都在 `plein-data` 卷里，备份它即可。默认只绑定本机且免登录；要让其他设备访问，按 `compose.yaml` 里的注释改端口并删掉 `PLEIN_AUTH`，首次访问会要求创建所有者账号。

不用 Docker 时：`pnpm install && pnpm build && pnpm start`（需要本机装好 ffmpeg，用于视频封面和音频波形）。

打开设置中的「模型平台」，填写密钥、保存并启用对应平台，再在节点里选择模型。四家真实平台默认关闭；无需环境变量注入密钥。支持范围和配置说明见 [模型平台接入](docs/providers.md)。

| 环境变量                                   | 默认                               | 说明                                                   |
| ------------------------------------------ | ---------------------------------- | ------------------------------------------------------ |
| `PLEIN_HOST` / `PLEIN_PORT`                | `127.0.0.1` / `8787`               | 监听地址                                               |
| `PLEIN_DATA_DIR`                           | `./data`                           | 数据目录                                               |
| `PLEIN_AUTH`                               | 本机地址为 `none`，否则 `password` | `password` 时用 Better Auth 登录，只允许一个所有者账号 |
| `PLEIN_PUBLIC_URL`                         | 按请求推断                         | 反向代理后的对外地址                                   |
| `PLEIN_ALLOWED_HOSTS`                      | 空                                 | 免登录模式下额外允许的主机名，逗号分隔                 |
| `PLEIN_MAX_UPLOAD_MB`                      | `2048`                             | 单个文件上限                                           |
| `PLEIN_MAX_JOBS`                           | `4`                                | 同时运行的节点任务数上限                               |
| `PLEIN_FFMPEG_PATH` / `PLEIN_FFPROBE_PATH` | 从 `PATH` 查找                     | ffmpeg / ffprobe 可执行文件                            |
| `PLEIN_AGENT`                              | 免登录模式下开启                   | 设为 `0` 关闭本机智能体                                |

## 本机智能体

右下角的助手会调用这台电脑上已安装、已登录的 [Claude Code](https://docs.anthropic.com/en/docs/claude-code) 或 [Codex](https://github.com/openai/codex) CLI，让它直接操作当前画布：读画布、新建和修改节点、连线、运行节点、查看生成效果、剪辑视频。Plein 不读取也不保存它们的登录凭据，用的是你在终端里的同一个账号和额度。

- 只在免登录模式（桌面端或本机部署）可用；开启登录后自动关闭，因为智能体以服务端进程的身份在这台机器上运行。
- 服务端在本机 `/mcp` 提供画布工具（MCP，Streamable HTTP），每个对话一个随机令牌；CLI 只开放这些工具和联网搜索，不碰本机文件和命令（Codex 在只读沙箱里运行）。
- 每条消息启动一次 `claude -p` / `codex exec`，之后用 CLI 自己的会话 id 续聊；对话记录存在数据库里，工作目录是 `<数据目录>/agent`。
- 选中画布元素再提问，选中的元素会作为上下文一起发过去。

## 开发

```bash
npm i -g pnpm@12         # 版本由 package.json 的 packageManager 锁定
pnpm install
pnpm dev                 # 前端 http://localhost:5173 + 服务端 :8787（数据在 ./data）
pnpm lint                # Biome + Prettier 检查（pnpm format 自动修复）
pnpm typecheck
pnpm test                # Vitest
```

性能演示画布不依赖服务端：`http://localhost:5173/#/demo?n=5000`。

格式化与代码检查统一使用 `pnpm lint`，CI 在 PR 和 main 推送时执行同一命令。`pnpm format` 应用格式化和可安全自动修复的代码规则：Biome 负责 JS / TS / JSX / TSX、JSON / JSONC 和 CSS；Prettier 负责 Markdown（`.md`）、YAML（`.yaml` / `.yml`）和 HTML（`.html`）。两者遵循 `.gitignore`，排除构建产物；`pnpm-lock.yaml` 保留 pnpm 生成的格式。Markdown 段落不强制折行，代码块和 HTML 内嵌代码不做二次格式化。

### 桌面端

```bash
pnpm dev:desktop         # Vite + Electron；服务端跑源码，接口经 Vite 代理到 :8787
pnpm start:desktop       # 先构建服务端和前端，再用构建产物启动（与安装包的运行方式一致）
```

桌面端保留系统原生标题栏和窗口按钮：macOS 使用系统菜单栏、⌘ 快捷键，关闭窗口后应用继续运行，可从 Dock 重开；Windows 使用窗口菜单栏、Ctrl 快捷键和系统窗口布局，关闭最后一个窗口即退出。菜单中的撤销、重做和全选会作用于当前画布或文本编辑器，设置可用 `CmdOrCtrl+,` 打开。窗口位置、尺寸和最大化状态保存在应用数据目录的 `window-state.json`；显示器变化时会将窗口移回可见工作区。开发工具菜单仅在开发模式显示。

首次运行会下载 Electron。桌面端的数据在系统应用数据目录（macOS `~/Library/Application Support/plein/data`，Windows `%APPDATA%\plein\data`，Linux `~/.config/plein/data`），可用 `PLEIN_DATA_DIR` 覆盖；服务端只接受桌面端窗口的请求（每次启动生成的令牌放在窗口 Cookie 里），所以开发模式下用普通浏览器打开 5173 会返回 403。安装包打包见路线图第八节。

## 原则

- 相机与渲染不走 React state，拖动/缩放期间 React 零重渲染
- 二进制资源不进 Yjs 文档，只存 assetId
- 渲染：GPU 画内容，DOM 覆盖层负责编辑与表单（按 LOD 挂载）

## 分支规范

遵循 [Conventional Branch](https://conventionalbranch.org/)：`<type>/<description>`，全小写、连字符分隔。

- type：`feature`/`feat`、`bugfix`/`fix`、`hotfix`、`release`、`chore`；AI 代理自建分支用 `claude/`、`codex/`、`copilot/`、`cursor/`、`ai/`
- 主干 `main` 不加前缀
- 示例：`feature/add-login-page`、`fix/edge-hit-test`、`release/v1.2.0`

三层强制：husky `pre-push` 本地拦截；GitHub 规则集（`.github/rulesets/conventional-branch.json`）禁止创建前缀不合规的分支；`Branch name` CI 用完整正则校验 PR 分支。

Dependabot 的 `dependabot/*` 自动分支是保留例外；PR 检查同时核验作者必须为 `dependabot[bot]`。手动创建同前缀的 PR 仍会被命名检查拒绝。

## 依赖检查

- Dependabot 每周一北京时间 09:00 检查整个 pnpm workspace 和 GitHub Actions，提出更新 PR。生产与开发依赖的 minor / patch 分组更新，major 单独评审；不自动合并。
- `Dependency security / dependency-review` 检查 PR 引入的依赖，新增 high / critical 漏洞时失败。
- `Dependency security / dependency-audit` 用原生 `pnpm audit` 检查完整锁文件，覆盖生产、开发和间接依赖。PR、main 推送、每周定时及手动触发均运行；high / critical 漏洞阻断，不忽略审计服务错误。本地可运行 `pnpm audit:deps`。

pnpm 12 锁文件包含多份 YAML 文档，上游依赖图解析仍有[兼容问题](https://github.com/dependabot/dependabot-core/issues/15904)，因此保留原生审计补足依赖图的覆盖。检查依据已知漏洞数据库，不代表所有依赖风险都已消除。若需要阻止漏洞 PR 合并，应在 main 的合并规则里把上述两个 job 设为必需检查。

## 许可证

[GNU AGPL v3.0](LICENSE)：允许商用、修改与分发，但衍生作品（包括通过网络提供的服务）必须以相同许可证开源。
