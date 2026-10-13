# 参与开发

## 环境

- Node ≥ 24（`.node-version`），pnpm 版本由 `package.json` 的 `packageManager` 锁定
- ffmpeg / ffprobe（视频封面、音频波形、导出成片；烧字幕需要带 libass 的构建）

```bash
npm i -g pnpm@12
pnpm install
pnpm dev                 # 前端 http://localhost:5173 + 服务端 :8787（数据在 ./data）
```

性能演示画布不依赖服务端：`http://localhost:5173/#/demo?n=5000`。

## 常用命令

| 命令             | 作用                                                                                |
| ---------------- | ----------------------------------------------------------------------------------- |
| `pnpm lint`      | Vite+ 检查（Oxfmt 格式 + Oxlint 规则）+ markdownlint（CI 在 PR 和 main 推送时执行） |
| `pnpm format`    | 应用格式化和可安全自动修复的规则，含 markdownlint 能自动修的项                      |
| `pnpm typecheck` | 全部包的类型检查                                                                    |
| `pnpm test`      | Vitest 单测与集成测试                                                               |
| `pnpm smoke`     | 起真服务，走 HTTP 与 Yjs WebSocket，重启后验证不丢数据                              |
| `pnpm verify`    | 以上四项依次跑完，合并前的门禁                                                      |
| `pnpm e2e`       | Playwright 界面冒烟（mock 平台，走通短剧模板到导出）                                |
| `pnpm perf`      | 画布渲染性能基准                                                                    |

验收分四层（单测、集成、启动冒烟、真实样例），见 [docs/acceptance-0.1.0.md](docs/acceptance-0.1.0.md)。

工具链是 [Vite+](https://viteplus.dev)（`vp`）：Oxfmt 格式化代码、样式、Markdown、YAML 和 HTML，Oxlint 做代码检查（含类型感知规则），Vitest 跑单测，`vp pack`（tsdown）打包服务端和桌面端；规则与格式选项都在根目录 `vite.config.ts`。遵循 `.gitignore`，排除构建产物；`pnpm-lock.yaml` 保留 pnpm 生成的格式。Markdown 段落不强制折行，代码块和 HTML 内嵌代码不做二次格式化；Markdown 规则另由 markdownlint 检查，配置在 `.markdownlint.jsonc`（VS Code 的 markdownlint 插件读同一份）。

## 代码结构

```text
apps/web               Vite + React 19 + Tailwind v4 前端
apps/server            本地服务：Hono（Node）+ SQLite + Yjs 同步 + 资产 + 任务队列 + Better Auth
apps/desktop           Electron 外壳，在 utilityProcess 里运行 apps/server
packages/canvas-core   画布内核：PixiJS v8 + 相机 + 输入
packages/doc           文档模型：Yjs（Element / Edge / Undo）
packages/flow          工作流：依赖图、执行顺序、按依赖调度、缓存键
packages/nodes         内置节点声明（plein/core）、短剧模板与提示词
packages/capabilities  画布能力层：界面、⌘K、智能体和对外 MCP 共用
packages/protocol      前后端共享的接口约定（zod）
packages/plugin-sdk    插件 API：清单、节点、Provider、执行器
packages/providers     模型平台适配器（服务端）：MiniMax、豆包语音、百炼、火山方舟及 mock
```

设计取舍见 [architecture.md](docs/architecture.md)，界面规范见 [design-spec.md](docs/design-spec.md)。几条硬约束：

- 相机与渲染不走 React state，拖动 / 缩放期间 React 零重渲染
- 二进制资源不进 Yjs 文档，只存 assetId
- GPU 画内容，DOM 覆盖层负责编辑与表单（按 LOD 挂载）

## 桌面端

```bash
pnpm dev:desktop         # Vite + Electron；服务端跑源码，接口经 Vite 代理到 :8787
pnpm start:desktop       # 先构建服务端和前端，再用构建产物启动（与安装包的运行方式一致）
pnpm dist:desktop        # 出 macOS 安装包（Apple 芯片），没有证书时 ad-hoc 签名
```

桌面端保留系统原生标题栏和窗口按钮：macOS 使用系统菜单栏、⌘ 快捷键，关闭窗口后应用继续运行，可从 Dock 重开；Windows 使用窗口菜单栏、Ctrl 快捷键和系统窗口布局，关闭最后一个窗口即退出。菜单中的撤销、重做和全选会作用于当前画布或文本编辑器，设置可用 `CmdOrCtrl+,` 打开。窗口位置、尺寸和最大化状态保存在应用数据目录的 `window-state.json`；显示器变化时会将窗口移回可见工作区。开发工具菜单仅在开发模式显示。

首次运行会下载 Electron。服务端只接受桌面端窗口的请求（每次启动生成的令牌放在窗口 Cookie 里），所以开发模式下用普通浏览器打开 5173 会返回 403。ffmpeg 构建、打包和签名发布见[路线图第八节](docs/roadmap-0.1.0.md#八桌面端)。

## 分支

遵循 [Conventional Branch](https://conventionalbranch.org/)：`<type>/<description>`，全小写、连字符分隔。

- type：`feature`/`feat`、`bugfix`/`fix`、`hotfix`、`release`、`chore`；AI 代理自建分支用 `claude/`、`codex/`、`copilot/`、`cursor/`、`ai/`
- 主干 `main` 不加前缀
- 示例：`feature/add-login-page`、`fix/edge-hit-test`、`release/v1.2.0`

三层强制：husky `pre-push` 本地拦截；GitHub 规则集（`.github/rulesets/conventional-branch.json`）禁止创建前缀不合规的分支；`Branch name` CI 用完整正则校验 PR 分支。

Dependabot 的 `dependabot/*` 自动分支是保留例外；PR 检查同时核验作者必须为 `dependabot[bot]`。手动创建同前缀的 PR 仍会被命名检查拒绝。

## 提交

格式为 `<emoji> type(scope): 中文描述`，例如 `✨ feat(canvas): 新增小地图`。type 与 emoji 一一对应，由 husky `commit-msg` 钩子里的 commitlint 校验，完整对照表见 `commitlint.config.cjs`。

## 依赖检查

- Dependabot 每周一北京时间 09:00 检查整个 pnpm workspace 和 GitHub Actions，提出更新 PR。生产与开发依赖的 minor / patch 分组更新，major 单独评审；不自动合并。
- `Dependency security / dependency-review` 检查 PR 引入的依赖，新增 high / critical 漏洞时失败。
- `Dependency security / dependency-audit` 用原生 `pnpm audit` 检查完整锁文件，覆盖生产、开发和间接依赖。PR、main 推送、每周定时及手动触发均运行；high / critical 漏洞阻断，不忽略审计服务错误。本地可运行 `pnpm audit:deps`。

pnpm 12 锁文件包含多份 YAML 文档，上游依赖图解析仍有[兼容问题](https://github.com/dependabot/dependabot-core/issues/15904)，因此保留原生审计补足依赖图的覆盖。检查依据已知漏洞数据库，不代表所有依赖风险都已消除。若需要阻止漏洞 PR 合并，应在 main 的合并规则里把上述两个 job 设为必需检查。
